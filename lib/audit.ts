import path from "node:path";
import fs from "node:fs/promises";
import { getBook, getSection, getSectionTitle } from "./book";
import { aggregateCitations, type Citation } from "./citations";
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
import { runFidelity, computeCoverage, FIDELITY_ROOT } from "./fidelity";
import { reconcileAgainstTranscript, renderCoverageReportMd, deriveCoverageVerdict } from "./coverage";
import { getChecklist } from "./checklist";

/** 审计维度：审书本身、审教师教学质量、Fidelity 保真度审计、教学覆盖度审计。 */
export type AuditDimension = "book" | "teacher" | "fidelity" | "coverage";

/** 每个维度的 tag 集合（顺序即报告顺序，END 是终止符不入报告）。
 *  fidelity/coverage 维度不用 ===TAG===，其 report.md 是纯 markdown，tags 为空。 */
const DIMENSION_TAGS: Record<AuditDimension, string[]> = {
  book: ["VERDICT", "CLARITY", "HARD_SPOTS", "INCONSISTENCY", "SUGGESTIONS"],
  teacher: ["VERDICT", "METHOD", "PERSONA_FIT", "RULE_VIOLATIONS", "RULE_SUGGESTIONS"],
  fidelity: [],
  coverage: [],
};

const DIMENSION_RULES_FILE: Record<AuditDimension, string> = {
  book: "audit_rules.md",
  teacher: "audit_teacher_rules.md",
  fidelity: "",
  coverage: "",
};

/** 已解析的审计报告：tag → 段落文本（外加 raw）。 */
export type AuditReport = {
  sections: Record<string, string>;
  raw: string;
};

export type AuditMeta = {
  aid: string;
  bookSlug: string;
  dimension: AuditDimension;
  sids: string[];
  sectionIds: string[];
  sampleName?: string; // fidelity 维度用，标记被审的样本名
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

async function loadTurns(sid: string, turnsSoFar?: number): Promise<Turn[]> {
  const p = sessionTranscriptPath(sid);
  if (!(await exists(p))) return [];
  const raw = await readText(p);
  const all = raw
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

  if (turnsSoFar === undefined) return all;

  // 只保留 turn <= turnsSoFar 且成对出现（teacher + learner 都在）
  // append-only 时 resume 会留下半截 teacher（没有配对 learner）→ 排除
  const byTurn = new Map<number, { teacher?: Turn; learner?: Turn }>();
  for (const t of all) {
    if (t.turn > turnsSoFar) continue;
    const slot = byTurn.get(t.turn) ?? {};
    if (t.actor === "teacher") slot.teacher = t;
    else slot.learner = t;
    byTurn.set(t.turn, slot);
  }
  const out: Turn[] = [];
  for (let i = 1; i <= turnsSoFar; i++) {
    const slot = byTurn.get(i);
    if (slot?.teacher && slot?.learner) {
      out.push(slot.teacher, slot.learner);
    }
    // 缺任何一半的轮次整轮丢——审计不用看半截
  }
  return out;
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
  passive: "冷淡型（不懂且不爱说话，问一句答一句，回复极短）",
  moderate: "适度型（不懂但愿意学，正常互动，中等篇幅）",
  active: "话痨型（不懂但热情高，话多主动追问联想，容易跑题）",
};

/** 每一节的审计素材：本节原文 + 覆盖该节的所有 session transcript。 */
type SectionMaterial = {
  sectionId: string;
  sectionTitle: string;
  sectionText: string;
  sessions: {
    sid: string;
    learnerId: string;
    turns: Turn[];
    citationRecords: { turn: number; cites: Citation[] }[];
  }[];
};

async function loadCitations(
  sid: string,
): Promise<{ turn: number; cites: Citation[] }[]> {
  const p = path.join(SESSIONS_ROOT, sid, "citations.jsonl");
  if (!(await exists(p))) return [];
  const raw = await readText(p);
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as { turn: number; cites: Citation[] };
      } catch {
        return null;
      }
    })
    .filter((x): x is { turn: number; cites: Citation[] } => x !== null);
}

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
    const turns = await loadTurns(m.sid, m.turnsSoFar);
    if (turns.length === 0) continue; // 空 transcript 跳过
    const citationRecords = await loadCitations(m.sid);
    // 只保留 turn <= turnsSoFar 的引用记录（对齐 loadTurns 的截断）
    const filteredCites =
      m.turnsSoFar !== undefined
        ? citationRecords.filter((r) => r.turn <= m.turnsSoFar)
        : citationRecords;
    mat.sessions.push({
      sid: m.sid,
      learnerId: m.learnerId,
      turns,
      citationRecords: filteredCites,
    });
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

