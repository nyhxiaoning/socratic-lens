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
