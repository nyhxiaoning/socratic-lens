// @ts-check
/**
 * 把 MinerU 输出的 full.md 按"节"切分导入到 data/books/<slug>/ 下。
 *
 * 用法：
 *   node scripts/import-mineru.mjs <full.md 路径> <书 slug> [书名] [作者]
 *
 * 示例：
 *   node scripts/import-mineru.mjs "s:/Code/工作探索/备考书/_mineru_work/md/textbook_631_part1/full.md" makesi "马克思主义基本原理（2023 年版）" "本书编写组"
 */

import fs from "node:fs/promises";
import path from "node:path";

// -------- args --------
const [, , sourcePath, slug, providedTitle, providedAuthor] = process.argv;
if (!sourcePath || !slug) {
  console.error("用法: node scripts/import-mineru.mjs <full.md> <slug> [title] [author]");
  process.exit(1);
}

const CWD = process.cwd();
const outDir = path.join(CWD, "data", "books", slug);
const sectionsDir = path.join(outDir, "sections");

// -------- read --------
const raw = await fs.readFile(sourcePath, "utf-8");
const lines = raw.split("\n");

// -------- 找边界 --------
// 支持："## 导论" / "## 第X章 ..." / "## 第X节 ..."
// 章一级用于标注 section 的归属；只有节和导论会真正成为 section
/** @type {{ lineIdx: number; kind: "intro"|"chapter"|"section"; text: string }[]} */
const boundaries = [];
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

if (boundaries.length === 0) {
  console.error("没找到任何 ## 导论 / ## 第X章 / ## 第X节 边界，脚本可能不适用这本书");
  process.exit(1);
}

// -------- 构造 section 列表 --------
// 每个 section 从自己那行 起，到"下一个 章或节 或 导论 或 文件末尾"之前一行 止
/** @type {{ id: string; title: string; chapter: string|null; startLine: number; endLine: number }[]} */
const sections = [];
let currentChapter = null;
let seq = 0;

// 找出"真正的 section 边界"（导论 + 各节），忽略章标题——章标题只用来更新 currentChapter
// 但章标题也应该结束前一 section
const cutPoints = boundaries
  .filter((b) => b.kind === "intro" || b.kind === "chapter" || b.kind === "section")
  .map((b, idx, arr) => ({
    ...b,
    nextLineIdx: arr[idx + 1]?.lineIdx ?? lines.length,
  }));

for (const cp of cutPoints) {
  if (cp.kind === "chapter") {
    currentChapter = cp.text;
    continue; // 章标题不生成 section
  }
  seq++;
  const id = String(seq).padStart(2, "0");
  sections.push({
    id,
    title: cp.text,
    chapter: cp.kind === "section" ? currentChapter : null,
    startLine: cp.lineIdx,
    endLine: cp.nextLineIdx,
  });
}

// -------- 清洗每段 --------
function clean(text) {
  // 删所有 markdown 图片引用（可能带 alt 文本）
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  // 删营销广告
  text = text.replace(/后续关注公众号\[?研大\]?永久微信\d+图书在版编目.*$/gm, "");
  text = text.replace(/^\s*永久微信\d+\s*$/gm, "");
  text = text.replace(/^## 永久微信\d+\s*$/gm, "");
  text = text.replace(/后续关注公众号\[?研大\]?永久微信\d+\s*/g, "");
  // 折叠多余空行（3+ 行 → 2 行）
  text = text.replace(/\n{3,}/g, "\n\n");
  // 首尾空白
  return text.trim() + "\n";
}

// -------- 写盘 --------
await fs.mkdir(sectionsDir, { recursive: true });
const manifestSections = [];

for (const s of sections) {
  const body = lines.slice(s.startLine, s.endLine).join("\n");
  const cleaned = clean(body);
  const outPath = path.join(sectionsDir, `${s.id}.md`);
  await fs.writeFile(outPath, cleaned, "utf-8");
  manifestSections.push({
    id: s.id,
    title: s.chapter ? `${s.chapter}｜${s.title}` : s.title,
  });
  console.log(`  §${s.id}  ${manifestSections[manifestSections.length - 1].title}  (${cleaned.length} 字)`);
}

// -------- 写 manifest --------
// 尝试从 markdown 里找书名
let bookTitle = providedTitle;
if (!bookTitle) {
  const m = raw.match(/^#\s+(.+)$/m);
  bookTitle = m ? m[1].trim().replace(/\s+/g, "") : slug;
}
const manifest = {
  title: bookTitle,
  author: providedAuthor || undefined,
  sections: manifestSections,
};
await fs.writeFile(
  path.join(outDir, "manifest.json"),
  JSON.stringify(manifest, null, 2),
  "utf-8",
);

console.log("");
console.log(`✓ 导入完成：${outDir}`);
console.log(`  共 ${manifestSections.length} 节`);
