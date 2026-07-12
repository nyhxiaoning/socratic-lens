# Fidelity 审计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给「有源材料的合成书」跑一个保真度审计——抽源材料结构化清单，逐条勾稽合成节，产出三态（落地/变形/漏）勾稽表 + 覆盖率，CLI 脚本先跑通。

**Architecture:** 全部审计逻辑在 `lib/fidelity.ts`（LLM 步骤薄、纯函数确定性）；`scripts/fidelity-audit.ts` 是薄壳；audit 走独立厂/端点的模型（`lib/llm.ts` 的 `getClient` 改成按 purpose 选 client）。Phase 2 接 API 时复用同一批 `lib/` 函数，不重写。

**Tech Stack:** TypeScript + Node 24 + `tsx`（跑 TS 脚本/测试）+ `node:test`（测试框架，零框架依赖）+ openai SDK（已有）。

## Global Constraints

- **不碰 `lib/audit.ts`**：Fidelity 是全新路径，现有 transcript 审计一行不动。
- **不改造书管线**（破卷写书仓），不定正式导入格式。
- **源材料可选**：没源的书照跑现有 `book`/`teacher` 维度；Fidelity 只在有源时点亮。
- **LLM 输出走 `jsonMode`**（`callLLM` 已支持，仅非流式生效）；解析用 `JSON.parse` + 字段校验 + 容错。
- **核心逻辑在 `lib/fidelity.ts`，脚本/测试是薄壳**——保证 Phase 2 是复用不是重写。
- **现有 `teacher`/`learner`/`coach` 行为必须完全不变**：`getClient` 改动后它们 fallback 到原共享 client。
- **产物落盘目录**：`data/fidelity-samples/<name>/`（样例，你手工放）、`data/fidelity/<fid>/`（审计产物），二者 `.gitignore`。
- 平台：win32 + bash，路径用正斜杠，`/dev/null` 不用 `NUL`。

---

## 类型契约（贯穿全 plan，先定死）

这些类型定义在 `lib/fidelity.ts` 顶部。所有任务引用同一份签名。

```ts
// —— 清单（从源章抽）——
export type KnowledgePoint = { id: string; name: string; sourceQuote: string; note?: string };
export type Criterion     = { id: string; desc: string; sourceQuote: string };
export type Exercise      = { id: string; question: string; answer: string; sourceQuote: string };
export type ErrorSpot     = { id: string; desc: string; sourceQuote: string };
export type Checklist = {
  knowledgePoints: KnowledgePoint[];
  assessmentCriteria: Criterion[];
  exercises: Exercise[];
  errorSpots: ErrorSpot[];
};

// —— 勾稽表 ——
export type ReconStatus = "landed" | "morphed" | "dropped";
export type ReconCategory = "knowledgePoint" | "criteria" | "exercise" | "errorSpot";
export type Row = {
  checklistId: string;
  category: ReconCategory;
  itemName: string;
  status: ReconStatus;
  synthQuote?: string;      // landed/morphed 才有
  quoteUnverified?: boolean; // verbatim 校验未命中 → true
  note?: string;
};

export type Coverage = {
  total: number;
  landed: number;
  morphed: number;
  dropped: number;
  coverageRate: number;     // landed / total，保留 2 位小数（0~1）；total=0 时为 0
};

export type FidelityResult = {
  fid: string;
  checklist: Checklist;
  rows: Row[];
  coverage: Coverage;
  verdict: string;
  dir: string;              // data/fidelity/<fid> 绝对路径
};
```

**coverageRate 定义**：`landed / total`（严格；morphed 不计入 landed）。morphed / dropped 单独看。

---

## 任务依赖

```
Task 1 (llm.ts 独立 client)  ──┐
Task 2 (类型 + 解析纯函数)   ──┤
Task 3 (verify + coverage)   ──┤（依赖 Task 2 类型）
Task 4 (render md)           ──┤（依赖 Task 2/3 类型）
                               ├─► Task 5 (LLM 步骤 + prompts，依赖 1,2)
                               ├─► Task 6 (runFidelity 编排，依赖 3,4,5)
                               └─► Task 7 (脚本薄壳，依赖 6)
                                   Task 8 (样例 + 真跑验收 + Phase2 留档，依赖 7)
```

---

## Task 1: `lib/llm.ts` 按 purpose 选独立 client + 环境变量

**Files:**
- Modify: `lib/llm.ts:32-45`（`pickModel` + `getClient` + `callLLM` 里调用处 `:97`）
- Modify: `.env.example`
- Test: `lib/__tests__/llm.test.ts`
- Modify: `package.json`（加 `tsx` devDep + `test` 脚本）

**Interfaces:**
- Produces: `getClient(purpose: Purpose): OpenAI`（原签名无参，改为带 purpose）；`pickModel(purpose)` 行为扩展。供 Task 5 的 `callLLM("audit", ...)` 使用。

- [ ] **Step 1: 装 tsx，加 test 脚本**

Run:
```bash
cd "S:/Code/工作探索/书的审计" && npm install -D tsx
```
Expected: `tsx` 出现在 `package.json` devDependencies。

编辑 `package.json` 的 `scripts`，加一行（保留现有 dev/build/start）：
```json
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "test": "node --import tsx --test lib/__tests__/*.test.ts"
  },
```

- [ ] **Step 2: 写失败测试**

Create `lib/__tests__/llm.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickModel, getClient } from "../llm.ts";

test("pickModel: audit 优先 LLM_AUDIT_MODEL", () => {
  process.env.LLM_MODEL = "base-model";
  process.env.LLM_AUDIT_MODEL = "audit-model";
  assert.equal(pickModel("audit"), "audit-model");
  delete process.env.LLM_AUDIT_MODEL;
});

test("pickModel: audit 无专用模型时回落 LLM_MODEL", () => {
  process.env.LLM_MODEL = "base-model";
  delete process.env.LLM_AUDIT_MODEL;
  delete process.env.LLM_MODEL_AUDIT;
  assert.equal(pickModel("audit"), "base-model");
});

test("getClient: audit 配了独立端点则用独立 baseURL", () => {
  process.env.LLM_API_KEY = "k1";
  process.env.LLM_BASE_URL = "https://shared.example/v1";
  process.env.LLM_AUDIT_API_KEY = "k2";
  process.env.LLM_AUDIT_BASE_URL = "https://audit.example/v1";
  const c = getClient("audit");
  assert.equal(String(c.baseURL), "https://audit.example/v1");
  delete process.env.LLM_AUDIT_BASE_URL;
  delete process.env.LLM_AUDIT_API_KEY;
});

test("getClient: audit 未配独立端点则回落共享 baseURL", () => {
  process.env.LLM_API_KEY = "k1";
  process.env.LLM_BASE_URL = "https://shared.example/v1";
  delete process.env.LLM_AUDIT_BASE_URL;
  const c = getClient("audit");
  assert.equal(String(c.baseURL), "https://shared.example/v1");
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npm test`
Expected: FAIL —— `pickModel`/`getClient` 现在签名不接受 purpose，或 `getClient()` 无参 → 类型/运行错误。

