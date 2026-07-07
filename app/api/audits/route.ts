import { NextRequest } from "next/server";
import { runAudit, type AuditEvent } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();
function sseFrame(ev: AuditEvent): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(ev)}\n\n`);
}

/** POST /api/audits { sids: string[] } → SSE 流 */
export async function POST(req: NextRequest) {
  let body: { sids?: string[] };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), { status: 400 });
  }
  const sids = Array.isArray(body.sids) ? body.sids.filter((s) => typeof s === "string") : [];
  if (sids.length === 0) {
    return new Response(JSON.stringify({ error: "sids 必填且非空" }), { status: 400 });
  }

  const abortCtrl = new AbortController();
  req.signal.addEventListener("abort", () => abortCtrl.abort(), { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const ev of runAudit(sids, abortCtrl.signal)) {
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
