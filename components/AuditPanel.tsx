import { useMemo } from "react";
import { LEARNERS, SECTION_LABELS, type BookSummary, type SessionListItem } from "./types";

export function AuditPicker({
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
  const grouped = useMemo(() => {
    const map = new Map<string, SessionListItem[]>();
    for (const s of sessions) {
      if (!map.has(s.sectionId)) map.set(s.sectionId, []);
      map.get(s.sectionId)!.push(s);
    }
    return map;
  }, [sessions]);

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
      <div
        style={{
          marginBottom: 8,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
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

/** 把 ===TAG=== 分隔的审计报告分段渲染。 */
export function AuditView({ raw }: { raw: string }) {
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
