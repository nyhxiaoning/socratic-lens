/**
 * 教学覆盖度审计核心。
 * 与 fidelity 共享 extractChecklist/parseChecklist 但 reconcile 目标从"合成节"换成"对话 transcript"。
 * 见 docs/superpowers/specs/2026-07-11-teach-coverage-design.md。
 */
import path from "node:path";
import { callLLM, callLLMWithTool } from "./llm";
import { readText, PROMPTS_ROOT } from "./storage";
import {
  type Checklist, type Row, type Coverage,
  parseReconciliation, parseReconciliationText, verifyQuotes, computeCoverage,
  RECONCILE_TOOL,
} from "./fidelity";

const MAX_LLM_ATTEMPTS = 3;

/**
 * 勾稽：清单 + 教学对话 transcript → LLM → Row[]（含 verbatim 校验）+ verdict。
 *
 * 双路径：
 * 1. Tool calling（优先）——所有非 thinking 模型走这条，结构最可靠
 * 2. 纯文本 ROW|... 格式（降级）——thinking 模型（如 DeepSeek pro）走这条，
 *    不依赖 JSON/response_format，靠行格式 + 正则解析
 */
export async function reconcileAgainstTranscript(
  checklist: Checklist,
  transcriptText: string,
  pacing: string,
  signal: AbortSignal,
): Promise<{ rows: Row[]; verdict: string }> {
  const rules = await readText(path.join(PROMPTS_ROOT, "coverage_reconcile.md"));
  const user = [
    `## 教学节奏`,
    pacing,
    ``,
    `## 教学内容清单（JSON）`,
    JSON.stringify(checklist, null, 2),
    ``,
    `## 教学对话 transcript`,
    transcriptText,
  ].join("\n");

  let lastErr: unknown;

  // —— 路径 1：Tool calling（优先）——
  for (let attempt = 1; attempt <= 2; attempt++) {
    const retryBanner =
      attempt > 1
        ? `\n\n---\n⚠️ 上一步输出不合法。严格按提供的函数 schema 输出。`
        : "";
    try {
      const result = await callLLMWithTool(
        "audit",
        [
          { role: "system", content: rules + retryBanner },
          { role: "user", content: user },
        ],
        RECONCILE_TOOL,
        { temperature: Math.max(0.05, 0.2 - attempt * 0.08), maxTokens: 4000, signal },
      );
      const rows = verifyQuotes(parseReconciliation(JSON.stringify(result)), transcriptText);
      const verdict = String(result.verdict ?? "");
      return { rows, verdict };
    } catch (e) {
      lastErr = e;
      if (signal.aborted) break;
    }
  }

  // —— 路径 2：纯文本行格式（thinking 模型降级）——
  for (let attempt = 1; attempt <= MAX_LLM_ATTEMPTS; attempt++) {
    if (signal.aborted) break;
    const retryBanner =
      attempt > 1
        ? `\n\n---\n⚠️ 上一步输出不符合格式要求。严格按 ROW|... 和 VERDICT|... 格式输出，每行一条。`
        : "";
    try {
      const raw = await callLLM(
        "audit",
        [
          { role: "system", content: rules + retryBanner },
          { role: "user", content: user },
        ],
        { temperature: Math.max(0.1, 0.3 - attempt * 0.1), maxTokens: 4000, signal },
      );
      const { rows, verdict } = parseReconciliationText(raw);
      if (rows.length === 0) throw new Error("未解析到任何 ROW 行");
      const verified = verifyQuotes(rows, transcriptText);
      return { rows: verified, verdict };
    } catch (e) {
      lastErr = e;
    }
  }

  throw new Error(`覆盖度勾稽失败：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

/** 渲染覆盖度审计报告 markdown。 */
export function renderCoverageReportMd(
  rows: Row[],
  coverage: Coverage,
  verdict: string,
  sourceLabel: string,
  pacing?: string,
): string {
  const STATUS_ICON: Record<string, string> = { landed: "✅", morphed: "⚠️", dropped: "❌" };
  const STATUS_LABEL: Record<string, string> = { landed: "落地", morphed: "变形", dropped: "漏" };
  const PACING_LABEL: Record<string, string> = {
    thorough: "细（期望全覆盖）",
    normal: "中（期望知识点+易错点落地）",
    express: "快（仅知识点必须落地）",
  };

  const nonExercise = rows.filter((r) => r.category !== "exercise");
  const exercises = rows.filter((r) => r.category === "exercise");

  const lines: string[] = [];
  lines.push(`# 教学覆盖度审计报告`);
  lines.push(``);
  lines.push(`> **知识来源**：${sourceLabel}`);
  if (pacing) lines.push(`> **教学节奏**：${PACING_LABEL[pacing] ?? pacing}`);
  lines.push(``);
  lines.push(`## 总评`);
  lines.push(verdict || "（无）");
  lines.push(``);
  lines.push(`## 覆盖率`);
  lines.push(
    `覆盖 ${coverage.landed}/${coverage.total}（${Math.round(coverage.coverageRate * 100)}%）` +
      ` · 变形 ${coverage.morphed} · 漏 ${coverage.dropped}`,
  );
  lines.push(``);
  lines.push(`## 知识点 / 评价标准 / 易错点 覆盖`);
  if (nonExercise.length) {
    for (const r of nonExercise) {
      const icon = STATUS_ICON[r.status] ?? "";
      const label = STATUS_LABEL[r.status] ?? r.status;
      const parts = [`- ${icon} **${label}**：${r.itemName}`];
      if (r.synthQuote) {
        const warn = r.quoteUnverified ? " ⚠️（此引用未在 transcript 逐字命中）" : "";
        parts.push(`\n  > ${r.synthQuote}${warn}`);
      }
      if (r.note) parts.push(`\n  说明：${r.note}`);
      lines.push(parts.join(""));
    }
  } else {
    lines.push("- 无");
  }
  lines.push(``);
  lines.push(`## 教材原题覆盖`);
  if (exercises.length) {
    for (const r of exercises) {
      const icon = STATUS_ICON[r.status] ?? "";
      const label = STATUS_LABEL[r.status] ?? r.status;
      const parts = [`- ${icon} **${label}**：${r.itemName}`];
      if (r.synthQuote) {
        const warn = r.quoteUnverified ? " ⚠️（此引用未在 transcript 逐字命中）" : "";
        parts.push(`\n  > ${r.synthQuote}${warn}`);
      }
      if (r.note) parts.push(`\n  说明：${r.note}`);
      lines.push(parts.join(""));
    }
  } else {
    lines.push("- 无");
  }
  lines.push(``);
  return lines.join("\n");
}

/** 覆盖率兜底 verdict。 */
export function deriveCoverageVerdict(cov: Coverage): string {
  if (cov.total === 0) return "无可勾稽条目。";
  const pct = Math.round(cov.coverageRate * 100);
  if (cov.dropped === 0 && cov.morphed === 0) return `覆盖度高：${cov.total} 条全部落地。`;
  if (cov.dropped === 0) return `覆盖度尚可：落地 ${pct}%，${cov.morphed} 条讲法有变形需关注。`;
  return `覆盖度存疑：${cov.dropped} 条漏、${cov.morphed} 条变形，覆盖率 ${pct}%。`;
}
