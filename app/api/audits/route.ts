import { NextRequest, NextResponse } from "next/server";
import { runAudit, runFidelityAudit, runCoverageAudit, listAuditHistory, type AuditEvent, type AuditDimension } from "@/lib/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();
function sseFrame(ev: AuditEvent): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(ev)}\n\n`);
}

/** GET /api/audits?bookSlug=xxx → 该书的审计历史（倒序）。 */
export async function GET(req: NextRequest) {
  const bookSlug = req.nextUrl.searchParams.get("bookSlug") || undefined;
  const items = await listAuditHistory(bookSlug);
  return NextResponse.json({ audits: items });
}

function sseResponse(
  stream: ReadableStream<Uint8Array>,
): Response {
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

/** POST /api/audits { sids, dimension, sampleName } → SSE 流 */
export async function POST(req: NextRequest) {
  let body: { sids?: string[]; dimension?: string; sampleName?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), { status: 400 });
  }

  const dimension: AuditDimension =
    body.dimension === "teacher" ? "teacher"
    : body.dimension === "fidelity" ? "fidelity"
    : body.dimension === "coverage" ? "coverage"
    : "book";

  // fidelity：sampleName only
  if (dimension === "fidelity") {
    if (!body.sampleName) {
      return new Response(JSON.stringify({ error: "fidelity 审计需要 sampleName" }), { status: 400 });
    }
    const abortCtrl = new AbortController();
    req.signal.addEventListener("abort", () => abortCtrl.abort(), { once: true });
    return sseResponse(new ReadableStream({
      async start(controller) {
        try {
          for await (const ev of runFidelityAudit(body.sampleName!, abortCtrl.signal)) {
            controller.enqueue(sseFrame(ev));
            if (ev.type === "audit_done" || ev.type === "audit_error") break;
          }
        } catch (err) {
          controller.enqueue(sseFrame({ type: "audit_error", message: err instanceof Error ? err.message : String(err) }));
        } finally { controller.close(); }
      },
      cancel() { abortCtrl.abort(); },
    }));
  }

  // coverage：sids + optional sampleName
  if (dimension === "coverage") {
    const sids = Array.isArray(body.sids) ? body.sids.filter((s) => typeof s === "string") : [];
    if (sids.length === 0) {
      return new Response(JSON.stringify({ error: "coverage 审计需要至少一个 sids" }), { status: 400 });
    }
    const abortCtrl = new AbortController();
    req.signal.addEventListener("abort", () => abortCtrl.abort(), { once: true });
    return sseResponse(new ReadableStream({
      async start(controller) {
        try {
          for await (const ev of runCoverageAudit(sids, abortCtrl.signal, body.sampleName)) {
            controller.enqueue(sseFrame(ev));
            if (ev.type === "audit_done" || ev.type === "audit_error") break;
          }
        } catch (err) {
          controller.enqueue(sseFrame({ type: "audit_error", message: err instanceof Error ? err.message : String(err) }));
        } finally { controller.close(); }
      },
      cancel() { abortCtrl.abort(); },
    }));
  }

  // book / teacher：sids only
  const sids = Array.isArray(body.sids) ? body.sids.filter((s) => typeof s === "string") : [];
  if (sids.length === 0) {
    return new Response(JSON.stringify({ error: "sids 必填且非空" }), { status: 400 });
  }
  const abortCtrl = new AbortController();
  req.signal.addEventListener("abort", () => abortCtrl.abort(), { once: true });
  return sseResponse(new ReadableStream({
    async start(controller) {
      try {
        for await (const ev of runAudit(sids, abortCtrl.signal, dimension)) {
          controller.enqueue(sseFrame(ev));
          if (ev.type === "audit_done" || ev.type === "audit_error") break;
        }
      } catch (err) {
        controller.enqueue(sseFrame({ type: "audit_error", message: err instanceof Error ? err.message : String(err) }));
      } finally { controller.close(); }
    },
    cancel() { abortCtrl.abort(); },
  }));
}
