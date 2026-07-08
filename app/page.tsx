"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type SectionStat = { id: string; title: string; chars: number };
type BookSummary = {
  slug: string;
  title: string;
  author?: string;
  sectionCount: number;
  totalChars: number;
  sections: SectionStat[];
};
type SectionMeta = { id: string; title: string };
type BookDetail = { slug: string; title: string; author?: string; sections: SectionMeta[] };

type LearnerId = "novice" | "mid" | "critic";
const LEARNERS: { id: LearnerId; label: string; desc: string }[] = [
  { id: "novice", label: "新手", desc: "没啥预备知识，多问为什么、求例子" },
  { id: "mid", label: "中级", desc: "有基础，会复述、会追问细节" },
  { id: "critic", label: "挑刺型", desc: "主动找边界与反例，容易质疑" },
];

type Pacing = "thorough" | "normal" | "express";
const PACINGS: { id: Pacing; label: string; desc: string }[] = [
  { id: "thorough", label: "细", desc: "拆到最细，多复述多例子" },
  { id: "normal", label: "中", desc: "正常节奏，每 2-3 轮复述一次" },
  { id: "express", label: "快", desc: "跳过基础，直奔核心" },
];

type TeachingMode = "socratic" | "close_reading";
const TEACHING_MODES: { id: TeachingMode; label: string; desc: string; badge: string }[] = [
  { id: "socratic", label: "苏格拉底", desc: "默认模式，一节一节讲现代书", badge: "📖" },
  { id: "close_reading", label: "句读", desc: "讲经典，一半句一半句读，可选启用注疏", badge: "🈶" },
];

