/**
 * 实时覆盖度追踪。
 * 两层匹配：
 *   1. 字符串 fuzzy 匹配（引用标记 + 全文，零 LLM 成本）
 *   2. LLM 语义匹配（口语化表达兜底，捕捉字符串匹配漏掉的覆盖）
 */
import { extractCitations, fuzzyKey } from "./citations";
import { callLLM, type LLMUsage } from "./llm";
import type { Checklist, KnowledgePoint, Criterion, Exercise, ErrorSpot } from "./fidelity";
import { locateQuotePages, type Page } from "./pagination";

export type CoverageCategory = "knowledgePoint" | "criteria" | "exercise" | "errorSpot";

export type CoverageItem = {
  id: string;
  category: CoverageCategory;
  name: string;
  /** 清单项自身的引文片段，用于匹配教师引用。 */
  sourceQuote: string;
  status: "uncovered" | "covered";
  /** 命中的教师引用片段（用于 UI 展示）。 */
  evidence?: string;
  /** 哪一轮被首次覆盖。 */
  coveredAtTurn?: number;
  /**
   * 该知识点归属的页号（升序，允许多页）。空数组=无法定位到任何页。
   * undefined=尚未归页（本节未分页或未调用 assignPages）。见 §4.2。
   */
  pages?: number[];
};

const CATEGORY_LABEL: Record<CoverageCategory, string> = {
  knowledgePoint: "知识点",
  criteria: "评价标准",
  exercise: "原题",
  errorSpot: "易错点",
};

export function categoryLabel(c: CoverageCategory): string {
  return CATEGORY_LABEL[c];
}

function itemName(x: KnowledgePoint | Criterion | Exercise | ErrorSpot): string {
  if ("name" in x) return x.name;
  if ("question" in x) return x.question;
  return x.desc;
}

function toItems(
  list: (KnowledgePoint | Criterion | Exercise | ErrorSpot)[],
  category: CoverageCategory,
): CoverageItem[] {
  return list.map((x) => ({
    id: x.id,
    category,
    name: itemName(x),
    sourceQuote: x.sourceQuote ?? "",
    status: "uncovered" as const,
  }));
}

/** 从清单生成初始覆盖状态（全部 uncovered）。 */
export function initCoverageState(checklist: Checklist): CoverageItem[] {
  return [
    ...toItems(checklist.knowledgePoints, "knowledgePoint"),
    ...toItems(checklist.assessmentCriteria, "criteria"),
    ...toItems(checklist.exercises, "exercise"),
    ...toItems(checklist.errorSpots, "errorSpot"),
  ];
}

/**
 * 检查教师本轮发言里新覆盖了哪些清单项。
 * 两层匹配：
 *   1. 引用标记 `〔§id｜片段〕`（高置信，精确定位）
 *   2. 教师全文（兜底——教师没用引用标记时仍能追踪覆盖）
 * 返回更新后的 items 列表和新覆盖的 id 集合。
 */
export function updateCoverage(
  items: CoverageItem[],
  teacherText: string,
  turn: number,
): { items: CoverageItem[]; newlyCovered: string[] } {
  // 收集待匹配的文本片段
  const fragments: { text: string; source: "citation" | "fulltext" }[] = [];

  const citations = extractCitations(teacherText);
  for (const c of citations) {
    if (c.snippet) fragments.push({ text: c.snippet, source: "citation" });
  }
  // 兜底：始终用教师全文做一次粗匹配（捕捉没打引用标记但实际讲了的内容）
  fragments.push({ text: teacherText, source: "fulltext" });

  if (fragments.length === 0) return { items, newlyCovered: [] };

  const newlyCovered: string[] = [];
  const updated = items.map((item) => {
    if (item.status === "covered") return item;
    if (!item.sourceQuote) return item;

    const itemKey = fuzzyKey(item.sourceQuote);
    if (itemKey.length === 0) return item;

    for (const frag of fragments) {
      const fragKey = fuzzyKey(frag.text);
      if (fragKey.length === 0) continue;

      // 双向子串匹配
      if (itemKey.includes(fragKey) || fragKey.includes(itemKey)) {
        newlyCovered.push(item.id);
        const evidence =
          frag.source === "citation"
            ? frag.text
            : frag.text.length > 120
              ? frag.text.slice(0, 120) + "…"
              : frag.text;
        return {
          ...item,
          status: "covered" as const,
          evidence,
          coveredAtTurn: turn,
        };
      }
    }
    return item;
  });

  return { items: updated, newlyCovered };
}

/**
 * LLM 语义匹配：判断教师本轮发言覆盖了哪些尚未覆盖的清单项。
 * 用于捕捉口语化表达——教师用自己的话讲了一个知识点，但字符串匹配抓不到。
 *
 * 返回被覆盖的 item ID 数组。LLM 调用失败时返回空数组（静默降级）。
 */
