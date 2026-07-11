import path from "node:path";
import { BOOKS_ROOT, exists, writeAtomic } from "./storage";
import type { SectionMeta } from "./book";
import type { ParsedSection } from "./parse-book";

// 纯解析逻辑在 parse-book.ts（无 node 依赖，前端也能 import）。这里只放落盘相关。
export { parseMarkdownToBook } from "./parse-book";
export type { ParsedSection, ParsedBook } from "./parse-book";

/** 落盘一本书：manifest.json + sections/<id>.md。调用方需先确保 slug 不存在。 */
export async function writeBook(
  slug: string,
  title: string,
  author: string | undefined,
  sections: ParsedSection[],
): Promise<void> {
  for (const s of sections) {
    await writeAtomic(path.join(BOOKS_ROOT, slug, "sections", `${s.id}.md`), s.body);
  }
  const manifestSections: SectionMeta[] = sections.map((s) => ({ id: s.id, title: s.title }));
  const manifest = { title, author: author || undefined, sections: manifestSections };
  await writeAtomic(
    path.join(BOOKS_ROOT, slug, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
}

/** slug 是否已存在（有 manifest.json 即视为占用）。 */
export async function bookExists(slug: string): Promise<boolean> {
  return await exists(path.join(BOOKS_ROOT, slug, "manifest.json"));
}
