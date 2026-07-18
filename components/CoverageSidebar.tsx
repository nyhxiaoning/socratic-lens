import type { CoverageItem, CoverageStats } from "./types";

const CATEGORY_LABEL: Record<string, string> = {
  knowledgePoint: "知识点",
  criteria: "评价标准",
  exercise: "原题",
  errorSpot: "易错点",
};

type Props = {
  visible: boolean;
  items: CoverageItem[];
  stats: CoverageStats | null;
  onCollapse: () => void;
};

export function CoverageSidebar({ visible, items, stats, onCollapse }: Props) {
  if (!visible) return null;

  if (items.length === 0) {
    return (
      <div
        className="side-panel"
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          background: "var(--panel)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: 12,
          fontSize: 13,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <span style={{ fontWeight: 600 }}>知识点覆盖</span>
          <button onClick={onCollapse} style={{ fontSize: 11, padding: "2px 8px" }}>收起</button>
        </div>
        <div style={{ color: "var(--muted)", fontSize: 12, lineHeight: 1.7, marginTop: 12 }}>
          开始跑课后，这里会实时标注教师讲到了哪些知识点、还漏了哪些。
          <br />
          （首次会自动为本节生成知识点清单，稍等片刻。）
        </div>
      </div>
    );
  }

  const grouped = new Map<string, CoverageItem[]>();
  for (const item of items) {
    if (!grouped.has(item.category)) grouped.set(item.category, []);
    grouped.get(item.category)!.push(item);
  }

  const pct = stats && stats.total > 0 ? Math.round((stats.covered / stats.total) * 100) : 0;

  return (
    <div
      className="side-panel"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
        background: "var(--panel)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 12,
        fontSize: 13,
      }}
    >
      {/* 头部：进度条 + 折叠按钮 */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <span style={{ fontWeight: 600, fontSize: 13 }}>
          知识点覆盖 {stats && `${stats.covered}/${stats.total}`}
        </span>
        <button onClick={onCollapse} style={{ fontSize: 11, padding: "2px 8px" }}>
          收起
        </button>
      </div>

      {/* 总进度条 */}
      <div
        style={{
          height: 6,
          borderRadius: 3,
          background: "var(--bg)",
          marginBottom: 10,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: pct === 100 ? "var(--accent)" : "var(--teacher)",
            transition: "width 0.3s ease",
            borderRadius: 3,
          }}
        />
      </div>

      {/* 分类统计 */}
      {stats && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10, fontSize: 11, color: "var(--muted)" }}>
          {Object.entries(stats.byCategory).map(([cat, c]) => {
            if (c.total === 0) return null;
            return (
              <span key={cat}>
                {CATEGORY_LABEL[cat] ?? cat}: {c.covered}/{c.total}
              </span>
            );
          })}
        </div>
      )}

      {/* 清单列表 */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {Array.from(grouped.entries()).map(([cat, catItems]) => (
          <div key={cat} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 11, color: "var(--muted)", marginBottom: 4, fontWeight: 600 }}>
              {CATEGORY_LABEL[cat] ?? cat} ({catItems.filter((i) => i.status === "covered").length}/{catItems.length})
            </div>
            {catItems.map((item) => (
              <div
                key={item.id}
                title={item.evidence ? `引用: ${item.evidence}` : "尚未覆盖"}
                style={{
                  padding: "3px 6px",
                  marginBottom: 2,
                  borderRadius: 4,
                  fontSize: 12,
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 6,
                  background: item.status === "covered" ? "rgba(34,197,94,0.08)" : "transparent",
                }}
              >
                <span style={{ flexShrink: 0 }}>
                  {item.status === "covered" ? "✅" : "⬜"}
                </span>
                <span
                  style={{
                    color: item.status === "covered" ? "var(--text)" : "var(--muted)",
                    lineHeight: 1.4,
                  }}
                >
                  {item.name}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>

      {items.length === 0 && (
        <div style={{ color: "var(--muted)", fontSize: 12, textAlign: "center", padding: 20 }}>
          点击开始自动分析知识点
        </div>
      )}
    </div>
  );
}

