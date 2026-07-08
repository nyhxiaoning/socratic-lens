import path from "node:path";
import { getBook, getSection, getSectionTitle } from "./book";
import { buildCitationLedger } from "./citation";
import { callLLM, type LLMMessage } from "./llm";
import type { SessionMeta, Turn } from "./session";
import {
  appendLine,
  BOOKS_ROOT,
  DATA_ROOT,
  ensureDir,
  exists,
  PROMPTS_ROOT,
  readJson,
  readText,
  SESSIONS_ROOT,
  writeAtomic,
} from "./storage";

/** 已解析的审计报告——sections 是 tag → 段落文本，raw 是完整原文。 */
export type AuditReport = {
  sections: Record<string, string>;
  raw: string;
};

/** 审计模式：书 / 教学 / 教师改进方案。老 meta 缺该字段默认 book。 */
export type AuditMode = "book" | "teaching" | "playbook";

export type AuditMeta = {
  aid: string;
  bookSlug: string;
  sids: string[];
  sectionIds: string[];
  /** 参与本次审计的所有会话涉及的学生画像（去重、去空）。用于历史列表快速判别"novice / mid / critic / novice+critic 合审"。 */
  learnerIds: string[];
  mode: AuditMode;
  startedAt: number;
  endedAt?: number;
  status: "running" | "done" | "errored";
  error?: string;
};

const RULES_FILE: Record<AuditMode, string> = {
  book: "audit_book.md",
  teaching: "audit_teaching.md",
  playbook: "audit_teacher_playbook.md",
};

const TAGS_BY_MODE: Record<AuditMode, string[]> = {
  book: ["VERDICT", "CLARITY", "HARD_SPOTS", "INCONSISTENCY", "SUGGESTIONS"],
  teaching: [
    "VERDICT",
    "STRENGTHS",
    "VIOLATIONS",
    "MISSED_MOMENTS",
    "PACING_JUDGMENT",
    "CITATION_HYGIENE",
  ],
  playbook: [
    "VERDICT",
    "BOOK_TRAPS",
    "PLAYBOOK_FOR_NEXT_RUN",
    "RESPONSE_PATCHES",
    "WINNING_MOVE",
  ],
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
  sessions: {
    sid: string;
    learnerId: string;
    teachingMode: "socratic" | "close_reading";
    commentariesEnabled: boolean;
    turns: Turn[];
  }[];
};

