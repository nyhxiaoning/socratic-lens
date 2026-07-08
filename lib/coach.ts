import path from "node:path";
import { callLLM, type LLMMessage, type Purpose } from "./llm";
import { parseLenientJson } from "./json-repair";
import { PROMPTS_ROOT, readText } from "./storage";
import type { Turn } from "./session";
import type { TeachingMode } from "./teacher";

/** 与 prompts/coach_rules.md 严格对齐（教师教练）。 */
export type CoachAnalysis = {
  companionBehavior:
    | "normal"
    | "looping"
    | "drifting"
    | "criticizing_author"
    | "vague_answers"
    | "too_fast_for_persona"
    | "extending_beyond_text";
  learnerEngagement:
    | "passive"
    | "following"
    | "curious"
    | "deeply_engaged"
    | "frustrated";
  isLearnerDrivingRepetition: boolean;
  isTangent: boolean;
  mainlineTopic: string;
  currentFocus: string;
  learnerWeakPoint: string;
  recentPatterns: string;
  teachingGoalAlignment: "aligned" | "slightly_off" | "off_track";
  recommendedAction:
    | "advance"
    | "deepen"
    | "honor_curiosity"
    | "challenge"
    | "rescue"
    | "address_question"
    | "return_to_mainline"
    | "slow_down_for_persona";
  actionReason: string;
  responsePlaybook: {
    ifShortAck: string;
    ifQuestion: string;
    ifSubstantive: string;
    ifConfused: string;
  };
  qualityFlags: string[];
  /** 教师当前窗口的教学进度（只有本节被分页时才有意义）。缺失时视为 first_half。 */
  contentProgress?: "first_half" | "second_half" | "done";
};

/** 与 prompts/learner_coach_rules.md 严格对齐（学生教练）。 */
export type LearnerCoachAnalysis = {
  understandingLevel: "not_yet" | "superficial" | "working" | "solid" | "deep";
  shouldHaveLearned: string;
  actuallyLearned: string;
  gap: string;
  prosthesisRisk: "none" | "mild" | "strong";
  prosthesisEvidence: string;
  personaFidelity: "faithful" | "drifting" | "broken";
  personaNote: string;
  affect: "engaged" | "anxious" | "frustrated" | "disengaged" | "performing";
  recommendedAction:
    | "ack_and_move_on"
    | "ask_why"
    | "ask_boundary"
    | "ask_analogy"
    | "restate_and_flag_uncertainty"
    | "admit_confusion"
    | "slow_down"
    | "drop_pretraining_hint"
    | "keep_short";
  actionReason: string;
  responsePlaybook: {
    ifTeacherAdvances: string;
    ifTeacherQuestions: string;
    ifTeacherRepeats: string;
    ifTeacherWrong: string;
  };
  qualityFlags: string[];
};

const RECENT_TURNS_FOR_COACH = 10;

const LEARNER_LABEL: Record<string, string> = {
  novice: "novice（新手：几乎没有预备知识，默认反应是『嗯我理解了』，不主动复述、不问边界）",
  mid: "mid（中级：有基础，会复述与追问）",
  critic: "critic（挑刺型：主动找边界与反例）",
};

/**
 * 后台教练分析。观察最近 turns，产出结构化 JSON。失败时返回 null，教师那一轮就不注入。
 */
