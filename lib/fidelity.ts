import path from "node:path";
import { callLLM } from "./llm";
import { readText, PROMPTS_ROOT, ensureDir, writeAtomic, DATA_ROOT } from "./storage";
import { normalizeForMatch } from "./citations";

// —— 类型契约（见 plan）——
export type KnowledgePoint = { id: string; name: string; sourceQuote: string; note?: string };
export type Criterion = { id: string; desc: string; sourceQuote: string };
export type Exercise = { id: string; question: string; answer: string; sourceQuote: string };
export type ErrorSpot = { id: string; desc: string; sourceQuote: string };
export type Checklist = {
  knowledgePoints: KnowledgePoint[];
  assessmentCriteria: Criterion[];
  exercises: Exercise[];
  errorSpots: ErrorSpot[];
};

export type ReconStatus = "landed" | "morphed" | "dropped";
export type ReconCategory = "knowledgePoint" | "criteria" | "exercise" | "errorSpot";
export type Row = {
  checklistId: string;
  category: ReconCategory;
  itemName: string;
  status: ReconStatus;
  synthQuote?: string;
  quoteUnverified?: boolean;
  note?: string;
};
export type Coverage = {
  total: number;
  landed: number;
  morphed: number;
  dropped: number;
  coverageRate: number;
};
export type FidelityResult = {
  fid: string;
  checklist: Checklist;
  rows: Row[];
  coverage: Coverage;
  verdict: string;
  dir: string;
};

function parseJsonLoose(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // 有的模型会包一层 ```json ... ```，剥掉再试
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) {
      try {
        return JSON.parse(fence[1]);
      } catch {
        /* fallthrough */
      }
    }
    throw new Error(`Fidelity: LLM 输出不是合法 JSON`);
  }
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function parseChecklist(raw: string): Checklist {
  const o = parseJsonLoose(raw) as Record<string, unknown>;
  const checklist: Checklist = {
    knowledgePoints: asArray(o.knowledgePoints).map((x, i) => {
      const r = x as Record<string, unknown>;
      return {
        id: String(r.id ?? `kp${i + 1}`),
        name: String(r.name ?? ""),
        sourceQuote: String(r.sourceQuote ?? ""),
        note: r.note != null ? String(r.note) : undefined,
      };
    }),
    assessmentCriteria: asArray(o.assessmentCriteria).map((x, i) => {
      const r = x as Record<string, unknown>;
      return { id: String(r.id ?? `ac${i + 1}`), desc: String(r.desc ?? ""), sourceQuote: String(r.sourceQuote ?? "") };
    }),
    exercises: asArray(o.exercises).map((x, i) => {
      const r = x as Record<string, unknown>;
      return {
        id: String(r.id ?? `ex${i + 1}`),
        question: String(r.question ?? ""),
        answer: String(r.answer ?? ""),
        sourceQuote: String(r.sourceQuote ?? ""),
      };
    }),
    errorSpots: asArray(o.errorSpots).map((x, i) => {
      const r = x as Record<string, unknown>;
      return { id: String(r.id ?? `es${i + 1}`), desc: String(r.desc ?? ""), sourceQuote: String(r.sourceQuote ?? "") };
    }),
  };
  const total =
    checklist.knowledgePoints.length +
    checklist.assessmentCriteria.length +
    checklist.exercises.length +
    checklist.errorSpots.length;
  if (total === 0) throw new Error("Fidelity: 清单没抽到任何条目");
  return checklist;
}

const VALID_STATUS: ReconStatus[] = ["landed", "morphed", "dropped"];
const VALID_CATEGORY: ReconCategory[] = ["knowledgePoint", "criteria", "exercise", "errorSpot"];

export function parseReconciliation(raw: string): Row[] {
  const o = parseJsonLoose(raw) as Record<string, unknown>;
  const rows = asArray(o.rows).map((x) => {
    const r = x as Record<string, unknown>;
    const status = String(r.status ?? "");
    if (!VALID_STATUS.includes(status as ReconStatus)) {
      throw new Error(`Fidelity: 非法 status "${status}"`);
    }
    const category = String(r.category ?? "");
    if (!VALID_CATEGORY.includes(category as ReconCategory)) {
      throw new Error(`Fidelity: 非法 category "${category}"`);
    }
    return {
      checklistId: String(r.checklistId ?? ""),
      category: category as ReconCategory,
      itemName: String(r.itemName ?? ""),
      status: status as ReconStatus,
      synthQuote: r.synthQuote != null ? String(r.synthQuote) : undefined,
      note: r.note != null ? String(r.note) : undefined,
    } as Row;
  });
  if (rows.length === 0) throw new Error("Fidelity: 勾稽表没有任何行");
  return rows;
}

