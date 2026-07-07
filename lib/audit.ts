import path from "node:path";
import { getBook, getSection, getSectionTitle } from "./book";
import { callLLM, type LLMMessage } from "./llm";
import type { SessionMeta, Turn } from "./session";
import {
  appendLine,
  DATA_ROOT,
  ensureDir,
  exists,
  PROMPTS_ROOT,
  readJson,
  readText,
  SESSIONS_ROOT,
  writeAtomic,
} from "./storage";

/** 已解析的审计报告分段（都是 raw 里 ===TAG=== 之间的文本）。 */
export type AuditReport = {
  verdict: string;
  clarity: string;
  hardSpots: string;
  inconsistency: string;
  suggestions: string;
  raw: string;
};

export type AuditMeta = {
  aid: string;
  bookSlug: string;
  sids: string[];
  sectionIds: string[];
  startedAt: number;
  endedAt?: number;
  status: "running" | "done" | "errored";
  error?: string;
};

export const AUDITS_ROOT = path.join(DATA_ROOT, "audits");

function auditDir(aid: string): string {
  return path.join(AUDITS_ROOT, aid);
}

function sessionMetaPath(sid: string): string {
  return path.join(SESSIONS_ROOT, sid, "meta.json");
}
function sessionTranscriptPath(sid: string): string {
  return path.join(SESSIONS_ROOT, sid, "transcript.jsonl");
}

function newAid(): string {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `a-${ts}-${rand}`;
}

async function loadTurns(sid: string): Promise<Turn[]> {
  const p = sessionTranscriptPath(sid);
  if (!(await exists(p))) return [];
  const raw = await readText(p);
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Turn;
      } catch {
        return null;
      }
    })
    .filter((t): t is Turn => t !== null);
}

function formatTranscript(turns: Turn[]): string {
  return turns
    .map((t) => {
      const label = t.actor === "teacher" ? "【教师】" : "【学生】";
      return `${label}第 ${t.turn} 轮\n${t.text}`;
    })
    .join("\n\n");
}

const LEARNER_LABEL: Record<string, string> = {
  novice: "新手（几乎没有预备知识，多问 why / 求打比方）",
  mid: "中级（有基础，会复述、会追问细节，容易半懂就以为懂）",
  critic: "挑刺型（受训的怀疑者，主动找边界与反例）",
};

/** 每一节的审计素材：本节原文 + 覆盖该节的所有 session transcript。 */
type SectionMaterial = {
  sectionId: string;
  sectionTitle: string;
  sectionText: string;
  sessions: { sid: string; learnerId: string; turns: Turn[] }[];
};

async function collectMaterial(sids: string[]): Promise<{
  bookSlug: string;
  bookTitle: string;
  bookAuthor: string | undefined;
  sections: SectionMaterial[];
  sectionIds: string[];
}> {
  if (sids.length === 0) throw new Error("要审计的 session 列表为空");

  // 先加载所有 session meta
  const metas: SessionMeta[] = [];
  for (const sid of sids) {
    if (!(await exists(sessionMetaPath(sid)))) {
      throw new Error(`会话 ${sid} 不存在`);
    }
    metas.push(await readJson<SessionMeta>(sessionMetaPath(sid)));
  }

  // 所有 session 必须属于同一本书
  const bookSlug = metas[0].bookSlug;
  for (const m of metas) {
    if (m.bookSlug !== bookSlug) {
      throw new Error(`选中的 session 分属不同的书（${bookSlug} vs ${m.bookSlug}），跨书审计不支持`);
    }
  }

  const book = await getBook(bookSlug);

  // 按 sectionId 聚合
  const bySection = new Map<string, SectionMaterial>();
  for (const m of metas) {
    let mat = bySection.get(m.sectionId);
    if (!mat) {
      mat = {
        sectionId: m.sectionId,
        sectionTitle: getSectionTitle(book, m.sectionId),
        sectionText: await getSection(bookSlug, m.sectionId),
        sessions: [],
      };
      bySection.set(m.sectionId, mat);
    }
    const turns = await loadTurns(m.sid);
    if (turns.length === 0) continue; // 空 transcript 跳过
    mat.sessions.push({ sid: m.sid, learnerId: m.learnerId, turns });
  }

  // 按书里的 section 顺序排
  const sections: SectionMaterial[] = [];
  const sectionIds: string[] = [];
  for (const s of book.sections) {
    const mat = bySection.get(s.id);
    if (!mat) continue;
    if (mat.sessions.length === 0) continue;
    sections.push(mat);
    sectionIds.push(s.id);
  }

  if (sections.length === 0) throw new Error("所选 session 都没有有效 transcript");

  return {
    bookSlug,
    bookTitle: book.title,
    bookAuthor: book.author,
    sections,
    sectionIds,
  };
}