async function buildAuditMessages(sids: string[], dimension: AuditDimension): Promise<{
  messages: LLMMessage[];
  bookSlug: string;
  sectionIds: string[];
}> {
  const { bookSlug, bookTitle, bookAuthor, sections, sectionIds } =
    await collectMaterial(sids);
  const rules = await readText(path.join(PROMPTS_ROOT, DIMENSION_RULES_FILE[dimension]));

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

      // 引用命中率块：INCONSISTENCY 段落的数据基础
      const stats = aggregateCitations(sess.citationRecords);
      if (stats.total > 0) {
        const misses = sess.citationRecords
          .flatMap((r) => r.cites.map((c) => ({ turn: r.turn, ...c })))
          .filter((c) => !c.hit)
          .slice(0, 8); // 最多列 8 个避免 prompt 过长
        parts.push(
          `**教师引用 verbatim 校验**：${stats.hit}/${stats.total} 命中${stats.miss > 0 ? "，" + stats.miss + " 未命中" : ""}。`,
        );
        if (misses.length > 0) {
          parts.push(``);
          parts.push(`未命中的引用（教师说的片段**不在**本节原文里逐字出现——INCONSISTENCY 段应重点核查）：`);
          for (const c of misses) {
            parts.push(
              `- 第 ${c.turn} 轮：〔§${c.sectionId}｜${c.snippet}〕${c.sectionId !== sec.sectionId ? "（跨节引用，铁律不允许）" : ""}`,
            );
          }
        }
        parts.push(``);
      }

      parts.push(formatTranscript(sess.turns));
      parts.push(``);
    }
  }

  parts.push(`---`);
  parts.push(`按上面的 ===TAG=== 协议输出**一份**综合审计报告。`);
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

function parseReport(raw: string, tags: string[]): AuditReport {
  const sections: Record<string, string> = {};
  for (const tag of tags) {
    sections[tag] = extractSection(raw, tag);
  }
  return { sections, raw };
}

/** 该维度的所有 tag 都非空才算完整。 */
function hasAllTags(raw: string, tags: string[]): boolean {
  const report = parseReport(raw, tags);
  return tags.every((t) => report.sections[t].length > 0);
}

export type AuditEvent =
  | { type: "audit_start"; aid: string; dimension: AuditDimension; sids?: string[]; sectionIds?: string[]; sampleName?: string }
  | { type: "audit_chunk"; text: string }
  | { type: "audit_done"; aid: string; report: AuditReport }
  | { type: "audit_error"; message: string };

/**
 * Fidelity 保真度审计（不依赖 sessions，读 samples/{name}/{source.md, synth.md}）。
 * 复用 lib/fidelity.ts 的 runFidelity，产物落 data/audits/<aid>/。
 */