type CoachAnalysis = {
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

type LearnerCoachAnalysis = {
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

type Msg = { turn: number; actor: "teacher" | "learner"; text: string };

type SessionEvent =
  | { type: "meta"; meta: { sid: string; turnsSoFar?: number } }
  | { type: "turn_start"; actor: "teacher" | "learner"; turn: number }
  | { type: "chunk"; actor: "teacher" | "learner"; turn: number; text: string }
  | { type: "turn_end"; actor: "teacher" | "learner"; turn: number; text: string }
  | { type: "coach"; turn: number; side: "teacher" | "learner"; analysis: CoachAnalysis | LearnerCoachAnalysis }
  | { type: "compressed"; side: "teacher" | "learner"; upto: number }
  | {
      type: "window_slide";
      turn: number;
      startPage: number;
      endPage: number;
      totalPages: number;
    }
  | { type: "done"; sid: string }
  | { type: "error"; message: string };

type AuditEvent =
  | { type: "audit_start"; aid: string; sids: string[]; sectionIds: string[] }
  | { type: "audit_chunk"; text: string }
  | { type: "audit_done"; aid: string; report: { raw: string } }
  | { type: "audit_error"; message: string };

type SessionListItem = {
  sid: string;
  bookSlug: string;
  sectionId: string;
  learnerId: LearnerId;
  startedAt: number;
  status: string;
  maxTurns?: number;
  turnsSoFar?: number;
  teachingMode?: TeachingMode;
  commentariesEnabled?: boolean;
};

type AuditMode = "book" | "teaching" | "playbook";
const AUDIT_MODES: { id: AuditMode; label: string; desc: string; badge: string }[] = [
  { id: "book", label: "书", desc: "审书本身，找原文的空洞与不清楚", badge: "📖" },
  { id: "teaching", label: "教学", desc: "诊断教师表现，对齐教师硬规则", badge: "🎓" },
  { id: "playbook", label: "教师改进方案", desc: "书不动的前提下，下次怎么教得更好", badge: "🛠" },
];

type AuditHistoryItem = {
  aid: string;
  bookSlug: string;
  sectionIds: string[];
  learnerIds: string[];
  mode: AuditMode;
  sidCount: number;
  verdict: string;
  ts: number;
};

const CITE_RE = /〔§([\w-]{1,32})(?:[｜|]([^〕\n]{0,120}))?〕/g;

export default function Page() {
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [bookSlug, setBookSlug] = useState<string>("");
  const [book, setBook] = useState<BookDetail | null>(null);
  const [sectionId, setSectionId] = useState<string>("");
  const [learnerId, setLearnerId] = useState<LearnerId>("novice");
  const [pacing, setPacing] = useState<Pacing>("normal");
  const [teachingMode, setTeachingMode] = useState<TeachingMode>("socratic");
  const [commentariesEnabled, setCommentariesEnabled] = useState<boolean>(false);
  const [coachEnabled, setCoachEnabled] = useState<boolean>(true);
  const [learnerCoachEnabled, setLearnerCoachEnabled] = useState<boolean>(true);
  const [maxTurns, setMaxTurns] = useState<number>(6);

  const [messages, setMessages] = useState<Msg[]>([]);
  const [coachHistory, setCoachHistory] = useState<{ turn: number; analysis: CoachAnalysis }[]>([]);
  const [learnerCoachHistory, setLearnerCoachHistory] = useState<
    { turn: number; analysis: LearnerCoachAnalysis }[]
  >([]);
  const [showCoach, setShowCoach] = useState<boolean>(true);
  const [coachTab, setCoachTab] = useState<"teacher" | "learner">("teacher");
  const [showHistory, setShowHistory] = useState<boolean>(false);
  const [historyItems, setHistoryItems] = useState<SessionListItem[]>([]);
  const [showAuditHistory, setShowAuditHistory] = useState<boolean>(false);
  const [auditHistory, setAuditHistory] = useState<AuditHistoryItem[]>([]);
  const [windowInfo, setWindowInfo] = useState<{
    startPage: number;
    endPage: number;
    totalPages: number;
  } | null>(null);
  const [running, setRunning] = useState(false);
  const [sid, setSid] = useState<string>("");
  // 当前载入/进行中会话的状态——用来判断能不能"继续"
  const [sessionStatus, setSessionStatus] = useState<string>("");
  const [sessionMaxTurns, setSessionMaxTurns] = useState<number>(0);
  const [sessionTurnsSoFar, setSessionTurnsSoFar] = useState<number>(0);
  const [error, setError] = useState<string>("");
  const [modalSection, setModalSection] = useState<{ id: string; text: string } | null>(null);

  // 审计相关
  const [auditText, setAuditText] = useState<string>("");
  const [auditing, setAuditing] = useState<boolean>(false);
  const [sessionDone, setSessionDone] = useState<boolean>(false);
  const [showAuditPanel, setShowAuditPanel] = useState<boolean>(false);
  const [existingSessions, setExistingSessions] = useState<SessionListItem[]>([]);
  const [pickedSids, setPickedSids] = useState<Set<string>>(new Set());
  const [auditMode, setAuditMode] = useState<AuditMode>("book");
  // 当前面板显示的报告属于哪种模式（跑新审计或载入历史都会同步）
  const [currentAuditMode, setCurrentAuditMode] = useState<AuditMode>("book");
  const auditAbortRef = useRef<AbortController | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const auditRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/books")
      .then((r) => r.json())
      .then((d) => {
        setBooks(d.books || []);
        if (d.books?.[0]) setBookSlug(d.books[0].slug);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!bookSlug) return;
    fetch(`/api/books/${bookSlug}`)
      .then((r) => r.json())
      .then((d: BookDetail) => {
        setBook(d);
        if (d.sections?.[0]) setSectionId(d.sections[0].id);
      })
      .catch((e) => setError(String(e)));
  }, [bookSlug]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const currentBookStat = useMemo(
    () => books.find((b) => b.slug === bookSlug),
    [books, bookSlug],
  );

  const canStart = useMemo(
    () => Boolean(bookSlug && sectionId && learnerId && !running),
    [bookSlug, sectionId, learnerId, running],
  );

  // 能不能"继续"跑当前载入/停下的会话：
  // - 已有 sid（载入或刚跑过）
  // - 不在跑、不在审计
  // - 已跑轮数 < maxTurns
  // - 状态不是 done（done 是自然跑完，没剩下的轮数）
  const canResume = useMemo(
    () =>
      Boolean(
        sid &&
          !running &&
          !auditing &&
          sessionMaxTurns > 0 &&
          sessionTurnsSoFar < sessionMaxTurns &&
          sessionStatus !== "done",
      ),
    [sid, running, auditing, sessionStatus, sessionMaxTurns, sessionTurnsSoFar],
  );

  /** 把某个已有会话的 transcript + 教练分析载入到对话栏，只读，不起新流。 */
  async function loadSessionIntoView(sidToLoad: string) {
    setError("");
    setAuditText("");
    setShowAuditPanel(false);
    setSessionDone(false);
    try {
      const r = await fetch(`/api/sessions/${sidToLoad}`);
      const d = await r.json();
      if (!d.meta) {
        setError(d.error || "会话不存在");
        return;
      }
      setSid(sidToLoad);
      setSessionStatus(d.meta.status || "");
      setSessionMaxTurns(d.meta.maxTurns ?? 0);
      const turnsArr = (d.turns ?? []) as { turn: number }[];
      const inferred = turnsArr.length > 0 ? Math.max(...turnsArr.map((t) => t.turn)) : 0;
      setSessionTurnsSoFar(d.meta.turnsSoFar ?? inferred);
      setMessages(
        (d.turns as { turn: number; actor: "teacher" | "learner"; text: string }[])
          .map((t) => ({ turn: t.turn, actor: t.actor, text: t.text })),
      );
      setCoachHistory(
        (d.teacherCoach as { turn: number; analysis: CoachAnalysis }[])
          .map((c) => ({ turn: c.turn, analysis: c.analysis })),
      );
      setLearnerCoachHistory(
        (d.learnerCoach as { turn: number; analysis: LearnerCoachAnalysis }[])
          .map((c) => ({ turn: c.turn, analysis: c.analysis })),
      );
      setBookSlug(d.meta.bookSlug);
      setSectionId(d.meta.sectionId);
      setLearnerId(d.meta.learnerId);
      setPacing(d.meta.pacing || "normal");
      setTeachingMode((d.meta.teachingMode as TeachingMode) || "socratic");
      setCommentariesEnabled(!!d.meta.commentariesEnabled);
      if (
        d.meta.windowStartPage !== undefined &&
        d.meta.windowEndPage !== undefined
      ) {
        setWindowInfo({
          startPage: d.meta.windowStartPage,
          endPage: d.meta.windowEndPage,
          totalPages: 0,
        });
      } else {
        setWindowInfo(null);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function start(resumeSid?: string) {
    setError("");
    setMessages([]);
    setCoachHistory([]);
    setLearnerCoachHistory([]);
    setSid("");
    setSessionStatus("");
    setSessionTurnsSoFar(0);
    setSessionMaxTurns(resumeSid ? 0 : maxTurns);
    setAuditText("");
    setSessionDone(false);
    setShowAuditPanel(false);
    setWindowInfo(null);
    setRunning(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // 如果是 resume，先把已存的 turns / coach 载入内存
    if (resumeSid) {
      try {
        const r = await fetch(`/api/sessions/${resumeSid}`);
        const d = await r.json();
        if (d.meta) {
          setSid(resumeSid);
          setSessionStatus(d.meta.status || "");
          setSessionMaxTurns(d.meta.maxTurns ?? 0);
          const turnsArr = (d.turns ?? []) as { turn: number }[];
          const inferred = turnsArr.length > 0 ? Math.max(...turnsArr.map((t) => t.turn)) : 0;
          setSessionTurnsSoFar(d.meta.turnsSoFar ?? inferred);
          setMessages(
            (d.turns as { turn: number; actor: "teacher" | "learner"; text: string }[])
              .map((t) => ({ turn: t.turn, actor: t.actor, text: t.text })),
          );
          setCoachHistory(
            (d.teacherCoach as { turn: number; analysis: CoachAnalysis }[])
              .map((c) => ({ turn: c.turn, analysis: c.analysis })),
          );
          setLearnerCoachHistory(
            (d.learnerCoach as { turn: number; analysis: LearnerCoachAnalysis }[])
              .map((c) => ({ turn: c.turn, analysis: c.analysis })),
          );
          // 用 meta 里的 bookSlug/section/learner 覆盖当前选择（视觉上一致）
          setBookSlug(d.meta.bookSlug);
          setSectionId(d.meta.sectionId);
          setLearnerId(d.meta.learnerId);
          setPacing(d.meta.pacing || "normal");
          setTeachingMode((d.meta.teachingMode as TeachingMode) || "socratic");
          setCommentariesEnabled(!!d.meta.commentariesEnabled);
          if (
            d.meta.windowStartPage !== undefined &&
            d.meta.windowEndPage !== undefined
          ) {
            // totalPages 我们从 session-side 事件流后续拿；先没有的话显示 ?
            setWindowInfo({
              startPage: d.meta.windowStartPage,
              endPage: d.meta.windowEndPage,
              totalPages: 0,
            });
          }
        }
      } catch {
        // 忽略
      }
    }

    try {
      const resp = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          resumeSid
            ? { resumeSid, pacing, coachEnabled, learnerCoachEnabled, maxTurns }
            : {
                bookSlug,
                sectionId,
                learnerId,
                pacing,
                coachEnabled,
                learnerCoachEnabled,
                maxTurns,
                teachingMode,
                commentariesEnabled,
              },
        ),
        signal: ctrl.signal,
      });
      if (!resp.ok || !resp.body) {
        const txt = await resp.text();
        throw new Error(txt || `HTTP ${resp.status}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";
        for (const frame of frames) {
          if (!frame.startsWith("data: ")) continue;
          try {
            const ev = JSON.parse(frame.slice(6)) as SessionEvent;
            handleEvent(ev);
          } catch {
            // 忽略坏帧
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setError((e as Error).message);
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  function handleEvent(ev: SessionEvent) {
    switch (ev.type) {
      case "meta":
        setSid(ev.meta.sid);
        setSessionStatus("running");
        if (ev.meta.turnsSoFar !== undefined) setSessionTurnsSoFar(ev.meta.turnsSoFar);
        break;
      case "turn_start":
        setMessages((prev) => [...prev, { turn: ev.turn, actor: ev.actor, text: "" }]);
        break;
      case "chunk":
        setMessages((prev) => {
          const copy = prev.slice();
          for (let i = copy.length - 1; i >= 0; i--) {
            if (copy[i].turn === ev.turn && copy[i].actor === ev.actor) {
              copy[i] = { ...copy[i], text: copy[i].text + ev.text };
              break;
            }
          }
          return copy;
        });
        break;
      case "turn_end":
        setMessages((prev) => {
          const copy = prev.slice();
          for (let i = copy.length - 1; i >= 0; i--) {
            if (copy[i].turn === ev.turn && copy[i].actor === ev.actor) {
              copy[i] = { ...copy[i], text: ev.text };
              break;
            }
          }
          return copy;
        });
        // 学生说完才算一整轮走完
        if (ev.actor === "learner") setSessionTurnsSoFar(ev.turn);
        break;
      case "error":
        setError(ev.message);
        setSessionStatus("errored");
        break;
      case "done":
        setSessionDone(true);
        // 会话流走到 done 事件说明服务端标了 done 或 aborted——按 turnsSoFar 反推
        setSessionStatus((prev) => (prev === "errored" ? "errored" : "done"));
        break;
      case "coach":
        if (ev.side === "teacher") {
          setCoachHistory((prev) => [
            ...prev,
            { turn: ev.turn, analysis: ev.analysis as CoachAnalysis },
          ]);
        } else {
          setLearnerCoachHistory((prev) => [
            ...prev,
            { turn: ev.turn, analysis: ev.analysis as LearnerCoachAnalysis },
          ]);
        }
        break;
      case "compressed":
        // 静默；侧栏可以显示，先不做
        break;
      case "window_slide":
        setWindowInfo({
          startPage: ev.startPage,
          endPage: ev.endPage,
          totalPages: ev.totalPages,
        });
        break;
    }
  }

  function stop() {
    abortRef.current?.abort();
    // 手动停止后立刻允许审计（不等 SSE 的 done——它多半到不了）
    setSessionDone(true);
    setSessionStatus("aborted");
  }

  async function openAuditPanel() {
    setShowAuditPanel(true);
    setPickedSids(sid ? new Set([sid]) : new Set());
    // 句读会话默认建议用 teaching 模式（audit_book 的"缺什么"语义在句读下会错位）
    if (teachingMode === "close_reading") {
      setAuditMode("teaching");
    }
    if (!bookSlug) return;
    try {
      const r = await fetch(`/api/sessions?bookSlug=${encodeURIComponent(bookSlug)}`);
      const d = await r.json();
      setExistingSessions(d.sessions || []);
    } catch (e) {
      setError(String(e));
    }
  }

  async function runAudit(sids: string[]) {
    if (sids.length === 0) {
      setError("请至少选一个会话");
      return;
    }
    setAuditText("");
    setAuditing(true);
    setError("");
    setCurrentAuditMode(auditMode);
    const ctrl = new AbortController();
    auditAbortRef.current = ctrl;
    try {
      const resp = await fetch(`/api/audits`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sids, mode: auditMode }),
        signal: ctrl.signal,
      });
      if (!resp.ok || !resp.body) {
        throw new Error((await resp.text()) || `HTTP ${resp.status}`);
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";
        for (const frame of frames) {
          if (!frame.startsWith("data: ")) continue;
          try {
            const ev = JSON.parse(frame.slice(6)) as AuditEvent;
            if (ev.type === "audit_chunk") {
              setAuditText((prev) => prev + ev.text);
              queueMicrotask(() =>
                auditRef.current?.scrollTo({ top: auditRef.current.scrollHeight }),
              );
            } else if (ev.type === "audit_done") {
              setAuditText(ev.report.raw);
            } else if (ev.type === "audit_error") {
              setError(ev.message);
            }
          } catch {
            // 忽略
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        setError((e as Error).message);
      }
    } finally {
      setAuditing(false);
      auditAbortRef.current = null;
    }
  }

  function stopAudit() {
    auditAbortRef.current?.abort();
  }

  async function openSection(id: string) {
    if (!bookSlug) return;
    try {
      const r = await fetch(`/api/books/${bookSlug}?section=${encodeURIComponent(id)}`);
      const d = await r.json();
      if (d.text) setModalSection({ id, text: d.text });
    } catch {
      // 忽略
    }
  }

  async function openHistory() {
    setShowHistory(true);
    try {
      // 拿全部 session（不限 book）
      const r = await fetch(`/api/sessions`);
      const d = await r.json();
      setHistoryItems(d.sessions || []);
    } catch (e) {
      setError(String(e));
    }
  }

  async function openAuditHistory() {
    setShowAuditHistory(true);
    try {
      const q = bookSlug ? `?bookSlug=${encodeURIComponent(bookSlug)}` : "";
      const r = await fetch(`/api/audits${q}`);
      const d = await r.json();
      setAuditHistory(d.audits || []);
    } catch (e) {
      setError(String(e));
    }
  }

  /** 把一次已存的审计报告载入到当前面板，只读对照。 */
  async function loadAuditIntoView(aid: string) {
    setError("");
    try {
      const r = await fetch(`/api/audits/${aid}`);
      const d = await r.json();
      if (!d.meta) {
        setError(d.error || "审计不存在");
        return;
      }
      setAuditText((d.report?.raw as string) || "");
      setCurrentAuditMode((d.meta.mode as AuditMode) || "book");
      setShowAuditPanel(false);
      // 滚到审计区
      queueMicrotask(() =>
        auditRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: "16px 20px" }}>
      <header style={{ marginBottom: 12 }}>
        <h1 style={{ margin: 0, fontSize: 18 }}>教-学 agent 观察台</h1>
        <p style={{ margin: "4px 0 0", color: "var(--muted)", fontSize: 12 }}>
          教师看得到本节原文，学生看不到——学生的困惑就是这本书的困惑。
        </p>
      </header>

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
          <select value={bookSlug} onChange={(e) => setBookSlug(e.target.value)} disabled={running}>
            {books.map((b) => (
              <option key={b.slug} value={b.slug}>
                {b.title}（{b.sectionCount} 节 · {formatChars(b.totalChars)}）
              </option>
            ))}
          </select>
        </Field>

        <Field label="节">
          <select
            value={sectionId}
            onChange={(e) => setSectionId(e.target.value)}
            disabled={running || !book}
          >
            {book?.sections.map((s) => {
              const stat = currentBookStat?.sections.find((x) => x.id === s.id);
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
            value={learnerId}
            onChange={(e) => setLearnerId(e.target.value as LearnerId)}
            disabled={running}
          >
            {LEARNERS.map((l) => (
              <option key={l.id} value={l.id} title={l.desc}>
                {l.label}
              </option>
            ))}
          </select>
        </Field>

        {teachingMode === "close_reading" ? (
          <Field label="节奏">
            <span
              style={{
                fontSize: 11,
                color: "#888",
                padding: "4px 4px",
                fontStyle: "italic",
              }}
              title="句读节奏由方法本身决定：逐字停、遇关键字才拆。thorough/normal/express 在此不适用。"
            >
              由句读方法决定
            </span>
          </Field>
        ) : (
          <Field label="节奏">
            <select
              value={pacing}
              onChange={(e) => setPacing(e.target.value as Pacing)}
              disabled={running}
            >
              {PACINGS.map((p) => (
                <option key={p.id} value={p.id} title={p.desc}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>
        )}

        <Field label="教学模式">
          <select
            value={teachingMode}
            onChange={(e) => {
              const m = e.target.value as TeachingMode;
              setTeachingMode(m);
              if (m === "socratic") setCommentariesEnabled(false);
              if (m === "close_reading") setPacing("normal");
            }}
            disabled={running}
            title="苏格拉底：默认；句读：讲经典，一半句一半句读"
          >
            {TEACHING_MODES.map((m) => (
              <option key={m.id} value={m.id} title={m.desc}>
                {m.badge} {m.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="注疏">
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              fontSize: 12,
              padding: "2px 4px",
              opacity: teachingMode === "close_reading" ? 1 : 0.4,
            }}
            title={
              teachingMode === "close_reading"
                ? "启用后教师只能引用 data/books/<slug>/commentaries/<sid>.md 里的家和字；文件不存在则退回不引"
                : "仅句读模式可用"
            }
          >
            <input
              type="checkbox"
              checked={commentariesEnabled}
              onChange={(e) => setCommentariesEnabled(e.target.checked)}
              disabled={running || teachingMode !== "close_reading"}
            />
            <span>启用</span>
          </label>
        </Field>

        <Field label="教练">
          <select
            value={
              coachEnabled && learnerCoachEnabled
                ? "both"
                : coachEnabled
                  ? "teacher"
                  : learnerCoachEnabled
                    ? "learner"
                    : "off"
            }
            onChange={(e) => {
              const v = e.target.value;
              setCoachEnabled(v === "both" || v === "teacher");
              setLearnerCoachEnabled(v === "both" || v === "learner");
            }}
            disabled={running}
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
            value={maxTurns}
            onChange={(e) => setMaxTurns(Number(e.target.value))}
            disabled={running}
          >
            {[3, 6, 12, 30, 80, 120].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>

        <div style={{ flex: 1 }} />

        {!running ? (
          <>
            <button onClick={openHistory}>历史…</button>
            <button onClick={openAuditHistory}>审计历史…</button>
            <button className="primary" onClick={() => start()} disabled={!canStart}>
              开始
            </button>
          </>
        ) : (
          <button className="danger" onClick={stop}>
            停止
          </button>
        )}
      </section>

      {currentBookStat && (
        <div
          style={{
            padding: "8px 12px",
            marginBottom: 12,
            fontSize: 12,
            color: "var(--muted)",
            background: "var(--panel)",
            border: "1px solid var(--border)",
            borderRadius: 6,
          }}
        >
          {auditRecommendation(currentBookStat)}
        </div>
      )}

      {error && (
        <div
          style={{
            padding: 10,
            marginBottom: 12,
            border: "1px solid var(--danger)",
            color: "var(--danger)",
            borderRadius: 6,
            background: "var(--panel)",
            fontSize: 13,
            whiteSpace: "pre-wrap",
          }}
        >
          {error}
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns:
            showCoach &&
            (coachEnabled || learnerCoachEnabled || coachHistory.length > 0 || learnerCoachHistory.length > 0)
              ? "1fr 320px"
              : "1fr",
          gap: 12,
          height: "calc(100vh - 280px)",
          minHeight: 300,
        }}
      >
        <div
          ref={scrollRef}
          style={{
            overflowY: "auto",
            padding: 12,
            background: "var(--panel)",
            border: "1px solid var(--border)",
            borderRadius: 8,
          }}
        >
          {messages.length === 0 && !running && (
            <div style={{ color: "var(--muted)", textAlign: "center", padding: 40 }}>
              选好书、节和学生档位，点"开始"。教师说完一轮学生跟上，共 {maxTurns} 轮。
            </div>
          )}
          {messages.map((m, i) => (
            <Bubble key={i} msg={m} onCite={openSection} />
          ))}
          {running && (
            <div style={{ color: "var(--muted)", fontSize: 12, marginTop: 6 }}>
              ● 进行中…
            </div>
          )}
        </div>

        {(coachEnabled || learnerCoachEnabled || coachHistory.length > 0 || learnerCoachHistory.length > 0) && showCoach && (
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
                  onClick={() => setCoachTab("teacher")}
                  className={coachTab === "teacher" ? "primary" : ""}
                  style={{ padding: "2px 8px", fontSize: 12 }}
                >
                  教师教练 ({coachHistory.length})
                </button>
                <button
                  onClick={() => setCoachTab("learner")}
                  className={coachTab === "learner" ? "primary" : ""}
                  style={{ padding: "2px 8px", fontSize: 12 }}
                >
                  学生教练 ({learnerCoachHistory.length})
                </button>
              </div>
              <button style={{ padding: "2px 6px", fontSize: 11 }} onClick={() => setShowCoach(false)}>
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
        )}
        {(coachEnabled || learnerCoachEnabled) && !showCoach && (
          <button
            onClick={() => setShowCoach(true)}
            style={{
              position: "absolute",
              right: 20,
              top: 210,
              fontSize: 11,
              padding: "2px 8px",
            }}
          >
            显示教练
          </button>
        )}
      </div>

      <footer
        style={{
          marginTop: 8,
          fontSize: 12,
          color: "var(--muted)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <span>
          {sid ? `会话 ${sid}` : "尚未开始"}
          {windowInfo && windowInfo.totalPages > 0 && (
            <>
              {" · "}
              <span title="教师当前看到的原文范围（自适应翻页）">
                窗口 页 {windowInfo.startPage}–{windowInfo.endPage} / {windowInfo.totalPages}
              </span>
            </>
          )}
        </span>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {canResume && (
            <button
              className="primary"
              onClick={() => start(sid)}
              title={`从第 ${sessionTurnsSoFar + 1} 轮起继续（共 ${sessionMaxTurns} 轮）`}
            >
              继续（{sessionTurnsSoFar}/{sessionMaxTurns}）
            </button>
          )}
          {sid && !running && !auditing && (
            <button className="primary" onClick={openAuditPanel}>
              审计…
            </button>
          )}
          {auditing && (
            <button className="danger" onClick={stopAudit}>
              停止审计
            </button>
          )}
          {sid && (
            <a
              href={`/api/sessions/${sid}`}
              target="_blank"
              style={{ color: "var(--accent)" }}
              rel="noreferrer"
            >
              查看 transcript
            </a>
          )}
        </div>
      </footer>

      {showAuditPanel && !auditing && !auditText && (
        <AuditPicker
          book={currentBookStat}
          currentSid={sid}
          sessions={existingSessions}
          picked={pickedSids}
          mode={auditMode}
          onModeChange={setAuditMode}
          onTogglePick={(s) => {
            setPickedSids((prev) => {
              const copy = new Set(prev);
              if (copy.has(s)) copy.delete(s);
              else copy.add(s);
              return copy;
            });
          }}
          onCancel={() => setShowAuditPanel(false)}
          onSubmit={() => runAudit(Array.from(pickedSids))}
        />
      )}

      {(auditText || auditing) && (
        <section
          ref={auditRef}
          style={{
            marginTop: 12,
            maxHeight: 480,
            overflowY: "auto",
            padding: 14,
            background: "var(--panel)",
            border: "1px solid var(--border)",
            borderRadius: 8,
          }}
        >
          <div
            style={{
              fontSize: 12,
              color: "var(--muted)",
              marginBottom: 8,
              display: "flex",
              justifyContent: "space-between",
            }}
          >
            <span>
              {AUDIT_MODES.find((m) => m.id === currentAuditMode)?.badge ?? "📖"}{" "}
              {AUDIT_MODES.find((m) => m.id === currentAuditMode)?.label ?? "书"}
              {" · "}
              审计报告{auditing && "（生成中…）"}
            </span>
            {!auditing && (
              <button
                onClick={() => {
                  setAuditText("");
                  setShowAuditPanel(true);
                }}
              >
                重开一次
              </button>
            )}
          </div>
          <AuditView raw={auditText} mode={currentAuditMode} />
        </section>
      )}

      {showHistory && (
        <HistoryDrawer
          items={historyItems}
          books={books}
          onClose={() => setShowHistory(false)}
          onView={(sid) => {
            setShowHistory(false);
            loadSessionIntoView(sid);
          }}
          onResume={(sid) => {
            setShowHistory(false);
            start(sid);
          }}
        />
      )}

      {showAuditHistory && (
        <AuditHistoryDrawer
          items={auditHistory}
          books={books}
          currentBookSlug={bookSlug}
          onClose={() => setShowAuditHistory(false)}
          onView={(aid) => {
            setShowAuditHistory(false);
            loadAuditIntoView(aid);
          }}
        />
      )}

      {modalSection && (
        <Modal onClose={() => setModalSection(null)} title={`§${modalSection.id} 原文`}>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontFamily: "inherit",
              margin: 0,
            }}
          >
            {modalSection.text}
          </pre>
        </Modal>
      )}
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 12 }}>
      <span style={{ color: "var(--muted)" }}>{label}</span>
      {children}
    </label>
  );
}

function formatChars(n: number): string {
  if (n < 1000) return `${n} 字`;
  if (n < 10000) return `${(n / 1000).toFixed(1)}k 字`;
  return `${(n / 10000).toFixed(1)}w 字`;
}

/** 根据书总字数给个推荐范围。启发式，不追求精确。 */
function auditRecommendation(book: BookSummary): string {
  const total = book.totalChars;
  const nSec = book.sectionCount;
  if (total < 20_000) {
    return `全书约 ${formatChars(total)}，${nSec} 节 —— 可以每节各跑一次会话，最后合审全书。`;
  }
  if (total < 80_000) {
    return `全书约 ${formatChars(total)}，${nSec} 节 —— 建议一次审计覆盖 2-3 节相关内容（例如同一章的三节），审起来性价比较高。`;
  }
  if (total < 200_000) {
    return `全书约 ${formatChars(total)}，${nSec} 节 —— 一次审计建议聚焦一节；跨节审计限制在同一章，最多 2-3 节，超出容易过长。`;
  }
  return `全书约 ${formatChars(total)}，${nSec} 节 —— 每次审计只挑一节，或者最多 2 节。合审全书不现实。`;
}

function AuditPicker({
  book,
  currentSid,
  sessions,
  picked,
  mode,
  onModeChange,
  onTogglePick,
  onCancel,
  onSubmit,
}: {
  book: BookSummary | undefined;
  currentSid: string;
  sessions: SessionListItem[];
  picked: Set<string>;
  mode: AuditMode;
  onModeChange: (m: AuditMode) => void;
  onTogglePick: (sid: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  // 按 sectionId 分组
  const grouped = useMemo(() => {
    const map = new Map<string, SessionListItem[]>();
    for (const s of sessions) {
      if (!map.has(s.sectionId)) map.set(s.sectionId, []);
      map.get(s.sectionId)!.push(s);
    }
    return map;
  }, [sessions]);

  // 所选会话是否包含句读——决定要不要弹提示
  const pickedHasCloseReading = useMemo(
    () => sessions.some((s) => picked.has(s.sid) && s.teachingMode === "close_reading"),
    [sessions, picked],
  );

  // 按书里的 section 顺序展示
  const orderedSectionIds = book?.sections.map((s) => s.id) ?? [];

  return (
    <section
      style={{
        marginTop: 12,
        padding: 14,
        background: "var(--panel)",
        border: "1px solid var(--accent)",
        borderRadius: 8,
      }}
    >
      <div style={{ marginBottom: 8, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong style={{ fontSize: 14 }}>选要一起送审的会话</strong>
        <div style={{ fontSize: 12, color: "var(--muted)" }}>
          勾选后点"开始审计"。跨多节 = 合审。已选 {picked.size} 个
        </div>
      </div>

      <div style={{ marginBottom: 10 }}>
        <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>审计模式</div>
        <div style={{ display: "flex", gap: 6 }}>
          {AUDIT_MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => onModeChange(m.id)}
              className={mode === m.id ? "primary" : ""}
              title={m.desc}
              style={{ padding: "6px 10px", fontSize: 12, flex: 1 }}
            >
              {m.badge} {m.label}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
          {AUDIT_MODES.find((m) => m.id === mode)?.desc}
        </div>
        {pickedHasCloseReading && mode === "book" && (
          <div
            style={{
              marginTop: 6,
              padding: "6px 8px",
              fontSize: 11,
              color: "var(--danger)",
              background: "var(--panel)",
              border: "1px solid var(--danger)",
              borderRadius: 4,
            }}
          >
            所选包含<strong>句读</strong>会话——用"书"模式审计会把教师的字面拆解误判为"原文补丁"，建议改用<strong>教学</strong>或<strong>教师改进方案</strong>模式。
          </div>
        )}
      </div>

      <div
        style={{
          maxHeight: 300,
          overflowY: "auto",
          padding: 8,
          background: "var(--bg)",
          border: "1px solid var(--border)",
          borderRadius: 6,
        }}
      >
        {orderedSectionIds
          .filter((sid) => grouped.has(sid))
          .map((secId) => {
            const list = grouped.get(secId)!;
            const secTitle = book?.sections.find((s) => s.id === secId)?.title ?? secId;
            return (
              <div key={secId} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>
                  §{secId} {secTitle}
                </div>
                {list.map((s) => (
                  <label
                    key={s.sid}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "4px 6px",
                      fontSize: 13,
                      cursor: "pointer",
                      background: picked.has(s.sid) ? "var(--teacher)" : "transparent",
                      borderRadius: 4,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={picked.has(s.sid)}
                      onChange={() => onTogglePick(s.sid)}
                    />
                    <span style={{ color: s.status === "done" ? "inherit" : "var(--muted)" }}>
                      {s.sid}
                      {s.sid === currentSid && "（本次）"}
                    </span>
                    <span style={{ fontSize: 11, color: "var(--muted)", marginLeft: "auto" }}>
                      {LEARNERS.find((l) => l.id === s.learnerId)?.label ?? s.learnerId} ·{" "}
                      <TeachingModeBadge
                        mode={s.teachingMode}
                        commentariesEnabled={s.commentariesEnabled}
                      />{" "}
                      · {s.status}
                    </span>
                  </label>
                ))}
              </div>
            );
          })}
        {sessions.length === 0 && (
          <div style={{ color: "var(--muted)", padding: 20, textAlign: "center" }}>
            这本书还没有其它会话。审计当前这次即可。
          </div>
        )}
      </div>

      <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button onClick={onCancel}>取消</button>
        <button className="primary" onClick={onSubmit} disabled={picked.size === 0}>
          开始审计（{picked.size}）
        </button>
      </div>
    </section>
  );
}

function Bubble({ msg, onCite }: { msg: Msg; onCite: (id: string) => void }) {
  const isTeacher = msg.actor === "teacher";
  return (
    <div
      style={{
        display: "flex",
        justifyContent: isTeacher ? "flex-start" : "flex-end",
        marginBottom: 10,
      }}
    >
      <div
        style={{
          maxWidth: "78%",
          background: isTeacher ? "var(--teacher)" : "var(--learner)",
          border: `1px solid ${isTeacher ? "var(--teacher-border)" : "var(--learner-border)"}`,
          borderRadius: 10,
          padding: "8px 12px",
        }}
      >
        <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 4 }}>
          {isTeacher ? "教师" : "学生"} · 第 {msg.turn} 轮
        </div>
        <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
          {renderWithCitations(msg.text, onCite)}
        </div>
      </div>
    </div>
  );
}

function renderWithCitations(
  text: string,
  onCite: (id: string) => void,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(CITE_RE.source, "g");
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIdx) out.push(text.slice(lastIdx, m.index));
    const id = m[1];
    const snippet = m[2] || "";
    out.push(
      <button
        key={`c${key++}`}
        onClick={() => onCite(id)}
        style={{
          display: "inline",
          padding: "0 6px",
          margin: "0 2px",
          fontSize: "0.85em",
          border: "1px solid var(--accent)",
          borderRadius: 4,
          background: "transparent",
          color: "var(--accent)",
          cursor: "pointer",
        }}
        title="查看该节原文"
      >
        §{id}
        {snippet && ` · ${snippet}`}
      </button>,
    );
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) out.push(text.slice(lastIdx));
  return out;
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--panel)",
          border: "1px solid var(--border)",
          borderRadius: 10,
          padding: 16,
          maxWidth: 720,
          maxHeight: "80vh",
          width: "90%",
          overflow: "auto",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
          <strong>{title}</strong>
          <button onClick={onClose}>关闭</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** 把 ===TAG=== 分隔的审计报告分段渲染。流式过程中未完成的段会保持原始文本。 */
function AuditView({ raw, mode }: { raw: string; mode: AuditMode }) {
  const sections = parseAuditSections(raw);
  const labels = SECTION_LABELS_BY_MODE[mode] ?? SECTION_LABELS_BY_MODE.book;
  if (sections.length === 0) {
    return (
      <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontFamily: "inherit" }}>
        {raw || "…"}
      </pre>
    );
  }
  return (
    <div>
      {sections.map((s, i) => (
        <div key={i} style={{ marginBottom: 14 }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "var(--accent)",
              marginBottom: 4,
              letterSpacing: 0.5,
            }}
          >
            {labels[s.tag] ?? s.tag}
          </div>
          <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{s.body}</div>
        </div>
      ))}
    </div>
  );
}

const SECTION_LABELS_BY_MODE: Record<AuditMode, Record<string, string>> = {
  book: {
    VERDICT: "一句话结论",
    CLARITY: "表达清晰度问题",
    HARD_SPOTS: "学生真正卡住的点",
    INCONSISTENCY: "教师讲的 vs 原文（关键）",
    SUGGESTIONS: "对书本身的修改建议",
  },
  teaching: {
    VERDICT: "一句话结论",
    STRENGTHS: "教师做对的动作",
    VIOLATIONS: "违反教师硬规则",
    MISSED_MOMENTS: "错过的信号",
    PACING_JUDGMENT: "节奏 vs 画像",
    CITATION_HYGIENE: "引用健康度",
  },
  playbook: {
    VERDICT: "一句话结论",
    BOOK_TRAPS: "原文注定卡人的地方",
    PLAYBOOK_FOR_NEXT_RUN: "下一次的动作序列",
    RESPONSE_PATCHES: "针对学生反应的模板",
    WINNING_MOVE: "本次做对的一招（下次照做）",
  },
};

function parseAuditSections(raw: string): { tag: string; body: string }[] {
  const re = /^===([A-Z_]+)===\s*\r?\n/gm;
  const out: { tag: string; body: string }[] = [];
  const matches: { tag: string; start: number; contentStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    matches.push({ tag: m[1], start: m.index, contentStart: m.index + m[0].length });
  }
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    if (cur.tag === "END") continue;
    const nextStart = matches[i + 1]?.start ?? raw.length;
    out.push({ tag: cur.tag, body: raw.slice(cur.contentStart, nextStart).trim() });
  }
  return out;
}

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

function Row({ k, v, danger }: { k: string; v: string; danger?: boolean }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "48px 1fr", gap: 6, fontSize: 12 }}>
      <span style={{ color: "var(--muted)" }}>{k}</span>
      <span style={{ color: danger ? "var(--danger)" : "inherit", wordBreak: "break-word" }}>{v}</span>
    </div>
  );
}

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

function HistoryDrawer({
  items,
  books,
  onClose,
  onView,
  onResume,
}: {
  items: SessionListItem[];
  books: BookSummary[];
  onClose: () => void;
  onView: (sid: string) => void;
  onResume: (sid: string) => void;
}) {
  const bookTitleOf = (slug: string) => books.find((b) => b.slug === slug)?.title ?? slug;
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        justifyContent: "flex-end",
        zIndex: 100,
      }}
    >
      <aside
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--panel)",
          border: "1px solid var(--border)",
          width: 480,
          maxWidth: "90vw",
          height: "100vh",
          padding: 16,
          overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
          <strong>历史会话</strong>
          <button onClick={onClose}>关闭</button>
        </div>
        {items.length === 0 && (
          <div style={{ color: "var(--muted)", padding: 30, textAlign: "center" }}>
            还没有历史会话。
          </div>
        )}
        {items.map((s) => (
          <div
            key={s.sid}
            style={{
              padding: 10,
              marginBottom: 8,
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "var(--bg)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <strong style={{ fontSize: 13 }}>{bookTitleOf(s.bookSlug)}</strong>
              <span style={{ fontSize: 11, color: "var(--muted)" }}>
                {new Date(s.startedAt).toLocaleString("zh-CN")}
              </span>
            </div>
            <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
              §{s.sectionId} · {LEARNERS.find((l) => l.id === s.learnerId)?.label ?? s.learnerId} ·{" "}
              <TeachingModeBadge mode={s.teachingMode} commentariesEnabled={s.commentariesEnabled} /> ·{" "}
              <StatusBadge status={s.status} /> ·{" "}
              <span>
                {s.turnsSoFar ?? "?"} / {s.maxTurns ?? "?"} 轮
              </span>
            </div>
            <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2, fontFamily: "monospace" }}>
              {s.sid}
            </div>
            <div style={{ marginTop: 6, display: "flex", gap: 6, justifyContent: "flex-end", alignItems: "center" }}>
              <a
                href={`/api/sessions/${s.sid}`}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 11, color: "var(--muted)" }}
                title="原始 JSON（新标签页）"
              >
                原始
              </a>
              <button style={{ padding: "2px 8px", fontSize: 11 }} onClick={() => onView(s.sid)}>
                载入
              </button>
              {s.status !== "done" &&
                (s.turnsSoFar ?? 0) < (s.maxTurns ?? Number.POSITIVE_INFINITY) && (
                  <button
                    className="primary"
                    style={{ padding: "2px 8px", fontSize: 11 }}
                    onClick={() => onResume(s.sid)}
                  >
                    继续
                  </button>
                )}
            </div>
          </div>
        ))}
      </aside>
    </div>
  );
}

function AuditHistoryDrawer({
  items,
  books,
  currentBookSlug,
  onClose,
  onView,
}: {
  items: AuditHistoryItem[];
  books: BookSummary[];
  currentBookSlug: string;
  onClose: () => void;
  onView: (aid: string) => void;
}) {
  const bookTitleOf = (slug: string) => books.find((b) => b.slug === slug)?.title ?? slug;
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        justifyContent: "flex-end",
        zIndex: 100,
      }}
    >
      <aside
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--panel)",
          border: "1px solid var(--border)",
          width: 560,
          maxWidth: "92vw",
          height: "100vh",
          padding: 16,
          overflowY: "auto",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
          <strong>
            审计历史
            {currentBookSlug && (
              <span style={{ fontSize: 12, color: "var(--muted)", marginLeft: 8 }}>
                · 仅显示《{bookTitleOf(currentBookSlug)}》
              </span>
            )}
          </strong>
          <button onClick={onClose}>关闭</button>
        </div>
        {items.length === 0 && (
          <div style={{ color: "var(--muted)", padding: 30, textAlign: "center" }}>
            这本书还没有历史审计。
          </div>
        )}
        {items.map((a) => (
          <div
            key={a.aid}
            style={{
              padding: 10,
              marginBottom: 8,
              border: "1px solid var(--border)",
              borderRadius: 6,
              background: "var(--bg)",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
              <div style={{ fontSize: 12, color: "var(--muted)" }}>
                <span
                  title={AUDIT_MODES.find((m) => m.id === a.mode)?.desc ?? ""}
                  style={{ fontWeight: 600, color: "var(--accent)", marginRight: 6 }}
                >
                  {AUDIT_MODES.find((m) => m.id === a.mode)?.badge ?? "📖"}{" "}
                  {AUDIT_MODES.find((m) => m.id === a.mode)?.label ?? "书"}
                </span>
                {a.sectionIds.length > 0
                  ? a.sectionIds.map((s) => `§${s}`).join(" / ")
                  : "?"}
                {" · "}
                <span title="参与本次审计的所有学生画像">
                  {a.learnerIds && a.learnerIds.length > 0
                    ? a.learnerIds
                        .map((l) => LEARNERS.find((x) => x.id === l)?.label ?? l)
                        .join(" + ")
                    : "?"}
                </span>
                {" · "}
                <span>{a.sidCount} 会话</span>
              </div>
              <span style={{ fontSize: 11, color: "var(--muted)" }}>
                {new Date(a.ts).toLocaleString("zh-CN")}
              </span>
            </div>
            <div
              style={{
                fontSize: 13,
                marginTop: 6,
                color: "var(--text)",
                wordBreak: "break-word",
              }}
              title={a.verdict}
            >
              {a.verdict || <span style={{ color: "var(--muted)" }}>（无 VERDICT）</span>}
            </div>
            <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 4, fontFamily: "monospace" }}>
              {a.aid}
            </div>
            <div style={{ marginTop: 6, display: "flex", gap: 6, justifyContent: "flex-end", alignItems: "center" }}>
              <a
                href={`/api/audits/${a.aid}`}
                target="_blank"
                rel="noreferrer"
                style={{ fontSize: 11, color: "var(--muted)" }}
                title="原始 JSON（新标签页）"
              >
                原始
              </a>
              <button
                className="primary"
                style={{ padding: "2px 8px", fontSize: 11 }}
                onClick={() => onView(a.aid)}
              >
                载入对照
              </button>
            </div>
          </div>
        ))}
      </aside>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === "done"
      ? "var(--accent)"
      : status === "running"
        ? "var(--accent)"
        : status === "aborted"
          ? "var(--muted)"
          : "var(--danger)";
  const label =
    status === "done"
      ? "完成"
      : status === "running"
        ? "进行中"
        : status === "aborted"
          ? "中止"
          : status === "errored"
            ? "报错"
            : status;
  return <span style={{ color }}>{label}</span>;
}

function TeachingModeBadge({
  mode,
  commentariesEnabled,
}: {
  mode?: string;
  commentariesEnabled?: boolean;
}) {
  const m = (mode || "socratic") as TeachingMode;
  const info = TEACHING_MODES.find((x) => x.id === m);
  const suffix =
    m === "close_reading" ? (commentariesEnabled ? " · +注" : " · 无注") : "";
  return (
    <span title={info?.desc ?? ""}>
      {info?.badge ?? "📖"} {info?.label ?? m}
      {suffix}
    </span>
  );
}
