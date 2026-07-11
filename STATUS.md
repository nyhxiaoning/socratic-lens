# STATUS.md · 项目当前状态与改进候选

> **给未来的你或 AI 拿起来接着改用。**
> 快照时间：2026-07-07（原文）+ 2026-07-11 增补一节"进行中的改进 (2026-07-11)"在文末
> 最新 commit：`ff14e26`（chore: .env.example 补 LLM 价格变量）——本节的 2026-07-11 改动已全部提交。
> **⚠️ 新会话打开先看文末"进行中的改进"那一节。**

## 一句话现状

一个 Socratopia 风格的**教-学-审**多 agent 试验台已经跑通并入库。核心黄金路径：**选书 → 选节 → 选学生画像 → 教师和学生 agent 对着讲 → 完了或中止后按"审计…"合审一次以上的 session → 出结构化诊断报告**。所有中间状态每轮落盘、可 resume、可回看。

## 已建成 · 按能力划分

### 基础对话循环
- 教师 / 学生 **独立上下文**：教师 messages 里 learner→user，学生 messages 里 teacher→user（Socratopia §3.1）
- **只有教师看得到本节原文**——学生的困惑就是书的困惑
- **引用协议** `〔§<节id>｜前若干字〕`；观察页把引用渲染成可点 chip，点开弹本节原文 Modal
- **三种学生画像**（`prompts/learner_*.md`）：novice / mid / critic

### 教师约束（复刻 Socratopia §3.1）
- 8 段硬规则 + 教学信条 + pacing 三档（thorough / normal / express）
- 铁律含：只讲当前窗口的原文；不许假装读过其它章节；不许自作主张下课；每条以问题结尾
- 学生 5 种提问本能（source: Socratopia pet §4.1，我们借了模式，不借人设）

### 双教练元回路（复刻 Socratopia §3.4）
- **教师教练** `coach_rules.md` → `CoachAnalysis` JSON：`companionBehavior` / `learnerEngagement` / `isTangent` / `recommendedAction` / `responsePlaybook` / `contentProgress`（用于自适应翻页）
- **学生教练** `learner_coach_rules.md` → `LearnerCoachAnalysis` JSON：`understandingLevel` / `shouldHaveLearned vs actuallyLearned` 落差 / `prosthesisRisk`（预训练作弊）/ `personaFidelity`（画像漂移）/ `affect`
- 每轮末尾 `Promise.allSettled` **并行**跑两个教练；结果注入下一轮对应 agent 的 system prompt 末尾
- UI 侧栏 tab 切换教师教练 / 学生教练；每张卡片可展开看 playbook

### 自适应翻页（复刻 Socratopia §5.4）
- section 原文 ≥ 12k 字符 → `paginate()` 按段落切成 ~1.8k / 页，缓存到 `sections/<id>.pages.json`
- 教师初始窗口 3-4 页（8k 字符预算）
- 教练输出 `contentProgress` 累计 2 次非 `first_half` → `slideWindow()`：保留 2 页重叠 + 追加至预算 + 末页守恒
- meta 里全程记录 `windowStartPage/endPage`，resume 保状态
- **实测**（马原 §08，19.6k 字符）：教师系统 prompt 中 section 段从 19.6k → 7k，节省 ~60%

### 滑动摘要（复刻 Socratopia §10.2）
- 每轮末：若"未压缩对话"累计 > 12k 字符，把最早的一批 turns 用 LLM 压成摘要（教师侧 / 学生侧独立 prompt）
- 教师侧上下文预算 60k / 学生侧 40k；单份摘要超 1.5k 会再压一次
- 摘要复用 `audit` purpose 的模型（廉价）

### 审计（跨会话合审）
- `prompts/audit_rules.md` 明令：只审书本身，不评价教师、不评价学生
- **5 段 `===TAG===` 协议**：VERDICT / CLARITY / HARD_SPOTS / INCONSISTENCY / SUGGESTIONS
- 支持一次审多个 session（`POST /api/audits { sids: [] }`）—— UI 里勾选合审
- 每一段的证据必须来自 transcript（用 `> ` 引用）
- 落盘 `data/audits/<aid>/{meta.json, report.md}` + 全局 `data/audits/history.jsonl`

