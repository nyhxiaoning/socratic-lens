import path from "node:path";
import { getBook, getPages, getSection, getSectionTitle } from "./book";
import {
  analyzeLearnerWithCoach,
  analyzeWithCoach,
  type CoachAnalysis,
  type LearnerCoachAnalysis,
} from "./coach";
import { callLLM, type LLMUsage, type Purpose } from "./llm";
import { verifyTurnCitations, type Citation } from "./citations";
import { makeCostEstimator } from "./pricing";
import { getChecklist } from "./checklist";
import { initCoverageState, updateCoverage, matchCoverageWithLLM, coverageStats, assignPages, windowCoveredRatio, type CoverageItem } from "./coverage-tracker";
import {
  buildLearnerMessages,
  buildLearnerSystemPrompt,
} from "./learner";
import { slideWindow } from "./pagination";
import {
  appendLine,
  ensureDir,
  exists,
  readJson,
  readText,
  SESSIONS_ROOT,
  writeAtomic,
} from "./storage";
import {
  buildTeacherMessages,
  buildTeacherSystemPrompt,
  TEACHER_OPENING_TRIGGER,
  normalizeLearnerId,
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
  learnerCoachEnabled: boolean;
  maxTurns: number;
  turnsSoFar: number; // 已完成的 turn 数（教师 + 学生都完成算 1）
  startedAt: number;
  status: "running" | "done" | "aborted" | "errored";
  endedAt?: number;
  error?: string;
  /** 教师侧的 lesson_summary 摘要（旧对话被压缩后放这里）。 */
  teacherSummary?: string;
  teacherSummaryUpto?: number; // 摘要覆盖到第几个 turn（包含）
  learnerSummary?: string;
  learnerSummaryUpto?: number;
  /** 自适应翻页：教师当前看到的窗口页码（仅本节被分页时用）。 */
  windowStartPage?: number;
  windowEndPage?: number;
};

export type SessionEvent =
  | { type: "meta"; meta: SessionMeta }
  | { type: "turn_start"; actor: Actor; turn: number }
  | { type: "chunk"; actor: Actor; turn: number; text: string }
  | { type: "turn_end"; actor: Actor; turn: number; text: string }
  | { type: "coach"; turn: number; side: "teacher" | "learner"; analysis: CoachAnalysis | LearnerCoachAnalysis }
  | { type: "compressed"; side: "teacher" | "learner"; upto: number }
  | {
      type: "window_slide";
      turn: number;
      startPage: number;
      endPage: number;
      totalPages: number;
    }
  | {
      type: "usage";
      /** 累计到此刻 */
      promptTokens: number;
      completionTokens: number;
      costCny: number;
      cacheHitTokens?: number;
      cacheMissTokens?: number;
    }
  | { type: "done"; sid: string }
  | { type: "error"; message: string }
  | { type: "coverage_init"; items: import("./coverage-tracker").CoverageItem[] }
  | { type: "coverage_update"; items: import("./coverage-tracker").CoverageItem[]; newlyCovered: string[]; stats: ReturnType<typeof import("./coverage-tracker").coverageStats> };

/** 一条 usage 记录，落盘到 data/sessions/<sid>/usage.jsonl */
export type UsageRecord = {
  ts: number;
  turn: number;
  purpose: Purpose;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costCny: number;
};

// ============================================================================
// 滑动摘要参数（参考 Socratopia §10.2 精神，字符尺度非 token）
// ============================================================================
const CONTEXT_KEEP_CHARS_TEACHER = 60_000; // 教师侧对话上下文预算
const CONTEXT_KEEP_CHARS_LEARNER = 40_000; // 学生侧预算（学生不需要看太多历史）
const COMPRESS_TRIGGER_CHARS = 12_000; // 一段"待压缩"内容达到这个字符数就跑一次摘要
const SUMMARY_MAX_CHARS = 1500; // 单份 lesson_summary 上限（超过就再压一遍）

// ============================================================================
// 自适应翻页参数（见 _dev/WINDOW-SLIDE-REDESIGN.md §4.5 / §6.5）
// ============================================================================
/** 翻页覆盖占比阈值，按 pacing 取——审细则近全覆盖才翻，审快则主干讲到就翻。 */
const SLIDE_COVERAGE_THRESHOLD: Record<Pacing, number> = {
  thorough: 0.95,
  normal: 0.8,
  express: 0.6,
};
/** 窗口内可定位知识点少于此数时，覆盖占比抖动大、不单独作数，交给教练信号兜。 */
const SLIDE_MIN_LOCATABLE = 2;
/**
 * 同一窗口最多停留多少轮就强制翻页（安全网）。
 * 治两类卡死：稀疏页（无可定位知识点 + 教练关）导致无信号；
 * 以及教师啃不动某点、覆盖率永远到不了阈值导致的空转。
 * 设得足够高，正常教学远用不到——它只在信号卡住时兜底。
 */
