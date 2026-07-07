import { NextRequest } from "next/server";
import { runSession, type SessionEvent } from "@/lib/session";
import type { LearnerId, Pacing } from "@/lib/teacher";

export const runtime = "nodejs";
// Node fetch/SSE 需要长连接；禁用静态优化
export const dynamic = "force-dynamic";

type StartBody = {
  bookSlug: string;
  sectionId: string;
  learnerId: LearnerId;
  pacing?: Pacing;
  coachEnabled?: boolean;
  maxTurns?: number;
};

const encoder = new TextEncoder();
function sseFrame(event: SessionEvent): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function POST(req: NextRequest) {
  let body: StartBody;
  try {
    body = (await req.json()) as StartBody;
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), { status: 400 });
  }

  if (!body.bookSlug || !body.sectionId || !body.learnerId) {
    return new Response(
      JSON.stringify({ error: "bookSlug / sectionId / learnerId 必填" }),
      { status: 400 },
    );
  }

  const maxTurns = Math.min(Math.max(body.maxTurns ?? 8, 1), 30);
  const pacing: Pacing = body.pacing === "thorough" || body.pacing === "express" ? body.pacing : "normal";
  const coachEnabled = body.coachEnabled !== false; // 默认开
  const abortCtrl = new AbortController();
  // 前端断开时中止 LLM 调用
  req.signal.addEventListener("abort", () => abortCtrl.abort(), { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of runSession({
          bookSlug: body.bookSlug,
          sectionId: body.sectionId,
          learnerId: body.learnerId,
          pacing,
          coachEnabled,
          maxTurns,
          signal: abortCtrl.signal,
        })) {
          controller.enqueue(sseFrame(event));
          if (event.type === "done" || event.type === "error") break;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        controller.enqueue(sseFrame({ type: "error", message: msg }));
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
