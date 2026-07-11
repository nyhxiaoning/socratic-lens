"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { readSse } from "@/lib/sse";
import {
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
  const [error, setError] = useState<string>("");
  const [modalSection, setModalSection] = useState<{ id: string; text: string } | null>(null);

  // 审计
  const [auditText, setAuditText] = useState<string>("");
  const [auditing, setAuditing] = useState<boolean>(false);
  const [showAuditPanel, setShowAuditPanel] = useState<boolean>(false);
  const [existingSessions, setExistingSessions] = useState<SessionListItem[]>([]);
  const [pickedSids, setPickedSids] = useState<Set<string>>(new Set());

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

  async function start(resumeSid?: string) {
    setError("");
    setMessages([]);
    setCoachHistory([]);
    setLearnerCoachHistory([]);
    setCitations(new Map());
    setUsage(ZERO_USAGE);
    setSid("");
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

    try {
      const resp = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          resumeSid
            ? { resumeSid, pacing, coachEnabled, learnerCoachEnabled, maxTurns }
            : { bookSlug, sectionId, learnerId, pacing, coachEnabled, learnerCoachEnabled, maxTurns },
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

  function stop() {
    abortRef.current?.abort();
  }

  async function openAuditPanel() {
    setShowAuditPanel(true);
    setPickedSids(sid ? new Set([sid]) : new Set());
    if (!bookSlug) return;
    try {
      const r = await fetch(`/api/sessions?bookSlug=${encodeURIComponent(bookSlug)}`);
      const d = await r.json();
      setExistingSessions(d.sessions || []);
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

  async function runAudit(sids: string[]) {
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
        body: JSON.stringify({ sids }),
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
    // 对话
    messages, coachHistory, learnerCoachHistory, citations, usage, windowInfo,
    running, sid, error, scrollRef,
    // 审计
    auditText, auditing, showAuditPanel, setShowAuditPanel, existingSessions,
    pickedSids, togglePick, auditRef,
    // 历史 / 弹窗
    showHistory, setShowHistory, historyItems, modalSection, setModalSection,
    // 动作
    start, stop, openAuditPanel, runAudit, stopAudit, reopenAudit,
    openSection, openHistory, loadSessionIntoView,
  };
}
