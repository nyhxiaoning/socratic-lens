/**
 * 教师引用协议 verbatim 校验（STATUS.md #7）。
 *
 * 教师说 `〔§01｜前若干字〕`——"若干字"必须**逐字**出现在本节原文里。
 * 现在只在 prompt 铁律里约束；这里加服务端 includes() 兜底。
 *
 * 中文文本 verbatim 判断有一堆边界情况（全半角标点、多空白），我们做保守的**规范化**：
 * - 去掉所有空白（含全角空格、换行、tab）
 * - 全角标点 → 半角（部分常见）
 * - 大小写归一
 *
 * 命中意味着"教师说的这段文字，在原文规范化后能被找到"。
 * 未命中 → verbatim miss，审计要点。
 */

export type Citation = {
  /** 节 id，来自 〔§<id>｜...〕。 */
  sectionId: string;
  /** "｜"之后的引用片段，可能为空（教师只写了 §id 没写片段）。 */
  snippet: string;
  /** 命中 = 规范化后原文包含 snippet；空 snippet 视为 true（没什么可校验的）。 */
  hit: boolean;
};

const CITE_RE = /〔§([\w-]{1,32})(?:[｜|]([^〕\n]{0,120}))?〕/g;

/** 中文/英文文本做保守规范化，用于 verbatim 判断。 */
export function normalizeForMatch(s: string): string {
  return s
    // 常见全角标点 → 半角（顺序无所谓，全是 1:1 映射）
    .replace(/，/g, ",")
    .replace(/。/g, ".")
    .replace(/；/g, ";")
    .replace(/：/g, ":")
    .replace(/！/g, "!")
    .replace(/？/g, "?")
    .replace(/（/g, "(")
    .replace(/）/g, ")")
    .replace(/【/g, "[")
    .replace(/】/g, "]")
    .replace(/"/g, '"')
    .replace(/"/g, '"')
    .replace(/'/g, "'")
    .replace(/'/g, "'")
    .replace(/、/g, ",")
    .replace(/·/g, ".")
    // 全部空白（含全角空格 \u3000）→ 无
    .replace(/[\s\u3000]+/g, "")
    .toLowerCase();
}

/**
 * 从教师说的文本里提取所有引用。不做 verbatim 判断（那需要原文）。
 */
export function extractCitations(text: string): { sectionId: string; snippet: string }[] {
  const out: { sectionId: string; snippet: string }[] = [];
  const re = new RegExp(CITE_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ sectionId: m[1], snippet: (m[2] ?? "").trim() });
  }
  return out;
}

/** 判断 snippet 是否逐字在 sectionText 里出现（规范化后比对）。 */
export function verifyCitation(snippet: string, sectionText: string): boolean {
  if (!snippet) return true; // 教师没写具体片段，跳过
  const a = normalizeForMatch(snippet);
  if (a.length === 0) return true;
  const b = normalizeForMatch(sectionText);
  return b.includes(a);
}

/**
 * 比 normalizeForMatch 更激进的规范化——再去掉所有标点，只留字母数字和中文。
 * 用于模糊子串匹配（覆盖度追踪、知识点归页共用，保证口径一致）。
 */
export function fuzzyKey(s: string): string {
  return normalizeForMatch(s).replace(/[^\w一-鿿]/g, "");
}

/**
 * 一次校验：给教师本轮说的文本 + 本节原文，返回该轮所有引用的命中情况。
 * 只校验 sectionId 匹配当前节的引用；跨节引用（我们目前限制本节）也标记为 miss。
 */
export function verifyTurnCitations(
  teacherText: string,
  currentSectionId: string,
  sectionText: string,
): Citation[] {
  const cites = extractCitations(teacherText);
  return cites.map((c) => {
    if (c.sectionId !== currentSectionId) {
      // 引了别节的 id，铁律不允许 → miss
      return { sectionId: c.sectionId, snippet: c.snippet, hit: false };
    }
    return {
      sectionId: c.sectionId,
      snippet: c.snippet,
      hit: verifyCitation(c.snippet, sectionText),
    };
  });
}

/** 一批引用的命中统计。 */
export type CitationStats = { total: number; hit: number; miss: number };

export function aggregateCitations(records: { cites: Citation[] }[]): CitationStats {
  let total = 0;
  let hit = 0;
  for (const r of records) {
    for (const c of r.cites) {
      total++;
      if (c.hit) hit++;
    }
  }
  return { total, hit, miss: total - hit };
}