### 进度保持
- transcript.jsonl / coach.jsonl / learner_coach.jsonl **append-only**
- meta.json 每轮末更新 `turnsSoFar`
- **重启修复**：`reconcileOnStartup()` 把 `status=running` 的僵尸会话改成 `aborted`（首次调用 `/api/session` 时触发）
- **续跑**：`POST /api/session { resumeSid }`——载入最后一次教练分析 + 从最后完整轮次接着跑；半截 teacher 消息（教师说完学生没接）会被丢弃
- **载入到对话栏**：历史抽屉的"载入"按钮把 transcript + 教练全放回观察页（只读），之后可以点"审计…"

### 书的导入
- `scripts/import-mineru.mjs`：把 MinerU 输出的 `full.md` 按 `## 导论 / ## 第X章 / ## 第X节` 切成 sections
- 删图片引用、删营销广告
- 目前入库：**example**（样例概率书 2 节）+ **makesi**（马原 10 节，约 11.5w 字）

## 关键参数速查

| 位置 | 常量 | 值 | 作用 |
|---|---|---|---|
| `pagination.ts` | `PAGINATION_THRESHOLD` | 12_000 | section 小于这个字符不分页 |
| `pagination.ts` | `TARGET_PAGE_CHARS` | 1_800 | 每页目标大小 |
| `pagination.ts` | `WINDOW_BUDGET_CHARS` | 8_000 | 教师窗口预算 |
| `pagination.ts` | `OVERLAP_PAGES_ON_SLIDE` | 2 | 滑窗时保留的重叠页数 |
| `session.ts` | `CONTEXT_KEEP_CHARS_TEACHER` | 60_000 | 教师对话上下文预算 |
| `session.ts` | `CONTEXT_KEEP_CHARS_LEARNER` | 40_000 | 学生对话上下文预算 |
| `session.ts` | `COMPRESS_TRIGGER_CHARS` | 12_000 | 待压缩内容超这个就摘要 |
| `session.ts` | `SUMMARY_MAX_CHARS` | 1_500 | 单份摘要上限（超再压） |
| `session.ts` (loop) | `PROGRESS_WINDOW / TRIGGER` | 4 / 2 | 4 轮内 2 次非 first_half 触发翻页 |
| `coach.ts` | `RECENT_TURNS_FOR_COACH` | 10 | 教练看最近 10 轮 |
| API | `maxTurns` 上限 | 200 | 前端下拉 3/6/12/30/80/120 |

## 目录

```
app/                              Next.js 15 app router
  page.tsx                        观察页（Client, 约 270 行；逻辑抽到 components/useSession.ts，UI 拆到 components/*）
  layout.tsx / globals.css
  api/
    books/route.ts                GET 书列表 + 字数
    books/[slug]/route.ts         GET 书详情 / ?section=<id>
    session/route.ts              POST 起会话 / resume, SSE
    sessions/route.ts             GET ?bookSlug=（可空）
    sessions/[sid]/route.ts       GET meta + turns + 双教练历史
    audits/route.ts               POST { sids: [] } SSE 审计
    audits/[aid]/route.ts         GET 单次审计

lib/
  llm.ts          唯一 callLLM(purpose, messages, opts)，purpose ∈ teacher/learner/audit/coach
                  含 jsonMode（response_format=json_object）
  book.ts         Book/Section 读取 + 字数统计 + 分页缓存 getPages()
  pagination.ts   paginate / initialWindow / slideWindow / renderWindow
  teacher.ts      buildTeacherSystemPrompt（返回 { systemPrompt, window }）
  learner.ts      buildLearnerSystemPrompt
  coach.ts        analyzeWithCoach + analyzeLearnerWithCoach + render*Block
  session.ts      runSession（async generator, 产 SessionEvent）
                  + maybeCompress + reconcileOnStartup + resume
  audit.ts        collectMaterial 跨 sid 组织素材 + 单次 LLM 出报告 + parseReport
  storage.ts      fs 小工具（原子写、追加行）

prompts/          （直接改这里就改了 LLM 行为，无需重启）
  teacher_rules.md
  learner_novice.md / _mid.md / _critic.md
  coach_rules.md            教师教练 JSON schema
  learner_coach_rules.md    学生教练 JSON schema
  audit_rules.md            审计 5 段协议

scripts/import-mineru.mjs   MinerU 输出 → sections/

data/
  books/<slug>/manifest.json + sections/<id>.md
                          + sections/<id>.pages.json    （.gitignored 缓存）
  sessions/<sid>/         （.gitignored）
    meta.json             （含 pacing / windowStartPage/endPage / teacherSummary / turnsSoFar）
    transcript.jsonl      append-only
    coach.jsonl / learner_coach.jsonl
  audits/<aid>/           （.gitignored）
    meta.json + report.md
  audits/history.jsonl    （.gitignored 全局索引）
```

