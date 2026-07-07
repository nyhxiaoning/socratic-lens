import path from "node:path";
import { BookManifest, getSection, getSectionTitle } from "./book";
import { LLMMessage } from "./llm";
import { PROMPTS_ROOT, readText } from "./storage";

export type LearnerId = "novice" | "mid" | "critic";

export async function buildTeacherSystemPrompt(
  book: BookManifest,
  bookSlug: string,
  sectionId: string,
  learnerId: LearnerId,
): Promise<string> {
  const rules = await readText(path.join(PROMPTS_ROOT, "teacher_rules.md"));
  const learnerCard = await readText(path.join(PROMPTS_ROOT, `learner_${learnerId}.md`));
  const sectionText = await getSection(bookSlug, sectionId);
  const sectionTitle = getSectionTitle(book, sectionId);

  const otherSections = book.sections
    .filter((s) => s.id !== sectionId)
    .map((s) => `- §${s.id} ${s.title}`)
    .join("\n");

  const parts = [
    `## 教学规则\n\n${rules}`,
    `## 你的学生\n\n${learnerCard}`,
    `## 当前教材\n\n《${book.title}》${book.author ? `　作者：${book.author}` : ""}\n本节：§${sectionId} ${sectionTitle}`,
    `## 本节原文（唯一允许引用的文本，逐字引）\n\n--- 第 §${sectionId} 部分 ---\n${sectionText}\n--- 本节完 ---`,
    otherSections
      ? `## 教材库（其它节标题，本次不许讲）\n\n${otherSections}`
      : `## 教材库\n\n（只有本节）`,
    `## 教学节奏\n\n- 每次消息最多讲一个点。\n- 每次消息以一个能引发学生思考的问题结尾。\n- 学生答错时，先问"你是怎么想到这里的"，再给正确解释。`,
    `## 引用格式\n\n引用书中原文用：〔§${sectionId}｜前若干字〕，例如 〔§${sectionId}｜${sectionText.trim().slice(0, 10)}〕。\n只能引用「本节原文」段落里逐字存在的片段；引本节以外的任何内容都算越界。`,
    `## 铁律\n\n- 严禁讲本节原文之外的知识（哪怕你"知道"）。\n- 严禁假装读过其它章节。\n- 严禁 AI 式积极表扬（"太棒了"/"回答得非常好"）。\n- 严禁 emoji 与动作神态描写（\`*微笑*\` / \`（点头）\` 一律不许）。\n- 你在教学生，不是在被评估——不要问"我讲清楚了吗"这种元问题，用具体的检验性问题让学生暴露理解。`,
  ];

  return parts.join("\n\n---\n\n");
}

/** 教师看到的对话：学生说的话是 user，自己说的话是 assistant。第一轮 assistantSaid 为空。 */
export function buildTeacherMessages(
  systemPrompt: string,
  turns: { actor: "teacher" | "learner"; text: string }[],
  openingTrigger: string,
): LLMMessage[] {
  const msgs: LLMMessage[] = [{ role: "system", content: systemPrompt }];
  if (turns.length === 0) {
    // 第一轮：注入一条虚构 user 消息触发开场
    msgs.push({ role: "user", content: openingTrigger });
    return msgs;
  }
  // 后续轮：教师视角，learner=user, teacher=assistant
  for (const t of turns) {
    msgs.push({
      role: t.actor === "learner" ? "user" : "assistant",
      content: t.text,
    });
  }
  return msgs;
}

export const TEACHER_OPENING_TRIGGER = "请开始今天的第一课。用一两句话切入主题，再问我第一个问题。";
