export type LearnerId = "passive" | "moderate" | "active";
export type Pacing = "thorough" | "normal" | "express";

export type CoverageCategory = "knowledgePoint" | "criteria" | "exercise" | "errorSpot";

export type CoverageItem = {
  id: string;
  category: CoverageCategory;
  name: string;
  sourceQuote: string;
  status: "uncovered" | "covered";
  evidence?: string;
  coveredAtTurn?: number;
};

export type CoverageStats = {
  total: number;
  covered: number;
  byCategory: Record<CoverageCategory, { total: number; covered: number }>;
};

export const LEARNERS: { id: LearnerId; label: string; desc: string }[] = [
  { id: "passive", label: "冷淡（问一句答一句）", desc: "不主动提问，回复极短。用来看书在最省力的学生身上还能不能讲清。" },
  { id: "moderate", label: "适度（正常互动）", desc: "不懂就问，中等篇幅。最接近普通学生。" },
  { id: "active", label: "话痨（追问联想）", desc: "热情话多，主动追问、容易跑题。用来压力测试书的边界。" },
];

export const PACINGS: { id: Pacing; label: string; desc: string }[] = [
  { id: "thorough", label: "细讲（拆到最细）", desc: "拆到最细，多复述、多举例。适合难点密集的内容。" },
  { id: "normal", label: "正常", desc: "常规节奏，每 2-3 轮复述一次。" },
  { id: "express", label: "快讲（直奔核心）", desc: "跳过基础，直奔核心。适合快速预习/复习。" },
];

export type CoachAnalysis = {
  companionBehavior: string;
  learnerEngagement: string;
  isLearnerDrivingRepetition: boolean;
  isTangent: boolean;
  mainlineTopic: string;
  currentFocus: string;
  learnerWeakPoint: string;
  recentPatterns: string;
  teachingGoalAlignment: string;
  recommendedAction: string;
  actionReason: string;
  responsePlaybook: {
    ifShortAck: string;
    ifQuestion: string;
    ifSubstantive: string;
    ifConfused: string;
  };
  qualityFlags: string[];
  contentProgress?: string;
};

export type LearnerCoachAnalysis = {
  understandingLevel: string;
  shouldHaveLearned: string;
  actuallyLearned: string;
  gap: string;
  prosthesisRisk: string;
  prosthesisEvidence: string;
  personaFidelity: string;
  personaNote: string;
  affect: string;
  recommendedAction: string;
  actionReason: string;
  responsePlaybook: {
    ifTeacherAdvances: string;
    ifTeacherQuestions: string;
    ifTeacherRepeats: string;
    ifTeacherWrong: string;
  };
  qualityFlags: string[];
};

export type Msg = { turn: number; actor: "teacher" | "learner"; text: string };

/** 每一节的 §id → 该节里教师说过的所有引用（含 hit 结果）。 */
export type CitationLookup = Map<
  number, // turn
  { sectionId: string; snippet: string; hit: boolean }[]
>;

export type SectionStat = { id: string; title: string; chars: number };
export type BookSummary = {
  slug: string;
  title: string;
  author?: string;
  sectionCount: number;
  totalChars: number;
  sections: SectionStat[];
};
export type SectionMeta = { id: string; title: string };
export type BookDetail = {
  slug: string;
  title: string;
  author?: string;
  sections: SectionMeta[];
};

export type SessionListItem = {
  sid: string;
  bookSlug: string;
  sectionId: string;
  learnerId: LearnerId;
  startedAt: number;
  status: string;
  maxTurns?: number;
  turnsSoFar?: number;
  pacing?: Pacing;
};