- [ ] **Step 4: 改实现**

改 `lib/llm.ts`。`pickModel`（替换 `:32-35`）：
```ts
function pickModel(purpose: Purpose): string {
  if (purpose === "audit") {
    const auditModel = process.env.LLM_AUDIT_MODEL || process.env.LLM_MODEL_AUDIT;
    if (auditModel) return auditModel;
    return requireEnv("LLM_MODEL");
  }
  const override = process.env[`LLM_MODEL_${purpose.toUpperCase()}`];
  return override || requireEnv("LLM_MODEL");
}
```

`getClient`（替换 `:37-45` 的单例逻辑，改成按 baseURL 缓存）：
```ts
const clientCache = new Map<string, OpenAI>();
export function getClient(purpose: Purpose): OpenAI {
  // audit 若配了独立端点，用独立 key + baseURL；否则回落共享
  const useAudit = purpose === "audit" && !!process.env.LLM_AUDIT_BASE_URL;
  const baseURL = useAudit
    ? requireEnv("LLM_AUDIT_BASE_URL")
    : requireEnv("LLM_BASE_URL");
  const apiKey = useAudit
    ? (process.env.LLM_AUDIT_API_KEY || requireEnv("LLM_API_KEY"))
    : requireEnv("LLM_API_KEY");
  const cached = clientCache.get(baseURL);
  if (cached) return cached;
  const client = new OpenAI({ apiKey, baseURL });
  clientCache.set(baseURL, client);
  return client;
}
```

同时把 `pickModel` 和 `getClient` 从内部函数改为 `export`（Step 2 测试 import 它们）。

改 `callLLM` 里的调用处（`:97`）：
```ts
  const client = getClient(purpose);
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm test`
Expected: PASS（4 个 llm 测试全绿）。

- [ ] **Step 6: 更新 `.env.example`**

在现有「可选：分别指定不同 purpose 的模型」块后追加：
```
# 可选：给 audit 配【独立厂/端点】的模型——审计器与生成器同源会互相包庇盲区，
# 强烈建议 audit 走不同厂的 key+baseURL+model。不配则回落共享端点（同源自审，脚本会警告）。
# LLM_AUDIT_BASE_URL=
# LLM_AUDIT_API_KEY=
# LLM_AUDIT_MODEL=
```

- [ ] **Step 7: 确认现有 next 构建不受影响**

Run: `cd "S:/Code/工作探索/书的审计" && npx tsc --noEmit`
Expected: 无新增类型错误（`getClient` 现在唯一调用点在 `callLLM`，已带 purpose）。

- [ ] **Step 8: Commit**

```bash
git add lib/llm.ts .env.example package.json package-lock.json lib/__tests__/llm.test.ts
git commit -m "feat(llm): getClient 按 purpose 选独立 client（audit 走独立端点）"
```

---

## Task 2: 类型定义 + 清单/勾稽 JSON 解析纯函数

**Files:**
- Create: `lib/fidelity.ts`
- Create: `lib/__tests__/fidelity.test.ts`
- Create: `lib/__tests__/fixtures/checklist.sample.json`
- Create: `lib/__tests__/fixtures/reconciliation.sample.json`

**Interfaces:**
- Produces: 上文「类型契约」全部类型；`parseChecklist(raw: string): Checklist`；`parseReconciliation(raw: string): Row[]`。两者对坏输入抛 `Error`（供 Task 5 的重试捕获）。

- [ ] **Step 1: 建 fixture（初始版，Task 8 真跑后替换）**

Create `lib/__tests__/fixtures/checklist.sample.json`:
```json
{
  "knowledgePoints": [
    { "id": "kp1", "name": "there be 句型", "sourceQuote": "There is a book on the desk.", "note": "存在句" },
    { "id": "kp2", "name": "冠词 a/an/the", "sourceQuote": "a book, an apple, the school" }
  ],
  "assessmentCriteria": [
    { "id": "ac1", "desc": "能用 there be 描述存在", "sourceQuote": "Describe what is in the classroom." }
  ],
  "exercises": [
    { "id": "ex1", "question": "There ___ three books.", "answer": "are", "sourceQuote": "There ___ three books." }
  ],
  "errorSpots": [
    { "id": "es1", "desc": "there is / there are 数不分", "sourceQuote": "常错：There is three books." }
  ]
}
```

Create `lib/__tests__/fixtures/reconciliation.sample.json`:
```json
{
  "rows": [
    { "checklistId": "kp1", "category": "knowledgePoint", "itemName": "there be 句型", "status": "landed", "synthQuote": "There is a book on the desk." },
    { "checklistId": "kp2", "category": "knowledgePoint", "itemName": "冠词 a/an/the", "status": "morphed", "synthQuote": "a book", "note": "只讲了 a，漏 the 的特指" },
    { "checklistId": "ex1", "category": "exercise", "itemName": "There ___ three books.", "status": "dropped", "note": "合成节无等价练习" }
  ],
  "verdict": "保真度中等：核心句型落地，但冠词讲窄、原题未覆盖。"
}
```

- [ ] **Step 2: 写失败测试**

Create `lib/__tests__/fidelity.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseChecklist, parseReconciliation } from "../fidelity.ts";

const fx = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf-8");

test("parseChecklist: 解析四类清单", () => {
  const c = parseChecklist(fx("checklist.sample.json"));
  assert.equal(c.knowledgePoints.length, 2);
  assert.equal(c.knowledgePoints[0].id, "kp1");
  assert.equal(c.exercises[0].answer, "are");
  assert.equal(c.errorSpots.length, 1);
});

test("parseChecklist: 缺失的类默认空数组", () => {
  const c = parseChecklist('{ "knowledgePoints": [{"id":"k","name":"n","sourceQuote":"s"}] }');
  assert.equal(c.assessmentCriteria.length, 0);
  assert.equal(c.exercises.length, 0);
});

test("parseChecklist: 坏 JSON 抛错", () => {
  assert.throws(() => parseChecklist("not json{"), /Fidelity/);
});

test("parseChecklist: 无任何条目抛错", () => {
  assert.throws(
    () => parseChecklist('{"knowledgePoints":[],"assessmentCriteria":[],"exercises":[],"errorSpots":[]}'),
    /没抽到任何条目/,
  );
});

test("parseReconciliation: 解析行", () => {
  const rows = parseReconciliation(fx("reconciliation.sample.json"));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].status, "landed");
  assert.equal(rows[2].status, "dropped");
});

test("parseReconciliation: 非法 status 抛错", () => {
  assert.throws(
    () => parseReconciliation('{"rows":[{"checklistId":"x","category":"knowledgePoint","itemName":"y","status":"bogus"}]}'),
    /status/,
  );
});

test("parseReconciliation: 坏 JSON 抛错", () => {
  assert.throws(() => parseReconciliation("]["), /Fidelity/);
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npm test`
Expected: FAIL —— `../fidelity.ts` 不存在 / 导出缺失。