async function buildAuditMessages(sids: string[]): Promise<{
  messages: LLMMessage[];
  bookSlug: string;
  sectionIds: string[];
}> {
  const { bookSlug, bookTitle, bookAuthor, sections, sectionIds } =
    await collectMaterial(sids);
  const rules = await readText(path.join(PROMPTS_ROOT, "audit_rules.md"));

  // 组装 user 内容
  const parts: string[] = [
    `## 被审的书`,
    `《${bookTitle}》${bookAuthor ? "  作者：" + bookAuthor : ""}`,
    ``,
    sections.length > 1
      ? `本次审计**跨 ${sections.length} 节**（${sections.map((s) => "§" + s.sectionId).join(" / ")}）。请你**先分节看**，再在最后按同一份 ===TAG=== 协议输出一份综合报告。`
      : `本节：§${sections[0].sectionId} ${sections[0].sectionTitle}`,
    ``,
  ];

  for (const sec of sections) {
    parts.push(`---`);
    parts.push(`## §${sec.sectionId} ${sec.sectionTitle}`);
    parts.push(``);
    parts.push(`### 本节原文`);
    parts.push("```");
    parts.push(sec.sectionText);
    parts.push("```");
    parts.push(``);
    for (const sess of sec.sessions) {
      parts.push(
        `### 会话 ${sess.sid}（学生画像：${LEARNER_LABEL[sess.learnerId] ?? sess.learnerId}）`,
      );
      parts.push(formatTranscript(sess.turns));
      parts.push(``);
    }
  }

  parts.push(`---`);
  parts.push(`按 audit_rules 里的 ===TAG=== 协议输出**一份**综合审计报告。`);
  if (sections.length > 1) {
    parts.push(
      `每一段的证据里请**注明来源**：如"[§02 会话xxxx] 学生说：..."。同一个问题在多节反复出现的话，SUGGESTIONS 里指出这个模式。`,
    );
  }

  return {
    messages: [
      { role: "system", content: rules },
      { role: "user", content: parts.join("\n") },
    ],
    bookSlug,
    sectionIds,
  };
}

function extractSection(raw: string, tag: string): string {
  const re = new RegExp(
    `^===${tag}===\\s*\\r?\\n([\\s\\S]*?)(?=^===[A-Z_]+===|\\z)`,
    "m",
  );
  const m = raw.match(re);
  return (m?.[1] ?? "").trim();
}

function parseReport(raw: string): AuditReport {
  return {
    verdict: extractSection(raw, "VERDICT"),
    clarity: extractSection(raw, "CLARITY"),
    hardSpots: extractSection(raw, "HARD_SPOTS"),
    inconsistency: extractSection(raw, "INCONSISTENCY"),
    suggestions: extractSection(raw, "SUGGESTIONS"),
    raw,
  };
}

export type AuditEvent =
  | { type: "audit_start"; aid: string; sids: string[]; sectionIds: string[] }
  | { type: "audit_chunk"; text: string }
  | { type: "audit_done"; aid: string; report: AuditReport }
  | { type: "audit_error"; message: string };

/**
 * 跨 sids 跑审计，落盘到 data/audits/<aid>/。
 * 若 sids 里只有一个 sid，那就是"审计一节"。
 */
export async function* runAudit(
  sids: string[],
  signal: AbortSignal,
): AsyncGenerator<AuditEvent> {
  const aid = newAid();
  const meta: AuditMeta = {
    aid,
    bookSlug: "",
    sids,
    sectionIds: [],
    startedAt: Date.now(),
    status: "running",
  };

  try {
    await ensureDir(auditDir(aid));

    const { messages, bookSlug, sectionIds } = await buildAuditMessages(sids);
    meta.bookSlug = bookSlug;
    meta.sectionIds = sectionIds;
    await writeAtomic(path.join(auditDir(aid), "meta.json"), JSON.stringify(meta, null, 2));

    yield { type: "audit_start", aid, sids, sectionIds };

    let raw = "";
    for await (const chunk of callLLM("audit", messages, {
      stream: true,
      temperature: 0.3,
      maxTokens: 4000,
      signal,
    })) {
      raw += chunk;
      yield { type: "audit_chunk", text: chunk };
    }

    const report = parseReport(raw);
    await writeAtomic(path.join(auditDir(aid), "report.md"), raw);
    meta.status = "done";
    meta.endedAt = Date.now();
    await writeAtomic(path.join(auditDir(aid), "meta.json"), JSON.stringify(meta, null, 2));

    // 同时把摘要 append 到全局 audit-history
    await appendLine(
      path.join(AUDITS_ROOT, "history.jsonl"),
      JSON.stringify({
        aid,
        bookSlug,
        sectionIds,
        sidCount: sids.length,
        verdict: report.verdict,
        ts: Date.now(),
      }),
    );

    yield { type: "audit_done", aid, report };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    meta.status = "errored";
    meta.endedAt = Date.now();
    meta.error = message;
    await writeAtomic(path.join(auditDir(aid), "meta.json"), JSON.stringify(meta, null, 2)).catch(
      () => {},
    );
    yield { type: "audit_error", message };
  }
}

/** 读一次已存的审计。 */
export async function readAudit(aid: string): Promise<{ meta: AuditMeta; report: AuditReport } | null> {
  const metaPath = path.join(auditDir(aid), "meta.json");
  const reportPath = path.join(auditDir(aid), "report.md");
  if (!(await exists(metaPath))) return null;
  const meta = await readJson<AuditMeta>(metaPath);
  const raw = (await exists(reportPath)) ? await readText(reportPath) : "";
  return { meta, report: parseReport(raw) };
}
