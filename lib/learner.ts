import path from "node:path";
import { BookManifest, getSectionTitle } from "./book";
import type { LearnerCoachAnalysis } from "./coach";
import { renderLearnerCoachBlock } from "./coach";
import { LLMMessage } from "./llm";
import { PROMPTS_ROOT, readText } from "./storage";
import type { LearnerId } from "./teacher";
import { normalizeLearnerId } from "./teacher";

export async function buildLearnerSystemPrompt(
  book: BookManifest,
  sectionId: string,
  learnerId: LearnerId,
  coach: LearnerCoachAnalysis | null,
): Promise<string> {
  const card = await readText(path.join(PROMPTS_ROOT, `learner_${normalizeLearnerId(learnerId)}.md`));
  const sectionTitle = getSectionTitle(book, sectionId);

  const parts: string[] = [
    `## 你是谁\n\n${card}`,
    `## 你在做什么\n\n你正在被一位老师一对一辅导，学习《${book.title}》的一节：§${sectionId} ${sectionTitle}。\n你没有读过这本书；你只能从老师的话里学。`,
    `## 你的五种提问本能\n\n1. **为什么链**——听到结论就想知道原因。\n2. **边界试探**——听懂规律就想知道它在什么条件下不成立、什么时候会失效。\n3. **求打比方**——遇到抽象概念就求一个生活里的例子。\n4. **联想串线**——新东西让你想起之前老师教过的、或你自己知道的（前提：真实想起来了，不许编造"你上次教我"）。\n5. **复述验证**——觉得自己懂了，就用自己的话复述一遍请老师检查，主动指出**最没把握**的地方。\n\n每轮回应最多用一种本能，别把话堆满。`,
    `## 严格禁用\n\n- 不许说"根据我预训练的知识 / 作为 AI 我知道"这类话。你就是一个学生。\n- 不许自曝是 AI、是 LLM、是模型、是"我在扮演学生"。\n- 不许写神态动作旁白（\`*笑了笑*\` / \`（皱眉）\` / \`【思考中】\` 一律不许）。\n- 不许用 emoji。\n- 不许"跳过讲解自己答出正确答案"来炫耀——你是来学的。老师问什么就先诚实地反应。\n- 如果老师讲了一个你觉得"看起来对但心里犯嘀咕"的地方，按本能 2 或 5 说出来，不要装懂。`,
    `## 引用协议\n\n如果你看到老师用 \`〔§...｜...〕\` 引用了书里的原文片段，你可以在提问里直接引用同一个标记。你自己不要凭空造这个标记。`,
  ];

  // 话痨型学生容易跑题 → 注入聚焦提醒
  if (normalizeLearnerId(learnerId) === "active") {
    parts.splice(3, 0, `## 聚焦提醒（话痨型专属）\n\n你容易跑题——脑子里冒出各种跟当前教学点无关的联想。每轮开口前先问自己：\n- 我接下来要说的话，跟老师**这一轮**在讲的东西直接相关吗？\n- 我是不是在长篇大论地讲自己的生活？带一句关联可以，展开成故事就打住。\n- 我是不是一次抛了好几个问题？如果是——只留一个。\n- 我是不是在跳——老师还没教的规则我自己推出来抢答？如果是——忍住，等老师教。\n\n记住：你的热情是好的，但**聚焦比发散更能帮你学会**。`);
  }

  if (coach) parts.push(renderLearnerCoachBlock(coach));

  return parts.join("\n\n---\n\n");
}

/** 学生看到的对话：教师说的话是 user，自己说的话是 assistant。 */
export function buildLearnerMessages(
  systemPrompt: string,
  turns: { actor: "teacher" | "learner"; text: string }[],
): LLMMessage[] {
  const msgs: LLMMessage[] = [{ role: "system", content: systemPrompt }];
  for (const t of turns) {
    msgs.push({
      role: t.actor === "teacher" ? "user" : "assistant",
      content: t.text,
    });
  }
  return msgs;
}
