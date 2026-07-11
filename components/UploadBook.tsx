"use client";

import { useMemo, useState } from "react";
import { Modal } from "./Modal";
import { parseMarkdownToBook } from "@/lib/parse-book";

/** 上传整本 md → 自动切节入库。预览用与后端同一份解析逻辑。 */
export function UploadBook({
  onClose,
  onImported,
}: {
  onClose: () => void;
  /** 导入成功回调，带新书 slug（供上层刷新书列表 + 选中）。 */
  onImported: (slug: string) => void;
}) {
  const [markdown, setMarkdown] = useState<string>("");
  const [fileName, setFileName] = useState<string>("");
  const [slug, setSlug] = useState<string>("");
  const [title, setTitle] = useState<string>("");
  const [author, setAuthor] = useState<string>("");
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string>("");

  // 本地即时预览（与后端同一份纯解析）
  const preview = useMemo(() => {
    if (!markdown.trim()) return null;
    try {
      return parseMarkdownToBook(markdown);
    } catch {
      return null;
    }
  }, [markdown]);

  const slugValid = /^[a-z0-9-]{1,64}$/.test(slug);
  const canImport = slugValid && (preview?.sections.length ?? 0) > 0 && !busy;

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setFileName(f.name);
    const text = await f.text();
    setMarkdown(text);
    // slug 留空则用文件名（去扩展名、转小写、非法字符转连字符）
    if (!slug) {
      const base = f.name.replace(/\.md$/i, "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
      if (base) setSlug(base.slice(0, 64));
    }
  }

  async function doImport() {
    setBusy(true);
    setError("");
    try {
      const resp = await fetch("/api/books", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, title, author, markdown }),
      });
      const d = await resp.json();
      if (!resp.ok) {
        setError(d.error || `HTTP ${resp.status}`);
        return;
      }
      onImported(d.slug);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const labelStyle: React.CSSProperties = { fontSize: 12, color: "var(--muted)", marginBottom: 2 };
  const inputStyle: React.CSSProperties = {
    width: "100%",
    padding: "6px 8px",
    background: "var(--bg)",
    border: "1px solid var(--border)",
    borderRadius: 4,
    color: "inherit",
    fontSize: 13,
  };

  return (
    <Modal title="上传书（整本 md 自动切节）" onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ fontSize: 12, color: "var(--muted)" }}>
          按 <code>## 导论</code> / <code>## 第X章</code> / <code>## 第X节</code> 切分。章标题只做归属前缀，不单独成节。
        </div>

        <div>
          <div style={labelStyle}>markdown 文件（.md）或直接粘贴到下方</div>
          <input type="file" accept=".md,.markdown,text/markdown,text/plain" onChange={onFile} />
          {fileName && <span style={{ fontSize: 12, marginLeft: 8, color: "var(--muted)" }}>{fileName}</span>}
        </div>

        <div>
          <textarea
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
            placeholder="或把整本 md 粘贴到这里…"
            style={{ ...inputStyle, minHeight: 120, fontFamily: "monospace", resize: "vertical" }}
          />
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <div style={{ flex: "1 1 160px" }}>
            <div style={labelStyle}>slug（必填 · 小写字母/数字/连字符）</div>
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="my-book"
              style={{
                ...inputStyle,
                borderColor: slug && !slugValid ? "var(--danger)" : "var(--border)",
              }}
            />
          </div>
          <div style={{ flex: "1 1 160px" }}>
            <div style={labelStyle}>书名（留空用解析猜的）</div>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={preview?.suggestedTitle || "书名"}
              style={inputStyle}
            />
          </div>
          <div style={{ flex: "1 1 120px" }}>
            <div style={labelStyle}>作者（选填）</div>
            <input value={author} onChange={(e) => setAuthor(e.target.value)} style={inputStyle} />
          </div>
        </div>

        {/* 切节预览 */}
        {preview && (
          <div
            style={{
              padding: 8,
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              maxHeight: 200,
              overflowY: "auto",
            }}
          >
            {preview.sections.length === 0 ? (
              <div style={{ color: "var(--danger)", fontSize: 13 }}>
                切不出节：没找到 ## 导论 / 第X章 / 第X节 边界。
              </div>
            ) : (
              <>
                <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>
                  将切成 {preview.sections.length} 节：
                </div>
                {preview.sections.map((s) => (
                  <div key={s.id} style={{ fontSize: 12, padding: "1px 0" }}>
                    §{s.id} {s.title}{" "}
                    <span style={{ color: "var(--muted)" }}>（{s.body.length} 字）</span>
                  </div>
                ))}
              </>
            )}
          </div>
        )}

        {error && (
          <div style={{ color: "var(--danger)", fontSize: 13, whiteSpace: "pre-wrap" }}>{error}</div>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onClose}>取消</button>
          <button className="primary" onClick={doImport} disabled={!canImport}>
            {busy ? "导入中…" : `导入（${preview?.sections.length ?? 0} 节）`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