## 已明确的技术约定

1. **单一 LLM 入口** `callLLM(purpose, messages, opts)`——`lib/llm.ts`。改 provider 只改这里。
2. **文件即记忆**：完全不用 RAG、不用向量库。
3. **拼接式 prompt**：段落间 `\n\n---\n\n`。教师 8 段 + 可选教练块 + 可选摘要 addendum。
4. **JSON 教练输出**：`response_format=json_object` + `stripFences()` 兜底剥围栏/`<think>`。教练解析失败就不注入，教学质量降级但不崩。
5. **半截 teacher 消息**：resume 时被丢弃后续跑；transcript.jsonl 里那条 append 记录仍在，**审计会看到**（V1 简化，未来可让 audit.ts 读 `meta.turnsSoFar` 只取有效范围）。
6. **教师主动结束是被禁止的**——课何时结束由 `maxTurns` 上层控制。
7. **审计只审书**——`audit_rules.md` 里明令不评价 agent、不许拿领域外知识补论证、每条批评要有 transcript 证据。

## 已知粗糙点（未来接手时可以看的锅）

按严重度排：

1. **`sessionDone` state 现在冗余**（`app/page.tsx`）——审计按钮改成看 `sid && !running` 之后，这个变量还在被 set 但没人读了。留着不动没坏事，但可以清一下。
2. **半截 teacher 消息污染 audit 素材**：审计会读到那条被主循环丢弃的 teacher 消息。想干净的话让 `audit.ts` 按 `meta.turnsSoFar` 截 transcript。
3. **教练 JSON 解析容忍度**：`stripFences()` 处理了围栏 + `<think>`。DeepSeek 一般稳；换其它模型可能要加更宽的解析（Socratopia `chunks/65705:f()` 那种 50 轮位置探测式补引号）。
4. **老 session resume 语境不匹配**：老 session 没有 `windowStartPage`；resume 时会给它初始化一个初始窗口。老对话讲的内容可能已经在窗口之后——教师会有一小段不自然。历史包袱，跑新会话没这个问题。
5. **翻页决策靠单条教练**：只看 `contentProgress`，且是主教练判断的（主教练本来是"看教学行为"的，判"内容进度"是搭车任务）。可能会误判、漏判。想更稳可以（a）加投票（连续 3 次），（b）另外派一个"内容进度教练"专职判。
6. **摘要 prompt 是英式硬编码在 `session.ts` 里**——不像其它 rules 走 `prompts/*.md`。想让摘要行为可调就得改代码。
7. ~~**没做 verbatim 引用校验**~~ ✅ **已解决**（2026-07-11）：`lib/citations.ts` 逐字比对教师 `〔§01｜XXX〕`，命中/未命中落 `citations.jsonl`，未命中片段在 ChatView 里红边 + ⚠️，命中率也注入 audit。
8. ~~**audit 只跑一次**~~ ✅ **已解决**（2026-07-11）：`lib/audit.ts` 加 `hasAllTags` + `MAX_ATTEMPTS=2`，首次 5 段 tag 不全就自动重跑一次。
9. ~~**成本无观测**~~ ✅ **已解决**（2026-07-11）：`lib/llm.ts` 走 `stream_options.include_usage` 拿 token 用量，`lib/pricing.ts` 按 `.env` 价格换算人民币，每轮落 `usage.jsonl` + SSE `usage` 事件，页面 footer 显示 `in/out/¥`。
10. **多进程并发**：现在假设单进程。如果哪天想跑一个 job runner 后台并发跑多 session，`SESSIONS_ROOT` 下的 `SELECT ... FOR UPDATE SKIP LOCKED` 那套要重新设计（当时被 Socratopia 逆向报告里的架构挑起过念头，V1 拍死了）。

