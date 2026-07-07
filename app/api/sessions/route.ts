import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { exists, listDir, readJson, SESSIONS_ROOT } from "@/lib/storage";
import type { SessionMeta } from "@/lib/session";

export const runtime = "nodejs";

/** GET /api/sessions?bookSlug=xxx → 列该书的所有会话 meta（按开始时间倒序） */
export async function GET(req: NextRequest) {
  const bookSlug = req.nextUrl.searchParams.get("bookSlug");
  const sids = await listDir(SESSIONS_ROOT);
  const metas: SessionMeta[] = [];
  for (const sid of sids) {
    const p = path.join(SESSIONS_ROOT, sid, "meta.json");
    if (!(await exists(p))) continue;
    try {
      const m = await readJson<SessionMeta>(p);
      if (bookSlug && m.bookSlug !== bookSlug) continue;
      metas.push(m);
    } catch {
      // 跳过坏文件
    }
  }
  metas.sort((a, b) => b.startedAt - a.startedAt);
  return NextResponse.json({ sessions: metas });
}
