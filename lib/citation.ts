/**
 * 教师引用 `〔§<id>｜<原文片段>〕` 的 verbatim 校验。
 *
 * 参考 Socratopia 模式 #5（manifest-based 反幻觉）：引用是否逐字来自原文，
 * 服务端可判——不该全靠 prompt 铁律 + 人工审。
 *
 * 判据：
 *   - snippet 里的 `……` / `...` / `…` 表示中间省略，切成多个片段
 *   - 每个片段必须**逐字**、**按出现顺序**出现在本节原文里
 *   - 匹配时忽略空白差异（全角/半角空格、换行），但保留标点和字
 *
 * verdict：
 *   - "verbatim"   全部片段按序命中
 *   - "partial"    部分命中（片段存在但顺序错，或只命中一部分）
 *   - "fabricated" 一个片段都没命中
 *   - "wrong_section" 引用的 §id 不是它所在会话被讲的那一节（调用方判，本模块只按传入原文核）
 */

export type Citation = {
  /** 原始标记全文，如 〔§01｜以往的哲学家……问题在于改变世界〕 */
  marker: string;
  sectionId: string;
  snippet: string;
  turn: number;
  actor: "teacher" | "learner";
};

export type CitationVerdict = {
  citation: Citation;
  verdict: "verbatim" | "partial" | "fabricated";
  /** 命中的片段数 / 总片段数 */
  matchedFragments: number;
  totalFragments: number;
};

const MARKER_RE = /〔§(\d{1,4})[｜|]([^〕\n]{1,200})〕/g;

/** 从一段文本里抽出所有引用标记。 */
export function extractCitations(
  text: string,
  turn: number,
  actor: "teacher" | "learner",
): Citation[] {
  const out: Citation[] = [];
  for (const m of text.matchAll(MARKER_RE)) {
    out.push({
      marker: m[0],
      sectionId: m[1],
      snippet: m[2].trim(),
      turn,
      actor,
    });
  }
  return out;
}

/** 去掉所有空白字符（含全角空格），用于宽松逐字比对。 */
function stripWhitespace(s: string): string {
  return s.replace(/[\s　]/g, "");
}

/** 按省略号把 snippet 切成必须逐字命中的片段。 */
function splitFragments(snippet: string): string[] {
  return snippet
    .split(/…{1,}|\.{3,}/)
    .map((f) => stripWhitespace(f))
    .filter((f) => f.length > 0);
}

/**
 * 核验一条引用是否逐字来自给定原文。
 * sectionText 应是该引用 §id 对应的本节原文。
 */
export function verifyCitation(citation: Citation, sectionText: string): CitationVerdict {
  const haystack = stripWhitespace(sectionText);
  const fragments = splitFragments(citation.snippet);
  const total = fragments.length;

  if (total === 0) {
    return { citation, verdict: "fabricated", matchedFragments: 0, totalFragments: 0 };
  }

  // 按序匹配：每个片段必须在上一个片段之后出现
  let cursor = 0;
  let matched = 0;
  let inOrder = true;
  for (const frag of fragments) {
    const idx = haystack.indexOf(frag, cursor);
    if (idx === -1) {
      // 顺序位后没找到——试试全局有没有（用于区分 partial vs fabricated）
      if (haystack.includes(frag)) {
        matched++;
        inOrder = false;
      }
      continue;
    }
    matched++;
    cursor = idx + frag.length;
  }

  let verdict: CitationVerdict["verdict"];
  if (matched === 0) verdict = "fabricated";
  else if (matched === total && inOrder) verdict = "verbatim";
  else verdict = "partial";

  return { citation, verdict, matchedFragments: matched, totalFragments: total };
}

/**
 * 给一节的所有 turns 核验引用，产出一份台账文本，供审计 LLM 直接引用（不必再人肉核验）。
 * sectionId 是本节 id，sectionText 是本节原文。
 * 只核验 §id === 本节 的引用；引用了别节的单独标出。
 */
export function buildCitationLedger(
  sectionId: string,
  sectionText: string,
  turns: { turn: number; actor: "teacher" | "learner"; text: string }[],
): {
  ledgerText: string;
  stats: { total: number; verbatim: number; partial: number; fabricated: number; wrongSection: number };
} {
  const stats = { total: 0, verbatim: 0, partial: 0, fabricated: 0, wrongSection: 0 };
  const lines: string[] = [];

  for (const t of turns) {
    if (t.actor !== "teacher") continue; // 只核教师引用
    const citations = extractCitations(t.text, t.turn, t.actor);
    for (const c of citations) {
      stats.total++;
      if (c.sectionId !== sectionId) {
        stats.wrongSection++;
        lines.push(
          `- 第 ${c.turn} 轮 ${c.marker} → **引错节**（标 §${c.sectionId}，但本节是 §${sectionId}）`,
        );
        continue;
      }
      const v = verifyCitation(c, sectionText);
      const label =
        v.verdict === "verbatim"
          ? "✓ 逐字命中"
          : v.verdict === "partial"
            ? `△ 部分命中（${v.matchedFragments}/${v.totalFragments} 片段，或顺序不符）`
            : "✗ 原文中查无此句（疑伪造）";
      if (v.verdict === "verbatim") stats.verbatim++;
      else if (v.verdict === "partial") stats.partial++;
      else stats.fabricated++;
      lines.push(`- 第 ${c.turn} 轮 ${c.marker} → ${label}`);
    }
  }

  if (lines.length === 0) {
    return { ledgerText: "（本节教师未产生任何 〔§…〕 引用）", stats };
  }

  const summary = `共 ${stats.total} 处引用：${stats.verbatim} 逐字命中 / ${stats.partial} 部分命中 / ${stats.fabricated} 疑伪造 / ${stats.wrongSection} 引错节。`;
  return { ledgerText: summary + "\n" + lines.join("\n"), stats };
}
