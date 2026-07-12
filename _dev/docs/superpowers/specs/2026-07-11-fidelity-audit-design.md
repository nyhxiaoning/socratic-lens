# Fidelity 审计 · 设计文档

> **状态：实验性功能**。此维度需要外部源材料（教材/课纲等 ground truth）才能运行，
> 与当前「AI 直接写书 → 教-学对话 → 覆盖度审计」的主工作流无关。
> 后续如果有「有源材料的写书」场景再正式启用。
> 产生于 2026-07-11 一场 `brainstorming`，续自交接文档 `2026-07-11-审计管线重构-交接.md`。
> 本 spec 只覆盖交接文档「七条改造」里的 **第 1 个 spec：Fidelity 审计（#3 划分 + #1 换独立模型 + #2 源勾稽）**。

---

## 1. 目标与边界

### 做什么

给「有源材料的合成书」跑一个 **保真度（Fidelity）审计**，回答一个客观问题：

> **合成书有没有丢/歪源材料（尤其教师用书）里的教学目标、知识点、教材原题、教师标注的易错点？**

抓的核心信号是 **漏**——源材料里有、合成书里静默消失的点。这与旧的 transcript 散文审计（读教-学对话挖卡壳）是**两条完全不同的路径**。

### 认识论定位（来自交接文档 §2）

- Fidelity 腿**不跑对话、不需要 fake learner**，拿源材料当铁证逐条勾稽，信号最可靠，拦住「造书没信心」的大头。
- 独立性的关键：审计器若与生成器**同源**，只抓得到它自己不会犯的错。所以 Fidelity 要走**独立厂/端点的模型**（#1）。清空上下文不等于独立——盲区长在权重里。

### 本次范围（Phase 1：CLI 脚本验证）

- 手工塑**一节样例**（英语书 Starter：合成节 + 对应源章）放进 `data/`。
- 抽结构化清单 → 逐条勾稽 → 出三态勾稽表 + 覆盖率，落盘 JSON + md。
- 走独立 audit client（不同厂/端点）；未配则 fallback + 醒目警告。
- **核心逻辑抽在 `lib/fidelity.ts`，脚本是薄壳**——保证 Phase 2 接 API 是复用不是重写。

### 明确不做

- **Phase 2（回接 `/api/audits` + UI，加 `dimension:"fidelity"`）——本次不做，但作为显式未完成阶段写在 §8，防遗忘。**
- 不改造书管线（破卷写书仓）。不定正式导入格式。
- 不碰 Sufficiency 腿（#4/#5/#7）、不碰对抗验证层（#6）。
- **源材料可选**：没源的书照跑现有 `book`/`teacher` 维度；Fidelity 只在有源材料时点亮，是**增量能力**，不是替换。

---

## 2. 架构与文件布局

**核心原则：逻辑在 `lib/`，脚本是薄壳。** Phase 2 接 API 时复用同一批 `lib/` 函数。

### 新增文件

```
lib/
  fidelity.ts          Fidelity 审计核心（全部逻辑在此）

prompts/
  fidelity_extract.md      抽清单规则（源章 → 结构化清单）
  fidelity_reconcile.md    勾稽规则（清单 + 合成节 → 三态勾稽表）

scripts/
  fidelity-audit.mjs       薄壳：读两个文件 → 调 runFidelity → 打印 + 报告路径

lib/__tests__/
  fidelity.test.mjs        node:test 纯函数单测
  fixtures/                真实 LLM 输出存的 fixture（供解析单测吃）

data/
  fidelity-samples/<name>/     手工塑的验证样例（.gitignored）
    synth.md                   合成节（从 BOOK.md 抠出）
    source.md                  对应源章（教师用书 + 学生课本对应段）
  fidelity/<fid>/              审计产物（.gitignored）
    checklist.json             抽出的结构化清单（人可扫验）
    report.json                三态勾稽表 + 覆盖率（结构化）
    report.md                  渲染好的报告
    meta.json                  fid / 样例名 / 模型 / 时间 / status
```

### 改动现有文件（最小）

