# CLAUDE.md

给 Claude Code 用的项目指南。

## 这是什么

一个 Socratopia 风格的"教-学-审"多 agent 试验台，用来审计用户自己写的书。

- **教师 agent**：拿到一本书的某一节的原文，扮演苏格拉底式老师给学生讲。
- **学生 agent**：**看不到原文**，只从老师的话里学；三种画像（`passive` / `moderate` / `active`）按积极程度划分。
- **教师教练 TAE**（§3.4）：每轮末尾后台跑一次 JSON 分析，注入下一轮教师 system prompt。默认开。
- **学生教练**：结构镜像教师教练，判断学生"是不是真懂 / 有没有用预训练作弊 / 画像有没有漂"，注入下一轮学生 system prompt。默认开。
- **审计 agent**：会话结束后手动触发。**支持跨多个 session 合审**——比如同一节跑了三种学生画像 → 合审看差异；同一章三节各跑一次 → 合审看整章讲得清不清。**四个维度**（`POST /api/audits { sids, dimension }`）：
  - `book`（审书本身，默认）：5 段 `===TAG===` 协议 VERDICT / CLARITY / HARD_SPOTS / INCONSISTENCY / SUGGESTIONS。规则 `prompts/audit_rules.md`。
  - `teacher`（审教师教学质量）：VERDICT / METHOD / PERSONA_FIT / RULE_VIOLATIONS / RULE_SUGGESTIONS。规则 `prompts/audit_teacher_rules.md`。
  - `fidelity`（保真度，审合成节 vs 源材料）：清单抽提 → 逐条勾稽 → 覆盖率报告。规则 `prompts/fidelity_extract.md` + `prompts/fidelity_reconcile.md`。
  - `coverage`（教学覆盖度，审对话 vs 书本/源材料）：清单缓存 → 逐条勾稽 transcript → 覆盖率报告，支持 pacing 感知判据。规则 `prompts/coverage_reconcile.md`。
  - 落盘 `data/audits/<aid>/report.md` + `report.json` + `checklist.json` + meta（含 `dimension`）；全局索引 `data/audits/history.jsonl`。

**长会话支持**：轮数最高 200。可选「直到本节结束」——讲完自动停。每轮结束时若"未压缩对话"超过阈值（~12k 字符）就把老对话压成 lesson_summary 存到 meta 里，教师侧 60k 字符预算、学生侧 40k。参考 §10.2。

**自适应翻页**（§5.4）：如果一节原文 > 12k 字符，会切成 ~2k 字符/页；教师初始只看头 3-4 页（约 8k 字符窗口）；每轮教练判断 `contentProgress`（first_half / second_half / done），连续 2 次非 first_half 就自动翻页（保留 2 页重叠 + 追加新页至预算，末页守恒）。`data/sessions/<sid>/meta.json` 里 `windowStartPage/endPage` 全程可 resume。

**进度保持**：所有状态每轮末落盘（transcript.jsonl append-only、coach.jsonl / learner_coach.jsonl、meta.json）。软件重启：`/api/session` 首次调用时跑 `reconcileOnStartup()`，把状态残留为 `running` 的老会话改成 `aborted`。观察页"历史"抽屉可以列出所有会话、查看 transcript、对未完成的会话点"继续"从最后一个完整轮次续跑。观察页 footer 的**「继续对话」**按钮对已停止/已到轮次（done）的会话再跑 N 轮（done 会话只要新轮数上限 > 已跑轮数即可续）。

**教师首句强制**：教师流式输出若为空串（LLM 偶发，尤其首轮），最多重试 3 次；仍空就中止本轮并报错 `status=errored`——**绝不放行到学生侧**，杜绝"教师没说话学生抢答"。

**批量矩阵生成**：顶栏「批量·矩阵」开关。开启后学生/节奏变多选，同一节 × 多画像 × 多节奏**串行**逐个跑（每个仍实时流进对话区），顶部进度条显示各组合状态。跑完自动把这批 sid 预勾选进审计选择器，直接送审得"单节多组合统一报告"。扩到全书时再加分层 map-reduce（未做）。

**网页上传书**：顶栏「上传书…」→ 上传/粘贴整本 md，按 `## 导论 / 第X章 / 第X节` 自动切节，入库前实时预览切节结果。解析逻辑在 `lib/parse-book.ts`（纯函数、无 node 依赖，前端预览与后端落盘共用）。slug 撞车拒绝、不覆盖已有书。

两 agent **独立上下文**：教师视角里学生说的话是 `user`，学生视角里教师说的话是 `user`——参考 `REVERSE-ENGINEERING-REPORT.md` §3.1。

