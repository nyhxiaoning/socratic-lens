# CLAUDE.md

给 Claude Code 用的项目指南。

## 这是什么

一个 Socratopia 风格的"教-学-审"多 agent 试验台，用来审计用户自己写的书。

- **教师 agent**：拿到一本书的某一节的原文，扮演苏格拉底式老师给学生讲。
- **学生 agent**：**看不到原文**，只从老师的话里学；三种画像（`novice` / `mid` / `critic`）轮询。
- **教师教练 TAE**（§3.4）：每轮末尾后台跑一次 JSON 分析，注入下一轮教师 system prompt。默认开。
- **学生教练**：结构镜像教师教练，判断学生"是不是真懂 / 有没有用预训练作弊 / 画像有没有漂"，注入下一轮学生 system prompt。默认开。
- **审计 agent**：会话结束后手动触发。**支持跨多个 session 合审**——比如同一节跑了三种学生画像 → 合审看差异；同一章三节各跑一次 → 合审看整章讲得清不清。按 `===TAG===` 5 段协议出**对书本身的诊断**（VERDICT / CLARITY / HARD_SPOTS / INCONSISTENCY / SUGGESTIONS）。落盘到 `data/audits/<aid>/report.md`。

**长会话支持**：轮数最高 120。每轮结束时若"未压缩对话"超过阈值（~12k 字符）就把老对话压成 lesson_summary 存到 meta 里，教师侧 60k 字符预算、学生侧 40k。参考 §10.2。

**自适应翻页**（§5.4）：如果一节原文 > 12k 字符，会切成 ~2k 字符/页；教师初始只看头 3-4 页（约 8k 字符窗口）；每轮教练判断 `contentProgress`（first_half / second_half / done），连续 2 次非 first_half 就自动翻页（保留 2 页重叠 + 追加新页至预算，末页守恒）。`data/sessions/<sid>/meta.json` 里 `windowStartPage/endPage` 全程可 resume。

**进度保持**：所有状态每轮末落盘（transcript.jsonl append-only、coach.jsonl / learner_coach.jsonl、meta.json）。软件重启：`/api/session` 首次调用时跑 `reconcileOnStartup()`，把状态残留为 `running` 的老会话改成 `aborted`。观察页"历史"抽屉可以列出所有会话、查看 transcript、对未完成的会话点"继续"从最后一个完整轮次续跑。

两 agent **独立上下文**：教师视角里学生说的话是 `user`，学生视角里教师说的话是 `user`——参考 `REVERSE-ENGINEERING-REPORT.md` §3.1。

一个 SSE 观察页 (`app/page.tsx`) 实时看两 agent 对话。

## 技术栈

- Next.js 15 app router + React 19 + TypeScript
- OpenAI 兼容 SDK（走 `LLM_BASE_URL` 环境变量，不绑定 provider）
- 无数据库；书 / 会话 / prompt 都是文件

## 目录

```
app/
  page.tsx                          观察页（Client Component）
  layout.tsx / globals.css
  api/books/route.ts                GET 书列表（含总字数、每节字数）
  api/books/[slug]/route.ts         GET 书详情 / GET ?section=<id> 取一节
  api/session/route.ts              POST 起会话，SSE 返回事件流
  api/sessions/route.ts             GET ?bookSlug=xxx 列该书所有会话
  api/sessions/[sid]/route.ts       GET 单条会话 meta + transcript
  api/audits/route.ts               POST { sids: [] } 跨会话跑审计（SSE）
  api/audits/[aid]/route.ts         GET 单次审计的 meta + 报告

lib/
  llm.ts       唯一 callLLM(purpose, messages, opts) 入口（含 jsonMode）
  book.ts      Book/Section 读取 + 每节字数统计 + 分页缓存
  pagination.ts 分页与滑窗算法（Socratopia §5.4 xC 简版）
  teacher.ts   教师 system prompt 组装（含 pacing + 教练分析注入 + 分页窗口）
  learner.ts   学生 system prompt 组装（含学生教练分析注入）
  coach.ts     教师教练 + 学生教练：analyze* / render*Block
  session.ts   会话循环 + 滑动摘要 + 双教练并行 + 自适应翻页 + resume + reconcile
  audit.ts     跨 sids 收集素材 + 一次 LLM 出报告 + ===TAG=== 解析 + 落盘
  storage.ts   fs 小工具（原子写、追加行、目录初始化）

prompts/
  teacher_rules.md
  learner_novice.md / learner_mid.md / learner_critic.md
  coach_rules.md              教师教练 JSON schema
  learner_coach_rules.md      学生教练 JSON schema
  audit_rules.md

scripts/
  import-mineru.mjs                 把 MinerU 输出的 full.md 按"节"切分导入

data/
  books/<slug>/manifest.json + sections/<id>.md
  sessions/<sid>/
    meta.json                       (含 pacing / turnsSoFar / teacherSummary 等)
    transcript.jsonl                (一行一 turn, append-only)
    coach.jsonl                     (教师教练每轮 JSON)
    learner_coach.jsonl             (学生教练每轮 JSON)
                                                             （data/sessions .gitignored）
  audits/<aid>/meta.json + report.md                         （.gitignored）
  audits/history.jsonl                                       （.gitignored 全局审计索引）
```