```
lib/llm.ts       getClient 改成按 purpose 选 client（audit 用独立 baseURL/key）。
                 现有 teacher/learner/coach 行为完全不变（fallback 到原共享 client）。
.env.example     加 LLM_AUDIT_BASE_URL / LLM_AUDIT_API_KEY / LLM_AUDIT_MODEL 注释块。
```

**`lib/audit.ts` 一行不动。** Fidelity 是全新路径，不碰现有 transcript 审计。

`.gitignore`：`data/fidelity-samples/` 和 `data/fidelity/` 默认忽略（与现有 `data/sessions`、`data/audits` 一致）。

---

## 3. 数据流

```
你手工准备:
  data/fidelity-samples/starter/synth.md    ← 从 BOOK.md 抠 Starter 那节
  data/fidelity-samples/starter/source.md   ← 教师用书+学生课本 Starter 对应段

$ node scripts/fidelity-audit.mjs starter
        │
        ▼
  runFidelity(sourceText, synthText, signal)     ← lib/fidelity.ts 编排
        │
        ├─(1)─► extractChecklist(sourceText)
        │         callLLM("audit", ..., { jsonMode: true }) 用独立 client
        │         读 prompts/fidelity_extract.md
        │         输出 JSON → parseChecklist() → checklist 对象
        │         落盘 checklist.json         ← 人可扫一眼验
        │
        ├─(2)─► reconcile(checklist, synthText)
        │         callLLM("audit", ..., { jsonMode: true }) 逐条勾稽
        │         读 prompts/fidelity_reconcile.md
        │         输出 JSON → parseReconciliation() → rows[]
        │         verbatim 校验每行 synthQuote 是否在 synthText 逐字命中
        │
        ├─(3)─► computeCoverage(rows)          ← 纯函数
        │         { total, landed, morphed, dropped, coverageRate }
        │
        └─(4)─► 落盘 report.json + report.md + meta.json
        │
        ▼
  脚本打印覆盖率摘要 + 报告文件路径
```

### 对齐原理

合成书已按源章节 1:1 组织（Starter + Unit 1–6，见 `破卷写书/.../OUTLINE.md`）。「合成节 → 对应源章」的指针只用来**划定范围**（该拿哪块源当 ground truth），审计器仍读**整块源章**扫漏——**指针划范围，不当「覆盖证明」**。因为生成器自报「我用了什么」≠「它该覆盖什么」，Fidelity 的核心正是抓它没自报的漏。

MVP 阶段这个「指针」就是你手工把对应源章放进 `source.md`——不需要机器对齐。

### 清单对象（checklist.json）

四类，全部从源章抽，每条带 `sourceQuote`（源材料原句，供人核 + 勾稽引证）：

```jsonc
{
  "knowledgePoints":     [{ "id": "kp1", "name": "...", "sourceQuote": "...", "note": "..." }],
  "assessmentCriteria":  [{ "id": "ac1", "desc": "...", "sourceQuote": "..." }],
  "exercises":           [{ "id": "ex1", "question": "...", "answer": "...", "sourceQuote": "..." }],
  "errorSpots":          [{ "id": "es1", "desc": "...", "sourceQuote": "..." }]
}
```

### 勾稽表（report.json）

清单每条 → 一行：

```jsonc
{
  "rows": [{
    "checklistId": "kp1",
    "category": "knowledgePoint",   // knowledgePoint | criteria | exercise | errorSpot
    "itemName": "...",
    "status": "landed",             // landed ✅ | morphed ⚠️ | dropped ❌
    "synthQuote": "...",            // 合成节里落地的句子（landed/morphed 才有）
    "quoteUnverified": false,       // verbatim 校验：synthQuote 未在合成节逐字命中则 true
    "note": "..."                   // 变形说明 / 漏的判断
  }],
  "coverage": { "total": 0, "landed": 0, "morphed": 0, "dropped": 0, "coverageRate": 0 },
  "verdict": "一句话总评：这节保真度够不够"
}
```

三态定义：
- ✅ **landed 落地**：合成节里找到，讲法一致。
- ⚠️ **morphed 变形**：落地了但讲法/范围/例子变了，需人核。
- ❌ **dropped 漏**：源材料有，合成节里找不到。**Fidelity 最要抓的信号。**

