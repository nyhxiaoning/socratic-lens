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

/** 消息滚动区。教师引用标记被渲染为可点击的隐藏脚注。 */
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
        <div style={{ color: "var(--muted)", textAlign: "center", padding: "48px 24px", lineHeight: 1.9 }}>
          <div style={{ fontSize: 15, color: "var(--text)", marginBottom: 8 }}>还没有对话</div>
          <div>
            上方选好书、节、学生类型，点「开始」。
            <br />
            教师说完一轮，学生跟一轮{maxTurns === 0 ? "，直到本节讲完" : `，共 ${maxTurns} 轮`}。
          </div>
          <div style={{ fontSize: 12, marginTop: 10, opacity: 0.8 }}>
            学生看不到原文，只能从老师的话里学——它问不出来、老师讲不到的，就是书要补的地方。
          </div>
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
  let citeIdx = 0;

  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIdx) out.push(text.slice(lastIdx, m.index));
    const id = m[1];
    const snippet = m[2] || "";
    const cite = turnCites?.[citeIdx++];
    const hit = cite ? cite.hit : true;
    out.push(
      <CiteBadge key={`c${key++}`} id={id} snippet={snippet} hit={hit} onCite={onCite} />,
    );
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) out.push(text.slice(lastIdx));
  return out;
}

/** 隐藏式引用脚注：只显示一个小 § 标记，点击打开原文全文模态。 */
function CiteBadge({
  id, snippet, hit, onCite,
}: {
  id: string; snippet: string; hit: boolean; onCite: (id: string) => void;
}) {
  return (
    <button
      onClick={() => onCite(id)}
      title={snippet ? `${snippet}${hit ? "" : " ⚠️ verbatim miss"}` : (hit ? "点击查看本节原文" : "⚠️ verbatim miss：该片段在原文中没有逐字出现")}
      style={{
        display: "inline",
        padding: "0 3px",
        margin: "0 1px",
        fontSize: "0.75em",
        verticalAlign: "super",
        border: `1px solid ${hit ? "var(--border)" : "var(--danger)"}`,
        borderRadius: 3,
        background: hit ? "var(--bg)" : "rgba(255,0,0,0.08)",
        color: hit ? "var(--muted)" : "var(--danger)",
        cursor: "pointer",
        lineHeight: 1,
      }}
    >
      §{id}
      {!hit && " ⚠"}
    </button>
  );
}
