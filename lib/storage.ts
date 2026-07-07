import fs from "node:fs/promises";
import path from "node:path";

export const DATA_ROOT = path.join(process.cwd(), "data");
export const BOOKS_ROOT = path.join(DATA_ROOT, "books");
export const SESSIONS_ROOT = path.join(DATA_ROOT, "sessions");
export const PROMPTS_ROOT = path.join(process.cwd(), "prompts");

export async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

export async function readText(p: string): Promise<string> {
  return await fs.readFile(p, "utf-8");
}

export async function readJson<T = unknown>(p: string): Promise<T> {
  const raw = await fs.readFile(p, "utf-8");
  return JSON.parse(raw) as T;
}

/** 原子写：先写 .tmp 再 rename。避免半个文件被读到。 */
export async function writeAtomic(p: string, content: string): Promise<void> {
  await ensureDir(path.dirname(p));
  const tmp = `${p}.tmp`;
  await fs.writeFile(tmp, content, "utf-8");
  await fs.rename(tmp, p);
}

/** 追加一行（用于 transcript.jsonl）。不原子——短消息、磁盘 append 单次 syscall 通常够。 */
export async function appendLine(p: string, line: string): Promise<void> {
  await ensureDir(path.dirname(p));
  await fs.appendFile(p, line.endsWith("\n") ? line : line + "\n", "utf-8");
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function listDir(p: string): Promise<string[]> {
  try {
    return await fs.readdir(p);
  } catch {
    return [];
  }
}
