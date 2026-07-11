import { Field } from "./Field";
import {
  LEARNERS,
  PACINGS,
  type LearnerId,
  type Pacing,
  type BookSummary,
  type BookDetail,
} from "./types";

function formatChars(n: number): string {
  if (n < 1000) return `${n} 字`;
  if (n < 10000) return `${(n / 1000).toFixed(1)}k 字`;
  return `${(n / 10000).toFixed(1)}w 字`;
}

type ControlsProps = {
  books: BookSummary[];
  bookSlug: string;
  onBookSlug: (v: string) => void;
  book: BookDetail | null;
  currentBookStat: BookSummary | undefined;
  sectionId: string;
  onSectionId: (v: string) => void;
  learnerId: LearnerId;
  onLearnerId: (v: LearnerId) => void;
  pacing: Pacing;
  onPacing: (v: Pacing) => void;
  coachEnabled: boolean;
  learnerCoachEnabled: boolean;
  onCoachMode: (coach: boolean, learnerCoach: boolean) => void;
  maxTurns: number;
  onMaxTurns: (v: number) => void;
  running: boolean;
  canStart: boolean;
  onStart: () => void;
  onStop: () => void;
  onHistory: () => void;
};

/** 顶部设置栏：书 / 节 / 学生 / 节奏 / 教练 / 轮数 + 开始/停止/历史。 */
export function Controls(p: ControlsProps) {
  const coachMode =
    p.coachEnabled && p.learnerCoachEnabled
      ? "both"
      : p.coachEnabled
        ? "teacher"
        : p.learnerCoachEnabled
          ? "learner"
          : "off";

  return (
    <section
      style={{
        display: "flex",
        gap: 12,
        flexWrap: "wrap",
        alignItems: "flex-end",
        padding: 12,
        background: "var(--panel)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        marginBottom: 12,
      }}
    >
      <Field label="书">
        <select value={p.bookSlug} onChange={(e) => p.onBookSlug(e.target.value)} disabled={p.running}>
          {p.books.map((b) => (
            <option key={b.slug} value={b.slug}>
              {b.title}（{b.sectionCount} 节 · {formatChars(b.totalChars)}）
            </option>
          ))}
        </select>
      </Field>

      <Field label="节">
        <select
          value={p.sectionId}
          onChange={(e) => p.onSectionId(e.target.value)}
          disabled={p.running || !p.book}
        >
          {p.book?.sections.map((s) => {
            const stat = p.currentBookStat?.sections.find((x) => x.id === s.id);
            return (
              <option key={s.id} value={s.id}>
                §{s.id} {s.title}
                {stat ? ` · ${formatChars(stat.chars)}` : ""}
              </option>
            );
          })}
        </select>
      </Field>

      <Field label="学生">
        <select
          value={p.learnerId}
          onChange={(e) => p.onLearnerId(e.target.value as LearnerId)}
          disabled={p.running}
        >
          {LEARNERS.map((l) => (
            <option key={l.id} value={l.id} title={l.desc}>
              {l.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="节奏">
        <select
          value={p.pacing}
          onChange={(e) => p.onPacing(e.target.value as Pacing)}
          disabled={p.running}
        >
          {PACINGS.map((pc) => (
            <option key={pc.id} value={pc.id} title={pc.desc}>
              {pc.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="教练">
        <select
          value={coachMode}
          onChange={(e) => {
            const v = e.target.value;
            p.onCoachMode(v === "both" || v === "teacher", v === "both" || v === "learner");
          }}
          disabled={p.running}
          title="教师/学生教练分析。每轮结束后并行跑，注入下一轮 system prompt"
        >
          <option value="both">全开</option>
          <option value="teacher">仅教师</option>
          <option value="learner">仅学生</option>
          <option value="off">全关</option>
        </select>
      </Field>

      <Field label="轮数">
        <select
          value={p.maxTurns}
          onChange={(e) => p.onMaxTurns(Number(e.target.value))}
          disabled={p.running}
        >
          {[3, 6, 12, 30, 80, 120].map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </Field>

      <div style={{ flex: 1 }} />

      {!p.running ? (
        <>
          <button onClick={p.onHistory}>历史…</button>
          <button className="primary" onClick={p.onStart} disabled={!p.canStart}>
            开始
          </button>
        </>
      ) : (
        <button className="danger" onClick={p.onStop}>
          停止
        </button>
      )}
    </section>
  );
}
