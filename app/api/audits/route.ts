import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { AUDITS_ROOT, runAudit, type AuditEvent, type AuditMeta, type AuditMode } from "@/lib/audit";
import { exists, readJson, readText } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();
function sseFrame(ev: AuditEvent): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(ev)}\n\n`);
}

const VALID_MODES: readonly AuditMode[] = ["book", "teaching", "playbook"];

type HistoryLine = {
  aid: string;
  bookSlug: string;
  sectionIds: string[];
  learnerIds?: string[];
  mode?: AuditMode;
  sidCount: number;
  verdict: string;
  ts: number;
};

/**
 * GET /api/audits?bookSlug=xxx
 *
 * 读 data/audits/history.jsonl，返回该书历史审计（按时间倒序）。
 * 老条目缺 learnerIds 时按需从对应 aid 的 meta.json 补——只做一次读，失败就留空。
 */
export async function GET(req: NextRequest) {
  const bookSlug = req.nextUrl.searchParams.get("bookSlug") || "";
  const historyPath = path.join(AUDITS_ROOT, "history.jsonl");
  if (!(await exists(historyPath))) {
    return NextResponse.json({ audits: [] });
  }
  const raw = await readText(historyPath);
  const lines = raw
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as HistoryLine;
      } catch {
        return null;
      }
    })
    .filter((x): x is HistoryLine => x !== null);

  const filtered = bookSlug ? lines.filter((l) => l.bookSlug === bookSlug) : lines;

  // 补 learnerIds / mode（老条目没写）——按需从 meta 读，失败就留空/兜底 book
  const enriched = await Promise.all(
    filtered.map(async (l) => {
      const needsLearners = !l.learnerIds || l.learnerIds.length === 0;
      const needsMode = !l.mode;
      if (!needsLearners && !needsMode) return l;
      try {
        const metaPath = path.join(AUDITS_ROOT, l.aid, "meta.json");
        if (await exists(metaPath)) {
          const meta = await readJson<AuditMeta>(metaPath);
          return {
            ...l,
            learnerIds:
              needsLearners && meta.learnerIds?.length
                ? meta.learnerIds
                : l.learnerIds ?? [],
            mode: needsMode ? meta.mode ?? "book" : l.mode!,
          };
        }
      } catch {
        // 忽略
      }
      return {
        ...l,
        learnerIds: l.learnerIds ?? [],
        mode: l.mode ?? ("book" as AuditMode),
      };
    }),
  );

  enriched.sort((a, b) => b.ts - a.ts);
  return NextResponse.json({ audits: enriched });
}

/** POST /api/audits { sids: string[] } → SSE 流 */
export async function POST(req: NextRequest) {
  let body: { sids?: string[]; mode?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), { status: 400 });
  }
  const sids = Array.isArray(body.sids) ? body.sids.filter((s) => typeof s === "string") : [];
  if (sids.length === 0) {
    return new Response(JSON.stringify({ error: "sids 必填且非空" }), { status: 400 });
  }
  const mode: AuditMode = (VALID_MODES as readonly string[]).includes(body.mode ?? "")
    ? (body.mode as AuditMode)
    : "book";

  const abortCtrl = new AbortController();
  req.signal.addEventListener("abort", () => abortCtrl.abort(), { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const ev of runAudit(sids, mode, abortCtrl.signal)) {
          controller.enqueue(sseFrame(ev));
          if (ev.type === "audit_done" || ev.type === "audit_error") break;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        controller.enqueue(sseFrame({ type: "audit_error", message }));
      } finally {
        controller.close();
      }
    },
    cancel() {
      abortCtrl.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
