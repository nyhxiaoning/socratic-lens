import { NextRequest } from "next/server";
import { reconcileOnStartup, runSession, type SessionEvent } from "@/lib/session";
import type { LearnerId, Pacing, TeachingMode } from "@/lib/teacher";

export const runtime = "nodejs";
// Node fetch/SSE 需要长连接；禁用静态优化
export const dynamic = "force-dynamic";

// 进程首次触碰 session 路由时跑一次 reconcile：把 status=running 的老会话改成 aborted
let reconciled = false;
async function ensureReconciled() {
  if (reconciled) return;
  reconciled = true;
  try {
    await reconcileOnStartup();
  } catch (e) {
    console.log(JSON.stringify({ tag: "reconcile_error", message: String(e) }));
  }
}

type StartBody = {
  bookSlug?: string;
  sectionId?: string;
  learnerId?: LearnerId;
  pacing?: Pacing;
  coachEnabled?: boolean;
  learnerCoachEnabled?: boolean;
  maxTurns?: number;
  teachingMode?: TeachingMode;
  commentariesEnabled?: boolean;
  /** 若给，续跑这个 sid（bookSlug/sectionId/learnerId 会被 meta 里的覆盖） */
  resumeSid?: string;
};

const encoder = new TextEncoder();
function sseFrame(event: SessionEvent): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function POST(req: NextRequest) {
  await ensureReconciled();

  let body: StartBody;
  try {
    body = (await req.json()) as StartBody;
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), { status: 400 });
  }

  const isResume = Boolean(body.resumeSid);
  if (!isResume && (!body.bookSlug || !body.sectionId || !body.learnerId)) {
    return new Response(
      JSON.stringify({ error: "新会话需要 bookSlug / sectionId / learnerId" }),
      { status: 400 },
    );
  }

  const maxTurns = Math.min(Math.max(body.maxTurns ?? 8, 1), 200);
  const teachingMode: TeachingMode =
    body.teachingMode === "close_reading" ? "close_reading" : "socratic";
  // 句读模式下 pacing 无意义（三档都塌成一档），硬编码 normal 保 resume 兼容
  const pacing: Pacing =
    teachingMode === "close_reading"
      ? "normal"
      : body.pacing === "thorough" || body.pacing === "express"
      ? body.pacing
      : "normal";
  const coachEnabled = body.coachEnabled !== false;
  const learnerCoachEnabled = body.learnerCoachEnabled !== false;
  // socratic 下 commentaries 强制 false，避免误传
  const commentariesEnabled = teachingMode === "close_reading" && body.commentariesEnabled === true;
  const abortCtrl = new AbortController();
  req.signal.addEventListener("abort", () => abortCtrl.abort(), { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of runSession({
          bookSlug: body.bookSlug ?? "",
          sectionId: body.sectionId ?? "",
          learnerId: body.learnerId ?? "novice",
          pacing,
          coachEnabled,
          learnerCoachEnabled,
          maxTurns,
          teachingMode,
          commentariesEnabled,
          signal: abortCtrl.signal,
          resumeSid: body.resumeSid,
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
