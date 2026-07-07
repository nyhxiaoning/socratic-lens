import path from "node:path";
import fs from "node:fs/promises";
import { BOOKS_ROOT, exists, listDir, readJson, readText } from "./storage";

export type SectionMeta = { id: string; title: string };
export type BookManifest = {
  title: string;
  author?: string;
  sections: SectionMeta[];
};

/** 一节的字数（去掉 markdown 标记后的近似字符数）。 */
export type SectionStat = SectionMeta & { chars: number };

export type BookSummary = {
  slug: string;
  title: string;
  author?: string;
  sectionCount: number;
  /** 全书字数（近似） */
  totalChars: number;
  sections: SectionStat[];
};

/** 列出 data/books/ 下所有含 manifest.json 的书。 */
export async function listBooks(): Promise<BookSummary[]> {
  const slugs = await listDir(BOOKS_ROOT);
  const out: BookSummary[] = [];
  for (const slug of slugs) {
    const manifestPath = path.join(BOOKS_ROOT, slug, "manifest.json");
    if (!(await exists(manifestPath))) continue;
    try {
      const m = await readJson<BookManifest>(manifestPath);
      const sections: SectionStat[] = [];
      let total = 0;
      for (const s of m.sections ?? []) {
        const p = path.join(BOOKS_ROOT, slug, "sections", `${s.id}.md`);
        let chars = 0;
        try {
          const st = await fs.stat(p);
          // md 里主要是 utf-8 中文，一个中文占 3 字节；用字节数 / 3 近似字符数
          chars = Math.round(st.size / 3);
        } catch {
          // 缺文件就当 0
        }
        sections.push({ id: s.id, title: s.title, chars });
        total += chars;
      }
      out.push({
        slug,
        title: m.title,
        author: m.author,
        sectionCount: sections.length,
        totalChars: total,
        sections,
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
