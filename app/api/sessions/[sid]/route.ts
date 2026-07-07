import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { readJson, readText, SESSIONS_ROOT, exists } from "@/lib/storage";
import type { SessionMeta } from "@/lib/session";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ sid: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { sid } = await ctx.params;
  const dir = path.join(SESSIONS_ROOT, sid);
  if (!(await exists(dir))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const meta = await readJson<SessionMeta>(path.join(dir, "meta.json"));
  const transcriptPath = path.join(dir, "transcript.jsonl");
  const raw = (await exists(transcriptPath)) ? await readText(transcriptPath) : "";
  const turns = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return NextResponse.json({ meta, turns });
}
