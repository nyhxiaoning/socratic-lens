# Plan：Socratopia 同款 · 教-学-审 三 agent（V1 只做教-学 + 观察页）

## Context

用户在写一本书，想验证书本身是否讲得清、讲得对。手段是造一个 Socratopia 风格的多 agent 系统：**教师 agent** 拿这本书当教材向 **学生 agent** 讲课，两 agent 各自独立上下文；对话全程记录，将来交给 **审计 agent** 出报告。用户要看一个简单的实时观察页。

当前仓库无代码，只有 Socratopia 逆向报告等 4 份 md。刚删掉 `REPORT-ANALYSIS-TECH-SPEC.md`（原来的月报分析规划，已在别处备份）——CLAUDE.md 里所有"月报分析"相关内容需要一并重写。

V1 明确排除：审计 agent、批量跑章节、中断续跑/回滚、女娲式改书。审计 V2 再做，但 V1 要留好接口（transcript 完整落盘）。

已确定的决策：
- **书的格式**：Markdown，一章一节结构
- **教学法**：先照抄一版 Socratopia 风格骨架 rules，之后迭代
- **学生档位**：三种预置（新手 / 中级 / 挑刺型）轮询
- **LLM**：OpenAI 兼容端点，环境变量配
- **代码位置**：当前目录 `S:\Code\工作探索\月报分析\` 下建代码

## 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│  Next.js (app router)  —  唯一进程                            │
│                                                              │
│  app/                                                        │
│    page.tsx              ← 观察页（选书/选学生/开始/看流）     │
│    api/session/route.ts  ← POST 起会话（SSE 流）              │
│    api/books/route.ts    ← GET 书列表 / GET 单本               │
│    api/sessions/route.ts ← GET 历史列表 / GET 单条 transcript │
│                                                              │
│  lib/                                                        │
│    llm.ts        ← callLLM(purpose, messages, opts) 唯一入口 │
│    book.ts       ← Book 抽象：list/get/getSection/manifest   │
│    teacher.ts    ← buildTeacherSystemPrompt + 一轮教师回复    │
│    learner.ts    ← buildLearnerSystemPrompt + 一轮学生回复    │
│    session.ts    ← 会话状态机 + transcript 落盘 + SSE 广播    │
│    storage.ts    ← 文件系统读写小工具（原子写、目录初始化）    │
│                                                              │
│  prompts/                                                    │
│    teacher_rules.md      ← 教学 rules（Socratopia 骨架，中文）│
│    learner_novice.md     ← 学生画像 · 新手                    │
│    learner_mid.md        ← 学生画像 · 中级                    │
│    learner_critic.md     ← 学生画像 · 挑刺型                  │
│                                                              │
│  data/                   ← 运行时数据（.gitignore）           │
│    books/<slug>/         ← 用户的书                           │
│      manifest.json       ← {title, author, sections:[...]}   │
│      sections/<id>.md    ← 一节一文件                         │
│    sessions/<sid>/                                           │
│      meta.json           ← {bookSlug, sectionId, learnerId,  │
│                            startedAt, status}                │
│      transcript.jsonl    ← 每轮一行 {turn, actor, text, ts}  │
│                                                              │
│  .env.local              ← LLM_BASE_URL / LLM_API_KEY /      │
│                            LLM_MODEL (+ 可选 _TEACHER 等)     │
└─────────────────────────────────────────────────────────────┘
```

## 关键设计（从 Socratopia 借鉴哪几条）

参照 `REVERSE-ENGINEERING-REPORT.md`：

1. **§2.1 唯一 LLM 入口 `callLLM`**：一个函数掌控所有 provider/model/purpose/logging。V1 只走 OpenAI 兼容 `/chat/completions`（stream/非 stream 都支持）。`purpose` 用于日志与将来按用途切模型（teacher/learner/audit）。

2. **§3.1 独立上下文**：教师和学生**各自维护 messages 数组**，绝不共享。教师上下文里学生说的话是 `user` 角色，反过来教师说的话在学生上下文里也是 `user` 角色——这是 Socratopia npc 与 pet 分别独立的核心。

3. **§10.1 文件即记忆**：书、学生画像、教学 rules 全是 md 文件，每次组装 system prompt 时整份读入。不引入向量库、不做 embedding。

4. **§10.1 拼接式 prompt 组装**：教师 system = `[远程规则占位, 学生画像摘要, 书 · 本节内容, 教学节奏提醒, 引用协议]` 用 `\n\n---\n\n` 分隔；学生 system = `[学生画像正文, 你正在被教什么书的哪一节, 提问本能规则, 禁用清单]`。