export async function* runFidelityAudit(
  sampleName: string,
  signal: AbortSignal,
): AsyncGenerator<AuditEvent> {
  const aid = newAid();
  const meta: AuditMeta = {
    aid,
    bookSlug: "",
    dimension: "fidelity",
    sids: [],
    sectionIds: [],
    sampleName,
    startedAt: Date.now(),
    status: "running",
  };

  try {
    await ensureDir(auditDir(aid));
    await writeAtomic(path.join(auditDir(aid), "meta.json"), JSON.stringify(meta, null, 2));
    yield { type: "audit_start", aid, dimension: "fidelity", sampleName };

    // 读 sample 文件
    const sampleDir = path.join(FIDELITY_ROOT, "..", "fidelity-samples", sampleName);
    const sourcePath = path.join(sampleDir, "source.md");
    const synthPath = path.join(sampleDir, "synth.md");
    const sourceText = await fs.readFile(sourcePath, "utf-8");
    const synthText = await fs.readFile(synthPath, "utf-8");

    yield { type: "audit_chunk", text: `正在 Fidelity 审计「${sampleName}」：源材料 ${sourceText.length} 字、合成节 ${synthText.length} 字……\n\n` };

    const result = await runFidelity(sourceText, synthText, signal, { sampleName });
    const c = result.coverage;

    const summary = `✅ 审计完成\n覆盖率：落地 ${c.landed}/${c.total}（${Math.round(c.coverageRate * 100)}%）· 变形 ${c.morphed} · 漏 ${c.dropped}\n总评：${result.verdict}\n\n`;
    yield { type: "audit_chunk", text: summary };

    // 读 report.md
    const reportRaw = await fs.readFile(path.join(result.dir, "report.md"), "utf-8");
    await ensureDir(auditDir(aid));

    // 复制产物到 audit 目录（软链或复制）
    const dstReport = path.join(auditDir(aid), "report.md");
    // 先复制 fidelity 产物到 audit 目录，以便 audit history 统一管理
    const fidChecklist = await fs.readFile(path.join(result.dir, "checklist.json"), "utf-8");
    await writeAtomic(path.join(auditDir(aid), "report.md"), reportRaw);
    await writeAtomic(path.join(auditDir(aid), "checklist.json"), fidChecklist);
    await writeAtomic(path.join(auditDir(aid), "report.json"), JSON.stringify({
      rows: result.rows,
      coverage: result.coverage,
      verdict: result.verdict,
    }, null, 2));

    meta.status = "done";
    meta.endedAt = Date.now();
    await writeAtomic(path.join(auditDir(aid), "meta.json"), JSON.stringify(meta, null, 2));

    // 进审计历史
    await appendLine(
      path.join(AUDITS_ROOT, "history.jsonl"),
      JSON.stringify({
        aid,
        bookSlug: "",
        dimension: "fidelity",
        sectionIds: [],
        sidCount: 0,
        verdict: result.verdict,
        ts: Date.now(),
      }),
    );

    yield { type: "audit_done", aid, report: { sections: {}, raw: reportRaw } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    meta.status = "errored";
    meta.endedAt = Date.now();
    meta.error = message;
    await writeAtomic(path.join(auditDir(aid), "meta.json"), JSON.stringify(meta, null, 2)).catch(() => {});
    yield { type: "audit_error", message };
  }
}

/**
 * 教学覆盖度审计：从源材料（或书本原文）提取知识点清单 → 与教学对话 transcript 逐条勾稽。
 * 不依赖 ===TAG=== 协议，输出纯 markdown 报告。
 * @param sids 要审计的会话 ID 列表（目前只取第一个）
 * @param sampleName 可选：源材料样本名，不提供则从书本原文提取
 */
export async function* runCoverageAudit(
  sids: string[],
  signal: AbortSignal,
  sampleName?: string,
): AsyncGenerator<AuditEvent> {
  const aid = newAid();
  const meta: AuditMeta = {
    aid,
    bookSlug: "",
    dimension: "coverage",
    sids,
    sectionIds: [],
    sampleName,
    startedAt: Date.now(),
    status: "running",
  };

  try {
    await ensureDir(auditDir(aid));
    await writeAtomic(path.join(auditDir(aid), "meta.json"), JSON.stringify(meta, null, 2));
    yield { type: "audit_start", aid, dimension: "coverage", sids, sampleName };

    // 取第一个会话确定 bookSlug + sectionId + pacing
    const sid = sids[0];
    const sm = await readJson<SessionMeta>(sessionMetaPath(sid));
    const pacing = sm.pacing ?? "normal";
    const book = await getBook(sm.bookSlug);
    meta.bookSlug = sm.bookSlug;
    meta.sectionIds = [sm.sectionId];
    const sectionTitle = getSectionTitle(book, sm.sectionId);

    // 确定知识来源
    let sourceText: string;
    let sourceLabel: string;
    if (sampleName) {
      const srcPath = path.join(FIDELITY_ROOT, "..", "fidelity-samples", sampleName, "source.md");
      sourceText = await fs.readFile(srcPath, "utf-8");
      sourceLabel = `源材料「${sampleName}」`;
    } else {
      sourceText = await getSection(sm.bookSlug, sm.sectionId);
      sourceLabel = `书本原文「${book.title}」§${sm.sectionId} ${sectionTitle}（AI 从节中推断，非外部源材料）`;
    }

    // 1. 提取清单（优先读缓存，没有再在线提取）
    let checklist = await getChecklist(sm.bookSlug, sm.sectionId);
    if (checklist) {
      yield { type: "audit_chunk", text: `  使用已缓存的知识点清单。\n\n` };
    } else {
      yield { type: "audit_chunk", text: `  正在在线提取「${sectionTitle}」的知识点清单（未缓存）……\n\n` };
      const { extractChecklist } = await import("./fidelity");
      checklist = await extractChecklist(sourceText, signal);
    }
    const totalItems =
      checklist.knowledgePoints.length +
      checklist.assessmentCriteria.length +
      checklist.exercises.length +
      checklist.errorSpots.length;
    yield { type: "audit_chunk", text: `  提取到 ${totalItems} 条。\n\n  加载会话 ${sid}……\n\n` };

    // 2. 加载并格式化对话
    const turns = await loadTurns(sid, sm.turnsSoFar);
    if (turns.length === 0) throw new Error("所选会话没有对话记录");
    const transcriptText = formatTranscript(turns);
    const transcriptInfo = `  对话共 ${turns.length} 轮（${Math.round(transcriptText.length / 100) * 100}+ 字符）。\n\n  正在勾稽「${sectionTitle}」的教学覆盖度……\n\n`;
    yield { type: "audit_chunk", text: transcriptInfo };

    // 长对话截断（>16k 字符）
    const MAX_TRANSCRIPT_CHARS = 16000;
    const reconcileTranscript = transcriptText.length > MAX_TRANSCRIPT_CHARS
      ? truncateTranscript(transcriptText)
      : transcriptText;

    // 3. 勾稽
    const { rows, verdict: llmVerdict } = await reconcileAgainstTranscript(checklist, reconcileTranscript, pacing, signal);
    const coverage = computeCoverage(rows);
    const verdict = llmVerdict || deriveCoverageVerdict(coverage);

    // 4. 落盘
    const reportMd = renderCoverageReportMd(rows, coverage, verdict, sourceLabel, pacing);
    const reportJson = { rows, coverage, verdict, sourceLabel };
    await writeAtomic(path.join(auditDir(aid), "report.md"), reportMd);
    await writeAtomic(path.join(auditDir(aid), "report.json"), JSON.stringify(reportJson, null, 2));
    await writeAtomic(path.join(auditDir(aid), "checklist.json"), JSON.stringify(checklist, null, 2));

    meta.status = "done";
    meta.endedAt = Date.now();
    await writeAtomic(path.join(auditDir(aid), "meta.json"), JSON.stringify(meta, null, 2));

    // 5. 审计历史
    await appendLine(
      path.join(AUDITS_ROOT, "history.jsonl"),
      JSON.stringify({
        aid,
        bookSlug: sm.bookSlug,
        dimension: "coverage",
        sectionIds: [sm.sectionId],
        sidCount: 1,
        verdict,
        ts: Date.now(),
      }),
    );

    yield { type: "audit_chunk", text: `\n✅ 审计完成：覆盖 ${coverage.landed}/${coverage.total}（${Math.round(coverage.coverageRate * 100)}%）· 漏 ${coverage.dropped}\n` };
    yield { type: "audit_done", aid, report: { sections: {}, raw: reportMd } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    meta.status = "errored";
    meta.endedAt = Date.now();
    meta.error = message;
    await writeAtomic(path.join(auditDir(aid), "meta.json"), JSON.stringify(meta, null, 2)).catch(() => {});
    yield { type: "audit_error", message };
  }
}

/** 长对话截断：保留前 2 轮 + 最近 8 轮 + 中间省略标记。 */
function truncateTranscript(text: string): string {
  const lines = text.split("\n");
  const turnStarts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^【(教师|学生)】/.test(lines[i])) turnStarts.push(i);
  }
  if (turnStarts.length <= 12) return text;

  const firstEnd = turnStarts[Math.min(3, turnStarts.length - 9)];
  const lastStart = turnStarts[Math.max(turnStarts.length - 8, 0)];

  const head = lines.slice(0, firstEnd).join("\n");
  const tail = lines.slice(lastStart).join("\n");
  const omitted = Math.round((lastStart - firstEnd) / 2);
  return `${head}\n\n...（中间 ${omitted} 轮对话已省略，保留前 2 轮 + 最近 8 轮）...\n\n${tail}`;
}

