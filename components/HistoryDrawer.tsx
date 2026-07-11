import { LEARNERS, type BookSummary, type SessionListItem } from "./types";

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

export function HistoryDrawer({
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
              <StatusBadge status={s.status} /> ·{" "}
              <span>
                {s.turnsSoFar ?? "?"} / {s.maxTurns ?? "?"} 轮
              </span>
            </div>
            <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2, fontFamily: "monospace" }}>
              {s.sid}
            </div>
            <div
              style={{
                marginTop: 6,
                display: "flex",
                gap: 6,
                justifyContent: "flex-end",
                alignItems: "center",
              }}
            >
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
              {(s.status === "aborted" || s.status === "errored") &&
                (s.turnsSoFar ?? 0) < (s.maxTurns ?? 0) && (
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