教材原题（exercise）在 md 里**单列一组**——它问的是「合成节里有没有等价的能练到的东西」，视角与知识点落地不同。

---

## 4. 组件接口

LLM 调用与纯逻辑分开：纯函数好测、确定性钉死；LLM 部分薄、靠人验收。

```
lib/fidelity.ts
─────────────────────────────────────────────────────────────
// —— LLM 步骤（薄，难测，靠人验收）——
extractChecklist(sourceText: string, signal): Promise<Checklist>
    callLLM("audit", [system=fidelity_extract.md, user=sourceText], { jsonMode: true })
    内部调 parseChecklist。解析不出任何条目 → 重试 1 次 → 仍失败抛错。

reconcile(checklist: Checklist, synthText: string, signal): Promise<Row[]>
    callLLM("audit", [system=fidelity_reconcile.md, user=清单+合成节], { jsonMode: true })
    内部调 parseReconciliation + verbatim 校验。

// —— 纯函数（确定性，单测钉死）——
parseChecklist(raw: string): Checklist                    JSON.parse + 字段校验 + 容错
parseReconciliation(raw: string): Row[]                   同上
verifyQuotes(rows: Row[], synthText: string): Row[]       逐字命中校验，标 quoteUnverified
computeCoverage(rows: Row[]): Coverage
renderChecklistMd(c: Checklist): string
renderReportMd(rows, coverage, verdict): string

// —— 编排（薄，负责落盘）——
runFidelity(sourceText, synthText, signal, opts?): Promise<FidelityResult>
    extract → reconcile → verify → coverage → 落盘四文件
    返回 { fid, checklist, rows, coverage, dir }

lib/llm.ts（改）
─────────────────────────────────────────────────────────────
getClient(purpose: Purpose): OpenAI
    purpose="audit" 且 LLM_AUDIT_BASE_URL 存在 → 独立 client（独立 baseURL/key）
    否则 → 原共享 client（teacher/learner/coach 完全不受影响）
    client 按 key 缓存（避免每次 new）。
pickModel(purpose)
    audit 优先 LLM_AUDIT_MODEL，其次 LLM_MODEL_AUDIT，其次 LLM_MODEL（向后兼容）。

scripts/fidelity-audit.mjs（薄壳）
─────────────────────────────────────────────────────────────
node scripts/fidelity-audit.mjs <sample-name>
    读 data/fidelity-samples/<name>/{source.md, synth.md}
    调 runFidelity → 打印覆盖率摘要 + 报告路径。不含任何审计逻辑。
```

**LLM 输出格式：`jsonMode` 结构化 JSON**（`callLLM` 已支持，非流式）。比 `===TAG===` 散文正则更稳。两次调用都是非流式一次拿全——CLI 不需要流式打字机效果。

---

## 5. 错误处理

**LLM 输出不合格式** —— 学现有 `runAudit` 的重试思路（缺 tag 重试一次）：
- `parseChecklist` / `parseReconciliation` 解析失败（JSON 坏 / 关键字段缺）→ **重跑该步一次**（最多 2 次尝试）。两次都失败 → 抛错，脚本打印原始输出片段帮 debug，`meta.status="errored"`。

**勾稽引用臆造** —— 复用本项目已有的 `lib/citations.ts` verbatim 思路：
- `verifyQuotes` 检查每行 `synthQuote` 是否在 `synthText` 逐字命中。未命中 → 标 `quoteUnverified: true`，md 里红字提示「⚠️ 此引用未在合成节逐字命中，可能是模型臆造」。**不推翻 LLM 判定，只标记**，给人核警示。纯函数，进单测。

**样例目录不全** —— 脚本层友好报错：`data/fidelity-samples/<name>/source.md 不存在`，退出。

**独立 audit client 没配** —— `LLM_AUDIT_*` 没填时 `getClient("audit")` fallback 到共享 client（同源模型）。此时脚本打印醒目警告：

> ⚠️ 未配置独立审计端点，正在用与生成器同源的模型自审——按交接文档 §2，同源自审的「通过」可信度存疑。

