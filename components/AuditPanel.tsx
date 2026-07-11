import { useMemo, useState, useEffect } from "react";
import {
  AUDIT_DIMENSIONS,
  LEARNERS,
  SECTION_LABELS,
  type AuditDimension,
  type AuditHistoryItem,
  type BookSummary,
  type SessionListItem,
} from "./types";

export function AuditPicker({
  book,
  currentSid,
  sessions,
  picked,
  onTogglePick,
  dimension,
  onDimension,
  history,
  onViewHistory,
  onCancel,
  onSubmit,
}: {
  book: BookSummary | undefined;
  currentSid: string;
  sessions: SessionListItem[];
  picked: Set<string>;
  onTogglePick: (sid: string) => void;
  dimension: AuditDimension;
  onDimension: (d: AuditDimension) => void;
  history: AuditHistoryItem[];
  onViewHistory: (aid: string) => void;
  onCancel: () => void;
  onSubmit: (sampleName?: string) => void;
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
  const dimLabel = (d: AuditDimension) =>
    AUDIT_DIMENSIONS.find((x) => x.id === d)?.label ?? d;

  // Fidelity 样本选择
  const [samples, setSamples] = useState<{ name: string; hasSource: boolean; hasSynth: boolean }[]>([]);
  const [selectedSample, setSelectedSample] = useState<string>("");
  useEffect(() => {
    if (dimension === "fidelity") {
      fetch("/api/fidelity-samples")
        .then((r) => r.json())
        .then((d) => {
          setSamples(d.samples || []);
          if (d.samples?.[0]) setSelectedSample(d.samples[0].name);
        })
        .catch(() => {});
    }
  }, [dimension]);

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
        <strong style={{ fontSize: 14 }}>{dimension === "fidelity" ? "选要审的保真度样本" : "选要一起送审的会话"}</strong>
        <div style={{ fontSize: 12, color: "var(--muted)" }}>
          {dimension === "fidelity" ? "源材料 vs 合成节 勾稽" : `跨多节 = 合审。已选 ${picked.size} 个`}
        </div>
      </div>

      {/* 审计维度切换 */}
      <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        {AUDIT_DIMENSIONS.map((d) => (
          <button
            key={d.id}
            onClick={() => onDimension(d.id)}
            title={d.desc}
            className={dimension === d.id ? "primary" : undefined}
            style={{ fontSize: 12 }}
          >
            {d.label}
          </button>
        ))}
        <span style={{ fontSize: 11, color: "var(--muted)", alignSelf: "center" }}>
          {AUDIT_DIMENSIONS.find((x) => x.id === dimension)?.desc}
        </span>
      </div>

      {/* Fidelity 保真度审计：选样本 */}
      {dimension === "fidelity" ? (
        <div
          style={{
            maxHeight: 200,
            overflowY: "auto",
            padding: 8,
            background: "var(--bg)",
            border: "1px solid var(--border)",
            borderRadius: 6,
          }}
        >
          {samples.length === 0 ? (
            <div style={{ color: "var(--muted)", padding: 20, textAlign: "center" }}>
              没有找到保真度审计样本。请先在 <code>data/fidelity-samples/</code> 下建样本。
            </div>
          ) : (
            samples.filter((s) => s.hasSource && s.hasSynth).map((s) => (
              <label
                key={s.name}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "4px 6px",
                  fontSize: 13,
                  cursor: "pointer",
                  background: selectedSample === s.name ? "var(--teacher)" : "transparent",
                  borderRadius: 4,
                }}
              >
                <input
                  type="radio"
                  name="fidelity-sample"
                  checked={selectedSample === s.name}
                  onChange={() => setSelectedSample(s.name)}
                />
                {s.name}
              </label>
            ))
          )}
        </div>
      ) : (
        /* 普通审计：选会话 */
        <div
          style={{
            maxHeight: 260,
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
      )}

      {/* 审计历史 */}
      {history.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>
            本书审计历史（点击回看）
          </div>
          <div
            style={{
              maxHeight: 140,
              overflowY: "auto",
              padding: 8,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 6,
            }}
          >
            {history.map((h) => (
              <button
                key={h.aid}
                onClick={() => onViewHistory(h.aid)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "4px 6px",
                  fontSize: 12,
                  background: "transparent",
                  border: "none",
                  borderBottom: "1px solid var(--border)",
                  cursor: "pointer",
                }}
                title={h.verdict}
              >
                <span
                  style={{
                    color: h.dimension === "teacher" ? "var(--accent)" : "var(--muted)",
                    marginRight: 6,
                  }}
                >
                  [{dimLabel(h.dimension)}]
                </span>
                <span style={{ color: "var(--muted)" }}>
                  {h.sectionIds.map((s) => "§" + s).join(" ")} · {h.sidCount} 会话
                </span>
                {h.verdict && (
                  <span style={{ display: "block", color: "var(--muted)", opacity: 0.85 }}>
                    {h.verdict.length > 60 ? h.verdict.slice(0, 60) + "…" : h.verdict}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end", gap: 8 }}>
        <button onClick={onCancel}>取消</button>
        {dimension === "fidelity" ? (
          <button className="primary" onClick={() => onSubmit(selectedSample)} disabled={!selectedSample}>
            开始审计 · 保真度（{selectedSample || "未选"}）
          </button>
        ) : (
          <button className="primary" onClick={() => onSubmit()} disabled={picked.size === 0}>
            开始审计 · {dimLabel(dimension)}（{picked.size}）
          </button>
        )}
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
