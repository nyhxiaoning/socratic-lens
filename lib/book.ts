import path from "node:path";
import fs from "node:fs/promises";
import {
  paginate,
  PAGINATION_THRESHOLD,
  type Page,
} from "./pagination";
import { BOOKS_ROOT, exists, listDir, readJson, readText, writeAtomic } from "./storage";

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

// ============================================================================
// 分页（自适应翻页）
// ============================================================================

function pagesCachePath(slug: string, sectionId: string): string {
  return path.join(BOOKS_ROOT, slug, "sections", `${sectionId}.pages.json`);
}

/**
 * 拿一节的分页信息。若原文长度 < 阈值 → 返回 null（不分页，直接全塞）。
 * 首次读会写盘缓存 sections/<id>.pages.json，下次直接读缓存。
 */
export async function getPages(slug: string, sectionId: string): Promise<Page[] | null> {
  const text = await getSection(slug, sectionId);
  if (text.length < PAGINATION_THRESHOLD) return null;

  const cachePath = pagesCachePath(slug, sectionId);
  if (await exists(cachePath)) {
    try {
      const cached = await readJson<{ chars: number; pages: Page[] }>(cachePath);
      // 缓存有效性检验：原文字符数与缓存一致才用
      if (cached.chars === text.length && Array.isArray(cached.pages) && cached.pages.length > 0) {
        return cached.pages;
      }
    } catch {
      // 缓存坏了，重新算
    }
  }

  const pages = paginate(text);
  await writeAtomic(cachePath, JSON.stringify({ chars: text.length, pages }, null, 2));
  return pages;
}