5. **§10.3 结构化输出**：V1 不需要——教师和学生都输出**自由 markdown**。**只保留一条 §3.1 的引用协议**：教师引用书本原文用 `〔§节id｜前 10 字〕`，让观察页高亮就够了。审计 V2 再加分隔符协议。

6. **§10.2 上下文压缩**：V1 不做。会话短（几轮就打住），保留最近 20 条消息够用。超过用 `[...]` 截断单条尾巴。

7. **manifest 反幻觉（§10.2）**：本节课本节文本原文列成 system prompt 的独立段落，教师被明令"引用只能来自本段文本，逐字引"。服务端不做 verbatim 校验（V1 简化），审计 V2 补上。

## 教师 System Prompt 组装（`lib/teacher.ts`）

按 §3.1 的骨架，简化到 8 段，`\n\n---\n\n` 分隔：

1. **教学规则**（读 `prompts/teacher_rules.md`）
2. **你的学生**（读 `prompts/learner_<档位>.md` 的摘要块，200 字左右）
3. **当前教材**（书标题 + 作者 + 本节标题）
4. **本节原文**（读 `data/books/<slug>/sections/<id>.md`，含 `--- 第 §<id> 部分 ---` 分隔标记以便被引用）
5. **教材库**（其余节的标题清单，只给标题，不给内容——防溢出）
6. **教学节奏**（V1 固定"normal"：每次讲一个点，问一个问题）
7. **引用格式**：`〔§<节id>｜前 10 字〕`，且只能引本节原文里存在的文字
8. **铁律**：每条消息以问题结尾 / 讲错要接受纠正 / 不许假装读了别的章节

## 学生 System Prompt 组装（`lib/learner.ts`）

按 §4.1 pet 三层知识建模的思想，V1 简化：

1. **画像正文**（读 `prompts/learner_<档位>.md` 全文）
2. **你正在被教什么**（书标题 + 本节标题，**不给正文** —— 学生看不到原书才能真正暴露教师讲得清不清）
3. **五种提问本能**（照抄 §4.1 pet 的：为什么链 / 边界试探 / 求打比方 / 联想串线 / 复述验证）
4. **禁用清单**：不许说"根据我预训练的知识…"、不许自曝是 AI、不许写神态动作（`*...*` 括号方括号一律禁）
5. **档位强度**：新手多问"为什么/能不能举个例子"；中级会尝试复述；挑刺型主动找边界与反例

学生 messages 是**反转的**：教师说的话在学生 context 里是 `user` role，学生说的话是 `assistant`。反过来一样。

## 会话循环（`lib/session.ts`）

单线程串行，教师先发第一句"开场":

```
POST /api/session { bookSlug, sectionId, learnerId, maxTurns=8 }
   ├─ 生成 sid = <ts>-<rand>
   ├─ mkdir data/sessions/<sid>/ ; 写 meta.json
   ├─ 返回 SSE 流：
   │    for turn in 1..maxTurns:
   │       teacherMsg = await callLLM("teacher", teacherMessages, {stream:true})
   │         → SSE: {type:"chunk", actor:"teacher", text}
   │         → 完整消息追加到 teacherMessages 与 learnerMessages（角色互反）
   │         → transcript.jsonl 追加一行
   │       SSE: {type:"turn_end", actor:"teacher"}
   │       learnerMsg = await callLLM("learner", learnerMessages, {stream:true})
   │         → 同上
   │       SSE: {type:"turn_end", actor:"learner"}
   │    SSE: {type:"done", sid}
   └─ 若前端断开：把上下文丢弃，transcript 保留到当时那一步（V1 不做断点续跑）
```

用户可以在观察页点"停止"——前端 `AbortController` 中止 fetch，服务端 SSE 生成器捕获 close，`status="aborted"` 写回 meta.json。

## 观察页（`app/page.tsx`）

一个 Client Component 就够：

- 顶部：选书下拉（读 `/api/books`）、选节（读书 manifest）、选学生档位（新手/中级/挑刺型）、"开始"按钮、"停止"按钮
- 中部：两栏气泡对话（左教师、右学生），流式渲染，`〔§...｜...〕` 引用标记渲染成可点 chip（V1 点击弹 Modal 显示该节原文）
- 底部：turn 计数、当前 sid、"打开 transcript.jsonl"按钮（走 `/api/sessions/<sid>`）

