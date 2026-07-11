/**
 * 教学覆盖度审计核心。
 * 与 fidelity 共享 extractChecklist/parseChecklist 但 reconcile 目标从"合成节"换成"对话 transcript"。
 * 见 docs/superpowers/specs/2026-07-11-teach-coverage-design.md。
 */
import path from "node:path";
import { callLLM } from "./llm";
import { readText, PROMPTS_ROOT } from "./storage";
import {
  type Checklist, type Row, type Coverage,
  parseReconciliation, verifyQuotes, computeCoverage,
} from "./fidelity";

const MAX_LLM_ATTEMPTS = 2;

/**
 * 勾稽：清单 + 教学对话 transcript → LLM → Row[]（含 verbatim 校验）+ verdict。
 * 与 fidelity.reconcile() 结构一致但 prompt 换成 coverage_reconcile.md，
 * 目标文本是教学对话而非合成节。
 */
export async function reconcileAgainstTranscript(
  checklist: Checklist,
  transcriptText: string,
  signal: AbortSignal,
): Promise<{ rows: Row[]; verdict: string }> {
  const rules = await readText(path.join(PROMPTS_ROOT, "coverage_reconcile.md"));
  const user = [
    `## 教学内容清单（JSON）`,
    JSON.stringify(checklist, null, 2),
    ``,
    `## 教学对话 transcript`,
    transcriptText,
  ].join("\n");

  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_LLM_ATTEMPTS; attempt++) {
    const raw = await callLLM(
      "audit",
      [
        { role: "system", content: rules },
        { role: "user", content: user },
      ],
      { jsonMode: true, temperature: 0.2, maxTokens: 4000, signal },
    );
    try {
      const rows = verifyQuotes(parseReconciliation(raw), transcriptText);
      let verdict = "";
      try {
        const o = JSON.parse(raw) as { verdict?: unknown };
        if (o.verdict != null) verdict = String(o.verdict);
      } catch {
        /* verdict 可选 */
      }
      return { rows, verdict };
    } catch (e) {
      lastErr = e;
      if (signal.aborted) break;
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
): string {
  const STATUS_ICON: Record<string, string> = { landed: "✅", morphed: "⚠️", dropped: "❌" };
  const STATUS_LABEL: Record<string, string> = { landed: "落地", morphed: "变形", dropped: "漏" };

  const nonExercise = rows.filter((r) => r.category !== "exercise");
  const exercises = rows.filter((r) => r.category === "exercise");

  const lines: string[] = [];
  lines.push(`# 教学覆盖度审计报告`);
  lines.push(``);
  lines.push(`> **知识来源**：${sourceLabel}`);
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