只有 `data/books/example/` 提交入库，其它 slug 在 `.gitignore` 里。

## 关键设计原则

1. **唯一 LLM 入口 `callLLM(purpose, messages, opts)`**（`lib/llm.ts`）——所有 provider 切换、日志、限流都改这一个函数。参考 Socratopia 逆向报告 §2.1。
2. **独立上下文**：教师和学生**各维护 messages 数组**，绝不共享。构造方向相反：教师 messages 里 `learner→user`，学生 messages 里 `teacher→user`。
3. **文件即记忆**（§10.1）：书、rules、画像都是 md 文件，system prompt 组装时整份读入。不引 RAG、不引向量库。
4. **拼接式 prompt**：段落间用 `\n\n---\n\n` 分隔（§10.1）。教师 8 段，学生 5 段。
5. **本节原文只喂教师**：学生看不到——学生的困惑就是这本书的困惑。这是"用 agent 审书"的核心。
6. **引用协议 `〔§<id>｜前若干字〕`**：仅从 §3.1 里保留这一条结构化约束。V1 不做服务端 verbatim 校验，靠 prompt 铁律 + 人工审阅；V2 补 manifest 校验（§10.2）。
7. **transcript.jsonl 一行一 turn**：`{turn, actor, text, ts}`。V2 审计 agent 直接吃这个文件。

## 常用命令

```bash
# 首次
pnpm install                # 或 npm install
cp .env.example .env.local  # 填 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL

# 开发
pnpm dev                    # http://localhost:3000

# 构建
pnpm build && pnpm start
```

## 加一本书

**从 MinerU 输出导入**（PDF → markdown 已经被 MinerU 处理过）：
```bash
node scripts/import-mineru.mjs <full.md 路径> <slug> [title] [author]
```
按 `## 导论` / `## 第X章` / `## 第X节` 边界切分成 sections，删掉图片引用和营销广告。

**手动加书**：
1. 在 `data/books/<你的-slug>/` 下建目录（`.gitignore` 默认只提交 `example` 和 `makesi`，其它 slug 在本地跑就好）
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

消息回滚 · 长期学生画像演化 · verbatim 引用校验 · 多用户 · PDF/EPUB 导入 · 教师改书。

## 沟通风格（沿用旧约定）

- **中文优先**，技术术语可英文。
- "记录下来 / 写在盘上"意思是**写文件**。
- 不啰嗦。不知道就说不知道。改动仓库任何现有文件前先确认。

## 相关文档

- `PLAN.md` — 本项目 V1 完整设计方案（跟这份 CLAUDE.md 对齐）
- `REVERSE-ENGINEERING-REPORT.md` — Socratopia 71 KB 逆向报告，本项目所有"借鉴自 Socratopia"的模式都来自这里
- `AI-DRIVEN-DEVELOPMENT-INSIGHTS.md` — 方法论姊妹篇
- `CONVERSATION-CONTEXT.md` — 旧的 Socratopia 逆向讨论快照（**与本项目无关**）
