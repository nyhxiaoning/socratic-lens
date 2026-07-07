import path from "node:path";
import { BOOKS_ROOT, exists, listDir, readJson, readText } from "./storage";

export type SectionMeta = { id: string; title: string };
export type BookManifest = {
  title: string;
  author?: string;
  sections: SectionMeta[];
};

export type BookSummary = { slug: string; title: string; author?: string; sectionCount: number };

/** 列出 data/books/ 下所有含 manifest.json 的书。 */
export async function listBooks(): Promise<BookSummary[]> {
  const slugs = await listDir(BOOKS_ROOT);
  const out: BookSummary[] = [];
  for (const slug of slugs) {
    const manifestPath = path.join(BOOKS_ROOT, slug, "manifest.json");
    if (!(await exists(manifestPath))) continue;
    try {
      const m = await readJson<BookManifest>(manifestPath);
      out.push({
        slug,
        title: m.title,
        author: m.author,
        sectionCount: m.sections?.length ?? 0,
      });
    } catch {
      // 忽略坏 manifest
    }
  }
  return out;
}

export async function getBook(slug: string): Promise<BookManifest> {
  return await readJson<BookManifest>(path.join(BOOKS_ROOT, slug, "manifest.json"));
}

/** 读某一节原文。找不到抛错。 */
export async function getSection(slug: string, sectionId: string): Promise<string> {
  const p = path.join(BOOKS_ROOT, slug, "sections", `${sectionId}.md`);
  return await readText(p);
}

export function getSectionTitle(book: BookManifest, sectionId: string): string {
  return book.sections.find((s) => s.id === sectionId)?.title ?? sectionId;
}