**不阻断运行**（MVP 阶段先跑通流程比强制独立性重要），但确保你不会误把「同源自审通过」当真信心。这是**已知局限**（见 §7）。

---

## 6. 测试策略

### 第一层：确定性单测（纯函数，钉死）— `node:test`，零新依赖

- `parseChecklist` / `parseReconciliation`：喂**真实 LLM 输出存成的 fixture**，断言解析出的对象/行数正确；喂坏 JSON，断言触发重试/抛错路径。
- `computeCoverage`：固定 rows → 断言 total/landed/morphed/dropped/coverageRate 精确。
- `verifyQuotes`：命中/未命中 → 断言 `quoteUnverified` 标记正确。
- `renderReportMd` / `renderChecklistMd`：快照测。

**fixture 来源：** Phase 1 实现时拿一小段源材料真跑一次 extract/reconcile，把 LLM 原始 JSON 存进 `lib/__tests__/fixtures/`。测的是「模型真会吐的格式」，不是想象的格式。

### 第二层：真跑一次当验收（不进 CI）

英语书 Starter 样例真跑一遍，人一起看勾稽表合不合理。这是 MVP「手工塑一节验证」的验收动作。

### 不做

LLM 调用打 mock 的端到端「测试」——只证明搬运对，证明不了判断对，投入产出低。判断质量靠第二层人看。

**运行器：** Node 内置 `node:test`（`node --test`），不引 vitest/jest。

---

## 7. 已知局限

- **同源自审不算数**：未配 `LLM_AUDIT_*` 时用同源模型，「通过」不可信（交接文档 §2 的死穴）。fallback 只是让 MVP 流程能跑通的权宜；出真结论前必须配独立端点。
- **指针不是覆盖证明**：源章由人手工放入 `source.md`，对齐正确性靠人；审计器读整章扫漏，不信任生成器自报。
- **变形（morphed）判定偏软**：「讲法变了算不算保真」有主观性，靠 `sourceQuote`/`synthQuote` 对照让人复核，不追求机器终判。

---

## 8. 分阶段落地（Phase 2 显式留档，防遗忘）

### Phase 1（本次做）— CLI 脚本验证
- [ ] `lib/llm.ts`：`getClient` 按 purpose 选 client + `.env.example` 加 `LLM_AUDIT_*`
- [ ] `lib/fidelity.ts`：extract / reconcile / 纯函数们 / runFidelity
- [ ] `prompts/fidelity_extract.md` + `prompts/fidelity_reconcile.md`
- [ ] `scripts/fidelity-audit.mjs` 薄壳
- [ ] `lib/__tests__/fidelity.test.mjs` + fixtures
- [ ] 手工塑英语书 Starter 样例，真跑一次人验收

### Phase 2（本次**不做**，白纸黑字留着）— 回接 API + UI
- [ ] `lib/audit.ts` 或 `api/audits/route.ts`：加 `dimension: "fidelity"` 分支，**复用 `lib/fidelity.ts` 的 `runFidelity`**（不重写逻辑）
- [ ] 审计面板能选 fidelity 维度、能选/上传源材料
- [ ] Fidelity 报告进审计历史 `history.jsonl`

> **防遗忘双锁**：① Phase 2 是本文档里显式未勾选的阶段；② Phase 1 跑通后，往项目 `STATUS.md` / 交接文档写一行「Fidelity Phase 2 回接 API 未做」，下次开会话第一眼可见。
> **关键设计决定**：Phase 1 核心逻辑全在 `lib/fidelity.ts`，脚本只是薄壳——就算 Phase 2 被拖，最坏也只是「少个网页按钮」，价值主体（勾稽逻辑）不会丢，Phase 2 是复用不是重写。

---

## 附：与交接文档七条改造的对应

| 交接文档条目 | 本 spec 落点 |
|---|---|
| #3 拆 Fidelity / Sufficiency | §1 定位：本 spec = Fidelity 腿 |
| #1 换独立模型 | §4 `getClient` 按 purpose + `LLM_AUDIT_*` |
| #2 源材料勾稽 | §3 数据流 + §4 extract/reconcile |
| #4 #5 #6 #7 | 明确不做（§1 边界） |