/** 校验每行的 synthQuote 是否逐字（规范化后）出现在合成节里。返回带 quoteUnverified 的新数组。 */
export function verifyQuotes(rows: Row[], synthText: string): Row[] {
  const normText = normalizeForMatch(synthText);
  return rows.map((r) => {
    if (!r.synthQuote) return { ...r, quoteUnverified: false };
    const needle = normalizeForMatch(r.synthQuote);
    const hit = needle.length === 0 ? true : normText.includes(needle);
    return { ...r, quoteUnverified: !hit };
  });
}

/** 覆盖率：landed / total（morphed 不计入 landed）。 */
export function computeCoverage(rows: Row[]): Coverage {
  let landed = 0, morphed = 0, dropped = 0;
  for (const r of rows) {
    if (r.status === "landed") landed++;
    else if (r.status === "morphed") morphed++;
    else dropped++;
  }
  const total = rows.length;
  const coverageRate = total === 0 ? 0 : Math.round((landed / total) * 100) / 100;
  return { total, landed, morphed, dropped, coverageRate };
}

const STATUS_ICON: Record<ReconStatus, string> = { landed: "✅", morphed: "⚠️", dropped: "❌" };
const STATUS_LABEL: Record<ReconStatus, string> = { landed: "落地", morphed: "变形", dropped: "漏" };

function renderRow(r: Row): string {
  const icon = STATUS_ICON[r.status];
  const parts = [`- ${icon} **${STATUS_LABEL[r.status]}**：${r.itemName}`];
  if (r.synthQuote) {
    const warn = r.quoteUnverified ? " ⚠️（此引用未在合成节逐字命中，可能是模型臆造）" : "";
    parts.push(`\n  > 合成节：${r.synthQuote}${warn}`);
  }
  if (r.note) parts.push(`\n  说明：${r.note}`);
  return parts.join("");
}

export function renderReportMd(rows: Row[], coverage: Coverage, verdict: string): string {
  const nonExercise = rows.filter((r) => r.category !== "exercise");
  const exercises = rows.filter((r) => r.category === "exercise");
  const lines: string[] = [];
  lines.push(`# Fidelity 审计报告`);
  lines.push(``);
  lines.push(`## 总评`);
  lines.push(verdict || "（无）");
  lines.push(``);
  lines.push(`## 覆盖率`);
  lines.push(
    `落地 ${coverage.landed}/${coverage.total}（${Math.round(coverage.coverageRate * 100)}%）` +
      ` · 变形 ${coverage.morphed} · 漏 ${coverage.dropped}`,
  );
  lines.push(``);
  lines.push(`## 知识点 / 评价标准 / 易错点 勾稽`);
  lines.push(nonExercise.length ? nonExercise.map(renderRow).join("\n") : "- 无");
  lines.push(``);
  lines.push(`## 教材原题勾稽`);
  lines.push(exercises.length ? exercises.map(renderRow).join("\n") : "- 无");
  lines.push(``);
  return lines.join("\n");
}

export function renderChecklistMd(c: Checklist): string {
  const lines: string[] = [`# 源材料结构化清单`, ``];
  lines.push(`## 知识点`);
  lines.push(c.knowledgePoints.length ? c.knowledgePoints.map((k) => `- **${k.name}**（${k.id}）\n  > ${k.sourceQuote}${k.note ? `\n  ${k.note}` : ""}`).join("\n") : "- 无");
  lines.push(``, `## 评价标准`);
  lines.push(c.assessmentCriteria.length ? c.assessmentCriteria.map((a) => `- ${a.desc}（${a.id}）\n  > ${a.sourceQuote}`).join("\n") : "- 无");
  lines.push(``, `## 教材原题`);
  lines.push(c.exercises.length ? c.exercises.map((e) => `- ${e.question}（${e.id}）\n  答案：${e.answer}\n  > ${e.sourceQuote}`).join("\n") : "- 无");
  lines.push(``, `## 易错点`);
  lines.push(c.errorSpots.length ? c.errorSpots.map((s) => `- ${s.desc}（${s.id}）\n  > ${s.sourceQuote}`).join("\n") : "- 无");
  lines.push(``);
  return lines.join("\n");
}

const MAX_LLM_ATTEMPTS = 2;

/** 抽清单：读源章 → LLM → 结构化 Checklist。解析失败重试 1 次。
 *  @param rulesFile 可选 prompt 文件名，默认 fidelity_extract.md（覆盖度审计可传不同 prompt）。 */
