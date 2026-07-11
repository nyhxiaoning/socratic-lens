/**
 * 纯解析：把一本书的 markdown 按"节"切分。**无任何 node 依赖**，
 * 因此前端预览和后端落盘可以共用同一份逻辑，保证"预览所见 = 入库所得"。
 * 逻辑取自 scripts/import-mineru.mjs。
 *
 * 边界识别：`## 导论` / `## 第X章 ...` / `## 第X节 ...`
 * - 章标题只用来标注归属（section.title 前缀），不单独成节
 * - 导论、各节成为 section
 */
export type ParsedSection = { id: string; title: string; body: string };
export type ParsedBook = {
  sections: ParsedSection[];
  /** 从 markdown 的 `# 一级标题` 猜的书名（可能为空）。 */
  suggestedTitle: string;
};

/** 删图片引用、营销广告、折叠多余空行。 */
function clean(text: string): string {
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  text = text.replace(/后续关注公众号\[?研大\]?永久微信\d+图书在版编目.*$/gm, "");
  text = text.replace(/^\s*永久微信\d+\s*$/gm, "");
  text = text.replace(/^## 永久微信\d+\s*$/gm, "");
  text = text.replace(/后续关注公众号\[?研大\]?永久微信\d+\s*/g, "");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim() + "\n";
}

export function parseMarkdownToBook(raw: string): ParsedBook {
  const lines = raw.split("\n");

  type Boundary = { lineIdx: number; kind: "intro" | "chapter" | "section"; text: string };
  const boundaries: Boundary[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith("## ")) continue;
    const t = line.slice(3).trim();
    if (t === "导论") {
      boundaries.push({ lineIdx: i, kind: "intro", text: "导论" });
    } else if (/^第[一二三四五六七八九十]+章\s/.test(t)) {
      boundaries.push({ lineIdx: i, kind: "chapter", text: t });
    } else if (/^第[一二三四五六七八九十]+节\s/.test(t)) {
      boundaries.push({ lineIdx: i, kind: "section", text: t });
    }
  }

  const cutPoints = boundaries.map((b, idx, arr) => ({
    ...b,
    nextLineIdx: arr[idx + 1]?.lineIdx ?? lines.length,
  }));

  const sections: ParsedSection[] = [];
  let currentChapter: string | null = null;
  let seq = 0;
  for (const cp of cutPoints) {
    if (cp.kind === "chapter") {
      currentChapter = cp.text;
      continue;
    }
    seq++;
    const id = String(seq).padStart(2, "0");
    const title = cp.kind === "section" && currentChapter ? `${currentChapter}｜${cp.text}` : cp.text;
    const body = clean(lines.slice(cp.lineIdx, cp.nextLineIdx).join("\n"));
    sections.push({ id, title, body });
  }

  const m = raw.match(/^#\s+(.+)$/m);
  const suggestedTitle = m ? m[1].trim().replace(/\s+/g, "") : "";

  return { sections, suggestedTitle };
}
