import { Row } from "./Field";
import type { CoachAnalysis, LearnerCoachAnalysis } from "./types";

const BEHAVIOR_COLORS: Record<string, string> = {
  normal: "var(--muted)",
  looping: "var(--danger)",
  drifting: "var(--danger)",
  criticizing_author: "var(--danger)",
  vague_answers: "var(--danger)",
};
const ENGAGEMENT_COLORS: Record<string, string> = {
  passive: "var(--muted)",
  following: "var(--muted)",
  curious: "var(--accent)",
  deeply_engaged: "var(--accent)",
  frustrated: "var(--danger)",
};

const UNDERSTANDING_COLORS: Record<string, string> = {
  not_yet: "var(--danger)",
  superficial: "var(--danger)",
  working: "var(--muted)",
  solid: "var(--accent)",
  deep: "var(--accent)",
};
const PROSTHESIS_COLORS: Record<string, string> = {
  none: "var(--muted)",
  mild: "var(--danger)",
  strong: "var(--danger)",
};
const PERSONA_COLORS: Record<string, string> = {
  faithful: "var(--muted)",
  drifting: "var(--danger)",
  broken: "var(--danger)",
};

type CoachSidebarProps = {
  visible: boolean;
  coachTab: "teacher" | "learner";
  onTabChange: (tab: "teacher" | "learner") => void;
  onCollapse: () => void;
  coachHistory: { turn: number; analysis: CoachAnalysis }[];
  learnerCoachHistory: { turn: number; analysis: LearnerCoachAnalysis }[];
};