async function collectMaterial(sids: string[]): Promise<{
  bookSlug: string;
  bookTitle: string;
  bookAuthor: string | undefined;
  sections: SectionMaterial[];
  sectionIds: string[];
  learnerIds: string[];
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
    mat.sessions.push({
      sid: m.sid,
      learnerId: m.learnerId,
      teachingMode: (m.teachingMode ?? "socratic") as "socratic" | "close_reading",
      commentariesEnabled: !!m.commentariesEnabled,
      turns,
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

  // 从 metas 收集所有学生画像（去重、按 novice/mid/critic 的固定顺序排）
  const learnerOrder: string[] = ["novice", "mid", "critic"];
  const learnerSet = new Set<string>(metas.map((m) => m.learnerId as string).filter(Boolean));
  const learnerIds = learnerOrder
    .filter((l) => learnerSet.has(l))
    .concat([...learnerSet].filter((l) => !learnerOrder.includes(l)));

  return {
    bookSlug,
    bookTitle: book.title,
    bookAuthor: book.author,
    sections,
    sectionIds,
    learnerIds,
  };
}

async function buildAuditMessages(
  sids: string[],
  mode: AuditMode,
): Promise<{
  messages: LLMMessage[];
  bookSlug: string;
  sectionIds: string[];
  learnerIds: string[];
}> {
  const { bookSlug, bookTitle, bookAuthor, sections, sectionIds, learnerIds } =
    await collectMaterial(sids);
  let rules = await readText(path.join(PROMPTS_ROOT, RULES_FILE[mode]));

  // 有任一会话是句读模式 → teaching 模式下需要额外挂 close_reading 规则供审计员参照
  const hasCloseReading = sections.some((sec) =>
    sec.sessions.some((s) => s.teachingMode === "close_reading"),
  );

  // teaching 模式把 teacher_rules 拼进 system prompt，供 VIOLATIONS 判据
  if (mode === "teaching") {
    const teacherRules = await readText(path.join(PROMPTS_ROOT, "teacher_rules.md"));
    rules = rules + "\n\n---\n\n## 教师被约束的硬规则（socratic 模式）\n\n" + teacherRules;
    if (hasCloseReading) {
      const closeReadingRules = await readText(
        path.join(PROMPTS_ROOT, "teacher_rules_close_reading.md"),
      );
      rules =
        rules +
        "\n\n---\n\n## 教师被约束的硬规则（close_reading 模式——被审会话里存在句读会话，判 VIOLATIONS / CITATION_HYGIENE 时按会话所属模式对应到相应规则）\n\n" +
        closeReadingRules;
    }
  }

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

    // 引用 verbatim 台账：服务端已逐字核验教师所有 〔§…〕 引用是否来自本节原文，
    // 审计员直接采信，不必再人肉核验（参考 Socratopia 模式 #5）。
    if (mode === "teaching" || mode === "book") {
      const allTurns = sec.sessions.flatMap((s) => s.turns);
      const { ledgerText } = buildCitationLedger(sec.sectionId, sec.sectionText, allTurns);
      parts.push(`### 本节教师引用核验台账（服务端逐字核对，可直接采信）`);
      parts.push(ledgerText);
      parts.push(
        mode === "teaching"
          ? `> CITATION_HYGIENE 段直接引用上面的核验结论；疑伪造 / 引错节的按违规处理。`
          : `> INCONSISTENCY 段若涉及"教师是否忠实转述原文"，以上面台账为准。`,
      );
      parts.push(``);
    }

    // 若本节存在句读会话，附上注疏素材（每节一次；根据 commentariesEnabled 组合分别提示）
    const secHasCloseReading = sec.sessions.some((s) => s.teachingMode === "close_reading");
    if (secHasCloseReading) {
      const secHasEnabled = sec.sessions.some(
        (s) => s.teachingMode === "close_reading" && s.commentariesEnabled,
      );
      const commentariesPath = path.join(
        BOOKS_ROOT,
        bookSlug,
        "commentaries",
        `${sec.sectionId}.md`,
      );
      const commentariesExists = await exists(commentariesPath);
      if (secHasEnabled && commentariesExists) {
        const commentariesRaw = await readText(commentariesPath);
        parts.push(`### 本节注疏素材（教师被允许引的来源）`);
        parts.push("```");
        parts.push(commentariesRaw);
        parts.push("```");
        parts.push(``);
      } else {
        parts.push(`### 本节注疏素材`);
        parts.push(
          secHasEnabled
            ? `（会话启用了 commentariesEnabled，但 \`data/books/${bookSlug}/commentaries/${sec.sectionId}.md\` 不存在——教师应当不引任何注疏。若引了，记为违规。）`
            : `（本节所有句读会话都**未启用注疏**——教师应当不引任何注疏。若引了，记为违规。）`,
        );
        parts.push(``);
      }
    }

    for (const sess of sec.sessions) {
      const modeTag =
        sess.teachingMode === "close_reading"
          ? `｜句读${sess.commentariesEnabled ? "+注" : "无注"}`
          : "";
      parts.push(
        `### 会话 ${sess.sid}（学生画像：${LEARNER_LABEL[sess.learnerId] ?? sess.learnerId}${modeTag}）`,
      );
      parts.push(formatTranscript(sess.turns));
      parts.push(``);
    }
  }

  parts.push(`---`);
  parts.push(
    mode === "playbook"
      ? `按上面 audit_teacher_playbook 里的 ===TAG=== 协议输出**一份**教师处方。书是硬约束不能改，你的任务是让教师下一次讲这一节时**学生学得更明白**。`
      : mode === "teaching"
        ? `按上面 audit_teaching 里的 ===TAG=== 协议输出**一份**教学质量诊断。判 VIOLATIONS 时对齐末尾的教师硬规则。`
        : `按 audit_book 里的 ===TAG=== 协议输出**一份**综合审计报告。`,
  );
  if (sections.length > 1) {
    parts.push(
      `每一段的证据里请**注明来源**：如"[§02 会话xxxx] 学生说：..."。同一个问题在多节反复出现的话，${mode === "playbook" ? "BOOK_TRAPS" : mode === "teaching" ? "VIOLATIONS" : "SUGGESTIONS"} 里指出这个模式。`,
    );
  }

  return {
    messages: [
      { role: "system", content: rules },
      { role: "user", content: parts.join("\n") },
    ],
    bookSlug,
    sectionIds,
    learnerIds,
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

function parseReport(raw: string, mode: AuditMode): AuditReport {
  const sections: Record<string, string> = {};
  for (const tag of TAGS_BY_MODE[mode]) {
    sections[tag] = extractSection(raw, tag);
  }
  return { sections, raw };
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
  mode: AuditMode,
  signal: AbortSignal,
): AsyncGenerator<AuditEvent> {
  const aid = newAid();
  const meta: AuditMeta = {
    aid,
    bookSlug: "",
    sids,
    sectionIds: [],
    learnerIds: [],
    mode,
    startedAt: Date.now(),
    status: "running",
  };

  try {
    await ensureDir(auditDir(aid));

    const { messages, bookSlug, sectionIds, learnerIds } = await buildAuditMessages(sids, mode);
    meta.bookSlug = bookSlug;
    meta.sectionIds = sectionIds;
    meta.learnerIds = learnerIds;
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

    const report = parseReport(raw, mode);
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
        learnerIds,
        mode,
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
  // 老 meta 没有 mode 字段——兜底 book
  if (!meta.mode) meta.mode = "book";
  const raw = (await exists(reportPath)) ? await readText(reportPath) : "";
  return { meta, report: parseReport(raw, meta.mode) };
}