- [ ] **Step 4: 写实现**

Create `lib/fidelity.ts`（先只放类型 + 两个解析函数；后续任务往同文件追加）：
```ts
// —— 类型契约（见 plan）——
export type KnowledgePoint = { id: string; name: string; sourceQuote: string; note?: string };
export type Criterion = { id: string; desc: string; sourceQuote: string };
export type Exercise = { id: string; question: string; answer: string; sourceQuote: string };
export type ErrorSpot = { id: string; desc: string; sourceQuote: string };
export type Checklist = {
  knowledgePoints: KnowledgePoint[];
  assessmentCriteria: Criterion[];
  exercises: Exercise[];
  errorSpots: ErrorSpot[];
};

export type ReconStatus = "landed" | "morphed" | "dropped";
export type ReconCategory = "knowledgePoint" | "criteria" | "exercise" | "errorSpot";
export type Row = {
  checklistId: string;
  category: ReconCategory;
  itemName: string;
  status: ReconStatus;
  synthQuote?: string;
  quoteUnverified?: boolean;
  note?: string;
};
export type Coverage = {
  total: number;
  landed: number;
  morphed: number;
  dropped: number;
  coverageRate: number;
};
export type FidelityResult = {
  fid: string;
  checklist: Checklist;
  rows: Row[];
  coverage: Coverage;
  verdict: string;
  dir: string;
};

function parseJsonLoose(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // 有的模型会包一层 ```json ... ```，剥掉再试
    const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) {
      try {
        return JSON.parse(fence[1]);
      } catch {
        /* fallthrough */
      }
    }
    throw new Error(`Fidelity: LLM 输出不是合法 JSON`);
  }
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function parseChecklist(raw: string): Checklist {
  const o = parseJsonLoose(raw) as Record<string, unknown>;
  const checklist: Checklist = {
    knowledgePoints: asArray(o.knowledgePoints).map((x, i) => {
      const r = x as Record<string, unknown>;
      return {
        id: String(r.id ?? `kp${i + 1}`),
        name: String(r.name ?? ""),
        sourceQuote: String(r.sourceQuote ?? ""),
        note: r.note != null ? String(r.note) : undefined,
      };
    }),
    assessmentCriteria: asArray(o.assessmentCriteria).map((x, i) => {
      const r = x as Record<string, unknown>;
      return { id: String(r.id ?? `ac${i + 1}`), desc: String(r.desc ?? ""), sourceQuote: String(r.sourceQuote ?? "") };
    }),
    exercises: asArray(o.exercises).map((x, i) => {
      const r = x as Record<string, unknown>;
      return {
        id: String(r.id ?? `ex${i + 1}`),
        question: String(r.question ?? ""),
        answer: String(r.answer ?? ""),
        sourceQuote: String(r.sourceQuote ?? ""),
      };
    }),
    errorSpots: asArray(o.errorSpots).map((x, i) => {
      const r = x as Record<string, unknown>;
      return { id: String(r.id ?? `es${i + 1}`), desc: String(r.desc ?? ""), sourceQuote: String(r.sourceQuote ?? "") };
    }),
  };
  const total =
    checklist.knowledgePoints.length +
    checklist.assessmentCriteria.length +
    checklist.exercises.length +
    checklist.errorSpots.length;
  if (total === 0) throw new Error("Fidelity: 清单没抽到任何条目");
  return checklist;
}

const VALID_STATUS: ReconStatus[] = ["landed", "morphed", "dropped"];
const VALID_CATEGORY: ReconCategory[] = ["knowledgePoint", "criteria", "exercise", "errorSpot"];

export function parseReconciliation(raw: string): Row[] {
  const o = parseJsonLoose(raw) as Record<string, unknown>;
  const rows = asArray(o.rows).map((x) => {
    const r = x as Record<string, unknown>;
    const status = String(r.status ?? "");
    if (!VALID_STATUS.includes(status as ReconStatus)) {
      throw new Error(`Fidelity: 非法 status "${status}"`);
    }
    const category = String(r.category ?? "");
    if (!VALID_CATEGORY.includes(category as ReconCategory)) {
      throw new Error(`Fidelity: 非法 category "${category}"`);
    }
    return {
      checklistId: String(r.checklistId ?? ""),
      category: category as ReconCategory,
      itemName: String(r.itemName ?? ""),
      status: status as ReconStatus,
      synthQuote: r.synthQuote != null ? String(r.synthQuote) : undefined,
      note: r.note != null ? String(r.note) : undefined,
    } as Row;
  });
  if (rows.length === 0) throw new Error("Fidelity: 勾稽表没有任何行");
  return rows;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm test`
Expected: PASS（llm 4 + fidelity 7 = 11 全绿）。

- [ ] **Step 6: Commit**

```bash
git add lib/fidelity.ts lib/__tests__/fidelity.test.ts lib/__tests__/fixtures/
git commit -m "feat(fidelity): 类型契约 + 清单/勾稽 JSON 解析纯函数"
```

---

## Task 3: verbatim 引用校验 + 覆盖率计算

**Files:**
- Modify: `lib/fidelity.ts`（追加 `verifyQuotes` + `computeCoverage`）
- Modify: `lib/__tests__/fidelity.test.ts`（追加测试）

**Interfaces:**
- Consumes: `normalizeForMatch` from `lib/citations.ts`（已 export，`:28`）；`Row`/`Coverage` 类型。
- Produces: `verifyQuotes(rows: Row[], synthText: string): Row[]`（返回带 `quoteUnverified` 的新数组）；`computeCoverage(rows: Row[]): Coverage`。

- [ ] **Step 1: 写失败测试（追加到 fidelity.test.ts 末尾）**