const SLIDE_MAX_DWELL = 12;

// ============================================================================
// 路径与 IO
// ============================================================================

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

async function readCoverage(sid: string): Promise<CoverageItem[] | null> {
  const p = path.join(sessionDir(sid), "coverage.json");
  if (!(await exists(p))) return null;
  try { return await readJson<CoverageItem[]>(p); } catch { return null; }
}

async function writeCoverage(sid: string, items: CoverageItem[]): Promise<void> {
  await writeAtomic(path.join(sessionDir(sid), "coverage.json"), JSON.stringify(items, null, 2));
}

async function appendCoach(
  sid: string,
  side: "teacher" | "learner",
  turnIdx: number,
  analysis: unknown,
): Promise<void> {
  const file = side === "teacher" ? "coach.jsonl" : "learner_coach.jsonl";
  await appendLine(
    path.join(sessionDir(sid), file),
    JSON.stringify({ turn: turnIdx, ts: Date.now(), analysis }),
  );
}

/** 读已存在的 transcript.jsonl（用于 resume）。 */
async function loadExistingTurns(sid: string): Promise<Turn[]> {
  const p = path.join(sessionDir(sid), "transcript.jsonl");
  if (!(await exists(p))) return [];
  const raw = await readText(p);
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Turn;
      } catch {
        return null;
      }
    })
    .filter((t): t is Turn => t !== null);
}

// ============================================================================
// 上下文窗口构造（含摘要前缀 + 最近若干 turn）
// ============================================================================

type WindowInput = {
  side: "teacher" | "learner";
  turns: Turn[];
  summary: string | undefined;
  summaryUpto: number | undefined;
  budget: number; // 字符预算
};

/**
 * 取从 summaryUpto 之后的 turns，累计不超过 budget 字符。超出部分丢弃（会由摘要覆盖）。
 * 返回：{ visibleTurns, prefixSystemAddendum }
 * prefixSystemAddendum 是"之前对话的摘要"文本，拼到 system prompt 末尾。
 */
function buildWindow(input: WindowInput): { visibleTurns: Turn[]; addendum: string } {
  const startFromTurn = input.summaryUpto ?? 0;
  const remaining = input.turns.filter((t) => t.turn > startFromTurn);

  // 从末尾往回累加，够 budget 就停
  const kept: Turn[] = [];
  let chars = 0;
  for (let i = remaining.length - 1; i >= 0; i--) {
    chars += remaining[i].text.length;
    if (kept.length > 0 && chars > input.budget) break;
    kept.unshift(remaining[i]);
  }

  const addendum = input.summary
    ? `## 之前对话的摘要（第 1–${input.summaryUpto} 轮）\n\n${input.summary}`
    : "";

  return { visibleTurns: kept, addendum };
}

// ============================================================================
// lesson_summary 压缩
// ============================================================================

const SUMMARY_PROMPT_TEACHER = `你是一个对话摘要助手。给你一段师生对话记录（AI 学习伙伴 vs 学生 agent）。

你的任务：用简洁的中文概括这段对话的**教学**要点，保留：
1. 讲到了哪些概念/结论
2. 学生的理解情况（对了什么、错了什么、卡在哪、当前对哪个点困惑）
3. 教师给出的关键解释或引导
4. 教师是否引用了原文（引了什么）

要求：
- 简洁扼要，不超过 400 字
- 不要用"总结""摘要"等元描述词开头，直接陈述内容
- 用叙述体，不要用列表
- 不要复制学生原话——转述即可`;

const SUMMARY_PROMPT_LEARNER = `你是一个对话摘要助手。给你一段师生对话记录（AI 学习伙伴 vs 学生 agent）。

你要从**学生视角**总结：
1. 老师此刻教到了哪一步（学生知道的信息就是这些）
2. 学生自己此刻理解到什么程度、还有什么疑问
3. 老师之前用过的例子、比喻、引用，学生可以在后续对话里引用

要求：
- 用第二人称写给学生自己看："老师告诉过你 X，你复述时提到 Y……"
- 简洁扼要，不超过 400 字
- 不要用"总结""摘要"开头
- 用叙述体`;

const SUMMARY_RECOMPRESS_PROMPT = `以下是一段较长的对话摘要。请你把它进一步压缩到 500 字以内，保留最关键的教学要点：

`;

