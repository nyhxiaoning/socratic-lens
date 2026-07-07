import path from "node:path";
import { getBook, getSectionTitle } from "./book";
import { analyzeWithCoach, type CoachAnalysis } from "./coach";
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
  type Pacing,
} from "./teacher";

export type Actor = "teacher" | "learner";
export type Turn = { turn: number; actor: Actor; text: string; ts: number };

export type SessionMeta = {
  sid: string;
  bookSlug: string;
  sectionId: string;
  learnerId: LearnerId;
  pacing: Pacing;
  coachEnabled: boolean;
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
  | { type: "coach"; turn: number; analysis: CoachAnalysis }
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

async function appendCoach(sid: string, turnIdx: number, analysis: CoachAnalysis): Promise<void> {
  await appendLine(
    path.join(sessionDir(sid), "coach.jsonl"),
    JSON.stringify({ turn: turnIdx, ts: Date.now(), analysis }),
  );
}

export type StartSessionInput = {
  bookSlug: string;
  sectionId: string;
  learnerId: LearnerId;
  pacing: Pacing;
  coachEnabled: boolean;
  maxTurns: number;
  signal: AbortSignal;
};

/**
 * 教-学对话循环，产出 SessionEvent 序列。
 * 一"turn"包含教师一次发言 + 学生一次发言；教师先说。
 * 每一轮末尾（学生说完之后）后台跑教练分析，结果注入下一轮教师 system prompt。
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
    pacing: input.pacing,
    coachEnabled: input.coachEnabled,
    maxTurns: input.maxTurns,
    startedAt: Date.now(),
    status: "running",
  };

  try {
    await ensureDir(sessionDir(sid));
    await writeMeta(meta);
    yield { type: "meta", meta };

    const book = await getBook(input.bookSlug);
    const sectionTitle = getSectionTitle(book, input.sectionId);

    const learnerSystem = await buildLearnerSystemPrompt(
      book,
      input.sectionId,
      input.learnerId,
    );

    const turns: Turn[] = [];
    let turnIdx = 0;
    let coachAnalysis: CoachAnalysis | null = null;

    while (turnIdx < input.maxTurns) {
      if (input.signal.aborted) break;
      turnIdx++;

      // ---- 教师 ----
      // 每轮都重建 system prompt（这样才能把 coachAnalysis 注入进去）
      const teacherSystem = await buildTeacherSystemPrompt(
        book,
        input.bookSlug,
        input.sectionId,
        input.learnerId,
        input.pacing,
        coachAnalysis,
      );

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
      const teacherTurn: Turn = { turn: turnIdx, actor: "teacher", text: teacherText, ts: Date.now() };
      turns.push(teacherTurn);
      await appendTurn(sid, teacherTurn);
      yield { type: "turn_end", actor: "teacher", turn: turnIdx, text: teacherText };

      if (input.signal.aborted) break;

      // ---- 学生 ----
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
      const learnerTurn: Turn = { turn: turnIdx, actor: "learner", text: learnerText, ts: Date.now() };
      turns.push(learnerTurn);
      await appendTurn(sid, learnerTurn);
      yield { type: "turn_end", actor: "learner", turn: turnIdx, text: learnerText };

      if (input.signal.aborted) break;

      // ---- 教练分析（本轮末，服务于下一轮）----
      // 最后一轮不用跑（下一轮不存在了）
      if (input.coachEnabled && turnIdx < input.maxTurns) {
        const next = await analyzeWithCoach({
          bookTitle: book.title,
          sectionTitle,
          pacing: input.pacing,
          turns,
          signal: input.signal,
        });
        if (next) {
          coachAnalysis = next;
          await appendCoach(sid, turnIdx, next);
          yield { type: "coach", turn: turnIdx, analysis: next };
        }
        // 失败或返回 null 就沿用上一轮的分析（更保守），也可以清空
      }
    }

    meta.status = input.signal.aborted ? "aborted" : "done";
    meta.endedAt = Date.now();
    await writeMeta(meta);
    yield { type: "done", sid };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
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
