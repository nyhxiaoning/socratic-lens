import path from "node:path";
import { getBook, getSection, getSectionTitle } from "./book";
import { callLLM, type LLMMessage } from "./llm";
import type { SessionMeta, Turn } from "./session";
import {
  appendLine,
  exists,
  PROMPTS_ROOT,
  readJson,
  readText,
  SESSIONS_ROOT,
  writeAtomic,
} from "./storage";

/** 已解析的六段审计报告。为空段落 = 原样保留（可能是 "- 无"）。 */
export type AuditReport = {
  verdict: string;
  clarity: string;
  hardSpots: string;
  inconsistency: string;
  suggestions: string;
  raw: string; // 完整原始输出，落盘用
};

function auditPath(sid: string): string {
  return path.join(SESSIONS_ROOT, sid, "audit.md");
}

function metaPath(sid: string): string {
  return path.join(SESSIONS_ROOT, sid, "meta.json");
}

function transcriptPath(sid: string): string {
  return path.join(SESSIONS_ROOT, sid, "transcript.jsonl");
}

async function loadTurns(sid: string): Promise<Turn[]> {
  const p = transcriptPath(sid);
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

async function buildAuditMessages(sid: string): Promise<LLMMessage[]> {
  const meta = await readJson<SessionMeta>(metaPath(sid));
  const turns = await loadTurns(sid);
  if (turns.length === 0) throw new Error("会话没有 transcript，无法审计");

  const book = await getBook(meta.bookSlug);
  const sectionTitle = getSectionTitle(book, meta.sectionId);
  const sectionText = await getSection(meta.bookSlug, meta.sectionId);
  const rules = await readText(path.join(PROMPTS_ROOT, "audit_rules.md"));

  const system = rules;
  const user = [
    `## 被审的书`,
    `《${book.title}》${book.author ? "  作者：" + book.author : ""}`,
    `本节：§${meta.sectionId} ${sectionTitle}`,
    ``,
    `## 学生画像`,
    LEARNER_LABEL[meta.learnerId] ?? meta.learnerId,
    ``,
    `## 本节原文`,
    "```",
    sectionText,
    "```",
    ``,
    `## 教-学对话 transcript`,
    formatTranscript(turns),
    ``,
    `按 audit_rules 里的分隔符协议输出报告。`,
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/** 抓 ===TAG=== ... 下一个 === 之前 / 或 ===END===。 */
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
  | { type: "audit_start"; sid: string }
  | { type: "audit_chunk"; text: string }
  | { type: "audit_done"; report: AuditReport }
  | { type: "audit_error"; message: string };

/** 流式跑审计。同时把原始文本写到 data/sessions/<sid>/audit.md。 */
export async function* runAudit(
  sid: string,
  signal: AbortSignal,
): AsyncGenerator<AuditEvent> {
  try {
    yield { type: "audit_start", sid };
    const messages = await buildAuditMessages(sid);
    let raw = "";
    for await (const chunk of callLLM("audit", messages, {
      stream: true,
      temperature: 0.3,
      maxTokens: 3000,
      signal,
    })) {
      raw += chunk;
      yield { type: "audit_chunk", text: chunk };
    }
    const report = parseReport(raw);
    await writeAtomic(auditPath(sid), raw);
    await appendLine(
      path.join(SESSIONS_ROOT, sid, "audit-history.jsonl"),
      JSON.stringify({ ts: Date.now(), verdict: report.verdict }),
    );
    yield { type: "audit_done", report };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    yield { type: "audit_error", message };
  }
}

/** 读已存在的审计报告（如果有）。 */
export async function readAudit(sid: string): Promise<AuditReport | null> {
  const p = auditPath(sid);
  if (!(await exists(p))) return null;
  const raw = await readText(p);
  return parseReport(raw);
}