export async function extractChecklist(sourceText: string, signal: AbortSignal, rulesFile?: string): Promise<Checklist> {
  const rules = await readText(path.join(PROMPTS_ROOT, rulesFile ?? "fidelity_extract.md"));
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_LLM_ATTEMPTS; attempt++) {
    const raw = await callLLM(
      "audit",
      [
        { role: "system", content: rules },
        { role: "user", content: `## 源材料（本章）\n\n${sourceText}` },
      ],
      { jsonMode: true, temperature: 0.2, maxTokens: 4000, signal },
    );
    try {
      return parseChecklist(raw);
    } catch (e) {
      lastErr = e;
      if (signal.aborted) break;
    }
  }
  throw new Error(`Fidelity 抽清单失败：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

/** 勾稽：清单 + 合成节 → LLM → Row[]（含 verbatim 校验）+ verdict。解析失败重试 1 次。 */
export async function reconcile(
  checklist: Checklist,
  synthText: string,
  signal: AbortSignal,
): Promise<{ rows: Row[]; verdict: string }> {
  const rules = await readText(path.join(PROMPTS_ROOT, "fidelity_reconcile.md"));
  const user = [
    `## 源材料清单（JSON）`,
    JSON.stringify(checklist, null, 2),
    ``,
    `## 合成的教学蓝本（本节）`,
    synthText,
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
      const rows = verifyQuotes(parseReconciliation(raw), synthText);
      let verdict = "";
      try {
        const o = JSON.parse(raw) as { verdict?: unknown };
        if (o.verdict != null) verdict = String(o.verdict);
      } catch {
        /* verdict 可选，拿不到就空 */
      }
      return { rows, verdict };
    } catch (e) {
      lastErr = e;
      if (signal.aborted) break;
    }
  }
  throw new Error(`Fidelity 勾稽失败：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

export const FIDELITY_ROOT = path.join(DATA_ROOT, "fidelity");

export function newFid(): string {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `f-${ts}-${rand}`;
}

type FidelityMeta = {
  fid: string;
  sampleName?: string;
  model: string;
  independentEndpoint: boolean;
  startedAt: number;
  endedAt?: number;
  status: "running" | "done" | "errored";
  error?: string;
};

export async function runFidelity(
  sourceText: string,
  synthText: string,
  signal: AbortSignal,
  opts: { sampleName?: string } = {},
): Promise<FidelityResult> {
  const fid = newFid();
  const dir = path.join(FIDELITY_ROOT, fid);
  await ensureDir(dir);

  const independentEndpoint = !!process.env.LLM_AUDIT_BASE_URL;
  const model =
    process.env.LLM_AUDIT_MODEL || process.env.LLM_MODEL_AUDIT || process.env.LLM_MODEL || "";
  const meta: FidelityMeta = {
    fid,
    sampleName: opts.sampleName,
    model,
    independentEndpoint,
    startedAt: Date.now(),
    status: "running",
  };
  await writeAtomic(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));

  try {
    const checklist = await extractChecklist(sourceText, signal);
    await writeAtomic(path.join(dir, "checklist.json"), JSON.stringify(checklist, null, 2));

    const { rows, verdict: llmVerdict } = await reconcile(checklist, synthText, signal);
    const coverage = computeCoverage(rows);
    const verdict = llmVerdict || deriveVerdict(coverage);
    const reportJson = { rows, coverage, verdict };
    await writeAtomic(path.join(dir, "report.json"), JSON.stringify(reportJson, null, 2));
    await writeAtomic(path.join(dir, "report.md"), renderReportMd(rows, coverage, verdict));

    meta.status = "done";
    meta.endedAt = Date.now();
    await writeAtomic(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));

    return { fid, checklist, rows, coverage, verdict, dir };
  } catch (err) {
    meta.status = "errored";
    meta.endedAt = Date.now();
    meta.error = err instanceof Error ? err.message : String(err);
    await writeAtomic(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2)).catch(() => {});
    throw err;
  }
}

/** 覆盖率兜底 verdict（LLM 没给 verdict 时用）。 */
function deriveVerdict(cov: Coverage): string {
  if (cov.total === 0) return "无可勾稽条目。";
  const pct = Math.round(cov.coverageRate * 100);
  if (cov.dropped === 0 && cov.morphed === 0) return `保真度高：${cov.total} 条全部落地。`;
  if (cov.dropped === 0) return `保真度尚可：落地 ${pct}%，${cov.morphed} 条讲法有变形需人核。`;
  return `保真度存疑：${cov.dropped} 条漏、${cov.morphed} 条变形，落地率 ${pct}%。`;
}