export type SessionEvent =
  | { type: "meta"; meta: { sid: string; turnsSoFar?: number } }
  | { type: "turn_start"; actor: "teacher" | "learner"; turn: number }
  | { type: "chunk"; actor: "teacher" | "learner"; turn: number; text: string }
  | { type: "turn_end"; actor: "teacher" | "learner"; turn: number; text: string }
  | {
      type: "coach";
      turn: number;
      side: "teacher" | "learner";
      analysis: CoachAnalysis | LearnerCoachAnalysis;
    }
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
      promptTokens: number;
      completionTokens: number;
      costCny: number;
      cacheHitTokens?: number;
      cacheMissTokens?: number;
    }
  | { type: "done"; sid: string }
  | { type: "error"; message: string }
  | { type: "coverage_init"; items: CoverageItem[] }
  | { type: "coverage_update"; items: CoverageItem[]; newlyCovered: string[]; stats: CoverageStats };

export type AuditDimension = "book" | "teacher" | "fidelity" | "coverage";

export type AuditHistoryItem = {
  aid: string;
  bookSlug: string;
  dimension: AuditDimension;
  sectionIds: string[];
  sidCount: number;
  verdict: string;
  ts: number;
};

export type AuditEvent =
  | { type: "audit_start"; aid: string; dimension?: AuditDimension; sids?: string[]; sectionIds?: string[]; sampleName?: string }
  | { type: "audit_chunk"; text: string }
  | { type: "audit_done"; aid: string; report: { raw: string } }
  | { type: "audit_error"; message: string };

export const CITE_RE = /〔§([\w-]{1,32})(?:[｜|]([^〕\n]{0,120}))?〕/g;

export const SECTION_LABELS: Record<string, string> = {
  // 书质量维度
  VERDICT: "一句话结论",
  CLARITY: "表达清晰度问题",
  HARD_SPOTS: "学生真正卡住的点",
  INCONSISTENCY: "教师讲的 vs 原文（关键）",
  SUGGESTIONS: "对书本身的修改建议",
  // 教师教学质量维度
  METHOD: "苏格拉底提问执行质量",
  PERSONA_FIT: "画像/节奏适配",
  RULE_VIOLATIONS: "违反铁律（关键）",
  RULE_SUGGESTIONS: "对教师约束的修改建议",
  // Fidelity 保真度维度
  VERDICT_FIDELITY: "总评",
  COVERAGE: "覆盖率",
  KNOWLEDGE_CHECK: "知识点 / 评价标准 / 易错点 勾稽",
  EXERCISE_CHECK: "教材原题勾稽",
  // 教学覆盖度维度（复用 fidelity 标签，report 是纯 markdown 无 ===TAG===）
};

export const AUDIT_DIMENSIONS: {
  id: AuditDimension;
  label: string;
  desc: string;
  /** basic=主动线常用；advanced=需要额外前提，收进「高级」 */
  tier: "basic" | "advanced";
  /** 一句话讲「能看出什么」 */
  outcome: string;
  /** 前提条件说明（没有前提就为空） */
  requires?: string;
}[] = [
  {
    id: "book",
    label: "审书",
    desc: "审这本书讲得清不清，产出面向更新造书流程",
    tier: "basic",
    outcome: "看出书里哪些地方表达不清、哪些是学生真卡住的点、教师讲的和原文有没有出入。",
  },
  {
    id: "teacher",
    label: "审教学",
    desc: "审教师照约束教得对不对，产出面向更新教师约束",
    tier: "basic",
    outcome: "看出教师的苏格拉底提问执行得好不好、有没有违反铁律、适不适配学生和节奏。",
  },
  {
    id: "coverage",
    label: "教学覆盖度",
    desc: "审教师对话里有没有覆盖源材料/书本的所有知识点",
    tier: "advanced",
    outcome: "看出对话里到底覆盖了多少知识点、哪些漏讲了。",
    requires: "需要先为该节生成「知识点清单」（面板里可一键生成）。",
  },
  {
    id: "fidelity",
    label: "保真度",
    desc: "审合成节有没有丢/歪源材料的教学目标、知识点、原题",
    tier: "advanced",
    outcome: "看出合成的书相对源材料，有没有丢失或改歪教学目标、知识点、原题。",
    requires: "需要在 data/fidelity-samples/ 下准备「源材料 + 合成节」样本。",
  },
];
