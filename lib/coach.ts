import path from "node:path";
import { callLLM, type LLMMessage, type Purpose } from "./llm";
import { PROMPTS_ROOT, readText } from "./storage";
import type { Turn } from "./session";

/** 与 prompts/coach_rules.md 严格对齐。 */
export type CoachAnalysis = {
  companionBehavior:
    | "normal"
    | "looping"
    | "drifting"
    | "criticizing_author"
    | "vague_answers";
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
    | "return_to_mainline";
  actionReason: string;
  responsePlaybook: {
    ifShortAck: string;
    ifQuestion: string;
    ifSubstantive: string;
    ifConfused: string;
  };
  qualityFlags: string[];
};

const RECENT_TURNS_FOR_COACH = 10;

/**
 * 剥掉 LLM 输出里可能的 markdown 代码围栏与 <think> 块，返回纯 JSON 字符串。
 */
function stripFences(raw: string): string {
  let s = raw.trim();
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  // 代码围栏
  const fenceMatch = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i);
  if (fenceMatch) return fenceMatch[1].trim();
  // 一些模型会在 JSON 前后加解释——取第一个 { 到最后一个 } 之间
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last > first) return s.slice(first, last + 1);
  return s;
}

/**
 * 后台教练分析。观察最近 turns，产出结构化 JSON。失败时返回 null，教师那一轮就不注入。
 */
export async function analyzeWithCoach(opts: {
  bookTitle: string;
  sectionTitle: string;
  pacing: "thorough" | "normal" | "express";
  turns: Turn[];
  signal?: AbortSignal;
}): Promise<CoachAnalysis | null> {
  const recent = opts.turns.slice(-RECENT_TURNS_FOR_COACH);
  if (recent.length === 0) return null;

  const rules = await readText(path.join(PROMPTS_ROOT, "coach_rules.md"));
  const transcript = recent
    .map((t) => (t.actor === "teacher" ? "【教师】\n" : "【学生】\n") + t.text)
    .join("\n\n---\n\n");

  const messages: LLMMessage[] = [
    { role: "system", content: rules },
    {
      role: "user",
      content: [
        `# 教练观察`,
        ``,
        `**书**：《${opts.bookTitle}》`,
        `**本节**：${opts.sectionTitle}`,
        `**教学节奏**：${opts.pacing}`,
        ``,
        `# 最近对话`,
        ``,
        transcript,
        ``,
        `按 coach_rules 的 JSON schema 输出，只输出 JSON。`,
      ].join("\n"),
    },
  ];

  try {
    // OpenAI 兼容 response_format=json_object；非流式
    const raw = await callLLM("coach" as Purpose, messages, {
      stream: false,
      temperature: 0.2,
      maxTokens: 1200,
      jsonMode: true,
      signal: opts.signal,
    });
    const cleaned = stripFences(raw);
    const parsed = JSON.parse(cleaned) as CoachAnalysis;
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