export async function matchCoverageWithLLM(
  teacherText: string,
  uncovered: CoverageItem[],
  signal: AbortSignal,
  onUsage?: (u: LLMUsage) => void,
): Promise<string[]> {
  if (uncovered.length === 0) return [];

  const itemLines = uncovered.map((item) =>
    `${item.id} | ${item.name} | ${item.sourceQuote.slice(0, 80)}`,
  ).join("\n");

  const prompt = [
    "你是教学覆盖度判断器。你的任务是判断教师**本轮发言**是否**实质性地讲授了**清单中的某个条目。",
    "",
    "## 覆盖判据（必须全部满足才算覆盖）",
    "1. 教师**明确讲解或展示了**该条目的核心内容——学生听完后能理解这个点",
    "2. 教师不只是「提到一个相同的词」——词汇重叠不等于教学覆盖",
    "3. 知识点：教师必须讲到了该知识点的**规则/原理/用法**，不只是例句里恰好包含这个词",
    "4. 评价标准/易错点：教师必须**显式地讨论了**该标准或错误模式",
    "",
    "## 不算覆盖（常见误判，务必避免）",
    "- 教师说「a uniform」，清单里有「school uniform」→ **不算**（只是词重叠，教师没讲 school uniform 相关的内容）",
    "- 教师讲语法规则，清单里有另一个语法点 → **不算**（即使同属语法大类，必须是**同一个具体点**）",
    "- 教师的提问方向和某个条目有一点点方向上的关联 → **不算**",
    "- 教师说的话和某个条目「属于同一章」→ **不算**（必须具体到条目本身）",
    "",
    "## 教师本轮发言",
    teacherText,
    "",
    "## 待判断清单（格式：ID | 名称 | 引文片段）",
    itemLines,
    "",
    "## 输出格式",
    "每行一个 ID（如 kp1），只输出本轮**新覆盖**的条目。本轮没有覆盖任何条目则**只输出 NONE**。不要输出解释、不要输出 markdown、不要输出其他内容。",
    "",
    "## 重要提醒",
    "宁可漏判（把实际覆盖的判为未覆盖）也不要误判（把没覆盖的判为已覆盖）。本轮教师发言只涉及一个很小的知识点范围——大多数清单条目本轮都不会被覆盖。预期本轮命中的条目数应该很少（通常 0-3 个）。",
  ].join("\n");

  try {
    const raw = await callLLM("coach", [
      { role: "user", content: prompt },
    ], { signal, maxTokens: 200, onUsage });

    const ids = new Set(uncovered.map((i) => i.id));
    const matched: string[] = [];
    for (const line of raw.split("\n")) {
      const id = line.trim();
      if (id === "NONE" || id === "none") break;
      if (ids.has(id)) matched.push(id);
    }

    // 幻觉防护：单轮匹配超过 uncovered 的 30% 或超过 5 条，很可能是 LLM 误判，全部丢弃
    const MAX_MATCH_RATIO = 0.3;
    const MAX_MATCH_ABS = 5;
    if (matched.length > MAX_MATCH_ABS || matched.length > Math.ceil(uncovered.length * MAX_MATCH_RATIO)) {
      console.warn(`[coverage] LLM 返回 ${matched.length}/${uncovered.length} 个匹配，超过阈值，疑似幻觉，全部丢弃。IDs: ${matched.join(", ")}`);
      return [];
    }
    return matched;
  } catch {
    // LLM 调用失败 → 静默降级，不影响教学流程
    return [];
  }
}

/** 计算覆盖统计。 */
export function coverageStats(items: CoverageItem[]) {
  const total = items.length;
  const covered = items.filter((i) => i.status === "covered").length;
  const byCategory = new Map<CoverageCategory, { total: number; covered: number }>();
  for (const c of ["knowledgePoint", "criteria", "exercise", "errorSpot"] as CoverageCategory[]) {
    const catItems = items.filter((i) => i.category === c);
    byCategory.set(c, {
      total: catItems.length,
      covered: catItems.filter((i) => i.status === "covered").length,
    });
  }
  return { total, covered, byCategory };
}

// ============================================================================
// 归页 + 窗口覆盖占比（自适应翻页信号，见 _dev/WINDOW-SLIDE-REDESIGN.md §4）
// ============================================================================

/**
 * 给每个 CoverageItem 填 `pages`（该知识点归属的页号）。
 * 纯函数，不改状态位，只补归页信息。本节未分页时不应调用。
 */
export function assignPages(items: CoverageItem[], pages: Page[]): CoverageItem[] {
  return items.map((item) => ({
    ...item,
    pages: locateQuotePages(pages, item.sourceQuote),
  }));
}

/**
 * 当前窗口 [startPage, endPage] 的覆盖占比（翻页判据，见 §4.1 / §4.3）。
 *
 * 只统计 `pages` 与窗口有交集**且已成功归页**的项（`pages` 非空）。
 * 返回：
 *   - locatable：窗口内可定位的项数（分母，供降级判断——太少则不单独信占比）
 *   - covered：其中已 covered 的项数
 *   - ratio：covered / locatable（locatable=0 时为 0）
 */
export function windowCoveredRatio(
  items: CoverageItem[],
  startPage: number,
  endPage: number,
): { locatable: number; covered: number; ratio: number } {
  const inWindow = items.filter(
    (i) => i.pages != null && i.pages.some((p) => p >= startPage && p <= endPage),
  );
  const covered = inWindow.filter((i) => i.status === "covered").length;
  const locatable = inWindow.length;
  return { locatable, covered, ratio: locatable === 0 ? 0 : covered / locatable };
}