一个 SSE 观察页 (`app/page.tsx`) 实时看两 agent 对话。

## 技术栈

- Next.js 15 app router + React 19 + TypeScript
- OpenAI 兼容 SDK（走 `LLM_BASE_URL` 环境变量，不绑定 provider）
- 无数据库；书 / 会话 / prompt 都是文件

## 目录

```
app/
  page.tsx                          观察页（Client Component，逻辑抽到 components/useSession.ts）
  layout.tsx / globals.css
  api/books/route.ts                GET 书列表（含总字数、每节字数）/ POST 上传整本 md 自动切节入库
  api/books/[slug]/route.ts         GET 书详情 / GET ?section=<id> 取一节
  api/session/route.ts              POST 起会话 / resume，SSE 返回事件流
  api/sessions/route.ts             GET ?bookSlug=xxx 列该书所有会话
  api/sessions/[sid]/route.ts       GET 单条会话 meta + transcript + 双教练 + usage + citations
  api/audits/route.ts               POST { sids, dimension } 跨会话跑审计（SSE）/ GET ?bookSlug 审计历史
  api/audits/[aid]/route.ts         GET 单次审计的 meta + 报告

lib/
  llm.ts       唯一 callLLM / callLLMWithTool 入口（含 jsonMode / tool calling / usage 回调 / DeepSeek thinking 关闭）
  pricing.ts   按 .env 价格把 token 用量换算人民币
  book.ts      Book/Section 读取 + 每节字数统计 + 分页缓存
  parse-book.ts 纯函数：整本 md 按节切分（前端预览 + 后端落盘共用，无 node 依赖）
  import-book.ts 落盘一本书（manifest + sections）+ slug 占用检查
  pagination.ts 分页与滑窗算法（Socratopia §5.4 xC 简版）
  citations.ts verbatim 引用逐字校验 + 命中率聚合
  teacher.ts   教师 system prompt 组装（含 pacing + 教练分析注入 + 分页窗口）
  learner.ts   学生 system prompt 组装（含学生教练分析注入）
  coach.ts     教师教练 + 学生教练：analyze* / render*Block
  session.ts   会话循环 + 教师首句强制 + 滑动摘要 + 双教练并行 + 自适应翻页 + auto-stop + resume + reconcile
  audit.ts     book/teacher/fidelity/coverage 四维度审计 + 落盘 + 历史
  fidelity.ts  Checklist 抽提 + 勾稽 reconciliation（纯文本/tool calling 双路径）+ 覆盖率计算
  coverage.ts  教学覆盖度勾稽 reconcileAgainstTranscript（对接 coverage_reconcile.md）
  coverage-tracker.ts 实时覆盖度追踪（教师引用 vs 清单 sourceQuote，零 LLM 成本）
  checklist.ts 知识点清单缓存读写（data/checklists/）
  storage.ts   fs 小工具（原子写、追加行、目录初始化）
  sse.ts       前端 readSse：逐帧 JSON.parse SSE 响应

components/    page.tsx 拆出的 UI + useSession hook
  useSession.ts（整套会话/批量/审计/覆盖度状态与副作用）· types.ts（共享类型）
  Controls.tsx · ChatView.tsx · CoachSidebar.tsx · CoverageSidebar.tsx
  AuditPanel.tsx · HistoryDrawer.tsx · UploadBook.tsx · Modal.tsx · Field.tsx

prompts/
  teacher_rules.md
  learner_passive.md / learner_moderate.md / learner_active.md（按积极程度分档）
  coach_rules.md              教师教练 JSON schema
  learner_coach_rules.md      学生教练 JSON schema
  audit_rules.md              审书维度（5 段 + 问题层级 + 三级严重度）
  audit_teacher_rules.md      审教师教学质量维度（5 段）
  fidelity_extract.md         保真度/覆盖度：从源材料抽知识点清单
  fidelity_reconcile.md       保真度：清单 vs 合成节 逐条勾稽
  coverage_reconcile.md       覆盖度：清单 vs 教学对话 逐条勾稽（含 pacing 感知判据）

scripts/
  import-mineru.mjs           把 MinerU 输出的 full.md 按"节"切分导入（命令行版，网页上传是它的 UI 化）
  fidelity-audit.mts          Fidelity 审计 CLI 薄壳

data/
  books/<slug>/manifest.json + sections/<id>.md（+ <id>.pages.json 分页缓存，.gitignored）
  sessions/<sid>/
    meta.json                       (含 pacing / turnsSoFar / windowStartPage-endPage / teacherSummary 等)
    transcript.jsonl                (一行一 turn, append-only)
    coach.jsonl / learner_coach.jsonl（每轮教练 JSON）
    usage.jsonl                     (每轮各 callLLM 的 token 用量与成本)
    citations.jsonl                 (教师每轮引用的 verbatim 校验结果)
                                                             （data/sessions .gitignored）
  audits/<aid>/meta.json + report.md + report.json + checklist.json （.gitignored）
  audits/history.jsonl                                       （.gitignored 全局审计索引，含 dimension）
  checklists/<slug>/<sectionId>.json                          （.gitignored 知识点清单缓存）
  fidelity/<fid>/...                                         （.gitignored 保真度审计结果）

_dev/           内部开发文档（设计笔记、测试、其他书、旧 prompt、Git 工作流备忘）
```