/**
 * 跨 sids 跑审计，落盘到 data/audits/<aid>/。
 * dimension 决定审"书本身"还是"教师教学质量"。
 * 若 sids 里只有一个 sid，那就是"审计一节"。
 */
export async function* runAudit(
  sids: string[],
  signal: AbortSignal,
  dimension: AuditDimension = "book",
): AsyncGenerator<AuditEvent> {
  const aid = newAid();
  const tags = DIMENSION_TAGS[dimension];
  const meta: AuditMeta = {
    aid,
    bookSlug: "",
    dimension,
    sids,
    sectionIds: [],
    startedAt: Date.now(),
    status: "running",
  };

  try {
    await ensureDir(auditDir(aid));

    const { messages, bookSlug, sectionIds } = await buildAuditMessages(sids, dimension);
    meta.bookSlug = bookSlug;
    meta.sectionIds = sectionIds;
    await writeAtomic(path.join(auditDir(aid), "meta.json"), JSON.stringify(meta, null, 2));

    yield { type: "audit_start", aid, dimension, sids, sectionIds };

    // 最多 2 次尝试：第 1 次输出不完整（缺 tag）就把已流出的清掉，再跑一遍。
    // 参考 Socratopia：下课解析失败重试一次。
    let raw = "";
    let attempt = 0;
    const MAX_ATTEMPTS = 2;
    while (attempt < MAX_ATTEMPTS) {
      attempt++;
      raw = "";
      // 第 2 次开始给前端一个"重试"信号（视觉上是"…重来了一段"）
      if (attempt > 1) {
        yield { type: "audit_chunk", text: "\n\n[审计首次输出不完整，正在重跑]\n\n" };
      }
      for await (const chunk of callLLM("audit", messages, {
        stream: true,
        temperature: 0.3,
        maxTokens: 4000,
        signal,
      })) {
        raw += chunk;
        yield { type: "audit_chunk", text: chunk };
      }
      if (hasAllTags(raw, tags)) break;
      // 若被 abort 就别再尝试
      if (signal.aborted) break;
    }

    const report = parseReport(raw, tags);
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
        dimension,
        sectionIds,
        sidCount: sids.length,
        verdict: report.sections.VERDICT ?? "",
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
  const tags = DIMENSION_TAGS[meta.dimension ?? "book"];
  return { meta, report: parseReport(raw, tags) };
}

/** 读某本书的审计历史（倒序，最近在前）。 */
export type AuditHistoryItem = {
  aid: string;
  bookSlug: string;
  dimension: AuditDimension;
  sectionIds: string[];
  sidCount: number;
  verdict: string;
  ts: number;
};

export async function listAuditHistory(bookSlug?: string): Promise<AuditHistoryItem[]> {
  const p = path.join(AUDITS_ROOT, "history.jsonl");
  if (!(await exists(p))) return [];
  const raw = await readText(p);
  const items = raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        const o = JSON.parse(line) as Partial<AuditHistoryItem>;
        return {
          aid: o.aid ?? "",
          bookSlug: o.bookSlug ?? "",
          dimension: (o.dimension ?? "book") as AuditDimension,
          sectionIds: o.sectionIds ?? [],
          sidCount: o.sidCount ?? 0,
          verdict: o.verdict ?? "",
          ts: o.ts ?? 0,
        } as AuditHistoryItem;
      } catch {
        return null;
      }
    })
    .filter((x): x is AuditHistoryItem => x !== null && Boolean(x.aid));
  const filtered = bookSlug ? items.filter((i) => i.bookSlug === bookSlug) : items;
  return filtered.sort((a, b) => b.ts - a.ts);
}
