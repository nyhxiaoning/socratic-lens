import path from "node:path";
import { getBook } from "./book";
import { callLLM } from "./llm";
import {
  buildLearnerMessages,
  buildLearnerSystemPrompt,
} from "./learner";
import {
  appendLine,
  ensureDir,
  SESSIONS_ROOT,
  writeAtomic,
} from "./storage";
import {
  buildTeacherMessages,
  buildTeacherSystemPrompt,
  TEACHER_OPENING_TRIGGER,
  type LearnerId,
} from "./teacher";

export type Actor = "teacher" | "learner";
export type Turn = { turn: number; actor: Actor; text: string; ts: number };

export type SessionMeta = {
  sid: string;
  bookSlug: string;
  sectionId: string;
  learnerId: LearnerId;
  maxTurns: number;
  startedAt: number;
  status: "running" | "done" | "aborted" | "errored";
  endedAt?: number;
  error?: string;
};

export type SessionEvent =
  | { type: "meta"; meta: SessionMeta }
  | { type: "turn_start"; actor: Actor; turn: number }
  | { type: "chunk"; actor: Actor; turn: number; text: string }
  | { type: "turn_end"; actor: Actor; turn: number; text: string }
  | { type: "done"; sid: string }
  | { type: "error"; message: string };

function newSid(): string {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

function sessionDir(sid: string): string {
  return path.join(SESSIONS_ROOT, sid);
}

async function writeMeta(meta: SessionMeta): Promise<void> {
  await writeAtomic(path.join(sessionDir(meta.sid), "meta.json"), JSON.stringify(meta, null, 2));
}

async function appendTurn(sid: string, turn: Turn): Promise<void> {
  await appendLine(path.join(sessionDir(sid), "transcript.jsonl"), JSON.stringify(turn));
}

export type StartSessionInput = {
  bookSlug: string;
  sectionId: string;
  learnerId: LearnerId;
  maxTurns: number;
  signal: AbortSignal;
};

/**
 * 教-学对话循环，产出 SessionEvent 序列。
 * 一"turn"包含教师一次发言 + 学生一次发言；教师先说。
 */
export async function* runSession(
  input: StartSessionInput,
): AsyncGenerator<SessionEvent> {
  const sid = newSid();
  const meta: SessionMeta = {
    sid,
    bookSlug: input.bookSlug,
    sectionId: input.sectionId,
    learnerId: input.learnerId,
    maxTurns: input.maxTurns,
    startedAt: Date.now(),
    status: "running",
  };

  try {
    await ensureDir(sessionDir(sid));
    await writeMeta(meta);
    yield { type: "meta", meta };

    const book = await getBook(input.bookSlug);
    const teacherSystem = await buildTeacherSystemPrompt(
      book,
      input.bookSlug,
      input.sectionId,
      input.learnerId,
    );
    const learnerSystem = await buildLearnerSystemPrompt(
      book,
      input.sectionId,
      input.learnerId,
    );

    const turns: { actor: Actor; text: string }[] = [];
    let turnIdx = 0;

    while (turnIdx < input.maxTurns) {
      if (input.signal.aborted) break;
      turnIdx++;

      // 教师
      yield { type: "turn_start", actor: "teacher", turn: turnIdx };
      const teacherMsgs = buildTeacherMessages(teacherSystem, turns, TEACHER_OPENING_TRIGGER);
      let teacherText = "";
      for await (const chunk of callLLM("teacher", teacherMsgs, {
        stream: true,
        temperature: 0.7,
        maxTokens: 800,
        signal: input.signal,
      })) {
        teacherText += chunk;
        yield { type: "chunk", actor: "teacher", turn: turnIdx, text: chunk };
      }
      turns.push({ actor: "teacher", text: teacherText });
      await appendTurn(sid, { turn: turnIdx, actor: "teacher", text: teacherText, ts: Date.now() });
      yield { type: "turn_end", actor: "teacher", turn: turnIdx, text: teacherText };

      if (input.signal.aborted) break;

      // 学生
      yield { type: "turn_start", actor: "learner", turn: turnIdx };
      const learnerMsgs = buildLearnerMessages(learnerSystem, turns);
      let learnerText = "";
      for await (const chunk of callLLM("learner", learnerMsgs, {
        stream: true,
        temperature: 0.8,
        maxTokens: 500,
        signal: input.signal,
      })) {
        learnerText += chunk;
        yield { type: "chunk", actor: "learner", turn: turnIdx, text: chunk };
      }
      turns.push({ actor: "learner", text: learnerText });
      await appendTurn(sid, { turn: turnIdx, actor: "learner", text: learnerText, ts: Date.now() });
      yield { type: "turn_end", actor: "learner", turn: turnIdx, text: learnerText };
    }

    meta.status = input.signal.aborted ? "aborted" : "done";
    meta.endedAt = Date.now();
    await writeMeta(meta);
    yield { type: "done", sid };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // AbortError 视为中止，不算错误
    const aborted =
      input.signal.aborted ||
      (err instanceof Error && (err.name === "AbortError" || /aborted/i.test(err.message)));
    meta.status = aborted ? "aborted" : "errored";
    meta.endedAt = Date.now();
    if (!aborted) meta.error = message;
    await writeMeta(meta).catch(() => {});
    if (aborted) {
      yield { type: "done", sid };
    } else {
      yield { type: "error", message };
    }
  }
}
