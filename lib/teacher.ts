import path from "node:path";
import { BookManifest, getSection, getSectionTitle } from "./book";
import type { CoachAnalysis } from "./coach";
import { renderCoachBlock } from "./coach";
import { LLMMessage } from "./llm";
import { PROMPTS_ROOT, readText } from "./storage";

export type LearnerId = "novice" | "mid" | "critic";
export type Pacing = "thorough" | "normal" | "express";

const PACING_LABEL: Record<Pacing, string> = {
  thorough: "thorough（细）",
  normal: "normal（中）",
  express: "express（快）",
};

/**
 * 组装教师 system prompt。参照 Socratopia §3.1 主对话 22 段骨架，
 * 但砍掉了对我们语境无用的段（人设 / 世界 / 关系 / 群聊 / handoff / 精力）。
 * 保留：规则、学生、教材、本节原文、教材库、节奏、引用、铁律 —— 加上可选的教练分析块。
 */
export async function buildTeacherSystemPrompt(
  book: BookManifest,
  bookSlug: string,
  sectionId: string,
  learnerId: LearnerId,
  pacing: Pacing,
  coach: CoachAnalysis | null,
): Promise<string> {
  const rules = await readText(path.join(PROMPTS_ROOT, "teacher_rules.md"));
  const learnerCard = await readText(path.join(PROMPTS_ROOT, `learner_${learnerId}.md`));
  const sectionText = await getSection(bookSlug, sectionId);
  const sectionTitle = getSectionTitle(book, sectionId);

  const otherSections = book.sections
    .filter((s) => s.id !== sectionId)
    .map((s) => `- §${s.id} ${s.title}`)
    .join("\n");

  const parts: string[] = [
    `## 教学规则\n\n${rules}`,
    `## 你的学生\n\n${learnerCard}`,
    `## 当前教材\n\n《${book.title}》${book.author ? `　作者：${book.author}` : ""}\n本节：§${sectionId} ${sectionTitle}`,
    `## 本节原文（唯一允许引用的文本，逐字引）\n\n--- 第 §${sectionId} 部分 ---\n${sectionText}\n--- 本节完 ---`,
    otherSections
      ? `## 教材库（其它节标题，本次不许讲）\n\n${otherSections}`
      : `## 教材库\n\n（只有本节）`,
    `## 本节课节奏档位\n\n**${PACING_LABEL[pacing]}** ——${pacingHint(pacing)}`,
    `## 引用格式\n\n引用书中原文用：〔§${sectionId}｜前若干字〕，例如 〔§${sectionId}｜${sectionText.trim().slice(0, 10)}〕。\n只能引用「本节原文」段落里逐字存在的片段；引本节以外的任何内容都算越界。`,
    `## 铁律（最后一遍强调）\n\n- 严禁讲本节原文之外的知识（哪怕你"知道"）。\n- 严禁假装读过其它章节。\n- 严禁 AI 式积极表扬（"太棒了"/"回答得非常好"）。\n- 严禁 emoji 与动作神态描写（\`*微笑*\` / \`（点头）\` 一律不许）。\n- 严禁主动说"下课"/"今天先到这里"——由上层控制。\n- 每条消息必须以问题结尾，且最多讲一个点。`,
  ];

  // 教练分析块（如果有）永远放最末——参照 §3.1 第 22 段
  if (coach) {
    parts.push(renderCoachBlock(coach));
  }

  return parts.join("\n\n---\n\n");
}

function pacingHint(pacing: Pacing): string {
  switch (pacing) {
    case "thorough":
      return `拆到最细。多例子、多复述。学生"能自己举反例"才算懂，不是"答对一次"。`;
    case "express":
      return "假设学生学得快。跳过基础问答，直奔核心；只在学生显示困惑时才停下来展开。";
    case "normal":
    default:
      return "每 2-3 轮做一次复述检查；答对推进、答错回到子问题。";
  }
}

/** 教师看到的对话：学生说的话是 user，自己说的话是 assistant。第一轮注入 opening trigger。 */
export function buildTeacherMessages(
  systemPrompt: string,
  turns: { actor: "teacher" | "learner"; text: string }[],
  openingTrigger: string,
): LLMMessage[] {
  const msgs: LLMMessage[] = [{ role: "system", content: systemPrompt }];
  if (turns.length === 0) {
    msgs.push({ role: "user", content: openingTrigger });
    return msgs;
  }
  for (const t of turns) {
    msgs.push({
      role: t.actor === "learner" ? "user" : "assistant",
      content: t.text,
    });
  }
  return msgs;
}

export const TEACHER_OPENING_TRIGGER = "请开始今天的第一课。用一两句话切入主题，再问我第一个问题。";