async function summarize(
  side: "teacher" | "learner",
  toSummarize: Turn[],
  prevSummary: string | undefined,
  signal: AbortSignal,
  onUsage?: (u: LLMUsage) => void,
): Promise<string | null> {
  const transcript = toSummarize
    .map((t) => (t.actor === "teacher" ? "【教师】" : "【学生】") + t.text)
    .join("\n\n");
  const system = side === "teacher" ? SUMMARY_PROMPT_TEACHER : SUMMARY_PROMPT_LEARNER;
  const user = prevSummary
    ? `以下是**已有的摘要**（覆盖更早的对话），请把它 + 新对话合并成一份新的摘要（不超过 400 字）：\n\n【已有摘要】\n${prevSummary}\n\n【新对话】\n${transcript}`
    : `请对以下对话产出摘要：\n\n${transcript}`;

  try {
    const raw = await callLLM(
      "audit", // 复用 audit purpose 的模型即可（都是非核心）
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      {
        stream: false,
        temperature: 0.2,
        maxTokens: 800,
        signal,
        onUsage,
      },
    );
    let s = raw.trim();
    // 如果新摘要还是超过 SUMMARY_MAX_CHARS，再压一次
    if (s.length > SUMMARY_MAX_CHARS) {
      const raw2 = await callLLM(
        "audit",
        [
          { role: "system", content: system },
          { role: "user", content: SUMMARY_RECOMPRESS_PROMPT + s },
        ],
        { stream: false, temperature: 0.2, maxTokens: 700, signal, onUsage },
      );
      s = raw2.trim();
    }
    return s;
  } catch (err) {
    console.log(
      JSON.stringify({
        tag: "summary_error",
        side,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
}

/**
 * 触发条件：summaryUpto 之后的 turns 累计字符 > COMPRESS_TRIGGER_CHARS。
 * 返回：如果压缩了，返回新的 { summary, summaryUpto }；否则 null。
 */
async function maybeCompress(
  side: "teacher" | "learner",
  turns: Turn[],
  prevSummary: string | undefined,
  prevUpto: number | undefined,
  signal: AbortSignal,
  onUsage?: (u: LLMUsage) => void,
): Promise<{ summary: string; upto: number } | null> {
  const startFromTurn = prevUpto ?? 0;
  const pending = turns.filter((t) => t.turn > startFromTurn);
  const totalChars = pending.reduce((s, t) => s + t.text.length, 0);
  if (totalChars < COMPRESS_TRIGGER_CHARS) return null;

  // 把"最近 4 个 turn"留在窗口里当上下文，只压更早的
  const keepFromEnd = 4;
  if (pending.length <= keepFromEnd) return null;
  const toSummarize = pending.slice(0, pending.length - keepFromEnd);
  const upto = toSummarize[toSummarize.length - 1].turn;

  const summary = await summarize(side, toSummarize, prevSummary, signal, onUsage);
  if (!summary) return null;
  return { summary, upto };
}

// ============================================================================
// 主循环
// ============================================================================

export type StartSessionInput = {
  bookSlug: string;
  sectionId: string;
  learnerId: LearnerId;
  pacing: Pacing;
  coachEnabled: boolean;
  learnerCoachEnabled: boolean;
  maxTurns: number;
  signal: AbortSignal;
  /** 若提供，恢复该 sid 继续跑；否则新建 sid。 */
  resumeSid?: string;
};

export async function* runSession(
  input: StartSessionInput,
): AsyncGenerator<SessionEvent> {
  // 价格表预解析一次（运行时配置优先，回落 env）；循环内同步换算成本
  const estimateCost = await makeCostEstimator();
  // ---- 初始化 meta 与状态 ----
  let meta: SessionMeta;
  let turns: Turn[];
  let coachAnalysis: CoachAnalysis | null = null;
  let learnerCoachAnalysis: LearnerCoachAnalysis | null = null;

  if (input.resumeSid) {
    const metaPath = path.join(sessionDir(input.resumeSid), "meta.json");
    if (!(await exists(metaPath))) {
      yield { type: "error", message: `会话 ${input.resumeSid} 不存在` };
      return;
    }
    meta = await readJson<SessionMeta>(metaPath);
    // 到轮次上限（done）或手动停止（aborted）都允许"继续对话"续跑，
    // 只要新的 maxTurns 比已跑轮数大。否则提示增大轮数。
    if (meta.status === "done" && input.maxTurns <= meta.turnsSoFar) {
      yield {
        type: "error",
        message: `该会话已跑满 ${meta.turnsSoFar} 轮，续跑需要更大的轮数上限`,
      };
      return;
    }
    meta.status = "running";
    meta.error = undefined;
    // maxTurns / pacing / coach flags 允许用新值覆盖（但保留原书/节/画像）
    meta.maxTurns = input.maxTurns;
    meta.pacing = input.pacing;
    meta.coachEnabled = input.coachEnabled;
    meta.learnerCoachEnabled = input.learnerCoachEnabled;
    turns = await loadExistingTurns(input.resumeSid);
    meta.turnsSoFar = turns.filter((t) => t.actor === "learner").length; // 教师+学生都完成的 turn 数
    await writeMeta(meta);

    // 载入最近一次教练分析
    const teacherCoachPath = path.join(sessionDir(input.resumeSid), "coach.jsonl");
    if (await exists(teacherCoachPath)) {
      const lines = (await readText(teacherCoachPath)).split("\n").filter(Boolean);
      const last = lines[lines.length - 1];
      if (last) {
        try {
          coachAnalysis = (JSON.parse(last) as { analysis: CoachAnalysis }).analysis;
        } catch {}
      }
    }
    const learnerCoachPath = path.join(sessionDir(input.resumeSid), "learner_coach.jsonl");
    if (await exists(learnerCoachPath)) {
      const lines = (await readText(learnerCoachPath)).split("\n").filter(Boolean);
      const last = lines[lines.length - 1];
      if (last) {
        try {
          learnerCoachAnalysis = (JSON.parse(last) as { analysis: LearnerCoachAnalysis }).analysis;
        } catch {}
      }
    }
  } else {
    const sid = newSid();
    meta = {
      sid,
      bookSlug: input.bookSlug,
      sectionId: input.sectionId,
      learnerId: normalizeLearnerId(input.learnerId),
      pacing: input.pacing,
      coachEnabled: input.coachEnabled,
      learnerCoachEnabled: input.learnerCoachEnabled,
      maxTurns: input.maxTurns,
      turnsSoFar: 0,
      startedAt: Date.now(),
      status: "running",
    };
    turns = [];
    await ensureDir(sessionDir(sid));
    await writeMeta(meta);
  }

  try {
    yield { type: "meta", meta };

    const book = await getBook(meta.bookSlug);
    const sectionTitle = getSectionTitle(book, meta.sectionId);

    // ---- 覆盖度追踪：加载知识点清单 ----
    let coverageItems: CoverageItem[] = [];
    // 本节分页信息（用于知识点归页 + 翻页判据）。短节不分页则为 null。
    const sectionPages = await getPages(meta.bookSlug, meta.sectionId);
    const checklist = await getChecklist(meta.bookSlug, meta.sectionId);
    if (checklist) {
      // Resume: 优先读落盘的覆盖状态（包含 LLM 匹配结果，重放恢复不全）
      const savedCoverage = await readCoverage(meta.sid);
      if (savedCoverage) {
        coverageItems = savedCoverage;
      } else {
        coverageItems = initCoverageState(checklist);
        // 重建：重放历史轮次的教师发言，恢复字符串匹配的覆盖
        for (const t of turns) {
          if (t.actor === "teacher") {
            const { items: updated } = updateCoverage(coverageItems, t.text, t.turn);
            coverageItems = updated;
          }
        }
      }
      // 知识点归页（覆盖度驱动翻页的信号来源，见 §4.2）。归页幂等，resume 也重算，
      // 兼容旧盘（旧 coverage.json 没有 pages 字段）。仅本节被分页时有意义。
      if (sectionPages && sectionPages.length > 0) {
        coverageItems = assignPages(coverageItems, sectionPages);
      }
      yield { type: "coverage_init", items: coverageItems };
      // 首次初始化后落盘，确保后续 resume 能直接读到
      if (!savedCoverage) await writeCoverage(meta.sid, coverageItems);
    }

    // 从 turns 里恢复"下一个 turnIdx"
    let turnIdx = meta.turnsSoFar; // 已完成 N 个 turn，接下来是 N+1

    // 如果 resume 时最后一次教师说完但学生没说，那 turns 最后一条是 teacher，
    // 得把 turnIdx-- 让当前循环重跑那一轮的教师（会被覆盖）——但这样有 bug：
    // append-only transcript 保留了坏消息。简单起见：resume 时如果最后不是完整的一轮，
    // 把 turnIdx 定位到"最后一个完整轮次"，让教师从下一轮说起（老的半截教师消息留着但作废）。
    // 更稳的做法是重启时截断——但我们 append-only。这里保守处理：
    // 如果 turns 末尾是 teacher 但没配对 learner，忽略这条半截 teacher，从下一整轮开始。
    if (turns.length > 0 && turns[turns.length - 1].actor === "teacher") {
      // 教师说了但学生没接，这是异常中止。丢弃这条半截 teacher 消息。
      // 注意：transcript 文件里还留着；下次审计会看到，但主循环忽略。
      turns = turns.slice(0, -1);
    }

    // 自适应翻页：教练最近若干轮 contentProgress 的滑动记录（参照 Socratopia §5.4 的思路）
    const recentProgress: ("first_half" | "second_half" | "done")[] = [];
    const PROGRESS_WINDOW = 4;
    const PROGRESS_TRIGGER = 2;
    // 当前窗口已停留轮数（含 resume 无法精确恢复，从 0 起算——只影响本次续跑的兜底时机）。
    let windowDwell = 0;

    // ---- usage 累计（本次 session）----
    let cumPromptTokens = 0;
    let cumCompletionTokens = 0;
    let cumCostCny = 0;
    let cumCacheHitTokens = 0;
    let cumCacheMissTokens = 0;
    // 存到闭包里的"待推送 usage 事件"——每轮末尾一次性 yield，避免频繁 SSE
    let usageDirty = false;
    const recordUsage = (purpose: Purpose, turn: number) => (u: LLMUsage) => {
      const cost = estimateCost(purpose, u.promptTokens, u.completionTokens);
      cumPromptTokens += u.promptTokens;
      cumCompletionTokens += u.completionTokens;
      cumCostCny += cost;
      if (u.cacheHitTokens != null) cumCacheHitTokens += u.cacheHitTokens;
      if (u.cacheMissTokens != null) cumCacheMissTokens += u.cacheMissTokens;
      usageDirty = true;
      // 落盘：append 到 usage.jsonl
      const rec: UsageRecord = {
        ts: Date.now(),
        turn,
        purpose,
        promptTokens: u.promptTokens,
        completionTokens: u.completionTokens,
        totalTokens: u.totalTokens,
        costCny: cost,
      };
      // 不 await——不阻塞流；出错只 console
      appendLine(path.join(sessionDir(meta.sid), "usage.jsonl"), JSON.stringify(rec)).catch(
        (e) => console.log(JSON.stringify({ tag: "usage_write_err", message: String(e) })),
      );
    };

    // 恢复已存的 usage 累计（resume 时不至于从 0 开始显示）
    if (input.resumeSid) {
      const usagePath = path.join(sessionDir(meta.sid), "usage.jsonl");
      if (await exists(usagePath)) {
        const raw = await readText(usagePath);
        for (const line of raw.split("\n")) {
          if (!line) continue;
          try {
            const rec = JSON.parse(line) as UsageRecord;
            cumPromptTokens += rec.promptTokens;
            cumCompletionTokens += rec.completionTokens;
            cumCostCny += rec.costCny;
          } catch {}
        }
        usageDirty = true; // resume 后先推一次给前端
      }
    }

    // 本节原文：verbatim 引用校验用（session 一节内不变，预取一次）
    const sectionText = await getSection(meta.bookSlug, meta.sectionId);

    // maxTurns=0 表示"直到本节教学结束"：自动在最后一页讲完后停止
    const AUTO_STOP = meta.maxTurns === 0;
    const effectiveMax = AUTO_STOP ? 200 : meta.maxTurns;

    while (turnIdx < effectiveMax) {
      if (input.signal.aborted) break;
      turnIdx++;

      // ---- 教师侧：构造上下文 + system prompt ----
      const teacherWindow = buildWindow({
        side: "teacher",
        turns,
        summary: meta.teacherSummary,
        summaryUpto: meta.teacherSummaryUpto,
        budget: CONTEXT_KEEP_CHARS_TEACHER,
      });
      const { systemPrompt: teacherSystemBase, window: teacherOriginWindow } =
        await buildTeacherSystemPrompt(
          book,
          meta.bookSlug,
          meta.sectionId,
          normalizeLearnerId(meta.learnerId),
          meta.pacing,
          coachAnalysis,
          meta.windowStartPage !== undefined && meta.windowEndPage !== undefined
            ? { startPage: meta.windowStartPage, endPage: meta.windowEndPage }
            : undefined,
        );
      // 若首轮 & 本节被分页 & meta 里还没有窗口，把 buildTeacherSystemPrompt 决定的初始窗口回写
      if (
        teacherOriginWindow.paginated &&
        (meta.windowStartPage === undefined || meta.windowEndPage === undefined)
      ) {
        meta.windowStartPage = teacherOriginWindow.startPage;
        meta.windowEndPage = teacherOriginWindow.endPage;
        await writeMeta(meta);
      }
      let teacherSystem = teacherSystemBase;
      if (teacherWindow.addendum) {
        teacherSystem = teacherSystem + "\n\n---\n\n" + teacherWindow.addendum;
      }

      yield { type: "turn_start", actor: "teacher", turn: turnIdx };
      const teacherMsgs = buildTeacherMessages(
        teacherSystem,
        teacherWindow.visibleTurns,
        TEACHER_OPENING_TRIGGER,
      );
      // 强制教师首句非空：LLM 偶尔会吐空串（尤其首轮），空串会导致学生"对着空气作答"。
      // 空则最多重试 2 次；仍空就中止本轮并报错，绝不放行到学生侧。
      let teacherText = "";
      const TEACHER_MAX_ATTEMPTS = 3;
      for (let attempt = 1; attempt <= TEACHER_MAX_ATTEMPTS; attempt++) {
        if (input.signal.aborted) break;
        teacherText = "";
        for await (const chunk of callLLM("teacher", teacherMsgs, {
          stream: true,
          temperature: 0.7,
          maxTokens: 800,
          signal: input.signal,
          onUsage: recordUsage("teacher", turnIdx),
        })) {
          teacherText += chunk;
          yield { type: "chunk", actor: "teacher", turn: turnIdx, text: chunk };
        }
        if (teacherText.trim() !== "") break;
        // 空输出：重试前发一个空 turn_end 把当前教师气泡清空，重收下一次尝试的 chunk
        if (attempt < TEACHER_MAX_ATTEMPTS && !input.signal.aborted) {
          yield { type: "turn_end", actor: "teacher", turn: turnIdx, text: "" };
        }
      }
      if (teacherText.trim() === "" && !input.signal.aborted) {
        throw new Error("教师连续多次输出为空，已中止本轮");
      }
      const teacherTurn: Turn = {
        turn: turnIdx,
        actor: "teacher",
        text: teacherText,
        ts: Date.now(),
      };
      turns.push(teacherTurn);
      await appendTurn(meta.sid, teacherTurn);

      // ---- verbatim 引用校验（教师专用）----
      const cites: Citation[] = verifyTurnCitations(
        teacherText,
        meta.sectionId,
        sectionText,
      );
      if (cites.length > 0) {
        appendLine(
          path.join(sessionDir(meta.sid), "citations.jsonl"),
          JSON.stringify({ turn: turnIdx, ts: Date.now(), cites }),
        ).catch((e) =>
          console.log(JSON.stringify({ tag: "citations_write_err", message: String(e) })),
        );
      }

      yield { type: "turn_end", actor: "teacher", turn: turnIdx, text: teacherText };

      if (input.signal.aborted) break;

      // ---- 学生侧：构造上下文 + system prompt ----
      const learnerWindow = buildWindow({
        side: "learner",
        turns,
        summary: meta.learnerSummary,
        summaryUpto: meta.learnerSummaryUpto,
        budget: CONTEXT_KEEP_CHARS_LEARNER,
      });
      let learnerSystem = await buildLearnerSystemPrompt(
        book,
        meta.sectionId,
        normalizeLearnerId(meta.learnerId),
        learnerCoachAnalysis,
      );
      if (learnerWindow.addendum) {
        learnerSystem = learnerSystem + "\n\n---\n\n" + learnerWindow.addendum;
      }

      yield { type: "turn_start", actor: "learner", turn: turnIdx };
      const learnerMsgs = buildLearnerMessages(learnerSystem, learnerWindow.visibleTurns);
      let learnerText = "";
      for await (const chunk of callLLM("learner", learnerMsgs, {
        stream: true,
        temperature: 0.8,
        maxTokens: 500,
        signal: input.signal,
        onUsage: recordUsage("learner", turnIdx),
      })) {
        learnerText += chunk;
        yield { type: "chunk", actor: "learner", turn: turnIdx, text: chunk };
      }
      const learnerTurn: Turn = {
        turn: turnIdx,
        actor: "learner",
        text: learnerText,
        ts: Date.now(),
      };
      turns.push(learnerTurn);
      await appendTurn(meta.sid, learnerTurn);
      yield { type: "turn_end", actor: "learner", turn: turnIdx, text: learnerText };

      meta.turnsSoFar = turnIdx;
      await writeMeta(meta);

      if (input.signal.aborted) break;

      // ---- 双教练 + 覆盖度追踪：并行 ----
      const isLastTurn = turnIdx >= effectiveMax;
      const runCoaches = !isLastTurn && (meta.coachEnabled || meta.learnerCoachEnabled);
      const runCoverage = coverageItems.length > 0;

      // 覆盖度追踪：字符串匹配 + LLM 语义兜底（与教练并行，返回值用 Promise 传回）
      type CovResult = { items: CoverageItem[]; newlyCovered: string[]; stats: ReturnType<typeof coverageStats> };
      const coveragePromise: Promise<CovResult | null> = runCoverage
        ? (async (): Promise<CovResult | null> => {
            // Tier 1: 字符串匹配（零 LLM 成本）
            const { items: afterFuzzy, newlyCovered } = updateCoverage(coverageItems, teacherText, turnIdx);
            coverageItems = afterFuzzy;
            let result: CovResult | null = newlyCovered.length > 0
              ? { items: coverageItems, newlyCovered, stats: coverageStats(coverageItems) }
              : null;

            // Tier 2: LLM 语义兜底——仅当字符串匹配本轮零收获 + 仍有未覆盖项时才触发
            const stillUncovered = coverageItems.filter((i) => i.status === "uncovered");
            if (newlyCovered.length === 0 && stillUncovered.length > 0) {
              const llmMatched = await matchCoverageWithLLM(
                teacherText,
                stillUncovered,
                input.signal,
                recordUsage("coach", turnIdx),
              );
              if (llmMatched.length > 0) {
                coverageItems = coverageItems.map((item) => {
                  if (llmMatched.includes(item.id) && item.status === "uncovered") {
                    return {
                      ...item,
                      status: "covered" as const,
                      evidence: teacherText.length > 120 ? teacherText.slice(0, 120) + "…" : teacherText,
                      coveredAtTurn: turnIdx,
                    };
                  }
                  return item;
                });
                const allNew = [...new Set([...(result?.newlyCovered ?? []), ...llmMatched])];
                result = { items: coverageItems, newlyCovered: allNew, stats: coverageStats(coverageItems) };
              }
            }
            return result;
          })()
        : Promise.resolve(null);

      const parallelTasks: Promise<unknown>[] = [coveragePromise];

      if (runCoaches) {
        if (meta.coachEnabled) {
          parallelTasks.push(
            (async () => {
              const a = await analyzeWithCoach({
                bookTitle: book.title,
                sectionTitle,
                pacing: meta.pacing,
                turns,
                signal: input.signal,
                onUsage: recordUsage("coach", turnIdx),
              });
              if (a) {
                coachAnalysis = a;
                await appendCoach(meta.sid, "teacher", turnIdx, a);
              }
            })(),
          );
        }

        if (meta.learnerCoachEnabled) {
          parallelTasks.push(
            (async () => {
              const a = await analyzeLearnerWithCoach({
                bookTitle: book.title,
                sectionTitle,
                learnerId: normalizeLearnerId(meta.learnerId),
                pacing: meta.pacing,
                turns,
                signal: input.signal,
                onUsage: recordUsage("coach", turnIdx),
              });
              if (a) {
                learnerCoachAnalysis = a;
                await appendCoach(meta.sid, "learner", turnIdx, a);
              }
            })(),
          );
        }
      }

      await Promise.allSettled(parallelTasks);

      // 推送覆盖度更新（从 coveragePromise 取回结果——不能在嵌套 async 里 yield）
      const covResult = await coveragePromise;
      if (covResult) {
        await writeCoverage(meta.sid, covResult.items);
        yield { type: "coverage_update" as const, items: covResult.items, newlyCovered: covResult.newlyCovered, stats: covResult.stats };
      }

      // 事件放循环外让前端可以刷新
      if (meta.coachEnabled && coachAnalysis) {
        yield { type: "coach", turn: turnIdx, side: "teacher", analysis: coachAnalysis };
      }
      if (meta.learnerCoachEnabled && learnerCoachAnalysis) {
        yield {
          type: "coach",
          turn: turnIdx,
          side: "learner",
          analysis: learnerCoachAnalysis,
        };
      }

      // ---- 自适应翻页（双信号：覆盖占比 + 教练节奏，见 §4）----
      // 只要本节被分页 + 已有窗口就考虑翻页——不再绑定 coachEnabled。
      if (
        sectionPages &&
        sectionPages.length > 0 &&
        meta.windowStartPage !== undefined &&
        meta.windowEndPage !== undefined &&
        meta.windowEndPage < sectionPages.length
      ) {
        // 信号一：教练节奏（教练开着才有）。维护 recentProgress 滑动计数。
        let coachSaysAdvance = false;
        let coachSignalAvailable = false;
        if (meta.coachEnabled && coachAnalysis) {
          coachSignalAvailable = true;
          const progress = coachAnalysis.contentProgress ?? "first_half";
          recentProgress.push(progress);
          if (recentProgress.length > PROGRESS_WINDOW) recentProgress.shift();
          coachSaysAdvance =
            recentProgress.filter((p) => p !== "first_half").length >= PROGRESS_TRIGGER;
        }

        // 信号二：当前窗口覆盖占比（有清单才有）。窗口内可定位项太少则不作数。
        let coverageSaysAdvance = false;
        let coverageSignalAvailable = false;
        if (coverageItems.length > 0) {
          const { locatable, ratio } = windowCoveredRatio(
            coverageItems,
            meta.windowStartPage,
            meta.windowEndPage,
          );
          if (locatable >= SLIDE_MIN_LOCATABLE) {
            coverageSignalAvailable = true;
            coverageSaysAdvance = ratio >= SLIDE_COVERAGE_THRESHOLD[meta.pacing];
          }
        }

        windowDwell++;

        // 决策：两个信号都可用时都要点头；只有一个可用则单信号定夺；都不可用不翻。
        let shouldSlide = false;
        if (coverageSignalAvailable && coachSignalAvailable) {
          shouldSlide = coverageSaysAdvance && coachSaysAdvance;
        } else if (coverageSignalAvailable) {
          shouldSlide = coverageSaysAdvance;
        } else if (coachSignalAvailable) {
          shouldSlide = coachSaysAdvance;
        }

        // 安全网：在同一窗口停留过久（稀疏页无信号、或教师啃不动某点空转）就强制翻，防卡死漏审。
        if (!shouldSlide && windowDwell >= SLIDE_MAX_DWELL) {
          shouldSlide = true;
        }

        if (shouldSlide) {
          const next = slideWindow(sectionPages, {
            startPage: meta.windowStartPage,
            endPage: meta.windowEndPage,
          });
          if (next) {
            meta.windowStartPage = next.startPage;
            meta.windowEndPage = next.endPage;
            recentProgress.length = 0; // 翻完页重置教练计数
            windowDwell = 0; // 翻完页重置停留计数
            await writeMeta(meta);
            yield {
              type: "window_slide",
              turn: turnIdx,
              startPage: next.startPage,
              endPage: next.endPage,
              totalPages: sectionPages.length,
            };
          }
        }
      }

      // ---- 自动停：直到本节结束 ----
      if (AUTO_STOP) {
        const onLastPage = meta.windowEndPage !== undefined &&
          teacherOriginWindow.totalPages > 0 &&
          meta.windowEndPage >= teacherOriginWindow.totalPages;
        const contentDone = coachAnalysis?.contentProgress === "done";
        // 末页覆盖达标：本节最后一个窗口的知识点按 pacing 阈值讲透了
        let lastPageCovered = false;
        if (onLastPage && coverageItems.length > 0 &&
            meta.windowStartPage !== undefined && meta.windowEndPage !== undefined) {
          const { locatable, ratio } = windowCoveredRatio(
            coverageItems, meta.windowStartPage, meta.windowEndPage,
          );
          lastPageCovered = locatable >= SLIDE_MIN_LOCATABLE &&
            ratio >= SLIDE_COVERAGE_THRESHOLD[meta.pacing];
        }
        // 停止条件：教练判 done / 末页且覆盖达标 / 末页且既无教练又无清单 /
        // 末页停留过久（稀疏末页或啃不动，兜底防跑满 200 轮空转）
        const noSignals = !meta.coachEnabled && coverageItems.length === 0;
        const lastPageStuck = onLastPage && windowDwell >= SLIDE_MAX_DWELL;
        if (contentDone || lastPageCovered || (onLastPage && noSignals) || lastPageStuck) {
          meta.maxTurns = turnIdx;
          meta.status = "done";
          await writeMeta(meta);
          break;
        }
      }

      // ---- 触发滑动摘要（如果达到阈值）----
      if (!isLastTurn) {
        const [teacherCompressed, learnerCompressed] = await Promise.all([
          maybeCompress(
            "teacher",
            turns,
            meta.teacherSummary,
            meta.teacherSummaryUpto,
            input.signal,
            recordUsage("audit", turnIdx),
          ),
          maybeCompress(
            "learner",
            turns,
            meta.learnerSummary,
            meta.learnerSummaryUpto,
            input.signal,
            recordUsage("audit", turnIdx),
          ),
        ]);
        if (teacherCompressed) {
          meta.teacherSummary = teacherCompressed.summary;
          meta.teacherSummaryUpto = teacherCompressed.upto;
          await writeMeta(meta);
          yield { type: "compressed", side: "teacher", upto: teacherCompressed.upto };
        }
        if (learnerCompressed) {
          meta.learnerSummary = learnerCompressed.summary;
          meta.learnerSummaryUpto = learnerCompressed.upto;
          await writeMeta(meta);
          yield { type: "compressed", side: "learner", upto: learnerCompressed.upto };
        }
      }

      // ---- 每轮末尾 push 一次 usage 累计给前端 ----
      if (usageDirty) {
        usageDirty = false;
        yield {
          type: "usage",
          promptTokens: cumPromptTokens,
          completionTokens: cumCompletionTokens,
          costCny: cumCostCny,
          cacheHitTokens: cumCacheHitTokens > 0 ? cumCacheHitTokens : undefined,
          cacheMissTokens: cumCacheMissTokens > 0 ? cumCacheMissTokens : undefined,
        };
      }
    }

    meta.status = input.signal.aborted ? "aborted" : "done";
    meta.endedAt = Date.now();
    await writeMeta(meta);
    yield { type: "done", sid: meta.sid };
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
      yield { type: "done", sid: meta.sid };
    } else {
      yield { type: "error", message };
    }
  }
}

/**
 * 启动时调用：把所有 status="running" 的 session 改成 "aborted"（因为进程已经死了）。
 * 这是"进度保持"的一部分：重启后老会话不会显示成"进行中"。
 */
export async function reconcileOnStartup(): Promise<void> {
  const { listDir } = await import("./storage");
  const sids = await listDir(SESSIONS_ROOT);
  for (const sid of sids) {
    const metaPath = path.join(SESSIONS_ROOT, sid, "meta.json");
    if (!(await exists(metaPath))) continue;
    try {
      const m = await readJson<SessionMeta>(metaPath);
      if (m.status === "running") {
        m.status = "aborted";
        m.endedAt = Date.now();
        await writeAtomic(metaPath, JSON.stringify(m, null, 2));
        console.log(
          JSON.stringify({ tag: "session_reconciled", sid, turnsSoFar: m.turnsSoFar }),
        );
      }
    } catch {
      // 坏文件跳过
    }
  }
}
