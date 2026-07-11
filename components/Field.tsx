/** 一个简单的带 label 的字段容器。 */
export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 12 }}>
      <span style={{ color: "var(--muted)" }}>{label}</span>
      {children}
    </label>
  );
}

/** 两列信息行：<key, value>，可选 danger 标红。 */
export function Row({
  k,
  v,
  danger,
}: {
  k: string;
  v: string;
  danger?: boolean;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "48px 1fr", gap: 6, fontSize: 12 }}>
      <span style={{ color: "var(--muted)" }}>{k}</span>
      <span style={{ color: danger ? "var(--danger)" : "inherit", wordBreak: "break-word" }}>
        {v}
      </span>
    </div>
  );
}