只有 `data/books/example/` 提交入库，其它 slug 在 `.gitignore` 里。

## 关键设计原则

1. **唯一 LLM 入口 `callLLM(purpose, messages, opts)`**（`lib/llm.ts`）——所有 provider 切换、日志、限流都改这一个函数。参考 Socratopia 逆向报告 §2.1。
2. **独立上下文**：教师和学生**各维护 messages 数组**，绝不共享。构造方向相反：教师 messages 里 `learner→user`，学生 messages 里 `teacher→user`。
3. **文件即记忆**（§10.1）：书、rules、画像都是 md 文件，system prompt 组装时整份读入。不引 RAG、不引向量库。
4. **拼接式 prompt**：段落间用 `\n\n---\n\n` 分隔（§10.1）。教师 8 段，学生 5 段。
5. **本节原文只喂教师**：学生看不到。学生的提问逼出教师回答的覆盖缺口——漏洞是真的，与困惑真假无关。
6. **引用协议 `〔§<id>｜前若干字〕`**：仅从 §3.1 里保留这一条结构化约束。服务端做 verbatim 逐字校验（`lib/citations.ts`）：教师每轮引用比对本节原文，命中/未命中落 `citations.jsonl`，未命中在 ChatView 里红边 + ⚠️，命中率注入 audit 的 INCONSISTENCY 段。
7. **transcript.jsonl 一行一 turn**：`{turn, actor, text, ts}`。V2 审计 agent 直接吃这个文件。

## 常用命令

```bash
# 首次
npm install
cp .env.example .env.local  # 填 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL（+ 可选 LLM_MODEL_<PURPOSE> 分模型 + 价格变量）

# 开发（不用 pnpm dev——pnpm 严格模式会因 sharp 的 build script 报错）
npx next dev               # http://localhost:3000，端口被占自动跳 3001/3002…

# 构建
npx next build && npx next start
```

## 加一本书

**网页上传（最省事，推荐）**：观察页顶栏「上传书…」→ 选 `.md` 文件或粘贴整本 markdown → 填 slug（书名/作者选填）→ 看切节预览确认边界 → 导入。按 `## 导论 / 第X章 / 第X节` 切，slug 撞车会拒绝、不覆盖已有书。

**从 MinerU 输出导入**（命令行，PDF → markdown 已被 MinerU 处理过）：
```bash
node scripts/import-mineru.mjs <full.md 路径> <slug> [title] [author]
```
按 `## 导论` / `## 第X章` / `## 第X节` 边界切分成 sections，删掉图片引用和营销广告。（网页上传就是这个脚本的 UI 化，切节逻辑同源于 `lib/parse-book.ts`。）

**手动加书**：
1. 在 `data/books/<你的-slug>/` 下建目录（`.gitignore` 默认只提交 `example`，其它 slug 在本地跑就好）
2. 写 `manifest.json`：
   ```json
   {
     "title": "...",
     "author": "...",
     "sections": [{ "id": "01", "title": "..." }]
   }
   ```
3. 写 `sections/<id>.md`——一节一文件，纯 markdown。

## V1 明确不做

消息回滚 · 长期学生画像演化 · 多用户 · PDF/EPUB 直接导入（要先转 markdown）· 教师改书 · 全书级 map-reduce 汇总。

## 沟通风格（沿用旧约定）

- **中文优先**，技术术语可英文。
- "记录下来 / 写在盘上"意思是**写文件**。
- 不啰嗦。不知道就说不知道。改动仓库任何现有文件前先确认。

## 相关文档

- `_dev/PLAN.md` — 本项目 V1 完整设计方案（跟这份 CLAUDE.md 对齐）
- `_dev/REVERSE-ENGINEERING-REPORT.md` — Socratopia 71 KB 逆向报告
- `_dev/AI-DRIVEN-DEVELOPMENT-INSIGHTS.md` — 方法论姊妹篇
- `_dev/GIT-WORKFLOW.md` — Git 双分支工作流备忘
