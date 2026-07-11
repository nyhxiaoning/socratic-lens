"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { readSse } from "@/lib/sse";
import {
  LEARNERS,
  PACINGS,
  type LearnerId,
  type Pacing,
  type CoachAnalysis,
  type LearnerCoachAnalysis,
  type Msg,
  type CitationLookup,
  type BookSummary,
  type BookDetail,
  type SessionListItem,
  type SessionEvent,
  type AuditEvent,
  type AuditDimension,
  type AuditHistoryItem,
} from "@/components/types";

export type Usage = { promptTokens: number; completionTokens: number; costCny: number };
const ZERO_USAGE: Usage = { promptTokens: 0, completionTokens: 0, costCny: 0 };
export type WindowInfo = { startPage: number; endPage: number; totalPages: number };

/** 观察台的全部状态与副作用。页面只负责渲染。 */
export function useSession() {
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [bookSlug, setBookSlug] = useState<string>("");
  const [book, setBook] = useState<BookDetail | null>(null);
  const [sectionId, setSectionId] = useState<string>("");
  const [learnerId, setLearnerId] = useState<LearnerId>("novice");
  const [pacing, setPacing] = useState<Pacing>("normal");
  const [coachEnabled, setCoachEnabled] = useState<boolean>(true);
  const [learnerCoachEnabled, setLearnerCoachEnabled] = useState<boolean>(true);
  const [maxTurns, setMaxTurns] = useState<number>(6);

  // 批量矩阵生成：同一节 × 多画像 × 多节奏
  const [batchMode, setBatchMode] = useState<boolean>(false);
  const [selectedLearners, setSelectedLearners] = useState<Set<LearnerId>>(
    new Set<LearnerId>(["novice", "mid", "critic"]),
  );
  const [selectedPacings, setSelectedPacings] = useState<Set<Pacing>>(
    new Set<Pacing>(["normal"]),
  );
  type BatchRun = {
    learnerId: LearnerId;
    pacing: Pacing;
    sid: string;
    status: "queued" | "running" | "done" | "error";
  };
  const [batchRuns, setBatchRuns] = useState<BatchRun[]>([]);
  const [batchRunning, setBatchRunning] = useState<boolean>(false);
  const batchStopRef = useRef<boolean>(false);

  const [messages, setMessages] = useState<Msg[]>([]);
  const [coachHistory, setCoachHistory] = useState<{ turn: number; analysis: CoachAnalysis }[]>([]);
  const [learnerCoachHistory, setLearnerCoachHistory] = useState<
    { turn: number; analysis: LearnerCoachAnalysis }[]
  >([]);
  const [citations, setCitations] = useState<CitationLookup>(new Map());
  const [usage, setUsage] = useState<Usage>(ZERO_USAGE);
  const [showHistory, setShowHistory] = useState<boolean>(false);
  const [historyItems, setHistoryItems] = useState<SessionListItem[]>([]);
  const [windowInfo, setWindowInfo] = useState<WindowInfo | null>(null);
  const [running, setRunning] = useState(false);
  const [sid, setSid] = useState<string>("");
  const [turnsSoFar, setTurnsSoFar] = useState<number>(0);
  const [error, setError] = useState<string>("");
  const [modalSection, setModalSection] = useState<{ id: string; text: string } | null>(null);
  const [showUpload, setShowUpload] = useState<boolean>(false);

  // 审计
  const [auditText, setAuditText] = useState<string>("");
  const [auditing, setAuditing] = useState<boolean>(false);
  const [showAuditPanel, setShowAuditPanel] = useState<boolean>(false);
  const [existingSessions, setExistingSessions] = useState<SessionListItem[]>([]);
  const [pickedSids, setPickedSids] = useState<Set<string>>(new Set());
  const [auditDimension, setAuditDimension] = useState<AuditDimension>("book");
  const [auditHistory, setAuditHistory] = useState<AuditHistoryItem[]>([]);

  const abortRef = useRef<AbortController | null>(null);
  const auditAbortRef = useRef<AbortController | null>(null);
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

  /** 重新拉书列表；可选传 selectSlug 拉完后选中它（上传成功后用）。 */
  async function refreshBooks(selectSlug?: string) {
    try {
      const r = await fetch("/api/books");
      const d = await r.json();
      setBooks(d.books || []);
      if (selectSlug) setBookSlug(selectSlug);
    } catch (e) {
      setError(String(e));
    }
  }

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

  /** 从 /api/sessions/<sid> 返回值把 transcript + 双教练 + 引用 + usage 灌进内存。 */
  function hydrateFromSession(d: any) {
    setMessages(
      (d.turns as Msg[]).map((t) => ({ turn: t.turn, actor: t.actor, text: t.text })),
    );
    setCoachHistory(
      (d.teacherCoach as { turn: number; analysis: CoachAnalysis }[]).map((c) => ({
        turn: c.turn,
        analysis: c.analysis,
      })),
    );
    setLearnerCoachHistory(
      (d.learnerCoach as { turn: number; analysis: LearnerCoachAnalysis }[]).map((c) => ({
        turn: c.turn,
        analysis: c.analysis,
      })),
    );
    const map: CitationLookup = new Map();
    for (const rec of (d.citations || []) as { turn: number; cites: any[] }[]) {
      map.set(rec.turn, rec.cites);
    }
    setCitations(map);
    setUsage(d.usageSummary ? (d.usageSummary as Usage) : ZERO_USAGE);
    setTurnsSoFar(d.meta.turnsSoFar ?? 0);
    setBookSlug(d.meta.bookSlug);
    setSectionId(d.meta.sectionId);
    setLearnerId(d.meta.learnerId);
    setPacing(d.meta.pacing || "normal");
    if (d.meta.windowStartPage !== undefined && d.meta.windowEndPage !== undefined) {
      setWindowInfo({ startPage: d.meta.windowStartPage, endPage: d.meta.windowEndPage, totalPages: 0 });
    } else {
      setWindowInfo(null);
    }
  }

  /** 把某个已有会话载入到对话栏，只读，不起新流。 */
  async function loadSessionIntoView(sidToLoad: string) {
    setError("");
    setAuditText("");
    setShowAuditPanel(false);
    try {
      const r = await fetch(`/api/sessions/${sidToLoad}`);
      const d = await r.json();
      if (!d.meta) {
        setError(d.error || "会话不存在");
        return;
      }
      setSid(sidToLoad);
      hydrateFromSession(d);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function handleEvent(ev: SessionEvent) {
    switch (ev.type) {
      case "meta":
        setSid(ev.meta.sid);
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
        // 学生说完这一轮才算完整完成，更新已跑轮数
        if (ev.actor === "learner") setTurnsSoFar(ev.turn);
        break;
      case "error":
        setError(ev.message);
        break;
      case "coach":
        if (ev.side === "teacher") {
          setCoachHistory((prev) => [...prev, { turn: ev.turn, analysis: ev.analysis as CoachAnalysis }]);
        } else {
          setLearnerCoachHistory((prev) => [
            ...prev,
            { turn: ev.turn, analysis: ev.analysis as LearnerCoachAnalysis },
          ]);
        }
        break;
      case "usage":
        setUsage((prev) => ({
          promptTokens: prev.promptTokens + ev.promptTokens,
          completionTokens: prev.completionTokens + ev.completionTokens,
          costCny: prev.costCny + ev.costCny,
        }));
        break;
      case "window_slide":
        setWindowInfo({ startPage: ev.startPage, endPage: ev.endPage, totalPages: ev.totalPages });
        break;
      // "done" / "compressed" 静默
    }
  }

  async function start(resumeSid?: string, maxTurnsOverride?: number) {
    setError("");
    setMessages([]);
    setCoachHistory([]);
    setLearnerCoachHistory([]);
    setCitations(new Map());
    setUsage(ZERO_USAGE);
    setSid("");
    setTurnsSoFar(0);
    setAuditText("");
    setShowAuditPanel(false);
    setWindowInfo(null);
    setRunning(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    if (resumeSid) {
      try {
        const r = await fetch(`/api/sessions/${resumeSid}`);
        const d = await r.json();
        if (d.meta) {
          setSid(resumeSid);
          hydrateFromSession(d);
        }
      } catch {
        // 忽略
      }
    }

    const effectiveMaxTurns = maxTurnsOverride ?? maxTurns;
    try {
      const resp = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          resumeSid
            ? { resumeSid, pacing, coachEnabled, learnerCoachEnabled, maxTurns: effectiveMaxTurns }
            : { bookSlug, sectionId, learnerId, pacing, coachEnabled, learnerCoachEnabled, maxTurns: effectiveMaxTurns },
        ),
        signal: ctrl.signal,
      });
      if (!resp.ok || !resp.body) throw new Error((await resp.text()) || `HTTP ${resp.status}`);
      await readSse<SessionEvent>(resp, handleEvent);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  /** 继续对话：对已停止/到轮次的会话再跑 extra 轮（默认 6）。 */
  function continueSession(extra = 6) {
    if (!sid) return;
    void start(sid, turnsSoFar + Math.max(1, extra));
  }

  function stop() {
    batchStopRef.current = true;
    abortRef.current?.abort();
  }

  function toggleLearner(id: LearnerId) {
    setSelectedLearners((prev) => {
      const copy = new Set(prev);
      if (copy.has(id)) copy.delete(id);
      else copy.add(id);
      return copy;
    });
  }
  function togglePacing(id: Pacing) {
    setSelectedPacings((prev) => {
      const copy = new Set(prev);
      if (copy.has(id)) copy.delete(id);
      else copy.add(id);
      return copy;
    });
  }

  /**
   * 批量矩阵：同一节 × 选中的画像 × 选中的节奏，串行逐个跑。
   * 每个会话仍实时流进 ChatView。全部完成后把这批 sid 预勾选进审计选择器。
   */
  async function runBatch() {
    if (!bookSlug || !sectionId) {
      setError("请先选书和节");
      return;
    }
    const learners = LEARNERS.map((l) => l.id).filter((id) => selectedLearners.has(id));
    const pacings = PACINGS.map((p) => p.id).filter((id) => selectedPacings.has(id));
    if (learners.length === 0 || pacings.length === 0) {
      setError("批量至少各选一个画像和一个节奏");
      return;
    }

    // 展开矩阵（画像外层、节奏内层，顺序稳定）
    const combos: { learnerId: LearnerId; pacing: Pacing }[] = [];
    for (const l of learners) for (const p of pacings) combos.push({ learnerId: l, pacing: p });

    setError("");
    setShowAuditPanel(false);
    setAuditText("");
    setBatchRunning(true);
    batchStopRef.current = false;
    const runs: BatchRun[] = combos.map((c) => ({ ...c, sid: "", status: "queued" }));
    setBatchRuns(runs);

    const doneSids: string[] = [];
    for (let i = 0; i < combos.length; i++) {
      if (batchStopRef.current) break;
      const { learnerId: l, pacing: p } = combos[i];
      runs[i] = { ...runs[i], status: "running" };
      setBatchRuns([...runs]);

      // 重置对话视图，跑这一个组合
      setMessages([]);
      setCoachHistory([]);
      setLearnerCoachHistory([]);
      setCitations(new Map());
      setUsage(ZERO_USAGE);
      setSid("");
      setTurnsSoFar(0);
      setWindowInfo(null);
      setRunning(true);

      const ctrl = new AbortController();
      abortRef.current = ctrl;
      let capturedSid = "";
      try {
        const resp = await fetch("/api/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            bookSlug,
            sectionId,
            learnerId: l,
            pacing: p,
            coachEnabled,
            learnerCoachEnabled,
            maxTurns,
          }),
          signal: ctrl.signal,
        });
        if (!resp.ok || !resp.body) throw new Error((await resp.text()) || `HTTP ${resp.status}`);
        await readSse<SessionEvent>(resp, (ev) => {
          if (ev.type === "meta") capturedSid = ev.meta.sid;
          handleEvent(ev);
        });
        runs[i] = { ...runs[i], sid: capturedSid, status: "done" };
        if (capturedSid) doneSids.push(capturedSid);
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          runs[i] = { ...runs[i], sid: capturedSid, status: "error" };
          if (capturedSid) doneSids.push(capturedSid); // 半截也留着可续跑/可审
          setBatchRuns([...runs]);
          break;
        }
        runs[i] = { ...runs[i], sid: capturedSid, status: "error" };
        setError((e as Error).message);
      } finally {
        setRunning(false);
        abortRef.current = null;
      }
      setBatchRuns([...runs]);
    }

    setBatchRunning(false);
    // 全部跑完：预勾选这批 sid，方便直接送审出"单节统一报告"
    if (doneSids.length > 0) {
      setPickedSids(new Set(doneSids));
    }
  }

  async function openAuditPanel() {
    setShowAuditPanel(true);
    setAuditText("");
    setPickedSids(sid ? new Set([sid]) : new Set());
    if (!bookSlug) return;
    try {
      const [sr, hr] = await Promise.all([
        fetch(`/api/sessions?bookSlug=${encodeURIComponent(bookSlug)}`),
        fetch(`/api/audits?bookSlug=${encodeURIComponent(bookSlug)}`),
      ]);
      const sd = await sr.json();
      setExistingSessions(sd.sessions || []);
      const hd = await hr.json();
      setAuditHistory(hd.audits || []);
    } catch (e) {
      setError(String(e));
    }
  }

  function togglePick(s: string) {
    setPickedSids((prev) => {
      const copy = new Set(prev);
      if (copy.has(s)) copy.delete(s);
      else copy.add(s);
      return copy;
    });
  }

  async function runAudit(sids: string[], dimension: AuditDimension = auditDimension) {
    if (sids.length === 0) {
      setError("请至少选一个会话");
      return;
    }
    setAuditText("");
    setAuditing(true);
    setError("");
    const ctrl = new AbortController();
    auditAbortRef.current = ctrl;
    try {
      const resp = await fetch(`/api/audits`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sids, dimension }),
        signal: ctrl.signal,
      });
      if (!resp.ok || !resp.body) throw new Error((await resp.text()) || `HTTP ${resp.status}`);
      await readSse<AuditEvent>(resp, (ev) => {
        if (ev.type === "audit_chunk") {
          setAuditText((prev) => prev + ev.text);
          queueMicrotask(() => auditRef.current?.scrollTo({ top: auditRef.current.scrollHeight }));
        } else if (ev.type === "audit_done") {
          setAuditText(ev.report.raw);
        } else if (ev.type === "audit_error") {
          setError(ev.message);
        }
      });
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      setAuditing(false);
      auditAbortRef.current = null;
    }
  }

  /** 载入一条历史审计报告到查看区（只读）。 */
  async function viewAudit(aid: string) {
    setError("");
    setShowAuditPanel(false);
    try {
      const r = await fetch(`/api/audits/${aid}`);
      const d = await r.json();
      if (d.report?.raw) {
        setAuditDimension((d.meta?.dimension as AuditDimension) ?? "book");
        setAuditText(d.report.raw);
      } else {
        setError(d.error || "审计不存在");
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function stopAudit() {
    auditAbortRef.current?.abort();
  }

  function reopenAudit() {
    setAuditText("");
    setShowAuditPanel(true);
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
      const r = await fetch(`/api/sessions`);
      const d = await r.json();
      setHistoryItems(d.sessions || []);
    } catch (e) {
      setError(String(e));
    }
  }

  return {
    // 配置
    books, bookSlug, setBookSlug, book, currentBookStat,
    sectionId, setSectionId, learnerId, setLearnerId, pacing, setPacing,
    coachEnabled, setCoachEnabled, learnerCoachEnabled, setLearnerCoachEnabled,
    maxTurns, setMaxTurns, canStart,
    // 批量矩阵
    batchMode, setBatchMode, selectedLearners, toggleLearner,
    selectedPacings, togglePacing, batchRuns, batchRunning, runBatch,
    // 对话
    messages, coachHistory, learnerCoachHistory, citations, usage, windowInfo,
    running, sid, turnsSoFar, error, scrollRef,
    // 审计
    auditText, auditing, showAuditPanel, setShowAuditPanel, existingSessions,
    pickedSids, togglePick, auditRef,
    auditDimension, setAuditDimension, auditHistory, viewAudit,
    // 历史 / 弹窗
    showHistory, setShowHistory, historyItems, modalSection, setModalSection,
    showUpload, setShowUpload, refreshBooks,
    // 动作
    start, stop, continueSession, openAuditPanel, runAudit, stopAudit, reopenAudit,
    openSection, openHistory, loadSessionIntoView,
  };
}