export async function analyzeWithCoach(opts: {
  bookTitle: string;
  sectionTitle: string;
  learnerId: string;
  pacing: "thorough" | "normal" | "express";
  teachingMode?: TeachingMode;
  turns: Turn[];
  signal?: AbortSignal;
}): Promise<CoachAnalysis | null> {
  const recent = opts.turns.slice(-RECENT_TURNS_FOR_COACH);
  if (recent.length === 0) return null;

  const rules = await readText(path.join(PROMPTS_ROOT, "coach_rules.md"));
  const transcript = recent
    .map((t) => (t.actor === "teacher" ? "【教师】\n" : "【学生】\n") + t.text)
    .join("\n\n---\n\n");

  const mode = opts.teachingMode ?? "socratic";
  const messages: LLMMessage[] = [
    { role: "system", content: rules },
    {
      role: "user",
      content: [
        `# 教练观察`,
        ``,
        `**书**：《${opts.bookTitle}》`,
        `**本节**：${opts.sectionTitle}`,
        `**学生画像**：${LEARNER_LABEL[opts.learnerId] ?? opts.learnerId}`,
        `**教学节奏**：${opts.pacing}`,
        `**教学模式**：${mode}`,
        ``,
        `# 最近对话`,
        ``,
        transcript,
        ``,
        `按 coach_rules 的 JSON schema 输出，只输出 JSON。判断教师推进节奏时**必须**结合上面标出的学生画像——novice 场景下推进过快就报 \`too_fast_for_persona\`。${mode === "close_reading" ? "**本会话为句读模式**：教师引原文外的话（注疏 / 类比 / 现代对应）或跨文本联想 → 报 `extending_beyond_text`（优先级最高）。" : ""}`,
      ].join("\n"),
    },
  ];

  try {
    const raw = await callLLM("coach" as Purpose, messages, {
      stream: false,
      temperature: 0.2,
      maxTokens: 1200,
      jsonMode: true,
      signal: opts.signal,
    });
    const parsed = parseLenientJson<CoachAnalysis>(raw);
    if (!parsed) return null;
    // 基本合法性校验：几个 enum 字段
    if (!parsed.companionBehavior || !parsed.recommendedAction) return null;
    if (!parsed.responsePlaybook) return null;
    if (!Array.isArray(parsed.qualityFlags)) parsed.qualityFlags = [];
    return parsed;
  } catch (err) {
    console.log(
      JSON.stringify({
        tag: "coach_error",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
}

/**
 * 把教练分析渲染成一段 markdown，注入教师下一轮 system prompt 末尾。
 */
export function renderCoachBlock(a: CoachAnalysis): string {
  const flags = a.qualityFlags.length > 0 ? `\n- **质量标记**：${a.qualityFlags.join(" / ")}` : "";
  const tangent = a.isTangent && a.mainlineTopic
    ? `\n- **⚠️ 已跑题**，主线是：${a.mainlineTopic}`
    : "";
  const repetition = a.isLearnerDrivingRepetition
    ? `\n- **⚠️ 学生在推动同一点反复被讲**——换讲法而不是重复。`
    : "";

  return [
    `## 教练分析（上一轮由后台生成，仅供你参考）`,
    ``,
    `- **你上一轮的行为倾向**：\`${a.companionBehavior}\`${a.companionBehavior !== "normal" ? "（这一轮请修正）" : ""}`,
    `- **学生当前状态**：\`${a.learnerEngagement}\``,
    `- **主线对齐度**：\`${a.teachingGoalAlignment}\``,
    `- **当前焦点**：${a.currentFocus}`,
    `- **学生薄弱点**：${a.learnerWeakPoint}`,
    `- **近期对话模式**：${a.recentPatterns}${tangent}${repetition}${flags}`,
    ``,
    `### 教练推荐的下一步：\`${a.recommendedAction}\``,
    `**理由**：${a.actionReason}`,
    ``,
    `### 分情况 playbook（下一句学生说什么，你就走哪一支）`,
    `- 学生只回"嗯/好"：${a.responsePlaybook.ifShortAck}`,
    `- 学生提问：${a.responsePlaybook.ifQuestion}`,
    `- 学生给出实质回答：${a.responsePlaybook.ifSubstantive}`,
    `- 学生表达困惑：${a.responsePlaybook.ifConfused}`,
  ].join("\n");
}

// ============================================================================
// 学生教练
// ============================================================================

export async function analyzeLearnerWithCoach(opts: {
  bookTitle: string;
  sectionTitle: string;
  learnerId: string;
  pacing: "thorough" | "normal" | "express";
  teachingMode?: TeachingMode;
  turns: Turn[];
  signal?: AbortSignal;
}): Promise<LearnerCoachAnalysis | null> {
  const recent = opts.turns.slice(-RECENT_TURNS_FOR_COACH);
  if (recent.length === 0) return null;

  const rules = await readText(path.join(PROMPTS_ROOT, "learner_coach_rules.md"));
  const transcript = recent
    .map((t) => (t.actor === "teacher" ? "【教师】\n" : "【学生】\n") + t.text)
    .join("\n\n---\n\n");

  const mode = opts.teachingMode ?? "socratic";
  const messages: LLMMessage[] = [
    { role: "system", content: rules },
    {
      role: "user",
      content: [
        `# 学生教练观察`,
        ``,
        `**书**：《${opts.bookTitle}》`,
        `**本节**：${opts.sectionTitle}`,
        `**学生画像**：${LEARNER_LABEL[opts.learnerId] ?? opts.learnerId}`,
        `**教学节奏**：${opts.pacing}`,
        `**教学模式**：${mode}`,
        ``,
        `# 最近对话`,
        ``,
        transcript,
        ``,
        `按 learner_coach_rules 的 JSON schema 输出，只输出 JSON。${mode === "close_reading" ? "**本会话为句读模式**：学生把原文说成现代话 → qualityFlags 加 `modernization_pressure`；学生带外部文本联想（\"这跟 XX 里一样吗\"）→ qualityFlags 加 `cross_text_pressure`。" : ""}`,
      ].join("\n"),
    },
  ];

  try {
    const raw = await callLLM("coach" as Purpose, messages, {
      stream: false,
      temperature: 0.2,
      maxTokens: 1200,
      jsonMode: true,
      signal: opts.signal,
    });
    const parsed = parseLenientJson<LearnerCoachAnalysis>(raw);
    if (!parsed) return null;
    if (!parsed.understandingLevel || !parsed.recommendedAction) return null;
    if (!parsed.responsePlaybook) return null;
    if (!Array.isArray(parsed.qualityFlags)) parsed.qualityFlags = [];
    return parsed;
  } catch (err) {
    console.log(
      JSON.stringify({
        tag: "learner_coach_error",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return null;
  }
}

/** 把学生教练分析渲染成 markdown，注入学生下一轮 system prompt 末尾。 */
export function renderLearnerCoachBlock(a: LearnerCoachAnalysis): string {
  const flags = a.qualityFlags.length > 0
    ? `\n- **质量标记**：${a.qualityFlags.join(" / ")}`
    : "";
  const prosthesis = a.prosthesisRisk !== "none"
    ? `\n- **⚠️ 预训练知识泄露风险 (${a.prosthesisRisk})**：${a.prosthesisEvidence}\n  —— 这一轮开始，只用老师说过的话回应，忘掉那个术语/结论。`
    : "";
  const persona = a.personaFidelity !== "faithful"
    ? `\n- **⚠️ 画像漂移 (${a.personaFidelity})**：${a.personaNote}\n  —— 回到你的档位该有的反应。`
    : "";

  return [
    `## 学习教练分析（上一轮由后台生成，仅供你参考）`,
    ``,
    `- **你对当前焦点的理解程度**：\`${a.understandingLevel}\``,
    `- **老师此刻应该讲清楚的**：${a.shouldHaveLearned}`,
    `- **你实际学到的**：${a.actuallyLearned}`,
    `- **落差**：${a.gap}`,
    `- **当下心态**：\`${a.affect}\`${prosthesis}${persona}${flags}`,
    ``,
    `### 教练推荐你下一步：\`${a.recommendedAction}\``,
    `**理由**：${a.actionReason}`,
    ``,
    `### 分情况参考（**只是备胎——你想不到怎么说时，可以从下面挑一支来做**；如果你自己已经有想说的，别翻这段）`,
    `- 老师推进到新点：${a.responsePlaybook.ifTeacherAdvances}`,
    `- 老师抛问题让你答：${a.responsePlaybook.ifTeacherQuestions}`,
    `- 老师在重复之前的点：${a.responsePlaybook.ifTeacherRepeats}`,
    `- 你觉得老师讲错或跳步了：${a.responsePlaybook.ifTeacherWrong}`,
    ``,
    `**注意**：这份 playbook 是给你**兜底**的，不是硬性剧本。不要 4 条挨着回；也不要每轮都精准套一条——真的学生反应比这乱、比这散、比这不齐整。`,
  ].join("\n");
}
