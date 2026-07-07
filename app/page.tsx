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

type Msg = { turn: number; actor: "teacher" | "learner"; text: string };

type SessionEvent =
  | { type: "meta"; meta: { sid: string } }
  | { type: "turn_start"; actor: "teacher" | "learner"; turn: number }
  | { type: "chunk"; actor: "teacher" | "learner"; turn: number; text: string }
  | { type: "turn_end"; actor: "teacher" | "learner"; turn: number; text: string }
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
};

const CITE_RE = /〔§([\w-]{1,32})(?:[｜|]([^〕\n]{0,120}))?〕/g;

export default function Page() {
  const [books, setBooks] = useState<BookSummary[]>([]);
  const [bookSlug, setBookSlug] = useState<string>("");
  const [book, setBook] = useState<BookDetail | null>(null);
  const [sectionId, setSectionId] = useState<string>("");
  const [learnerId, setLearnerId] = useState<LearnerId>("novice");
  const [maxTurns, setMaxTurns] = useState<number>(6);

  const [messages, setMessages] = useState<Msg[]>([]);
  const [running, setRunning] = useState(false);
  const [sid, setSid] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [modalSection, setModalSection] = useState<{ id: string; text: string } | null>(null);

  // 审计相关
  const [auditText, setAuditText] = useState<string>("");
  const [auditing, setAuditing] = useState<boolean>(false);
  const [sessionDone, setSessionDone] = useState<boolean>(false);
  const [showAuditPanel, setShowAuditPanel] = useState<boolean>(false);
  const [existingSessions, setExistingSessions] = useState<SessionListItem[]>([]);
  const [pickedSids, setPickedSids] = useState<Set<string>>(new Set());
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

  async function start() {
    setError("");
    setMessages([]);
    setSid("");
    setAuditText("");
    setSessionDone(false);
    setShowAuditPanel(false);
    setRunning(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const resp = await fetch("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bookSlug, sectionId, learnerId, maxTurns }),
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
      case "done":
        setSessionDone(true);
        break;
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

        <Field label="轮数">
          <select
            value={maxTurns}
            onChange={(e) => setMaxTurns(Number(e.target.value))}
            disabled={running}
          >
            {[3, 4, 6, 8, 12].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>

        <div style={{ flex: 1 }} />

        {!running ? (
          <button className="primary" onClick={start} disabled={!canStart}>
            开始
          </button>
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
        ref={scrollRef}
        style={{
          height: "calc(100vh - 280px)",
          minHeight: 300,
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
        <span>{sid ? `会话 ${sid}` : "尚未开始"}</span>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {sessionDone && !auditing && (
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
            <span>审计报告{auditing && "（生成中…）"}</span>
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
          <AuditView raw={auditText} />
        </section>
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
  onTogglePick,
  onCancel,
  onSubmit,
}: {
  book: BookSummary | undefined;
  currentSid: string;
  sessions: SessionListItem[];
  picked: Set<string>;
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
                      {s.status}
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
function AuditView({ raw }: { raw: string }) {
  const sections = parseAuditSections(raw);
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
            {SECTION_LABELS[s.tag] ?? s.tag}
          </div>
          <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{s.body}</div>
        </div>
      ))}
    </div>
  );
}

const SECTION_LABELS: Record<string, string> = {
  VERDICT: "一句话结论",
  CLARITY: "表达清晰度问题",
  HARD_SPOTS: "学生真正卡住的点",
  INCONSISTENCY: "教师讲的 vs 原文（关键）",
  SUGGESTIONS: "对书本身的修改建议",
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
