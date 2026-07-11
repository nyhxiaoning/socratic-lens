import { forwardRef } from "react";
import type { CitationLookup, Msg } from "./types";
import { CITE_RE } from "./types";

type ChatViewProps = {
  messages: Msg[];
  running: boolean;
  maxTurns: number;
  citations: CitationLookup;
  onCite: (id: string) => void;
};

/** 消息滚动区（引用 chip 会根据校验结果标 miss）。 */
export const ChatView = forwardRef<HTMLDivElement, ChatViewProps>(function ChatView(
  { messages, running, maxTurns, citations, onCite },
  ref,
) {
  return (
    <div
      ref={ref}
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
        <Bubble key={i} msg={m} citations={citations} onCite={onCite} />
      ))}
      {running && (
        <div style={{ color: "var(--muted)", fontSize: 12, marginTop: 6 }}>
          ● 进行中…
        </div>
      )}
    </div>
  );
});

function Bubble({
  msg,
  citations,
  onCite,
}: {
  msg: Msg;
  citations: CitationLookup;
  onCite: (id: string) => void;
}) {
  const isTeacher = msg.actor === "teacher";
  const turnCites = isTeacher ? citations.get(msg.turn) : undefined;
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
          {renderWithCitations(msg.text, onCite, turnCites)}
        </div>
      </div>
    </div>
  );
}

function renderWithCitations(
  text: string,
  onCite: (id: string) => void,
  turnCites: { sectionId: string; snippet: string; hit: boolean }[] | undefined,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(CITE_RE.source, "g");
  let key = 0;
  // 记录教师本轮里第 n 个引用对应 turnCites 的第 n 项（简单同序 zip）
  let citeIdx = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIdx) out.push(text.slice(lastIdx, m.index));
    const id = m[1];
    const snippet = m[2] || "";
    const cite = turnCites?.[citeIdx++];
    const hit = cite ? cite.hit : true; // 学生消息或没记录时默认视为 ok
    out.push(
      <button
        key={`c${key++}`}
        onClick={() => onCite(id)}
        title={hit ? "查看该节原文" : "⚠️ verbatim miss：引用片段在本节原文里没有逐字出现"}
        style={{
          display: "inline",
          padding: "0 6px",
          margin: "0 2px",
          fontSize: "0.85em",
          border: `1px solid ${hit ? "var(--accent)" : "var(--danger)"}`,
          borderRadius: 4,
          background: hit ? "transparent" : "rgba(255,0,0,0.08)",
          color: hit ? "var(--accent)" : "var(--danger)",
          cursor: "pointer",
        }}
      >
        §{id}
        {snippet && ` · ${snippet}`}
        {!hit && " ⚠"}
      </button>,
    );
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) out.push(text.slice(lastIdx));
  return out;
}