V1 不做：历史会话列表页、diff 视图、审计触发按钮。历史通过文件系统直接看。

## Prompt 文件初版内容（要在实现阶段现写）

**`prompts/teacher_rules.md`**（照 §3.1 主对话规则骨架的中文精简版，约 60 行）：
- 身份：耐心的苏格拉底式老师，只讲用户给你的这本书
- 只讲原文有的内容，不许拓展别的书别的领域
- 每条消息以问题结尾
- 每次至多讲一个点
- 学生犯错时先问"你是怎么想到这里的"再纠正
- 引用格式 `〔§...｜...〕`
- 禁用清单：AI 式积极表扬 / "太棒了" / emoji / 动作神态描写

**`prompts/learner_novice.md`**、**`_mid.md`**、**`_critic.md`**：各 30-50 行的画像。三档在"预备知识水平"、"提问倾向"、"是否复述"、"是否找反例"四维上拉差异。

**内容我在实现阶段写第一版，用户先审阅内容再上线。**

## LLM 入口 (`lib/llm.ts`)

单函数签名：
```ts
callLLM(
  purpose: "teacher" | "learner" | "audit",
  messages: {role, content}[],
  opts?: { stream?: boolean; maxTokens?: number; temperature?: number }
): AsyncIterable<string>  // stream=true 时；false 时返回 Promise<string>
```

- 读 `process.env.LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`；可选 `LLM_MODEL_TEACHER` 等覆盖
- 用官方 `openai` SDK（OpenAI 兼容端点通用）
- 日志：`console.log` 一行 JSON `{purpose, model, msgCount, inputChars, outputChars, ms}`
- 错误：抛出，让 `/api/session` 转成 SSE `{type:"error", message}`

## 目录/文件清单（要创建）

```
package.json                      新
tsconfig.json                     新
next.config.mjs                   新
.env.example                      新（LLM_BASE_URL 等注释说明）
.gitignore                        新（node_modules, .next, data/, .env.local）
CLAUDE.md                         重写（删月报，改成本项目）
app/page.tsx                      新
app/layout.tsx                    新
app/api/session/route.ts          新
app/api/books/route.ts            新
app/api/books/[slug]/route.ts     新
app/api/sessions/[sid]/route.ts   新
lib/llm.ts                        新
lib/book.ts                       新
lib/teacher.ts                    新
lib/learner.ts                    新
lib/session.ts                    新
lib/storage.ts                    新
prompts/teacher_rules.md          新
prompts/learner_novice.md         新
prompts/learner_mid.md            新
prompts/learner_critic.md         新
data/books/example/manifest.json  新（一份最小样例书，方便跑通）
data/books/example/sections/01.md 新
data/books/example/sections/02.md 新
```

## 依赖

- `next@^15`
- `react@^19`
- `typescript` / `@types/*`
- `openai@^4`（作为 OpenAI 兼容 SDK 用）
- 前端流式渲染不用额外库，用原生 `fetch` + `ReadableStream`

## 验证（跑通标准）

1. `pnpm install` → `pnpm dev` → 打开 `http://localhost:3000`
2. 观察页能看到样例书 `example` 和两节
3. 选"新手学生"，选第 01 节，点开始
4. 教师和学生各自流式说话，教师消息里出现 `〔§01｜...〕` 且点击能看到原文
5. `data/sessions/<sid>/transcript.jsonl` 存在且行数 = 教师轮数 + 学生轮数
6. 中途点"停止"：不再产生新消息，meta.json 里 `status="aborted"`
7. 换成"挑刺型学生"重跑同一节：对话明显更爱找反例、更爱质疑（观察差异，不做自动断言）
8. **手工审阅**：教师是否只引用了本节存在的原文；学生是否泄露"你其实是本书的作者在测我"这类越界

审计 agent（V2）留的接口：`transcript.jsonl` 已含 `{turn, actor, text, ts}`，再加读 `data/sessions/<sid>/meta.json` 得书/节/画像三元组，就能起一次审计 LLM 调用。

## 明确不做（V1 边界）

- 审计 agent、审计报告页
- 批量跑整本书
- 教师/学生的自适应记忆（长期学生画像随对话演化）
- 会话中断续跑、消息回滚
- 教材原文的 verbatim 引用校验（V2 加）
- 用户账号、权限、多用户
- PDF/EPUB 导入（先只吃 markdown）
- 教师改书（女娲那套）