```ts
import { verifyQuotes, computeCoverage } from "../fidelity.ts";
import type { Row } from "../fidelity.ts";

test("verifyQuotes: synthQuote 逐字命中则不标记", () => {
  const rows: Row[] = [
    { checklistId: "k1", category: "knowledgePoint", itemName: "x", status: "landed", synthQuote: "There is a book" },
  ];
  const out = verifyQuotes(rows, "The teacher says: There is a book on the desk.");
  assert.equal(out[0].quoteUnverified, false);
});

test("verifyQuotes: synthQuote 不在原文则标 quoteUnverified", () => {
  const rows: Row[] = [
    { checklistId: "k1", category: "knowledgePoint", itemName: "x", status: "landed", synthQuote: "There are five cats" },
  ];
  const out = verifyQuotes(rows, "There is a book on the desk.");
  assert.equal(out[0].quoteUnverified, true);
});

test("verifyQuotes: dropped 行无 synthQuote 不校验", () => {
  const rows: Row[] = [
    { checklistId: "k1", category: "exercise", itemName: "x", status: "dropped" },
  ];
  const out = verifyQuotes(rows, "whatever");
  assert.equal(out[0].quoteUnverified, false);
});

test("computeCoverage: 统计三态 + coverageRate", () => {
  const rows: Row[] = [
    { checklistId: "a", category: "knowledgePoint", itemName: "1", status: "landed" },
    { checklistId: "b", category: "knowledgePoint", itemName: "2", status: "landed" },
    { checklistId: "c", category: "knowledgePoint", itemName: "3", status: "morphed" },
    { checklistId: "d", category: "exercise", itemName: "4", status: "dropped" },
  ];
  const cov = computeCoverage(rows);
  assert.equal(cov.total, 4);
  assert.equal(cov.landed, 2);
  assert.equal(cov.morphed, 1);
  assert.equal(cov.dropped, 1);
  assert.equal(cov.coverageRate, 0.5);
});

test("computeCoverage: total=0 时 coverageRate=0", () => {
  const cov = computeCoverage([]);
  assert.equal(cov.coverageRate, 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL —— `verifyQuotes`/`computeCoverage` 未定义。

- [ ] **Step 3: 写实现（追加到 `lib/fidelity.ts`）**

在文件顶部 import 区加：
```ts
import { normalizeForMatch } from "./citations";
```

追加两个函数：
```ts
/** 校验每行的 synthQuote 是否逐字（规范化后）出现在合成节里。返回带 quoteUnverified 的新数组。 */
export function verifyQuotes(rows: Row[], synthText: string): Row[] {
  const normText = normalizeForMatch(synthText);
  return rows.map((r) => {
    if (!r.synthQuote) return { ...r, quoteUnverified: false };
    const needle = normalizeForMatch(r.synthQuote);
    const hit = needle.length === 0 ? true : normText.includes(needle);
    return { ...r, quoteUnverified: !hit };
  });
}

