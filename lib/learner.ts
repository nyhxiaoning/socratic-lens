import path from "node:path";
import { BookManifest, getSectionTitle } from "./book";
import type { LearnerCoachAnalysis } from "./coach";
import { LLMMessage } from "./llm";
import { PROMPTS_ROOT, readText } from "./storage";
import { readLearnerCard, type LearnerId, type TeachingMode } from "./teacher";

export async function buildLearnerSystemPrompt(
  book: BookManifest,
  sectionId: string,
  learnerId: LearnerId,
  coach: LearnerCoachAnalysis | null,
  teachingMode: TeachingMode = "socratic",
): Promise<string> {
  const card = await readLearnerCard(learnerId);
  const sectionTitle = getSectionTitle(book, sectionId);

  const parts: string[] = [
    `## 你是谁\n\n${card}`,
    `## 你在做什么\n\n你正在被一位老师一对一辅导，学习《${book.title}》的一节：§${sectionId} ${sectionTitle}。${teachingMode === "close_reading" ? "老师会**句读式**地一半句一半句地讲。" : ""}\n你没有读过这本书；你只能从老师的话里学。`,
    `## 你的五种提问本能\n\n1. **为什么链**——听到结论就想知道原因。\n2. **边界试探**——听懂规律就想知道它在什么条件下不成立、什么时候会失效。\n3. **求打比方**——遇到抽象概念就求一个生活里的例子。\n4. **联想串线**——新东西让你想起之前老师教过的、或你自己知道的（前提：真实想起来了，不许编造"你上次教我"）。\n5. **复述验证**——觉得自己懂了，就用自己的话复述一遍请老师检查，主动指出**最没把握**的地方。\n\n每轮回应最多用一种本能，别把话堆满。**不是**每轮都必须用一种——你可以只应一声、只卡在字面上、只表达困惑，什么本能都不用。`,
    `## 严格禁用\n\n- 不许说"根据我预训练的知识 / 作为 AI 我知道"这类话。你就是一个学生。\n- 不许自曝是 AI、是 LLM、是模型、是"我在扮演学生"。\n- 不许写神态动作旁白（\`*笑了笑*\` / \`（皱眉）\` / \`【思考中】\` 一律不许）。\n- 不许用 emoji。\n- 不许"跳过讲解自己答出正确答案"来炫耀——你是来学的。老师问什么就先诚实地反应。\n- 如果老师讲了一个你觉得"看起来对但心里犯嘀咕"的地方，按本能 2 或 5 说出来，不要装懂。`,
    `## 引用协议\n\n如果你看到老师用 \`〔§...｜...〕\` 引用了书里的原文片段，你可以在提问里直接引用同一个标记。你自己不要凭空造这个标记。`,
  ];

  if (teachingMode === "close_reading") {
    const discipline = await readText(path.join(PROMPTS_ROOT, "close_reading_discipline.md"));
    parts.push(discipline);
  }

  // 教练块**不再拼进 system**（每轮都变会破坏 DeepSeek 缓存前缀）。改由 buildLearnerMessages
  // 追加到 messages 尾部。coach 参数保留仅为兼容签名。
  void coach;

  return parts.join("\n\n---\n\n");
}

/** 学生看到的对话：教师说的话是 user，自己说的话是 assistant。
 * coachBlock（若有）作为**最后一条 user 消息**追加，理由同教师侧（缓存命中）。 */
export function buildLearnerMessages(
  systemPrompt: string,
  turns: { actor: "teacher" | "learner"; text: string }[],
  coachBlock?: string | null,
): LLMMessage[] {
  const msgs: LLMMessage[] = [{ role: "system", content: systemPrompt }];
  for (const t of turns) {
    msgs.push({
      role: t.actor === "teacher" ? "user" : "assistant",
      content: t.text,
    });
  }
  if (coachBlock && coachBlock.trim()) {
    msgs.push({ role: "user", content: coachBlock });
  }
  return msgs;
}
