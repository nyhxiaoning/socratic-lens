export type LearnerId = "novice" | "mid" | "critic";
export type Pacing = "thorough" | "normal" | "express";

export const LEARNERS: { id: LearnerId; label: string; desc: string }[] = [
  { id: "novice", label: "新手", desc: "没啥预备知识，多问为什么、求例子" },
  { id: "mid", label: "中级", desc: "有基础，会复述、会追问细节" },
  { id: "critic", label: "挑刺型", desc: "主动找边界与反例，容易质疑" },
];

export const PACINGS: { id: Pacing; label: string; desc: string }[] = [
  { id: "thorough", label: "细", desc: "拆到最细，多复述多例子" },
  { id: "normal", label: "中", desc: "正常节奏，每 2-3 轮复述一次" },
  { id: "express", label: "快", desc: "跳过基础，直奔核心" },
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
    }
  | { type: "done"; sid: string }
  | { type: "error"; message: string };

export type AuditEvent =
  | { type: "audit_start"; aid: string; sids: string[]; sectionIds: string[] }
  | { type: "audit_chunk"; text: string }
  | { type: "audit_done"; aid: string; report: { raw: string } }
  | { type: "audit_error"; message: string };

export const CITE_RE = /〔§([\w-]{1,32})(?:[｜|]([^〕\n]{0,120}))?〕/g;

export const SECTION_LABELS: Record<string, string> = {
  VERDICT: "一句话结论",
  CLARITY: "表达清晰度问题",
  HARD_SPOTS: "学生真正卡住的点",
  INCONSISTENCY: "教师讲的 vs 原文（关键）",
  SUGGESTIONS: "对书本身的修改建议",
};