/** 覆盖率：landed / total（morphed 不计入 landed）。 */
export function computeCoverage(rows: Row[]): Coverage {
  let landed = 0, morphed = 0, dropped = 0;
  for (const r of rows) {
    if (r.status === "landed") landed++;
    else if (r.status === "morphed") morphed++;
    else dropped++;
  }
  const total = rows.length;
  const coverageRate = total === 0 ? 0 : Math.round((landed / total) * 100) / 100;
  return { total, landed, morphed, dropped, coverageRate };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS（16 全绿）。

- [ ] **Step 5: Commit**

```bash
git add lib/fidelity.ts lib/__tests__/fidelity.test.ts
git commit -m "feat(fidelity): verbatim 引用校验 + 覆盖率计算"
```

---

## Task 4: md 渲染

**Files:**
- Modify: `lib/fidelity.ts`（追加 `renderChecklistMd` + `renderReportMd`）
- Modify: `lib/__tests__/fidelity.test.ts`（追加快照断言）

**Interfaces:**
- Consumes: `Checklist`/`Row`/`Coverage`。
- Produces: `renderChecklistMd(c: Checklist): string`；`renderReportMd(rows: Row[], coverage: Coverage, verdict: string): string`。

- [ ] **Step 1: 写失败测试（追加）**

```ts
import { renderChecklistMd, renderReportMd } from "../fidelity.ts";
import type { Checklist, Coverage } from "../fidelity.ts";

test("renderReportMd: 含覆盖率摘要、三态图标、原题分组", () => {
  const rows: Row[] = [
    { checklistId: "kp1", category: "knowledgePoint", itemName: "there be", status: "landed", synthQuote: "There is", quoteUnverified: false },
    { checklistId: "kp2", category: "knowledgePoint", itemName: "冠词", status: "dropped", note: "漏了" },
    { checklistId: "ex1", category: "exercise", itemName: "填空题", status: "morphed", synthQuote: "假引用", quoteUnverified: true },
  ];
  const cov: Coverage = { total: 3, landed: 1, morphed: 1, dropped: 1, coverageRate: 0.33 };
  const md = renderReportMd(rows, cov, "保真度一般");
  assert.match(md, /覆盖率/);
  assert.match(md, /1\/3/);            // landed/total
  assert.match(md, /✅/);
  assert.match(md, /❌/);
  assert.match(md, /⚠️/);
  assert.match(md, /教材原题/);         // exercise 单独分组标题
  assert.match(md, /未在合成节逐字命中/); // quoteUnverified 警示
  assert.match(md, /保真度一般/);        // verdict
});

test("renderChecklistMd: 四类都出小标题", () => {
  const c: Checklist = {
    knowledgePoints: [{ id: "kp1", name: "there be", sourceQuote: "There is a book" }],
    assessmentCriteria: [{ id: "ac1", desc: "能描述存在", sourceQuote: "Describe" }],
    exercises: [{ id: "ex1", question: "There ___ books", answer: "are", sourceQuote: "There ___ books" }],
    errorSpots: [{ id: "es1", desc: "数不分", sourceQuote: "There is three" }],
  };
  const md = renderChecklistMd(c);
  assert.match(md, /知识点/);
  assert.match(md, /评价标准/);
  assert.match(md, /教材原题/);
  assert.match(md, /易错点/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL —— 渲染函数未定义。

- [ ] **Step 3: 写实现（追加到 `lib/fidelity.ts`）**

```ts
const STATUS_ICON: Record<ReconStatus, string> = { landed: "✅", morphed: "⚠️", dropped: "❌" };
const STATUS_LABEL: Record<ReconStatus, string> = { landed: "落地", morphed: "变形", dropped: "漏" };

function renderRow(r: Row): string {
  const icon = STATUS_ICON[r.status];
  const parts = [`- ${icon} **${STATUS_LABEL[r.status]}**：${r.itemName}`];
  if (r.synthQuote) {
    const warn = r.quoteUnverified ? " ⚠️（此引用未在合成节逐字命中，可能是模型臆造）" : "";
    parts.push(`\n  > 合成节：${r.synthQuote}${warn}`);
  }
  if (r.note) parts.push(`\n  说明：${r.note}`);
  return parts.join("");
}

export function renderReportMd(rows: Row[], coverage: Coverage, verdict: string): string {
  const nonExercise = rows.filter((r) => r.category !== "exercise");
  const exercises = rows.filter((r) => r.category === "exercise");
  const lines: string[] = [];
  lines.push(`# Fidelity 审计报告`);
  lines.push(``);
  lines.push(`## 总评`);
  lines.push(verdict || "（无）");
  lines.push(``);
  lines.push(`## 覆盖率`);
  lines.push(
    `落地 ${coverage.landed}/${coverage.total}（${Math.round(coverage.coverageRate * 100)}%）` +
      ` · 变形 ${coverage.morphed} · 漏 ${coverage.dropped}`,
  );
  lines.push(``);
  lines.push(`## 知识点 / 评价标准 / 易错点 勾稽`);
  lines.push(nonExercise.length ? nonExercise.map(renderRow).join("\n") : "- 无");
  lines.push(``);
  lines.push(`## 教材原题勾稽`);
  lines.push(exercises.length ? exercises.map(renderRow).join("\n") : "- 无");
  lines.push(``);
  return lines.join("\n");
}

export function renderChecklistMd(c: Checklist): string {
  const lines: string[] = [`# 源材料结构化清单`, ``];
  lines.push(`## 知识点`);
  lines.push(c.knowledgePoints.length ? c.knowledgePoints.map((k) => `- **${k.name}**（${k.id}）\n  > ${k.sourceQuote}${k.note ? `\n  ${k.note}` : ""}`).join("\n") : "- 无");
  lines.push(``, `## 评价标准`);
  lines.push(c.assessmentCriteria.length ? c.assessmentCriteria.map((a) => `- ${a.desc}（${a.id}）\n  > ${a.sourceQuote}`).join("\n") : "- 无");
  lines.push(``, `## 教材原题`);
  lines.push(c.exercises.length ? c.exercises.map((e) => `- ${e.question}（${e.id}）\n  答案：${e.answer}\n  > ${e.sourceQuote}`).join("\n") : "- 无");
  lines.push(``, `## 易错点`);
  lines.push(c.errorSpots.length ? c.errorSpots.map((s) => `- ${s.desc}（${s.id}）\n  > ${s.sourceQuote}`).join("\n") : "- 无");
  lines.push(``);
  return lines.join("\n");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test`
Expected: PASS（18 全绿）。

- [ ] **Step 5: Commit**

```bash
git add lib/fidelity.ts lib/__tests__/fidelity.test.ts
git commit -m "feat(fidelity): 清单/报告 md 渲染"
```

---

## Task 5: LLM 步骤（抽清单 + 勾稽）+ prompt 文件

**Files:**
- Create: `prompts/fidelity_extract.md`
- Create: `prompts/fidelity_reconcile.md`
- Modify: `lib/fidelity.ts`（追加 `extractChecklist` + `reconcile`）

**Interfaces:**
- Consumes: `callLLM("audit", messages, { jsonMode: true })` from `lib/llm.ts`；`readText`/`PROMPTS_ROOT` from `lib/storage.ts`；`parseChecklist`/`parseReconciliation`/`verifyQuotes`。
- Produces: `extractChecklist(sourceText: string, signal: AbortSignal): Promise<Checklist>`；`reconcile(checklist: Checklist, synthText: string, signal: AbortSignal): Promise<Row[]>`。

> 这两个函数含 LLM 调用，**不写单测**（spec §6：不做 LLM mock 端到端）。质量靠 Task 8 真跑验收。重试编排里调用的是已测的 `parseChecklist`/`parseReconciliation`。

- [ ] **Step 1: 写 `prompts/fidelity_extract.md`**

```markdown
# 你的任务：把源材料抽成结构化清单

你是一位教材分析员。下面给你一章**源材料**（可能含教师用书 + 学生课本两部分）。
把这一章**要求覆盖的教学内容**抽成一份结构化清单，供后续核对「合成的教学蓝本有没有丢掉这些内容」。

## 抽哪四类

1. **knowledgePoints 知识点/教学目标**：这一章教什么（语法点、词汇群、功能句、概念）。
2. **assessmentCriteria 评价标准**：教材/教师用书里对「学生应该能做什么」的要求。
3. **exercises 教材原题及答案**：源材料里的练习题原文 + 答案（有答案就写，没有就留空字符串）。
4. **errorSpots 易错点**：教师用书里标注的、学生常犯的错 / 需要特别强调的点。

## 硬规则

- 每一条都要带 `sourceQuote`——**源材料里的原句**（逐字摘一小段，供人核对），不要自己转述。
- 只抽源材料**真有**的东西，不要凭你的知识补充源材料没写的。
- **只输出 JSON**，不要任何解释文字、不要 markdown 代码围栏。结构：

{
  "knowledgePoints": [{ "id": "kp1", "name": "...", "sourceQuote": "...", "note": "可选" }],
  "assessmentCriteria": [{ "id": "ac1", "desc": "...", "sourceQuote": "..." }],
  "exercises": [{ "id": "ex1", "question": "...", "answer": "...", "sourceQuote": "..." }],
  "errorSpots": [{ "id": "es1", "desc": "...", "sourceQuote": "..." }]
}

- id 用 kp1/kp2、ac1、ex1、es1 这样的连续编号。
- 某一类没有就给空数组 `[]`，但不要四类全空。
```

- [ ] **Step 2: 写 `prompts/fidelity_reconcile.md`**

```markdown
# 你的任务：拿清单逐条勾稽合成节

给你两样东西：
1. 一份**源材料清单**（上一步从源章抽的，JSON）。
2. 一节**合成的教学蓝本**（AI 老师将拿它去教学生；学生永远看不到源材料）。

对清单里**每一条**，判断它在合成节里的落地情况，输出三态之一：

- **landed 落地**：合成节里找到了，讲法与源材料一致。给出 `synthQuote`（合成节里的原句）。
- **morphed 变形**：落地了，但讲法/范围/例子变了（讲窄了、讲宽了、换了例子、顺序错位）。给 `synthQuote` + `note` 说明怎么变的。
- **dropped 漏**：源材料有，合成节里找不到对应内容。**这是最要抓的**。`note` 说明漏了什么。

## 判 exercise（教材原题）时

问的不是「原题原文在不在」，而是「合成节里有没有**等价的、学生能练到**这个点的东西」。有→landed/morphed，没有→dropped。

## 硬规则

- `synthQuote` 必须是合成节里**逐字**出现的片段（后续会做逐字校验，编造会被标红）。
- 拿不准落地与否时，倾向 **dropped**——审计宁可多报漏，不可漏报漏。
- **只输出 JSON**，不要解释、不要代码围栏。结构：

{
  "rows": [
    { "checklistId": "kp1", "category": "knowledgePoint", "itemName": "...", "status": "landed", "synthQuote": "..." },
    { "checklistId": "ex1", "category": "exercise", "itemName": "...", "status": "dropped", "note": "..." }
  ],
  "verdict": "一句话总评：这一节保真度够不够，漏的是不是要害。"
}

- category 取值：knowledgePoint / criteria / exercise / errorSpot（与清单条目对应）。
- 清单里每一条都必须在 rows 里出现一次，用相同的 id 作 checklistId。
```

- [ ] **Step 3: 写实现（追加到 `lib/fidelity.ts`）**

顶部 import 区补：
```ts
import path from "node:path";
import { callLLM } from "./llm";
import { readText, PROMPTS_ROOT } from "./storage";
```

追加：
```ts
const MAX_LLM_ATTEMPTS = 2;

/** 抽清单：读源章 → LLM → 结构化 Checklist。解析失败重试 1 次。 */
export async function extractChecklist(sourceText: string, signal: AbortSignal): Promise<Checklist> {
  const rules = await readText(path.join(PROMPTS_ROOT, "fidelity_extract.md"));
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_LLM_ATTEMPTS; attempt++) {
    const raw = await callLLM(
      "audit",
      [
        { role: "system", content: rules },
        { role: "user", content: `## 源材料（本章）\n\n${sourceText}` },
      ],
      { jsonMode: true, temperature: 0.2, maxTokens: 4000, signal },
    );
    try {
      return parseChecklist(raw);
    } catch (e) {
      lastErr = e;
      if (signal.aborted) break;
    }
  }
  throw new Error(`Fidelity 抽清单失败：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}

/** 勾稽：清单 + 合成节 → LLM → Row[]（含 verbatim 校验）。解析失败重试 1 次。 */
export async function reconcile(checklist: Checklist, synthText: string, signal: AbortSignal): Promise<Row[]> {
  const rules = await readText(path.join(PROMPTS_ROOT, "fidelity_reconcile.md"));
  const user = [
    `## 源材料清单（JSON）`,
    JSON.stringify(checklist, null, 2),
    ``,
    `## 合成的教学蓝本（本节）`,
    synthText,
  ].join("\n");
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_LLM_ATTEMPTS; attempt++) {
    const raw = await callLLM(
      "audit",
      [
        { role: "system", content: rules },
        { role: "user", content: user },
      ],
      { jsonMode: true, temperature: 0.2, maxTokens: 4000, signal },
    );
    try {
      const rows = parseReconciliation(raw);
      return verifyQuotes(rows, synthText);
    } catch (e) {
      lastErr = e;
      if (signal.aborted) break;
    }
  }
  throw new Error(`Fidelity 勾稽失败：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}
```

- [ ] **Step 4: 类型检查（无 LLM 调用，仅确认能编译）**

Run: `cd "S:/Code/工作探索/书的审计" && npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 5: 跑现有测试确认没破坏**

Run: `npm test`
Expected: PASS（18 全绿，未新增测试）。

- [ ] **Step 6: Commit**

```bash
git add lib/fidelity.ts prompts/fidelity_extract.md prompts/fidelity_reconcile.md
git commit -m "feat(fidelity): 抽清单 + 勾稽 LLM 步骤 + prompt 规则"
```

---

## Task 6: `runFidelity` 编排 + 落盘

**Files:**
- Modify: `lib/fidelity.ts`（追加 `runFidelity` + `newFid`）
- Modify: `lib/__tests__/fidelity.test.ts`（追加 `newFid` 格式测试）

**Interfaces:**
- Consumes: `extractChecklist`/`reconcile`/`computeCoverage`/`renderChecklistMd`/`renderReportMd`；`ensureDir`/`writeAtomic`/`DATA_ROOT` from `lib/storage.ts`。
- Produces: `runFidelity(sourceText: string, synthText: string, signal: AbortSignal, opts?: { sampleName?: string }): Promise<FidelityResult>`；落盘 `data/fidelity/<fid>/{checklist.json,report.json,report.md,meta.json}`。

- [ ] **Step 1: 写失败测试（追加，只测纯函数 `newFid` 的格式）**

```ts
import { newFid } from "../fidelity.ts";

test("newFid: 形如 f-<14位数字>-<6位>", () => {
  const id = newFid();
  assert.match(id, /^f-\d{14}-[a-z0-9]{6}$/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test`
Expected: FAIL —— `newFid` 未定义。

- [ ] **Step 3: 写实现（追加到 `lib/fidelity.ts`）**

顶部 import 补 `ensureDir`/`writeAtomic`/`DATA_ROOT`：
```ts
import { readText, PROMPTS_ROOT, ensureDir, writeAtomic, DATA_ROOT } from "./storage";
```

追加：
```ts
export const FIDELITY_ROOT = path.join(DATA_ROOT, "fidelity");

export function newFid(): string {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `f-${ts}-${rand}`;
}

type FidelityMeta = {
  fid: string;
  sampleName?: string;
  model: string;
  independentEndpoint: boolean;
  startedAt: number;
  endedAt?: number;
  status: "running" | "done" | "errored";
  error?: string;
};

export async function runFidelity(
  sourceText: string,
  synthText: string,
  signal: AbortSignal,
  opts: { sampleName?: string } = {},
): Promise<FidelityResult> {
  const fid = newFid();
  const dir = path.join(FIDELITY_ROOT, fid);
  await ensureDir(dir);

  const independentEndpoint = !!process.env.LLM_AUDIT_BASE_URL;
  const model =
    process.env.LLM_AUDIT_MODEL || process.env.LLM_MODEL_AUDIT || process.env.LLM_MODEL || "";
  const meta: FidelityMeta = {
    fid,
    sampleName: opts.sampleName,
    model,
    independentEndpoint,
    startedAt: Date.now(),
    status: "running",
  };
  await writeAtomic(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));

  try {
    const checklist = await extractChecklist(sourceText, signal);
    await writeAtomic(path.join(dir, "checklist.json"), JSON.stringify(checklist, null, 2));

    const rows = await reconcile(checklist, synthText, signal);
    const coverage = computeCoverage(rows);

    // verdict：勾稽 LLM 会在 rows 里给不出，改从 report.json 单独存；这里从 rows 无法拿 verdict，
    // 所以 reconcile 的 verdict 需要透出。见下方说明——我们把 verdict 存进 report.json。
    const verdict = deriveVerdict(coverage);
    const reportJson = { rows, coverage, verdict };
    await writeAtomic(path.join(dir, "report.json"), JSON.stringify(reportJson, null, 2));
    await writeAtomic(path.join(dir, "report.md"), renderReportMd(rows, coverage, verdict));

    meta.status = "done";
    meta.endedAt = Date.now();
    await writeAtomic(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2));

    return { fid, checklist, rows, coverage, verdict, dir };
  } catch (err) {
    meta.status = "errored";
    meta.endedAt = Date.now();
    meta.error = err instanceof Error ? err.message : String(err);
    await writeAtomic(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2)).catch(() => {});
    throw err;
  }
}

/** 覆盖率兜底 verdict（LLM 的 verdict 见下）。 */
function deriveVerdict(cov: Coverage): string {
  if (cov.total === 0) return "无可勾稽条目。";
  const pct = Math.round(cov.coverageRate * 100);
  if (cov.dropped === 0 && cov.morphed === 0) return `保真度高：${cov.total} 条全部落地。`;
  if (cov.dropped === 0) return `保真度尚可：落地 ${pct}%，${cov.morphed} 条讲法有变形需人核。`;
  return `保真度存疑：${cov.dropped} 条漏、${cov.morphed} 条变形，落地率 ${pct}%。`;
}
```

> **verdict 来源修正**：`reconcile` 目前只返回 `Row[]`，LLM 给的 `verdict` 字段被丢弃。为了不吞掉 LLM 的总评，改 `reconcile` 让它同时透出 verdict。见 Step 4。

- [ ] **Step 4: 让 `reconcile` 透出 LLM 的 verdict**

改 `reconcile` 返回类型为 `Promise<{ rows: Row[]; verdict: string }>`：
```ts
export async function reconcile(
  checklist: Checklist,
  synthText: string,
  signal: AbortSignal,
): Promise<{ rows: Row[]; verdict: string }> {
  const rules = await readText(path.join(PROMPTS_ROOT, "fidelity_reconcile.md"));
  const user = [
    `## 源材料清单（JSON）`,
    JSON.stringify(checklist, null, 2),
    ``,
    `## 合成的教学蓝本（本节）`,
    synthText,
  ].join("\n");
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_LLM_ATTEMPTS; attempt++) {
    const raw = await callLLM(
      "audit",
      [
        { role: "system", content: rules },
        { role: "user", content: user },
      ],
      { jsonMode: true, temperature: 0.2, maxTokens: 4000, signal },
    );
    try {
      const rows = verifyQuotes(parseReconciliation(raw), synthText);
      let verdict = "";
      try {
        const o = JSON.parse(raw) as { verdict?: unknown };
        if (o.verdict != null) verdict = String(o.verdict);
      } catch {
        /* verdict 可选，拿不到就空 */
      }
      return { rows, verdict };
    } catch (e) {
      lastErr = e;
      if (signal.aborted) break;
    }
  }
  throw new Error(`Fidelity 勾稽失败：${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
}
```

对应改 `runFidelity` 里的调用：
```ts
    const { rows, verdict: llmVerdict } = await reconcile(checklist, synthText, signal);
    const coverage = computeCoverage(rows);
    const verdict = llmVerdict || deriveVerdict(coverage);
```

（`deriveVerdict` 作为 LLM 没给 verdict 时的兜底，保留。）

- [ ] **Step 5: 跑测试确认通过**

Run: `npm test`
Expected: PASS（19 全绿）。

- [ ] **Step 6: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 7: 确认 `data/fidelity/` 与样例目录已被 gitignore**

Run: `cd "S:/Code/工作探索/书的审计" && grep -nE "fidelity" .gitignore || echo "NEED_ADD"`
若输出 `NEED_ADD`，在 `.gitignore` 追加：
```
/data/fidelity/
/data/fidelity-samples/
```
（若 `.gitignore` 已用 `/data/` 之类宽规则覆盖则跳过。先看现有 `.gitignore` 的 data 段落。）

- [ ] **Step 8: Commit**

```bash
git add lib/fidelity.ts lib/__tests__/fidelity.test.ts .gitignore
git commit -m "feat(fidelity): runFidelity 编排 + 落盘 + verdict 透出"
```

---

## Task 7: CLI 薄壳脚本

**Files:**
- Create: `scripts/fidelity-audit.ts`

**Interfaces:**
- Consumes: `runFidelity` from `lib/fidelity.ts`；读 `data/fidelity-samples/<name>/{source.md,synth.md}`。

- [ ] **Step 1: 写脚本**

Create `scripts/fidelity-audit.ts`:
```ts
/**
 * Fidelity 审计 CLI（薄壳，逻辑全在 lib/fidelity.ts）。
 *
 * 用法：
 *   node --import tsx scripts/fidelity-audit.ts <sample-name>
 * 读 data/fidelity-samples/<name>/{source.md, synth.md}，出勾稽报告落盘。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { runFidelity } from "../lib/fidelity";

const [, , sampleName] = process.argv;
if (!sampleName) {
  console.error("用法: node --import tsx scripts/fidelity-audit.ts <sample-name>");
  process.exit(1);
}

const CWD = process.cwd();
const sampleDir = path.join(CWD, "data", "fidelity-samples", sampleName);
const sourcePath = path.join(sampleDir, "source.md");
const synthPath = path.join(sampleDir, "synth.md");

async function readOrDie(p: string): Promise<string> {
  try {
    return await fs.readFile(p, "utf-8");
  } catch {
    console.error(`找不到文件：${p}`);
    process.exit(1);
  }
}

if (!process.env.LLM_AUDIT_BASE_URL) {
  console.warn(
    "\n⚠️  未配置独立审计端点（LLM_AUDIT_BASE_URL），正在用与生成器同源的模型自审——\n" +
      "   按交接文档 §2，同源自审的「通过」可信度存疑。出真结论前请配 LLM_AUDIT_* 换独立厂/端点。\n",
  );
}

const sourceText = await readOrDie(sourcePath);
const synthText = await readOrDie(synthPath);

console.log(`\n开始 Fidelity 审计：${sampleName}`);
console.log(`  源材料 ${sourceText.length} 字 · 合成节 ${synthText.length} 字\n`);

const ctrl = new AbortController();
try {
  const res = await runFidelity(sourceText, synthText, ctrl.signal, { sampleName });
  const c = res.coverage;
  console.log(`审计完成 fid=${res.fid}`);
  console.log(
    `  覆盖率：落地 ${c.landed}/${c.total}（${Math.round(c.coverageRate * 100)}%）· 变形 ${c.morphed} · 漏 ${c.dropped}`,
  );
  console.log(`  总评：${res.verdict}`);
  console.log(`\n产物目录：${res.dir}`);
  console.log(`  - checklist.json（源清单，请扫一眼验对不对）`);
  console.log(`  - report.md（勾稽报告）`);
} catch (err) {
  console.error(`\n审计失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
```

- [ ] **Step 2: 类型检查（脚本不在 tsconfig include 的测试范围，但语法要对）**

Run: `cd "S:/Code/工作探索/书的审计" && npx tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: 冒烟测试——参数缺失时友好报错**

Run: `cd "S:/Code/工作探索/书的审计" && node --import tsx scripts/fidelity-audit.ts; echo "exit=$?"`
Expected: 打印用法 + `exit=1`。

- [ ] **Step 4: 冒烟测试——样例不存在时友好报错**

Run: `cd "S:/Code/工作探索/书的审计" && node --import tsx scripts/fidelity-audit.ts nonexistent; echo "exit=$?"`
Expected: 打印同源警告（因为没配 LLM_AUDIT）+ `找不到文件：.../source.md` + `exit=1`。

- [ ] **Step 5: Commit**

```bash
git add scripts/fidelity-audit.ts
git commit -m "feat(fidelity): CLI 薄壳脚本"
```

---

## Task 8: 手工塑英语书 Starter 样例 + 真跑验收 + Phase 2 留档

**Files:**
- Create: `data/fidelity-samples/starter/source.md`（手工）
- Create: `data/fidelity-samples/starter/synth.md`（手工）
- Modify: `lib/__tests__/fixtures/*.json`（用真跑输出替换）
- Modify: `STATUS.md`（加 Phase 2 未做记号）
- Modify: `docs/superpowers/specs/2026-07-11-审计管线重构-交接.md`（更新进度）

- [ ] **Step 1: 手工塑样例**

- `synth.md`：从 `S:/Code/工作探索/破卷写书/english-book-七上-v2-师生合版/BOOK.md` 抠出 Starter 那一节（Unit 0 整段）。
- `source.md`：从 `.../source-md/full.md`（学生课本）+ `.../source-md-teacher/full.md`（教师用书）里，抠出 Starter 对应的段落，拼在一起（学生课本段 + `\n\n---\n\n` + 教师用书段）。用 OUTLINE.md 里的页码（Starter p2-p13）定位边界。

> 这一步是人工判断哪段对应 Starter；抠多抠少不苛求，目标是让审计器有真材料可勾稽。

- [ ] **Step 2: 配置检查**

确认 `.env.local` 有可用的 LLM 配置（至少 `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`）。若要验证独立性，另配 `LLM_AUDIT_*`。

- [ ] **Step 3: 真跑**

Run: `cd "S:/Code/工作探索/书的审计" && node --import tsx scripts/fidelity-audit.ts starter`
Expected: 打印覆盖率摘要 + 产物路径；`data/fidelity/<fid>/` 下四个文件生成。

- [ ] **Step 4: 人验收（与用户一起）**

打开 `data/fidelity/<fid>/checklist.json` 和 `report.md`：
- 清单抽得对不对？（有没有把 Starter 的知识点/原题/易错点抽全）
- 勾稽的三态判定合不合理？dropped 的是不是真漏？
- 有没有 `quoteUnverified` 红标（模型臆造引用）？

若清单/勾稽明显跑偏 → 回 Task 5 调 prompt，重跑。这是 MVP 的核心验收动作。

- [ ] **Step 5: 用真实输出替换 fixture**

把这次真跑的 LLM 原始 JSON 输出（可从 `checklist.json` 和 `report.json` 取，或加临时日志抓 raw）存进 `lib/__tests__/fixtures/checklist.sample.json` 和 `reconciliation.sample.json`，让解析单测吃真实格式。
Run: `npm test`
Expected: PASS（解析器对真实输出也解析正确；若失败说明解析器容错不足 → 修 `parseChecklist`/`parseReconciliation` 并补测试）。

- [ ] **Step 6: Phase 2 留档（防遗忘双锁的第二锁）**

在 `STATUS.md`（若无则在交接文档）顶部醒目处加一行：
```markdown
> **Fidelity Phase 2 未做**：审计逻辑已在 `lib/fidelity.ts`（CLI 可跑：`node --import tsx scripts/fidelity-audit.ts <sample>`）。
> 尚未回接 `/api/audits` + UI（加 `dimension:"fidelity"`、审计面板选源材料、进审计历史）。
> 见 `docs/superpowers/specs/2026-07-11-fidelity-audit-design.md` §8。
```

- [ ] **Step 7: Commit（样例默认 gitignore，只提交 fixture + 文档）**

```bash
git add lib/__tests__/fixtures/ STATUS.md docs/superpowers/specs/2026-07-11-审计管线重构-交接.md
git commit -m "test(fidelity): 真实 LLM 输出替换 fixture + Phase 2 留档"
```

> 样例文件在 `data/fidelity-samples/`（gitignore），不提交。若你想把 Starter 样例入库当回归基准，单独 `git add -f`。

---

## Self-Review

**1. Spec coverage（逐节对照 design.md）：**
- §1 目标/边界 → Task 1-8 整体；源可选（不改 audit.ts）→ Global Constraints + Task 全程不碰 audit.ts ✓
- §2 文件布局 → Task 1（llm/env）、2-6（fidelity.ts）、5（prompts）、7（脚本）、2（fixtures）✓
- §3 数据流 + 两个数据结构 → 类型契约 + Task 2/6 ✓
- §4 组件接口（含 jsonMode）→ Task 2-6 逐一实现；jsonMode 在 Task 5 ✓
- §5 错误处理（重试/verbatim/样例缺失/同源警告）→ Task 5 重试、Task 3 verbatim、Task 7 样例缺失+同源警告 ✓
- §6 测试（纯函数 node:test / 真跑验收 / 不做 mock）→ Task 2-4 单测、Task 8 验收 ✓
- §7 已知局限 → Task 7 同源警告 + meta.independentEndpoint 记录 ✓
- §8 分阶段（Phase 2 留档）→ Task 8 Step 6 ✓

**2. Placeholder scan：** 无 TBD/TODO；所有代码步骤含完整代码；prompt 全文写出。✓

**3. Type consistency：** `getClient(purpose)`、`reconcile` 返回 `{rows, verdict}`（Task 6 Step 4 修正了 Task 5 的 `Promise<Row[]>`——最终以 Task 6 版本为准，实现时 Task 5 先写 `Promise<Row[]>`、Task 6 Step 4 改签名，两处一致收敛）、`Row`/`Coverage`/`Checklist` 字段全 plan 统一。`newFid`/`FIDELITY_ROOT` 在 Task 6 定义并被脚本引用。✓

> **给实现者的注意**：Task 5 先把 `reconcile` 写成返回 `Promise<Row[]>`，Task 6 Step 4 会把它改成返回 `{ rows, verdict }`。这是有意的渐进——Task 6 需要 verdict 时才引入。若按顺序执行不会冲突。
