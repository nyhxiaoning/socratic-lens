import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { readJson, readText, SESSIONS_ROOT, exists } from "@/lib/storage";
import type { SessionMeta } from "@/lib/session";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ sid: string }> };

async function loadJsonl<T>(p: string): Promise<T[]> {
  if (!(await exists(p))) return [];
  const raw = await readText(p);
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as T;
      } catch {
        return null;
      }
    })
    .filter((x): x is T => x !== null);
}

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { sid } = await ctx.params;
  const dir = path.join(SESSIONS_ROOT, sid);
  if (!(await exists(dir))) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const meta = await readJson<SessionMeta>(path.join(dir, "meta.json"));
  const turns = await loadJsonl<{ turn: number; actor: string; text: string; ts: number }>(
    path.join(dir, "transcript.jsonl"),
  );
  const teacherCoach = await loadJsonl<{ turn: number; ts: number; analysis: unknown }>(
    path.join(dir, "coach.jsonl"),
  );
  const learnerCoach = await loadJsonl<{ turn: number; ts: number; analysis: unknown }>(
    path.join(dir, "learner_coach.jsonl"),
  );
  return NextResponse.json({ meta, turns, teacherCoach, learnerCoach });
}
