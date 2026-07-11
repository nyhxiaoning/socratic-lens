/**
 * 知识点清单缓存。
 * data/checklists/<slug>/<sectionId>.json — 预生成的教学内容清单，供覆盖度审计复用。
 *
 * 目标：同一节的所有审计用同一份 checklist，结果可比、可检视。
 */
import path from "node:path";
import { DATA_ROOT, ensureDir, exists, listDir, readJson, writeAtomic } from "./storage";
import { extractChecklist, type Checklist } from "./fidelity";

export const CHECKLISTS_ROOT = path.join(DATA_ROOT, "checklists");

export function checklistPath(bookSlug: string, sectionId: string): string {
  return path.join(CHECKLISTS_ROOT, bookSlug, `${sectionId}.json`);
}

/** 读缓存。不存在返回 null。 */
export async function getChecklist(
  bookSlug: string,
  sectionId: string,
): Promise<Checklist | null> {
  const p = checklistPath(bookSlug, sectionId);
  if (!(await exists(p))) return null;
  return readJson<Checklist>(p);
}

/** 写缓存。 */
export async function saveChecklist(
  bookSlug: string,
  sectionId: string,
  checklist: Checklist,
): Promise<void> {
  await ensureDir(path.dirname(checklistPath(bookSlug, sectionId)));
  await writeAtomic(checklistPath(bookSlug, sectionId), JSON.stringify(checklist, null, 2));
}

/** 列出某本书已有缓存的节。返回 sectionId 集合。 */
export async function listExistingChecklists(
  bookSlug: string,
): Promise<Set<string>> {
  const dir = path.join(CHECKLISTS_ROOT, bookSlug);
  const files = await listDir(dir);
  const result = new Set<string>();
  for (const f of files) {
    if (f.endsWith(".json")) result.add(f.replace(/\.json$/, ""));
  }
  return result;
}

/** 生成+缓存一条清单。返回 checklist。 */
export async function generateChecklist(
  bookSlug: string,
  sectionId: string,
  sectionText: string,
  signal: AbortSignal,
): Promise<Checklist> {
  const checklist = await extractChecklist(sectionText, signal);
  await saveChecklist(bookSlug, sectionId, checklist);
  return checklist;
}
