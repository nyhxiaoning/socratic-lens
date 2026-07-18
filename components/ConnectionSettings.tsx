"use client";

import { useEffect, useState } from "react";
import { Modal } from "./Modal";

const PRESETS: { label: string; baseUrl: string; hint: string }[] = [
  { label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", hint: "deepseek-chat" },
  { label: "OpenAI", baseUrl: "https://api.openai.com/v1", hint: "gpt-4o-mini" },
  { label: "火山方舟 Ark", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", hint: "接入点 ID" },
  { label: "阿里百炼", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", hint: "qwen-plus" },
];

type ConfigResp = {
  baseUrl: string; model: string; auditBaseUrl: string; auditModel: string;
  priceIn: number | null; priceOut: number | null;
  hasApiKey: boolean; apiKeyMasked: string; hasAuditApiKey: boolean; auditApiKeyMasked: string;
  envBaseUrl: boolean; envApiKey: boolean; envModel: boolean;
};

const lab: React.CSSProperties = { fontSize: 12, color: "var(--muted)", marginBottom: 3 };
const inp: React.CSSProperties = {
  width: "100%", padding: "7px 9px", background: "var(--bg)",
  border: "1px solid var(--border)", borderRadius: 5, color: "inherit", fontSize: 13,
};

/** 连接设置：页面内填 BASE_URL / API Key / MODEL，写到 data/config.json，含真实探活。 */
export function ConnectionSettings({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyChanged, setApiKeyChanged] = useState(false);
  const [model, setModel] = useState("");
  const [priceIn, setPriceIn] = useState("");
  const [priceOut, setPriceOut] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [auditBaseUrl, setAuditBaseUrl] = useState("");
  const [auditApiKey, setAuditApiKey] = useState("");
  const [auditApiKeyChanged, setAuditApiKeyChanged] = useState(false);
  const [auditModel, setAuditModel] = useState("");
  const [loaded, setLoaded] = useState<ConfigResp | null>(null);
  const [busy, setBusy] = useState(false);
  const [testState, setTestState] = useState<{ ok: boolean; msg: string } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/config").then((r) => r.json()).then((d: ConfigResp) => {
      setLoaded(d);
      setBaseUrl(d.baseUrl); setModel(d.model);
      setPriceIn(d.priceIn != null ? String(d.priceIn) : "");
      setPriceOut(d.priceOut != null ? String(d.priceOut) : "");
      setAuditBaseUrl(d.auditBaseUrl); setAuditModel(d.auditModel);
      if (d.auditBaseUrl || d.auditModel || d.hasAuditApiKey) setShowAdvanced(true);
    }).catch((e) => setError(String(e)));
  }, []);

  function body(testOnly: boolean) {
    return {
      testOnly,
      baseUrl: baseUrl.trim(), model: model.trim(),
      apiKey: apiKey.trim(), apiKeyChanged,
      auditBaseUrl: auditBaseUrl.trim(), auditModel: auditModel.trim(),
      auditApiKey: auditApiKey.trim(), auditApiKeyChanged,
      priceIn: priceIn.trim() === "" ? undefined : Number(priceIn),
      priceOut: priceOut.trim() === "" ? undefined : Number(priceOut),
    };
  }

  async function doTest() {
    setBusy(true); setError(""); setTestState(null);
    try {
      const r = await fetch("/api/config", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body(true)),
      });
      const d = await r.json();
      if (d.ok) {
        setTestState({ ok: true, msg: `连通成功，模型回复：${d.reply || "（空）"}` });
      } else setTestState({ ok: false, msg: d.error || "连接失败" });
    } catch (e) {
      setTestState({ ok: false, msg: (e as Error).message });
    } finally { setBusy(false); }
  }

  async function doSave() {
    setBusy(true); setError("");
    try {
      const r = await fetch("/api/config", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body(false)),
      });
      if (!r.ok) { const d = await r.json().catch(() => ({})); setError(d.error || `HTTP ${r.status}`); return; }
      onSaved(); onClose();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  const canSave = baseUrl.trim() !== "" && model.trim() !== "" && (loaded?.hasApiKey || apiKey.trim() !== "");

  return (
    <Modal title="连接设置（填一次，之后都用它）" onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.6 }}>
          填你自己的大模型接口（任意 OpenAI 兼容端点）。保存后写到 <code>data/config.json</code>，优先级高于 <code>.env.local</code>。API Key 只存在本机。
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>快速填端点：</span>
          {PRESETS.map((p) => (
            <button key={p.label} onClick={() => setBaseUrl(p.baseUrl)} style={{ fontSize: 12, padding: "3px 10px" }} title={`${p.baseUrl}（示例模型：${p.hint}）`}>
              {p.label}
            </button>
          ))}
        </div>
        <div>
          <div style={lab}>接口地址 BASE_URL（OpenAI 兼容，通常以 /v1 结尾）</div>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.deepseek.com/v1" style={inp} />
        </div>
        <div>
          <div style={lab}>
            API Key
            {loaded?.hasApiKey && !apiKeyChanged && (
              <span style={{ marginLeft: 8, color: "var(--accent)" }}>已保存（{loaded.apiKeyMasked}），留空则不改</span>
            )}
          </div>
          <input value={apiKey} onChange={(e) => { setApiKey(e.target.value); setApiKeyChanged(true); }} placeholder={loaded?.hasApiKey ? "（保持不变）" : "sk-..."} type="password" style={inp} />
        </div>
        <div>
          <div style={lab}>模型名 MODEL（教师 / 学生 / 审计默认共用）</div>
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="deepseek-chat" style={inp} />
        </div>
        {(loaded?.envBaseUrl || loaded?.envApiKey || loaded?.envModel) && (
          <div style={{ fontSize: 11, color: "var(--muted)" }}>
            检测到 .env.local 已有：{[loaded.envBaseUrl && "BASE_URL", loaded.envApiKey && "API Key", loaded.envModel && "MODEL"].filter(Boolean).join(" / ")}。此处留空的字段会自动回落它们。
          </div>
        )}
        <div>
          <button onClick={() => setShowAdvanced((v) => !v)} style={{ fontSize: 12, padding: "3px 10px" }}>
            {showAdvanced ? "▾ 收起高级" : "▸ 高级：独立审计端点 / 价格"}
          </button>
        </div>
        {showAdvanced && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 12, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6 }}>
            <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.6 }}>
              审计器与生成器同源会互相包庇盲区。想更客观，给审计单配别家端点。留空则用上面的主连接。
            </div>
            <div>
              <div style={lab}>审计端点 BASE_URL（可选）</div>
              <input value={auditBaseUrl} onChange={(e) => setAuditBaseUrl(e.target.value)} style={inp} />
            </div>
            <div>
              <div style={lab}>
                审计 API Key（可选）
                {loaded?.hasAuditApiKey && !auditApiKeyChanged && (
                  <span style={{ marginLeft: 8, color: "var(--accent)" }}>已保存（{loaded.auditApiKeyMasked}）</span>
                )}
              </div>
              <input value={auditApiKey} onChange={(e) => { setAuditApiKey(e.target.value); setAuditApiKeyChanged(true); }} type="password" style={inp} />
            </div>
            <div>
              <div style={lab}>审计模型（可选）</div>
              <input value={auditModel} onChange={(e) => setAuditModel(e.target.value)} style={inp} />
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <div style={{ flex: 1 }}>
                <div style={lab}>输入单价（¥ / 1000 token，可选）</div>
                <input value={priceIn} onChange={(e) => setPriceIn(e.target.value)} placeholder="0.001" inputMode="decimal" style={inp} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={lab}>输出单价（¥ / 1000 token，可选）</div>
                <input value={priceOut} onChange={(e) => setPriceOut(e.target.value)} placeholder="0.002" inputMode="decimal" style={inp} />
              </div>
            </div>
          </div>
        )}
        {testState && (
          <div style={{ fontSize: 12, padding: "8px 10px", borderRadius: 6, whiteSpace: "pre-wrap",
            border: `1px solid ${testState.ok ? "var(--accent)" : "var(--danger)"}`,
            color: testState.ok ? "var(--accent)" : "var(--danger)" }}>
            {testState.ok ? "✓ " : "✗ "}{testState.msg}
          </div>
        )}
        {error && <div style={{ color: "var(--danger)", fontSize: 13, whiteSpace: "pre-wrap" }}>{error}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose}>取消</button>
          <button onClick={doTest} disabled={busy || !canSave}>{busy ? "…" : "测试连接"}</button>
          <button className="primary" onClick={doSave} disabled={busy || !canSave}>保存</button>
        </div>
      </div>
    </Modal>
  );
}
