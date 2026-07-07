"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type BookSummary = { slug: string; title: string; author?: string; sectionCount: number };
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

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

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

  const canStart = useMemo(
    () => Boolean(bookSlug && sectionId && learnerId && !running),
    [bookSlug, sectionId, learnerId, running],
  );

  async function start() {
    setError("");
    setMessages([]);
    setSid("");
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
          // 找最后一条同 actor 同 turn 的消息追加
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
        // 已通过 chunk 累积完毕，用 text 校正一次防漂移
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
        // sid 已在 meta 时设置
        break;
    }
  }

  function stop() {
    abortRef.current?.abort();
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
                {b.title}（{b.sectionCount} 节）
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
            {book?.sections.map((s) => (
              <option key={s.id} value={s.id}>
                §{s.id} {s.title}
              </option>
            ))}
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
          height: "calc(100vh - 220px)",
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
        }}
      >
        <span>{sid ? `会话 ${sid}` : "尚未开始"}</span>
        {sid && (
          <a
            href={`/api/sessions/${sid}`}
            target="_blank"
            style={{ color: "var(--accent)" }}
            rel="noreferrer"
          >
            查看 transcript.jsonl
          </a>
        )}
      </footer>

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