## 下一步几个自然候选（按性价比排）

1. **教师引用 verbatim 校验**——投入很小（后端一个 `includes()` + 一段 prompt 惩罚），收益直接：审计里 INCONSISTENCY 段可以自动填。
2. **审计触发时按 `turnsSoFar` 截 transcript**——投入更小（audit.ts 一行修改），排除半截 teacher 污染。
3. **成本累计 UI**——底部 footer 加一个"本次会话已用 xxk 输入 / xxk 输出 tokens"。所有 provider 的 usage 字段都能从 SDK 拿。
4. **教练 v2 用投票 / 独立"内容进度教练"**——如果实测发现翻页决策不稳。
5. **审计对比模式**——现在合审多个 session 是拼在一起。可以加"对比模式"：novice vs critic 学同一节，你想看的是"哪些点在两种学生下都卡"。审计 prompt 里加一段。
6. **教师风格多样化**——目前只有一份 `teacher_rules.md`。可以加"耐心"/"严厉"/"跳跃"等档位，看不同风格教师暴露的书本问题会不会不同。
7. **端到端跑通一本书**——现在的黄金路径都是"跑一节看一节"。真做审书的话，需要一个 batch runner：每节 × 每种学生画像 × 每种教学节奏 = N 场 session，跑完 N × 3 × 3 场再合审出一份**书级审计报告**（新的 audit rules，比现在的 5 段更长）。这是最大的下一跳。

## 沟通与运行