export function CoachSidebar({
  visible,
  coachTab,
  onTabChange,
  onCollapse,
  coachHistory,
  learnerCoachHistory,
}: CoachSidebarProps) {
  if (!visible) return null;
  return (
    <aside
      style={{
        overflowY: "auto",
        padding: 12,
        background: "var(--panel)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        fontSize: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <div style={{ display: "flex", gap: 4 }}>
          <button
            onClick={() => onTabChange("teacher")}
            className={coachTab === "teacher" ? "primary" : ""}
            style={{ padding: "2px 8px", fontSize: 12 }}
          >
            教师教练 ({coachHistory.length})
          </button>
          <button
            onClick={() => onTabChange("learner")}
            className={coachTab === "learner" ? "primary" : ""}
            style={{ padding: "2px 8px", fontSize: 12 }}
          >
            学生教练 ({learnerCoachHistory.length})
          </button>
        </div>
        <button style={{ padding: "2px 6px", fontSize: 11 }} onClick={onCollapse}>
          收起
        </button>
      </div>
      {coachTab === "teacher" ? (
        coachHistory.length === 0 ? (
          <div style={{ color: "var(--muted)" }}>
            每轮结束后教师教练会在这里放一份分析。
          </div>
        ) : (
          coachHistory
            .slice()
            .reverse()
            .map((c) => <CoachCard key={c.turn} turn={c.turn} a={c.analysis} />)
        )
      ) : learnerCoachHistory.length === 0 ? (
        <div style={{ color: "var(--muted)" }}>
          每轮结束后学生教练会在这里放一份分析。
        </div>
      ) : (
        learnerCoachHistory
          .slice()
          .reverse()
          .map((c) => <LearnerCoachCard key={c.turn} turn={c.turn} a={c.analysis} />)
      )}
    </aside>
  );
}

function CoachCard({ turn, a }: { turn: number; a: CoachAnalysis }) {
  return (
    <details
      open={turn === -1}
      style={{
        marginBottom: 8,
        padding: 8,
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 6,
      }}
    >
      <summary style={{ cursor: "pointer", userSelect: "none" }}>
        <span style={{ color: "var(--muted)" }}>第 {turn} 轮后 · </span>
        <span style={{ color: BEHAVIOR_COLORS[a.companionBehavior] ?? "inherit" }}>
          {a.companionBehavior}
        </span>
        <span style={{ color: "var(--muted)" }}> / </span>
        <span style={{ color: ENGAGEMENT_COLORS[a.learnerEngagement] ?? "inherit" }}>
          {a.learnerEngagement}
        </span>
        <span style={{ color: "var(--muted)" }}> → </span>
        <strong>{a.recommendedAction}</strong>
      </summary>
      <div style={{ marginTop: 8, display: "grid", rowGap: 4 }}>
        <Row k="焦点" v={a.currentFocus} />
        <Row k="薄弱" v={a.learnerWeakPoint} />
        <Row k="对齐" v={a.teachingGoalAlignment} />
        <Row k="模式" v={a.recentPatterns} />
        {a.isTangent && <Row k="⚠️ 跑题" v={`应回到：${a.mainlineTopic}`} danger />}
        {a.isLearnerDrivingRepetition && (
          <Row k="⚠️ 学生复读" v="学生在推动同一点反复被讲——教师应换讲法" danger />
        )}
        <Row k="推荐" v={`${a.recommendedAction} — ${a.actionReason}`} />
        {a.qualityFlags.length > 0 && (
          <Row k="标记" v={a.qualityFlags.join(" / ")} danger />
        )}
        {a.contentProgress && (
          <Row
            k="窗口进度"
            v={a.contentProgress}
            danger={a.contentProgress === "done"}
          />
        )}
        <details style={{ marginTop: 4 }}>
          <summary style={{ cursor: "pointer", color: "var(--muted)", fontSize: 11 }}>
            playbook
          </summary>
          <div style={{ paddingLeft: 8, marginTop: 4, color: "var(--muted)" }}>
            <div>· 短肯定：{a.responsePlaybook.ifShortAck}</div>
            <div>· 提问：{a.responsePlaybook.ifQuestion}</div>
            <div>· 实质回答：{a.responsePlaybook.ifSubstantive}</div>
            <div>· 表达困惑：{a.responsePlaybook.ifConfused}</div>
          </div>
        </details>
      </div>
    </details>
  );
}

function LearnerCoachCard({ turn, a }: { turn: number; a: LearnerCoachAnalysis }) {
  return (
    <details
      style={{
        marginBottom: 8,
        padding: 8,
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: 6,
      }}
    >
      <summary style={{ cursor: "pointer", userSelect: "none" }}>
        <span style={{ color: "var(--muted)" }}>第 {turn} 轮后 · </span>
        <span style={{ color: UNDERSTANDING_COLORS[a.understandingLevel] ?? "inherit" }}>
          {a.understandingLevel}
        </span>
        {a.prosthesisRisk !== "none" && (
          <>
            <span style={{ color: "var(--muted)" }}> / </span>
            <span style={{ color: PROSTHESIS_COLORS[a.prosthesisRisk] }}>
              作弊:{a.prosthesisRisk}
            </span>
          </>
        )}
        {a.personaFidelity !== "faithful" && (
          <>
            <span style={{ color: "var(--muted)" }}> / </span>
            <span style={{ color: PERSONA_COLORS[a.personaFidelity] }}>
              画像:{a.personaFidelity}
            </span>
          </>
        )}
        <span style={{ color: "var(--muted)" }}> → </span>
        <strong>{a.recommendedAction}</strong>
      </summary>
      <div style={{ marginTop: 8, display: "grid", rowGap: 4 }}>
        <Row k="应学会" v={a.shouldHaveLearned} />
        <Row k="实学到" v={a.actuallyLearned} />
        {a.gap && a.gap !== "无" && <Row k="落差" v={a.gap} danger />}
        <Row k="心态" v={a.affect} />
        {a.prosthesisRisk !== "none" && (
          <Row k="⚠️ 作弊" v={a.prosthesisEvidence} danger />
        )}
        {a.personaFidelity !== "faithful" && (
          <Row k="⚠️ 画像" v={a.personaNote} danger />
        )}
        {a.qualityFlags.length > 0 && (
          <Row k="标记" v={a.qualityFlags.join(" / ")} danger />
        )}
        <Row k="推荐" v={`${a.recommendedAction} — ${a.actionReason}`} />
        <details style={{ marginTop: 4 }}>
          <summary style={{ cursor: "pointer", color: "var(--muted)", fontSize: 11 }}>
            playbook
          </summary>
          <div style={{ paddingLeft: 8, marginTop: 4, color: "var(--muted)" }}>
            <div>· 老师推进：{a.responsePlaybook.ifTeacherAdvances}</div>
            <div>· 老师提问：{a.responsePlaybook.ifTeacherQuestions}</div>
            <div>· 老师重复：{a.responsePlaybook.ifTeacherRepeats}</div>
            <div>· 老师错/跳：{a.responsePlaybook.ifTeacherWrong}</div>
          </div>
        </details>
      </div>
    </details>
  );
}
