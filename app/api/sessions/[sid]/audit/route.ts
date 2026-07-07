import { NextRequest } from "next/server";
import { readAudit, runAudit, type AuditEvent } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sid: string }> };

const encoder = new TextEncoder();
function sseFrame(ev: AuditEvent): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(ev)}\n\n`);
}

/** GET：如果有已存的报告则返回，没有 → 404。 */
export async function GET(_req: NextRequest, ctx: Ctx) {
  const { sid } = await ctx.params;
  const report = await readAudit(sid);
  if (!report) {
    return new Response(JSON.stringify({ error: "no audit yet" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  return new Response(JSON.stringify({ report }), {
    headers: { "Content-Type": "application/json" },
  });
}

/** POST：跑一次审计，SSE 流。 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const { sid } = await ctx.params;
  const abortCtrl = new AbortController();
  req.signal.addEventListener("abort", () => abortCtrl.abort(), { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const ev of runAudit(sid, abortCtrl.signal)) {
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