- **中文优先，技术术语可英文**。
- **改 md 就是改行为**——`prompts/*.md` 是 LLM 直接读的 system prompt，编辑后不用重启（Node fs 每次读盘）。
- **改 lib/*.ts 要重启 dev server** —— Next dev 有 HMR 但 API routes 不总是热更（保险起见 Ctrl+C 再 `npx next dev`）。
- **不用 `pnpm dev`**——pnpm 严格模式会因为 sharp 的 build script 报错，用 `npx next dev` 绕过。
- **端口自动挪**：3000 被占就跳 3001/3002/…，看启动日志。

## 相关文档

- **`REVERSE-ENGINEERING-REPORT.md`** — Socratopia 71 KB 完整逆向；本项目所有 §X.Y 引用都指这里。
- **`AI-DRIVEN-DEVELOPMENT-INSIGHTS.md`** — 同体量项目怎么和 AI 协作的方法论，姊妹篇。
- **`CONVERSATION-CONTEXT.md`** — 旧的 Socratopia 逆向讨论快照（**与本项目无关**）。
- **`PLAN.md`** — 项目 V1 初始设计方案（历史文档，实际实现的能力比它多）。
- **`CLAUDE.md`** — 给 AI 助手用的项目指南（更简洁，指向具体实现）。

---

## 2026-07-11 完成的改进 · 5 项全部完成并提交

针对上文"下一步候选"里的 #1/#2/#3 + 一项拆分。**已全部完成并提交**（见文末"提交映射"）。

### 已完成（后端 + 前端全部到位）

| # | 内容 | 落点 | 状态 |
|---|---|---|---|
| ① | 成本累计（候选 #3）| `lib/pricing.ts`（新）+ `lib/llm.ts` 加 `LLMUsage`+`onUsage`+`stream_options.include_usage` + `lib/session.ts` 每轮 4 处 callLLM 挂 `recordUsage(purpose, turn)` + 追加 `data/sessions/<sid>/usage.jsonl` + `SessionEvent` 加 `usage` 事件 + resume 时读盘累计 + `lib/coach.ts` 两个 analyze 加 `onUsage` 参数 + `.env.example` 加价格变量 + `app/page.tsx` footer 显示 `in/out/¥` | ✅ done |
| ② | audit 按 `turnsSoFar` 截（第 154 行候选 #2）| `lib/audit.ts::loadTurns(sid, turnsSoFar)` 只保留成对的 teacher+learner 轮次；`collectMaterial` 传入 `m.turnsSoFar` | ✅ done |
| ③ | audit 失败重试（第 147 行遗漏）| `lib/audit.ts` 加 `hasAllTags(raw)`；`runAudit` 外层 `MAX_ATTEMPTS=2` 循环，首次 5 段 tag 不全就重跑并 yield 提示 chunk | ✅ done |
| ④ | verbatim 引用校验（候选 #1）| `lib/citations.ts`（新，含 `extractCitations` / `verifyCitation` / `verifyTurnCitations` / `aggregateCitations` / `normalizeForMatch`——规范化：全角→半角、去空白、小写化）+ `lib/session.ts` 教师 turn 结束后 verify 并追加 `data/sessions/<sid>/citations.jsonl` + `lib/audit.ts::SectionMaterial` 加 `citationRecords`，`buildAuditMessages` 注入"教师引用 X/Y 命中"+未命中片段列表 | ✅ done |
| ⑤ | `app/page.tsx` 拆组件 + 接入 usage/citations UI | `components/`：`types.ts`（共享类型+`SessionEvent.usage`+`CitationLookup`+`CITE_RE`+`SECTION_LABELS`+`LEARNERS`+`PACINGS`）· `Field.tsx` · `Modal.tsx` · `ChatView.tsx`（forwardRef，miss chip 红边+⚠️）· `CoachSidebar.tsx` · `HistoryDrawer.tsx` · `AuditPanel.tsx` · `Controls.tsx` · `useSession.ts`（整套会话逻辑抽成 hook）。`app/page.tsx` 已从 1538 行内联版重写为约 270 行，全部从组件引入，接入 `usage`/`citations` state + footer 显示 | ✅ done |
| — | API 暴露 | `app/api/sessions/[sid]/route.ts` GET 加返回 `usage / usageSummary / citations` | ✅ done |

`npx tsc --noEmit` 全程无输出通过（本会话用 `node_modules/.bin/tsc --noEmit --incremental false` 复核，exit 0）。

### 落到候选清单里

- [x] 候选 #1（verbatim 引用校验）→ ④
- [x] 候选 #2（按 turnsSoFar 截 transcript）→ ②
- [x] 候选 #3（成本累计 UI，含 footer）→ ①
- [x] 已知粗糙 #8（audit 失败重试）→ ③
- [x] 新增：`app/page.tsx` 拆组件 + usage/citations UI → ⑤
- [ ] 候选 #4/#5/#6/#7 未动

### 提交映射（2026-07-11）

这批改动切成了 5 个 commit：

1. `chore: gitignore 忽略 .claude/ 和 .omo/ 本地状态`
2. `feat: 成本累计 + verbatim 引用校验 + audit 截断与失败重试`（① ② ③ ④ + `route.ts` 暴露）
3. `refactor: app/page.tsx 从内联版拆成组件`（⑤：`components/`、`lib/sse.ts`、`app/page.tsx`）
4. `chore: .env.example 补 LLM 价格变量`
5. `docs: STATUS.md 更新到与工作区一致`（本次）

### 待验证（尚未在本会话实跑，留给下个会话）

- **短会话（3 轮）**：`data/sessions/<sid>/usage.jsonl` 每轮 4 条（teacher/learner/teacherCoach/learnerCoach）、`citations.jsonl` 有教师引用、footer 显示 token 与 ¥、ChatView miss chip 红边+⚠️。
- **audit 回归**：对一个 `status=aborted` 的旧 session 跑 audit，确认教师素材不出现半截未完成轮次。
