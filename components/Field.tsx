"use client";

import { useState } from "react";

/** 一个简单的带 label 的字段容器。 */
export function Field({
  label,
  children,
  help,
}: {
  label: string;
  children: React.ReactNode;
  help?: string;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 12 }}>
      <span style={{ color: "var(--muted)", display: "flex", alignItems: "center", gap: 4 }}>
        {label}
        {help && <Help text={help} />}
      </span>
      {children}
    </label>
  );
}

/**
 * 点击式帮助气泡：一个小 ? 标记，点开显示一行说明。
 * 用点击而不是纯 hover——触屏也能看到。
 */
export function Help({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onBlur={() => setOpen(false)}
        aria-label="说明"
        title={text}
        style={{
          width: 15,
          height: 15,
          lineHeight: "13px",
          padding: 0,
          borderRadius: "50%",
          fontSize: 10,
          color: "var(--muted)",
          border: "1px solid var(--border)",
          background: "var(--bg)",
          cursor: "pointer",
        }}
      >
        ?
      </button>
      {open && (
        <span
          role="tooltip"
          style={{
            position: "absolute",
            top: "120%",
            left: 0,
            zIndex: 50,
            width: 240,
            padding: "8px 10px",
            fontSize: 12,
            lineHeight: 1.5,
            color: "var(--text)",
            background: "var(--panel)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            boxShadow: "0 4px 16px rgba(0,0,0,0.18)",
            whiteSpace: "normal",
          }}
        >
          {text}
        </span>
      )}
    </span>
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
