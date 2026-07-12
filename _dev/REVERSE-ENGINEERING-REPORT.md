# Socratopia 系统架构与提示词交互方案 · 完整逆向报告

> **产品**：Socratopia v3.2.0（Socratic Roleplay Learning）
> **作者**：Lemin（原工程根 `/Users/leminwu/Documents/Github/socralab-app/v2`）
> **产品定位**：以「同居 + 苏格拉底问答」的角色扮演做终身学习——用户是被 3 位伙伴陪读的"学习者"，同时收养一只反过来自己教学的"小生灵"。
> **发行渠道**：Electron 桌面 app（Windows/Mac，本次分析样本为 Windows x64）
> **分析日期**：2026-07-03
> **分析约束**：全程只读，`D:\Socratopia` 下的原始文件未做任何修改（本报告为新增文件）

---

## 目录

- 第一部分：宏观架构
- 第二部分：LLM 抽象层与代理契约
- 第三部分：五大 LLM 子系统
  - 3.1 主教学对话 `/api/chat`
  - 3.2 女娲模式（同路由，`nuwaMode=true`）
  - 3.3 下课与课后产物（同路由，最后消息 `[下课]`）
  - 3.4 教学教练 TAE（后台元监督）
  - 3.5 Socratopia 群聊 `/api/groupchat`
- 第四部分：宠物子系统（独立生态）
- 第五部分：教材导入 pipeline
- 第六部分：课后派生产物路由
- 第七部分：Companion / World / Profile 管理
- 第八部分：Electron 主进程与前端
- 第九部分：数据存储全景
- 第十部分：提示词模板与状态管理方案总结
- 第十一部分：值得学习的十个设计模式
- 附录 A：全部 40+ API 路由一览表
- 附录 B：一次主对话请求的完整流水
- 附录 C：所有已挖出的完整 Prompt 索引

---

## 第一部分：宏观架构

```
┌────────────────────────────────────────────────────────────────────┐
│ Socratopia.exe (Electron 40 shell, Chromium + Node.js)             │
│                                                                     │
│  resources/app.asar (1.3 MB, 仅 3 个文件)                           │
│    ├─ dist-electron/main.js    (主进程, esbuild 打包未混淆)          │
│    ├─ dist-electron/preload.js (contextBridge IPC 桥, 2.6 KB)       │
│    └─ package.json                                                   │
│                                                                     │
│  ↓ child_process.fork()   HOSTNAME=127.0.0.1  PORT=13713(优先)      │
│                                                                     │
│ resources/server/  (Next.js 16 standalone, ★真正的业务代码在这里)   │
│    ├─ server.js       (Next 官方 standalone entry)                  │
│    ├─ package.json    (socratopia@3.2.0)                            │
│    ├─ lib/pdf-worker.mjs   (pdfjs-dist legacy build)                │
│    └─ .next/                                                        │
│       ├─ server/app/api/{40+ routes}/route.js  ← 服务端 API + Prompt│
│       ├─ server/chunks/*.js                     ← 共享 Prompt / util│
│       └─ static/chunks/*.js                     ← 前端 Bundle       │
└────────────────────────────────────────────────────────────────────┘
                              ↓ HTTPS
┌────────────────────────────────────────────────────────────────────┐
│ 云端后端（都由 Lemin 运营）                                          │
│  · https://llm.socratopia.app/v1      (OpenAI 兼容代理, 主对话)      │
│  · https://api.socratopia.app         (业务 API, 论坛/账户)         │
│  · https://api-edge / llm-edge…       (fallback 边缘节点)           │
│  · https://releases.socratopia.app    (electron-updater feed)       │
│                                                                     │
│  代理服务器负责分发到实际的 LLM 提供商：                              │
│  deepseek / anthropic / openai / gemini / qwen / moonshot / minimax │
└────────────────────────────────────────────────────────────────────┘
                              ↓ 本地磁盘
┌────────────────────────────────────────────────────────────────────┐
│ PROJECT_ROOT = %APPDATA%/Roaming/Socratopia (由 main.js 传入)       │
│  accounts/<accountId>/                                              │
│    ├─ profiles/<pid>/                                               │
│    │   ├─ worlds/<XX>/  ← 每个 world = 一份完整世界+3 伙伴          │
│    │   │   ├─ story.md, learner_profile.md, npc_[abc].md            │
│    │   │   ├─ relation_npc_[abc].md, pal_moments.md                 │
│    │   │   ├─ world_meta.json, world_records.md                     │
│    │   │   ├─ companions/npc_*.png (头像)                            │
│    │   │   ├─ groupchat/{recent.md, last_read.txt, archive/…}       │
│    │   │   ├─ diary/YYYY-MM.md (追加式月度日记)                      │
│    │   │   ├─ concept-summaries/<cid>.json (课堂笔记)                │
│    │   │   ├─ flashcards/<tid>.json + favorites.json                │
│    │   │   ├─ conversations/<cid>/ (会话+阅读态派生)                 │
│    │   │   ├─ lesson_summaries/<cid>.md (窗口压缩摘要)               │
│    │   │   ├─ textbooks/<tid>/ (教材文件+索引+进度)                  │
│    │   │   └─ worlds/active.json                                    │
│    │   ├─ pet/ ← 宠物子系统数据（独立于 world）                       │
│    │   ├─ custom_companions/ (index.json + <ct_xx>.md/png)          │
│    │   └─ pet_unlock.json (孵化解锁进度)                             │
│    ├─ forum_key (社区匿名账号)                                       │
│    └─ profiles.json (账号列表 + pinHash/pinSalt)                    │
│  device_id (12 位随机, 惰性生成)                                     │
└────────────────────────────────────────────────────────────────────┘
```

**技术栈关键版本**：
- Electron 40.8 · Next.js 16.1.6 · React 19.2.3 · TypeScript 5.9.3
- SDK：`@anthropic-ai/sdk@0.78`、`openai@6.27`、`@google/generative-ai@0.24`
- 依赖：`pdfjs-dist@5.5`、`epub2@3.0`、`mathlive@0.110`、`katex@0.16`、`electron-store@11`、`electron-updater@6.8`、`node-machine-id@1.1`、`jose@5.9`

**发行版关键事实**：`NEXT_PUBLIC_ALLOW_BYOK=false`——**BYOK 已从二进制中剥离**（`verify-byok-stripped.sh` 强制校验）。前端还留有 BYOK 的 i18n 字符串，但取值路径已 dead-code-eliminate；主进程 `store:getApiKey/setApiKey` IPC handler 被硬短路成 `return ""` / no-op。**这是纯 hosted 版本**。

---

## 第二部分：LLM 抽象层与代理契约

### 2.1 唯一入口：`callLLM` 和 `streamLLM`

所有 LLM 调用都从这两个函数出发，位于 `chunks/2570.js`（module `64092`）和 `chunks/4026.js`（module `20375`）。二者都走 **OpenAI 兼容 `/chat/completions`** 协议（即便底层是 Anthropic，也由代理服务器做协议转换）。

```
POST ${SOCRATOPIA_PROXY_URL||"https://llm.socratopia.app/v1"}/chat/completions

Headers:
  Authorization: Bearer hosted             ← 固定字符串（真正的鉴权在 X-Session-Token）
  X-Session-Token: <session>               ← 用户身份
  X-Device-Id: <12 位随机 id>              ← 反滥用设备指纹
  X-Force-Provider: deepseek|anthropic|... ← 可选，强制路由到某家
  X-Socratopia-Purpose: chat|summary|end-class|... ← 计量维度
  X-Socratopia-Source: chat|chat_autoreply|groupchat|... ← 触发上下文
  X-No-Fallback: true                      ← 可选，拒绝 fallback

Body:
  {
    "model": "<provider 的具体型号>",
    "max_tokens": ...,
    "stream": true | false,
    "messages": [{role:"system",content:...}, ...],
    "thinking": {type:"enabled"|"disabled"},  // 仅 deepseek-chat / deepseek-v4* 生效
    "response_format": {type:"json_object"}   // 可选，强制 JSON
  }
```

- **非流式**：一次性 JSON 返回，用于摘要类任务
- **流式**：走 `openai` SDK 的 `chat.completions.create({stream:true})`，服务端把 openai SDK 事件流**再翻译成自定义 SSE 事件**推给前端

### 2.2 默认模型映射（`callLLM` 常量 `$b` / `e`）

| provider | 默认 model |
|---|---|
| anthropic | claude-sonnet-4-20250514 |
| openai | gpt-4o-mini |
| gemini | gemini-2.5-flash |
| **deepseek** | **deepseek-v4-flash** |
| qwen | qwen-plus |
| moonshot | moonshot-v1-auto |
| minimax | MiniMax-M2.7-highspeed |

**关键路径的模型选择**：
- 主对话：跟随用户设置，hosted 默认走 deepseek-v4-flash
- 教练分析（TAE）：**固定 `deepseek-chat`**
- 教材 preface/toc 分析：hosted 强制 `deepseek/deepseek-chat`
- 所有课后摘要类：`forceProvider:"deepseek"`, `thinking:false`
- 宠物子系统：**全线强制 deepseek + hosted only**（BYOK 直接拒绝）
- AI 代答（学习者视角自动回复）：固定 `deepseek/deepseek-chat`

### 2.3 前端到后端的两跳

前端 fetch 助手（`static/chunks/9373-*.js`）实际会做**两级路由 + fallback**：

```js
r = "https://api.socratopia.app"     // 业务 API 主
a = "https://llm.socratopia.app"     // LLM 代理主
o = "https://api-edge.socratopia.app" // 业务 fallback
i = "https://llm-edge.socratopia.app" // LLM fallback

// path 以 /v1 开头 → llm 后端；其余 → api 后端
```

但**实际调用链**是：前端 `POST http://localhost:13713/api/chat` → 本地 Next server 的 `route.js` → 本地再 `fetch https://llm.socratopia.app/v1/chat/completions` → 代理分发到真正的 LLM 提供商。**Prompt 组装、文件读写、tool 执行都发生在 localhost 上的 Next server 里**，前端只负责渲染 SSE。

### 2.4 错误哨兵映射

服务端错误码用 `%%SENTINEL%%` 形式回传，前端按码显示 i18n 文案：

| 哨兵 | 触发 | UI 含义 |
|---|---|---|
| `%%BETA_ENDED%%` | Beta 结束 | 停止服务提示 |
| `%%POOL_EXHAUSTED%%` | 月额度 / reward pool 用尽 | 充值提示 |
| `%%DEVICE_LIMIT%%` | 设备数超限 | 让用户先解绑其它设备 |
| `%%DEVICE_NOT_BOUND%%` / `%%DEVICE_MISSING%%` | 设备未绑定 | 登录 |
| `%%CONCURRENCY_LIMIT%%` | 并发限制 | 稍后再试 |
| `%%SESSION_INVALID%%` | session 无效 | 重登 |
| `%%RATE_LIMIT%%` / `%%TIMEOUT%%` / `%%NETWORK%%` | 网络类 | 通用提示 |
| `%%RULES_AUTH/NETWORK/SERVER%%` | 拉规则失败 | 三细分文案 |

### 2.5 规则远程加载与本地缓存

主对话的 system prompt 首段是**远程拉取**的教学规则（`chunks/4026.js` 的 `o()/p()/m()`）：

```
GET https://llm.socratopia.app/rules?lang=zh|zh-TW|en[&noEnd=1]
Headers: X-Session-Token: <session>
Response: text/plain（必须以 # 开头且 ≥100 字符）
```

- **本地内存缓存 1 小时**
- 失败原因分类缓存：auth / transient / permanent
- `noEnd=1` 版本用于**群聊**（不含下课流程规则）

**Lemin 可以远程灰度调教学规则本身而不需发新版**。这是整个系统里最"活"的一段 prompt。

---

## 第三部分：五大 LLM 子系统

### 3.1 主教学对话 `/api/chat`（930 行）

**触发方**：主教学界面每次用户发消息。

**参数**（POST body）：`messages, character(npc_a|npc_b|npc_c), apiKey, provider, model, profileId, worldId, textbookId, nuwaMode, clientTotalTokens, autoReply, conversationId, teachingLanguage, accessMode(hosted|byok), sessionToken, isPostJump, thinkingObserved, pacing(thorough|normal|express), hideNarration, fallbackProvider, fallbackModel, fallbackApiKey`

**System prompt 组装公式**（`chunks/4026.js` 的 `Ex()`，`\n\n---\n\n` 分隔）：

1. **教学规则**（远程 rules，见 §2.5）
2. `## 你的角色设定` — `npc_a/b/c.md`
3. `## 当前关系状态` — `relation_npc_*.md`
4. `## 世界背景` — `story.md`
5. `## 与伙伴的相处片段（近期）` — `pal_moments.md`
6. `## 学习者信息` — `learner_profile.md`
7. `## 上次学习日期` / `## 当前状态`（若空世界）— `world_meta.lastStudyDate`
8. `## Socratopia 群（最近消息）` — `groupchat/recent.md` 尾 500 字
9. `## 当前教材（本次教学对象）` — 教材元信息 + "从哪续讲"提示
10. `## 教材库` — 所有教材摘要清单
11. `## 学习进度（当前教材）` — `textbooks/<tid>/progress.md`
12. `## 当前教材内容（本节课已读取）` — `current_reading.md`（PDF 抽出的文本，含 `--- 第 N 页 ---` 分隔）
13. `## 本节课提纲` — `session_plan.md`（伙伴课中自己写的临时计划）
14. `## 前序对话摘要` — `lesson_summaries/<cid>.md` 剥离哨兵行
15. **伙伴精力状态 N/10** — 长会话时注入疲态文案（0–5 档），红线明令**不许**降低教学质量、催促、主动结束
16. `## 本节课节奏档位` — thorough / express / normal
17. **教材原文引用标记规则** — `〔§页号｜引言〕` 生成协议
18. **旁白与强调格式规则** — 单星号 = 神态动作（第三人称），双星号 = 强调
19. **提醒** — 每条消息必须以引发思考的问题结尾
20. **铁律** — 下课只能由用户点按钮触发
21. `## 授课语言（中/英/繁）` — 最高优先级
22. **[条件注入] 教练分析** — 见 §3.4

**用户消息插入手法**（服务端在真正调 LLM 前会篡改 messages）：

- **首轮伪装 tool_call**：第一次进入教材时，服务端在客户端不知情下先执行一次 `read_textbook_pages` 工具，把教材抽出的文本塞进 system prompt。前端收到一对"翻开教材…"的 `tool_use/tool_result` SSE 事件，看起来像 LLM 主动读的
- **handoff seed**：如果 `textbooks/<tid>/handoff/last_tail.json` 存在（上节课下课时写的最近尾部消息 + 元信息），服务端会**注入一条虚构的 user 消息**说明"这是上节课末尾发生的事情"，把 tail 消息前置。当会话达到 8 条时删除 handoff 文件
- **翻页教学触发**：用户点跳页后，前端主动发一条 user 消息 `请从第 N 页开始教学。`（`isPostJump:true`）
- **语言切换承诺**：切换 teachingLanguage 且历史里已有 assistant 消息时，服务端在 messages 末尾**手工插入一条 assistant 消息** `（语言切换确认。从现在起，我将全程使用 X 回答。）`，让 LLM 在下一轮"记得自己已经承诺过"

**SSE 事件类型**：
```
text, reasoning_content, thinking_observed, tool_use, tool_result,
reading_range, companion_note, usage, error, done
```

**工具集**（openai SDK tool_calls，服务端拦截并 `chunks/3358.js:o8()` 执行）：
- `read_textbook_pages(startPage, endPage?)` — 读教材页范围
- `get_textbook_toc()` — 查目录
- `read_file(path)` — 读世界文件（受路径白名单限制）
- `write_file(path, content)` — 写世界文件（**女娲模式独占**）

普通对话中允许的 read_file 目标：`diary/*, world_records.md, learner_profile.md, story.md, groupchat/*, progress.md`（对应 UI 上的 "翻看日记 / 回想过往 / 想起你 / 看看群消息 / 看看进度"）。

---

### 3.2 女娲模式（同路由，`nuwaMode=true`）

**用途**：让 LLM 扮演"女娲"帮用户维护世界设定——不做教学。

**System prompt 由 `chunks/4026.js` 的 `_()` 组装**（module `35684`），约 250 行中英双语。核心特征：

- 角色：世界创造者与守护者。语气温柔智慧带俏皮
- **🔴 第一铁律**：`write_file` 是唯一改文件的方式，没实调过就绝不许说"我已经改好了"（防止 LLM 幻觉一段"改后的样子"就当完成）
- **正确 vs 错误对比示例**：三段对比
- **槽位边界**：清单外的 `npc_*.md` 一律不许写（即使 `read_file` 返回空、即使用户说"填一下"，都视为"动词换皮的创建"，越界）
- 文件白名单（含字符数上限）：`story.md ≤4000`、`learner_profile.md ≤1500`、`npc_[abc].md ≤1500`

---

### 3.3 下课与课后产物（`[下课]`/`[下課]`/`[End Class]` 前缀）

**触发**：`chat/route.js:Q()` 检测到 messages 最后一条 user 内容匹配前缀正则 `t.Q()`，就改写这条消息为一整段"课后更新指令"，用非流式 `callLLM` 单次调用生成**六段结构化输出**：

```
===FAREWELL===           角色化告别（2-3 句）
===PAL_MOMENTS_MD===     今天的一条新条目（一行 ## YYYY-MM-DD | 伙伴名 + 段落）
===PROGRESS_MD===        整份 progress.md（覆写，保留最近 5 节课）
===DIARY_ENTRY===        新的日记条目（追加）
===RELATION_MD===        角色对学习者的当前态度（覆写，≤ 400 字符）
===COMPANION_NOTE===     伙伴寄语（≤ 140 字，展示 + 社交分享）
===END===
```

**System prompt 核心**（`chat/route.js:1-260` 常量 `K`（中文）/`L`（英文）/繁中动态附加）：

- 🔴 **第一铁律**：所有内容必须基于真实对话，不许虚构学习者的话；对话量决定输出量（宁可写三十字绝不虚构）
- 六段各自的独立规则
- 硬性格式规则：`===TAG===` 必须独占一行

**User 消息构造**（`chat/route.js:611` 起）**极其精巧**：
- 把本次课**所有 user 消息**编号列成一个 `manifest`
- 再附上一段 **🔴 关于引用/叙事的铁律**（4 条硬规则）：
  - "今天 vs 过去"严格分隔：state 文件里的内容不是今天素材
  - 引用学习者：清单外 = 虚构 = 禁止
  - 引用伙伴自己：可以自由发挥人设，但**不能把 1 个动作扩展成一连串**
  - manifest 长度决定输出长度

**服务端后处理**：
1. 正则解析六段
2. `pal_moments.md` 特殊合并：新条目置顶，超长逐个删旧
3. `textbooks/<tid>/progress.md` 覆写
4. `diary/YYYY-MM.md` 追加（用 `\n\n---\n\n` 分隔条目）
5. `relation_<slot>.md` 覆写
6. 写 handoff tail 与 meta
7. 追加 `world_records.md`
8. 清理该会话所有临时文件
9. 通过 SSE 推伪 tool_result 让前端播放动画
10. 解析失败会**自动重试一次**

**AI 代答**（`autoReply:true`）：追加一条 user prompt `[AI代答] 请你暂时以学习者的身份...`，用 deepseek-chat 生成 2-4 句"学习者视角"的回答返回。

---

### 3.4 教学教练 TAE（后台元监督，**双 LLM 元回路**）

**位置**：`chat/route.js:H()/I()`（约 line 320–560）

主对话每收到 LLM 回复完成一次后，**后台并行**发一个新请求给 DeepSeek（固定 `deepseek-chat`），system prompt 让 LLM 扮演"苏格拉底教学教练"分析最近 10 轮对话，输出严格 JSON：

```json
{
  "companionBehavior": "normal|looping|drifting|criticizing_author|vague_answers",
  "learnerEngagement": "passive|following|curious|deeply_engaged|frustrated",
  "isLearnerDrivingRepetition": bool,
  "isTangent": bool,
  "mainlineTopic": "岔题时的主线概括",
  "currentFocus": "当前焦点",
  "learnerWeakPoint": "学习者薄弱点",
  "recentPatterns": "近期对话模式",
  "teachingGoalAlignment": "aligned|slightly_off|off_track",
  "recommendedAction": "advance|deepen|honor_curiosity|challenge|rescue|address_question|return_to_mainline",
  "actionReason": "≤30 词",
  "responsePlaybook": {
    "ifShortAck": "如果学习者简短回应，你应该...",
    "ifQuestion": "如果学习者提问，你应该...",
    "ifSubstantive": "如果实质性回答，你应该...",
    "ifConfused": "如果表示困惑，你应该..."
  },
  "qualityFlags": [],
  "contentProgress": "first_half|second_half"
}
```

**结果处理**：
- 存入进程内 `M` map（键 = conversationId）
- **下一轮**主对话时把它渲染成中/英文的"教练分析块"**注入 system prompt 末尾**
- **同时驱动自适应翻页**：`contentProgress` 累计够阈值触发下一段教材抽取

**核心心智模式**：主 LLM 说话，教练 LLM 观察，把观察结果作为下一轮的 system prompt 补丁——**LLM 的元自我监督**。

---

### 3.5 Socratopia 群聊 `/api/groupchat`

**方法**：GET（读群聊 + full 拼合）/ PATCH（更新 last_read）/ **PUT（生成，SSE 流）** / DELETE（归档并清空）

**核心特点**：**服务端单次 LLM 调用一次生成多角色多条消息**——客户端不指定谁说话。

**System prompt**（`groupchat/route.js:B()`, line ~184）**独立实现**。段落：

1. **群聊生成器身份** — "你是 Socratopia 群的群聊生成器…成员：${名字列表}"
2. **投骰子发言模式**：每次概率 30%/40%/30% 决定 1/2/3 人发言；每人通常 1 条，活泼者可连发 2-4 条；**绝对禁止"每人各说一句轮流回复"**
3. **人设驱动 / 格式**：`[YYYY-MM-DD HH:MM:SS] 名字：内容`
4. `## 世界背景` — story.md
5. `## 学习者信息` — learner_profile.md
6. 各伙伴人设块（人设 + 当前 relation）
7. `## 最近课堂进度` — textbook progress
8. `## 最近群聊记录` — `groupchat/recent.md` 最后 3000 字符
9. `## 时间`
10. **⚠️ 最终强制规则**（覆盖前文冲突）：
    - **消息内容禁用任何 `*` 星号**（群聊不允许神态动作旁白）
    - 引用前先想清是谁说的（防错误归因）
    - 反应要匹配学习者实际表现，不硬夸

**生成后守卫**：
- 剥离 `<think>`
- 按时间戳切行
- **冒充学习者过滤**：匹配 `学习者/Learner/我/Me/User/学员/用户` 的行丢弃
- 上限 30 行
- 时间戳重写为「基准时间 + index×5 秒」

**recent.md 归档节奏**：每次成功写入后，若行数 > 150，把「除最后 100 行外」的旧行按 `YYYY-MM` 分桶归档到 `groupchat/archive/<YYYY-MM>.md`。

**postClass 模式**（下课后广播）：
- `groupchat/broadcasted.json` 去重（最多 50 条）
- 尝试计数 `groupchat/broadcast_attempts.json`（≥3 次生成 0 行也标记已广播）
- 有 conversationId 且能读到会话 → **先用 deepseek 对该堂课摘要**，再以 teacherSlot 指定的伙伴口吻在群里聊这堂课

**SSE 事件**：`text`, `already_broadcasted`, `lines_final` (最终解析后的行数组), `done`, `error`

---

## 第四部分：宠物子系统（独立生态）

宠物是一个**角色反转**的独立子系统：**用户是老师，LLM 是学生**。数据完全独立于 world，路径都在 `profiles/<pid>/pet/`。13 个路由分工明确。

### 4.1 宠物人设总纲（`chunks/2361.js`）

`buildPetSystem(profileId, lang)` 拼装：

```
[基础 pet prompt].replace({{PET_NAME}}, name)
+ [语言段：只说中文 / English only / 只说繁体]
+ 【自我设定（来自你的老师）】← profile.md
+ 【关系笔记 / 你心里记着的】← pet_relations.md
+ 【你已开悟的笔记】← summaries_archive.md + summaries/*.md
+ 【你已学的卡（自上次开悟以来）】← cards/*.md
```

**基础 pet prompt 关键要点**（中/英/繁三语，逐字保留在 chunks/2361.js:1-336）：

- **三层知识建模**：
  1. 老师亲口教过的卡（存在"已学的卡"里）
  2. 自主开悟时想通的道理（"开悟笔记"）
  3. **前置基础——随老师正在教的内容自动校准**：教研究生火箭物理时熟练掌握微积分、线代；教小学加法时几乎白纸。基础可坦然直接用不装傻
- **未知前沿**：正在教的知识点本身及更后——绝不抢答绝不炫耀，即使"知道"也表现得不知道
- **5 种提问本能**：
  1. **为什么链**（听到结论想知道原因）
  2. **边界试探**（听懂规律想知道什么时候不灵）
  3. **求打比方**（抽象概念求生活影子）
  4. **联想串线**（新东西让 pet 想起以前学过的卡——🚨 必须真实存在于已学卡/开悟笔记/今天对话，绝不编造"你上次教我"）
  5. **复述验证**（觉得懂了用自己的话复述，请老师检查——主动指出**最没把握**的地方，真实的薄弱点是最好的镜子）
- **提问节制**：每轮回应最多一个问题；同种本能不连用；讲透彻时允许"满足地消化"
- **🚨 跳步警觉**（优先级高于"每轮一问"）：老师突然引入无来由的新符号 / 断言 → **必须**发动"为什么链"
- **🚨 教材腔识别**：老师用密集术语学术陈述 / 罗列式定义 / 教科书条目式 → **必须**立刻打断求大白话
- **🚨 老师答不上时**（"我不知道"/"下次讲"/沉默）：**绝不**自己给答案（哪怕"知道"）；按性格选四种回应
- **🚨 严格禁止任何动作神态描写**（不许用括号 / 方括号 / 星号）——`chunks/80117.G()` 在存储时对 assistant 内容再做剥离作双保险

### 4.2 各路由分工

| 路由 | 方法 | 用 LLM？ | 说明 |
|---|---|---|---|
| `/api/pet/chat` | POST(SSE) | 是（deepseek，hosted only） | 主对话循环，无工具，上下文固定 `slice(-24)` |
| `/api/pet/lesson` | GET | 否 | 读单条 lesson 记录 |
| `/api/pet/lessons` | GET | 否 | 列全部 lesson |
| `/api/pet/end-lesson` | POST | **是**（评教 + 寄语 2 次并行 LLM） | 苏格拉底评教 |
| `/api/pet/enlighten` | POST | **是**（开悟 + 归档 + 画像 3 次 LLM） | 升级开悟 |
| `/api/pet/auto-teach` | POST | 是（deepseek） | 帮用户想"下一句该怎么教"，非流式，配额受等级限制 |
| `/api/pet/summaries` | GET | 否 | 读开悟 summaries |
| `/api/pet/cards` | GET/PATCH | 否 | 读卡片 / 改状态（如归档） |
| `/api/pet/conversation(s)` | GET/POST/DELETE | 否 | 会话 CRUD |
| `/api/pet/avatar` | GET/POST/DELETE | 否 | 头像二进制读写 |
| `/api/pet/profile` | GET/POST/DELETE | 否 | 领养 / 改名改人设 / 删档 |
| `/api/pet/unlock-status` | GET/POST | 否 | 孵化解锁：累计 `tokens_consumed_since_v300` 达 **3,000,000 tokens** 解锁 |

### 4.3 苏格拉底评教 `/api/pet/end-lesson`

**核心 prompt** 在 `chunks/2570.js` 常量 `e`（苏格拉底人设）——是**这个系统里字数最多、约束最细的 prompt 之一**。要点：

- **身份**：苏格拉底本人，两千多年前雅典街头辩论，因"不知者方能求知"被误解。语气是**历经千年、温和、保有强烈好奇心、习惯用问题代替陈述的老哲人**
- **禁用清单**：现代/地域性口头禅——"收获满满"、"加油"、"期待下次"、"真棒"、"月色真美"、"老头子"、"晚安"、表情符号、网络流行语；**不称呼用户为"朋友"（尚未相识），不叫"老师"**
- **统一开头**：`致 {{pet_name}} 的老师：`
- **统一结尾**：`—— 苏格拉底`
- **至少 1-2 次以问代述**——这是标志
- **绝不**说"读了对话"——是"听了他们的谈话"
- **信长度**：0 卡 ≤100 字 / 1-2 卡 ≤200 / 3+ ≤350
- **评教信 = 教练不是裁判**（两条职责）：
  1. **给做法不给空话**（❌"讲得不够生动" / ✓"你给了定义但没给例子——下次先讲一个生活场景，再落定义"）
  2. **本课最佳瞬间**：具体教学行为 + 引用老师原话（用「」引用）
- **知识卡 5 级阈值**：
  1. ✅ ACCURATE — 完全正确 → 出卡 `accurate`
  2. ✅ FACT-ONLY — 事实对但没讲为什么 → 出卡 `accurate` + restated 暗示"还想知道为什么"
  3. ⚠️ MINOR-DEVIATION — 主体对小偏差 → 出卡 `minor_deviation` 用正确表述
  4. ❌ CORE-ERROR — 主体/核心错 → **不出卡** + 反诘
  5. ❎ NOT-TEACHING — 纯闲聊 → 0 卡
- **🔍 "看似合理"的隐性误导警惕**：白天X晚上Y 二分式（植物 24h 都呼吸）、重的落得快、冷的东西"放冷气"、太阳近夏天热等
- **🚨 教材腔防刷等级**：识别用户复制粘贴课本行为，若萌宠没用自己的话复述且用户没进一步大白话解释 → **不出卡**
- **知识卡字段**：
  - `title` — 苏格拉底凝练标题（10-20 字）
  - `concept` — 学术口吻清晰条目
  - `user_quote` — 用户**一句完整原话**逐字复制（服务端会与 manifest 逐字比对，对不上会被清空）
  - `restated` — 萌宠以后如何向另一个人转述（孩子口吻，7 种开头模式**轮换**）
  - `error_flag` — accurate | minor_deviation
- **relations_md 重写纪律**：
  - 情愫演化必须**缓慢克制**，一节课通常只带来最细微变化
  - **绝不允许一节课内关系发生质变**
  - 段落式状态描述（1-2 段），**不是条目列表**
  - 全程第三人称
  - 写状态不写时间点
  - ≤ 900 字符（英文放宽 3000）
  - **留白规则**：本课完全没内容更新 → 输出空字符串 `""`

**实际输出协议**：虽然 prompt 说"通过 `submit_review` 工具"，但**实现改用 `response_format:"json_object"`**（无 tools 字段）。JSON 解析走 `chunks/65705.f()`——**能修复 LaTeX 反斜杠转义 + 游离引号**的宽松解析器（最多 50 轮位置探测式修复）。

**两次并行 LLM**：
1. **评教**（system=苏格拉底，maxTokens=4096）
2. **pet_note 下课寄语**（system=精简 pet 人设，maxTokens=600，≤220 字，英文放宽 ×3.4）

### 4.4 开悟 `/api/pet/enlighten`

**触发条件**：`cards_since_last_levelup >= next_levelup_threshold`（初始 30）。

**三次 LLM 调用**：

1. **开悟主 prompt**：让 LLM 扮演"Socratopia 萌宠成长系统的内省 LLM"，产出：
   - `summary_markdown` — 第一人称萌宠口吻内心独白，谦逊，≤800 字
   - `levelup_message` — 一两句开悟感言

2. **归档压缩**（第二次 LLM，非致命）：把 `ordinal <= 当前-3` 的旧 summaries 合并进 `summaries_archive.md`

3. **知识画像**（第三次 LLM，非致命）：第三人称"它"，≤160 字，生成 `knowledge_digest.md`（供 UI 展示）

### 4.5 auto-teach（教学助理）

**用途**：帮用户想"下一句该怎么教"，非 pet 自我循环。

- **配额表**：按 pet 等级授予（Lv2→1, Lv4→2, Lv6→3, Lv8→4）
- system prompt：`你是一位经验丰富的教学助理，正在帮一位用户教萌宠 ${name}` — 含已学概念列表、5 种教学手法、硬性要求（2-4 句、无 prefix、无 emoji）
- user prompt：最近 20 轮对话
- 非流式

---

## 第五部分：教材导入 pipeline

**核心模块**：`chunks/2751.js` 的 module `82751`。

### 5.1 上传（`/api/textbook` POST，multipart form-data）

支持扩展名：`.pdf / .md / .markdown / .epub / .epub.zip`。`.epub.zip` 会 `execSync` 调 unzip 解压再用 zip 重打成合规 EPUB。

### 5.2 四种 Extractor（统一接口）

工厂 `NE(format)` 动态 import：

| 格式 | Extractor | 备注 |
|---|---|---|
| `pdf` | chunks/7962.js | 委托 `resources/server/lib/pdf-worker.mjs` 子进程 (`execFile` + pdfjs-dist legacy) |
| `markdown` | chunks/1069.js | 剥离 YAML frontmatter；按 H1/H2 切 section，每 section ≤3000 字符算一"页"；`pages.json` 存 pageNum↔charOffset manifest |
| `epub` | chunks/9241.js | 内嵌完整 HTML→text parser + epub2 库 |
| `qbook` | chunks/602.js | **AES-256-CBC 加密的 markdown**，解密到临时 md 再走 markdown extractor |

**qbook 加密**（`chunks/6163.js`）：
```
key = pbkdf2Sync("socratopia-qbook-2026-lemin-menglu", "socratopia-salt-v1", 100000, 32, "sha256")
iv  = 随机 16 字节
输出 = IV || AES-256-CBC(plaintext)
```
**触发条件**：导入 markdown 且 world 语言 = `chinese-traditional` → 明文 md 加密存 `.qbook` 并删原文。

### 5.3 三阶段 LLM 分析

**阶段 A — TOC 选正文起始节**（非 PDF，函数 `w()`）

**完整 prompt（中文 `t`）**：
```
你是教材目录分析助手。给你一份按顺序排列的教材目录条目（每条包含 `title`、`page`、`level`），你要找出**真正的教学正文**从哪一条开始。

**永远跳过以下条目**（即使它们看起来内容丰富）：
- 封面 / 扉页 / 版权 / 题献 / 题记
- 目录 / 索引
- 序 / 前言 / 序言 / 自序 / 代序 / 推荐序
- Foreword / Preface / Prologue
- **Introduction / 引言 / 导言 / 导论 / 绪论 / 绪言**（产品设计：始终跳过，让用户主动选）
- 致谢 / 鸣谢 / Acknowledgments
- 作者简介 / About the Author / 译者序
- 关于本书 / 本书的特点 / 如何使用本书 / 致读者 / Note to Reader
- 出版说明 / 版权与传播 / 凡例 / 使用说明 / 编写说明
- 预设知识基础 / Prerequisites（属于使用说明类）

**优先选择**以下形式的条目作为正文起点：
- 第一章 / 第1章 / 第一节 / 第一课 / 第一讲 / 第一篇 / 第一单元
- Chapter 1 / Chapter One
- Day 1 / Lesson 1 / Lecture 1 / Module 1 / Unit 1 / Section 1
- Part 1 / Part I（若全书以 Part 划分大块）
- "1." / "1.1" / "I." 开头的标准章节编号

**关于 heading 层级（level）**：
- 不同书的章节可能用不同 level——有的书 H1 留给 "Part"、H2 给 "Chapter"，有的书 H1 直接是 Chapter
- 不要靠 level 数字判断，要靠 title 内容 + 上下文综合判断
- 如果一个 H1 标题后紧跟多个 H2 子标题，再换 H1，则前一个 H1 + 它的 H2 们构成一个 "块"

**边界情况**：
- 没有任何明确"第N章/Chapter N"标识时，挑前置内容结束后的**第一条带实质内容的条目**
- 拿不准时**宁可选靠后**（多跳前置比误起在前置上更安全）

只输出严格 JSON，不加任何额外说明：
{ "selectedIndex": <1 开始的索引数字>, "reasoning": "<一句话解释为什么选这条>" }

如果整份 TOC 全都是前置内容、或无法判断，返回 {"selectedIndex": null, "reasoning": "..."}。
```

**阶段 B — 教材信息提取**（所有格式，函数 `E()`）
- 抽取开头文本 + 文件名 + 起始页提示 + 出版社大纲提示，提取 `{title, author, year, field, abstract, contentStartPage, contentStartSnippet}`
- 关键设计：**"判断的核心：看内容，不是看标题"**

**阶段 C — TOC 结构化抽取**（仅 PDF + LLM，函数 `H()`）
- 取前 30 页文本（截 12000 字符），LLM 抽取印刷目录成 `{offset, entries:[{title, bookPage, pdfPage, level}]}`
- `offset = 实际 PDF 页 - TOC 上印的书页码`

**多层 fallback 判定优先级**：
1. **snippet 匹配**（LLM 给的 verbatim snippet 在切页文本里找）
2. **LLM contentStartPage**（无 snippet）
3. **regex 正文标记**（`第一章 / Chapter 1 / 1. / I.`）→ `positive-regex, high`
4. **regex 前置内容负匹配** → `negative-regex, medium`
5. **default, low**, page 1

PDF 专有**扩窗重试**（≤3 轮，每轮 +30 页至上限 max(200, 30% 总页)）。

### 5.4 自适应翻页（在 `/api/chat` 中）

**触发**：TAE 的 `contentProgress:"second_half"` 累计（`recentProgress` 数组保留最近 4 个，`filter(Boolean).length >= 2` 时触发）→ 加互斥锁 `WN(convId)` 执行 `xC` 扩窗。

**扩窗算法** `xC`：
```
1. targetTokens = 10000, k = 5000
2. 从 endPage+1 抽 4*k 新内容（extractFn）
3. 若无新内容 → return null （末页守恒）
4. l = 旧窗后半（secondHalf(currentContent)）+ 新内容
   ← 窗口重叠，保证话题连续
5. 按 target token 截断
6. JM(text, wasClamped)：找 `--- 第 N 页 ---` 标记
   ← 被截断且≥2个标记时取倒数第二个（避免把只露一半的最后一页算已读完）
7. writeFn(内容, 新末页, 新起页) → current_reading.md
```

`current_reading.md` 格式：
```
<!-- startPage: 5 endPage: 17 -->
--- 第 5 页 ---
...
--- 第 6 页 ---
...
```

### 5.5 教材原文引用标记 〔§页号｜引言〕

**前端解析、后端提供内容**：

- **规则注入**（`chunks/86363.n5(lang)`）在对话 system prompt 里明令：`§` 后是**分隔标记 `--- 第 N 页 ---` 里的整数 N**，不许用书本自己的 1.1/2.3；`｜`后是原文开头≤10 字逐字照抄；每消息 ≤3 个
- **前端正则**：`〔§(\d{1,4})(?:[｜|]([^〕\n]{0,120}))?〕`
- 点击 `〔§12｜熵增原理〕` → 前端调 `GET /api/textbook-section?section=12&snippet=熵增原理`
- 后端 `/api/textbook-section`：
  - **PDF 直接 422**
  - 非 PDF 用 pages.json + `extractAdaptive(file, 12, 12000, 1, manifest)` 取该节文本
  - **snippet 校正**：若给了 snippet 但当前节不含，在 `section±1、±2` 范围内搜索匹配节

### 5.6 其它相关路由

- `/api/reading-context`：GET，返回 `{readingRange, toc}`。无 LLM
- `/api/jump-page`：用户跳页时**预取教材内容 + 写入 current_reading.md** + 同步 `entry.currentPage` + 更新 dq 窗口
- `/api/pdf-assets`：**不是** PDF 缩略图，而是把 **KaTeX 的 CSS 及内嵌字体**打包成 JSON 供前端注入（渲染 LaTeX 公式）

---

## 第六部分：课后派生产物路由

| 路由 | LLM | 触发方 | 产物 |
|---|---|---|---|
| `/api/diary` | 否 | 用户读/编辑 | 覆写 `diary/YYYY-MM.md` |
| `/api/lesson-summary` | **是** | **/api/chat 内部** | `lesson_summaries/<cid>.md` + `<!-- windowStart: N -->` 哨兵 |
| `/api/concept-summary` | **是**（json_object） | 用户主动 | `concept-summaries/<cid>.json` |
| `/api/flashcard` | **是** | 用户主动 | `flashcards/<tid>.json` + `favorites.json` |
| `/api/forum` | 否（远程 HTTP） | 社区页 | 本地 `forum_key` |
| `/api/rollback` | 否 | 消息回退后 | 修改 lesson_summaries / current_reading.md 状态 |
| `/api/stats` | 否 | 面板 | 只读聚合 |
| `/api/search` | 否 | 搜索框 | 只读检索 hits |
| `/api/conversations` | 否 | 列表 CRUD | 会话 JSON + 级联删除派生产物 |

**只有 3 个真正调 LLM**：`lesson-summary / concept-summary / flashcard`。

### 6.1 lesson-summary（长会话滑动窗口摘要，**由 /api/chat 内部触发**）

哨兵 `<!-- windowStart: N -->` 记录已被摘要吸收的消息数。两个 action：
- `summarize`：吃 `windowStart+10` 条消息，maxTokens=500
- `rebuild`：回滚后重建

**prompt（中文，逐字）**：
```
你是一个对话摘要助手。用户会给你一段师生对话记录（AI学习伙伴 vs 学习者）。

你的任务：用简洁的文字概括这段对话的要点，保留：
1. 讨论了哪些知识点/概念
2. 学习者的理解情况（答对了什么、答错了什么、有什么困惑）
3. 伙伴给出的关键解释或引导
4. 任何重要的互动细节（比如学习者的情绪变化、特别的提问等）

要求：
- 使用中文
- 简洁扼要，不超过 200 字
- 不要用"总结""摘要"等元描述词开头，直接陈述内容
- 用叙述体，不要用列表
- 不要在输出中使用 HTML 注释（如 <!-- ... -->）
```

若累计摘要 token > 1500 触发**二级压缩**（另一个 prompt，压缩到 500 tokens）。

### 6.2 concept-summary（用户主动，课堂笔记概念卡）

**结构化 JSON 8 种 section 类型**：`tldr / narrative / concepts / key-insight / open-question / key-terms / review-questions / notes`。

**输出协议**：`{pagesRange, sections[]}`。`response_format: json_object`, maxTokens: 8192。

**关键规则**：
- 真实性 vs 完整性的平衡（section 层面严守对话，内容层面可适度借力预训练知识补细节）
- 所有数学包 `\(…\)` / `\[…\]`，LaTeX 反斜杠双写
- 短会话保护：非下课 user 消息 < 6 条时不调 LLM，直接生成硬编码 `tldr`

**JSON 解析用自定义健壮解析器**：剥 markdown fence → 花括号配对 → JSON.parse → 失败去尾逗号/控制字符重试 → 再失败按 0.95/0.9/0.8/0.7 截断补齐花括号重试。

### 6.3 flashcard（用户主动，把当前对话变四选一 MCQ）

**格式**：`{question, choices[4], correctIndex, explanation}` — 强制恰好一个正确选项，**明令禁止**"哪两个/哪些/select all"多选题。数量 = min(5, floor(messages.length/8))。

**5 步生成顺序**（写在 prompt 里）：
1. 先构思 question
2. 再写 explanation
3. 提炼简短的 correctAnswer
4. 编 3 个干扰选项
5. 混合并随机化位置

**服务端后处理**：
- 双策略抓 JSON（贪婪+非贪婪）
- 用共享修复器（LaTeX 反斜杠感知）
- **多答案题干正则丢弃**：`/哪\s*[两兩三四几幾2-9]|哪些|which\s+(two|three|four)|select\s+all/i`
- 4 选项去重校验；正确项位置 Fisher-Yates 再随机化
- 附 SM-2 字段 `{interval:0, ease:2.5, repetitions:0, nextReview, history:[]}`
- **每 profileId 串行队列**保证幂等/无并发写；原子写（`.tmp` + rename）

**answer action** 实现 **SM-2 间隔重复**：对→interval 1/3/×ease，ease+0.1（上限 3）；错→interval=0，ease-0.2（下限 1.3）。

### 6.4 forum（社区代理，非 LLM）

**修正猜测**：forum **不**生成角色观点、**不**调 LLM。它是本地客户端到远程 Socratopia 社区服务的**认证代理 BFF**。用户可把自制的 companion 角色卡 / 故事作为草稿发布到社区。

### 6.5 rollback（状态修复，非快照恢复）

**不恢复消息内容**（消息删除由前端完成）；它做的是**回滚后的派生状态一致性修复**：
1. 恢复"教材阅读窗口"起始页——按优先级：阅读日志 log → 消息里最后一次 read_textbook_pages tool_use 的 startPage → initial_reading.json
2. 找到后加锁调 `o8()` 重建阅读窗口
3. **作废摘要**：若当前消息数 < lesson_summary 哨兵 windowStart，删该摘要文件

---

## 第七部分：Companion / World / Profile 管理

### 7.1 `/api/companion/reconcile-persona`（字段级外科手术）

**修正猜测**：这**不是**"对话历史驱动的人设漂移修正"，而是"字段级更新"——用户改了 npc 槽的**显示名/身份/代词**后，让 LLM 把改动同步进 persona markdown 同时保留其余内容 verbatim。

**Prompt（英文原文）**：
```
You are a persona-document maintenance assistant for a Socratic-tutor app.
You will be given a persona markdown file plus target values for a few fields (display name, bio/role, pronoun) and a target gender-directive line.
Your job is to surgically update ONLY the requested fields and the gender-directive line. Preserve EVERYTHING ELSE verbatim — narrative paragraphs, dialogue examples, section headings, list formatting, blank lines, separators, language style, and any user-authored idiosyncrasies.
Do not reorder sections, do not re-sentence narrative, do not paraphrase, do not translate, do not add or remove sections, do not add commentary.
If the persona uses a custom (non-preset) structure, respect it as-is.
Output ONLY the full updated markdown file. No code fences, no preamble, no explanation.
```

- 长度校验：out/in 比值必须 0.85~1.3
- 必须包含目标名与性别标签
- 通过后**整份重写落盘**（非 patch）

### 7.2 `/api/custom-companions/merge-persona`（拼装文档，不落盘）

**不同用途**：把结构化基本信息头块 + persona 正文拼装成完整文档并返回（落盘由调用方 PATCH 完成）。system prompt 极短：3 条规则（原样输出头块、后接正文、只输出 markdown）。

### 7.3 Avatar 路由（全部**不生图**）

`companion/avatar`、`custom-companions/avatar`、`profile/avatar`、`pet/avatar` 都是纯静态 upload/serve/delete。真正的"头像来源"是**创建世界时从 `bundled-content/initial_world/candidates_pic/<id>.png` 拷贝**。

### 7.4 `/api/custom-companions`（自定义伙伴 CRUD）

- **上限 20 个**
- id = `ct_` + 8 位 [a-z0-9]
- index.json（元数据）+ `<id>.md`（persona 正文）+ `<id>.<ext>`（头像）分开存

### 7.5 `/api/translate`（占位符保护式翻译）

**关键技术**：**占位符保护**。翻译前用正则把代码块、LaTeX、行内 code、HTML 标签、URL 抽成 `⟦M0⟧⟦M1⟧⟦M2⟧…` 占位符，翻译后还原并校验 `intact` 布尔。

Prompt 核心（英文）：
```
You are a precise, faithful translator. Translate the user's text into ${b}.

HARD RULES:
- Tokens of the form ⟦M0⟧, ⟦M1⟧, ⟦M2⟧ … are PROTECTED PLACEHOLDERS. Copy each EXACTLY as-is, in place. Never translate, remove, alter, split, merge, or reorder their internal characters, and never invent new ones.
- Translate ONLY the surrounding prose. Keep technical terms accurate.
- Preserve the paragraph structure: keep blank lines between paragraphs where the source has them.
- Do NOT add notes, prefaces, explanations, or quotation marks around the output.
- Output ONLY the translation.
```

### 7.6 `/api/test-key` — **已被彻底 stub**

无论传什么，直接返回 `{"error":"BYOK_NOT_AVAILABLE"}` status 400。

### 7.7 `/api/system` — 世界文档编辑器后端

**不是**系统健康检查，而是让用户在 UI 里直接编辑 `story.md / learner_profile.md / npc_[abc].md` 的 CRUD 后端。字符上限：story 4000 / learner 1500 / npc 1500（英文 ×3.4）。POST 白名单仅这 5 个文件。

### 7.8 `/api/account/init` — 多账户迁移

- 校验 accountId 格式，设为当前 account
- `migrateIfNeeded`：如果旧的顶层 `profiles/` 存在且未打过 `.migrated` 标记，则把它 rename 到 `accounts/<id>/`
- **不生成 device_id**、**不拉规则**、**不建默认 profile**

### 7.9 `/api/profile`（user profile）

- 上限 5 个
- 字段：`{id:u+7位, name, nicknames:[name], avatar, createdAt, pinHash?, pinSalt?}`
- PIN：4 位数字 + SHA-256(salt:pin)，`timingSafeEqual` 比对，连续 5 次失败锁 30 秒

`/api/profile/reset`：body 必须 `{confirm:true}`，**递归删除整个 profile 根目录再重建**。

### 7.10 `/api/world` — 世界 CRUD 与 bundled content 的关系

- worldId = 2 位大写字母随机
- 上限 5
- 创建时从 `bundled-content/{语言目录}/initial_world/` 拷贝：
  - `world_preset.md` (blankStory 时用 `world_preset_blank.md`) → `worlds/<XX>/story.md`
  - 每个选中候选人：`candidates/<fileName>` → `npc_x.md`；`candidates_pic/<id>.png` → `companions/npc_x.png`
- 程序生成 `learner_profile.md` 模板
- **首个 world 不自动 seed**——必须通过 POST /api/world 显式创建

### 7.11 9 个内置候选角色

三大类 × 3 个 = 9 位：

- **female**：邱灵霓（大一 CS，热烈冒险）/ 鹿语萌（大一数学，毒舌温柔）/ 闻莺（大一物理，骄傲锐利）
- **male**：陶砺（AI 博一，沉稳）/ 霍云来（大一生物，热烈直冲）/ 孟煦（大三历史，慵懒通透）
- **legend**：孙悟空（热能系海归教授）/ 福尔摩斯（法医实验室主任）/ 爱丽丝（化工少年大学生 15 岁）

每张卡是**数百字的深度心理侧写**。英文版**改名**而非音译（邱灵霓 → Kira Walsh）。

---

## 第八部分：Electron 主进程与前端

### 8.1 主进程 (`dist-electron/main.js`, esbuild 打包未压缩, 34557 行可读)

**启动流程**（`app.whenReady()`）：
1. `initUserData()` → `setupStore(ipcMain)` → `createMenu()`
2. **权限处理器**：只放行 `media`（麦克风）和 `clipboard-sanitized-write`，其余全拒
3. 注册 IPC handler
4. `initAutoUpdater(isDev)` — electron-updater，autoDownload=false
5. **`startServerWithPortResilience()`** — 启动 Next server（子进程）
6. `createWindow()` → `mainWindow.loadURL('http://localhost:${serverPort}')`

**Next server 是 `child_process.fork` 子进程**（不是 in-process require）：
```
env: {
  PORT: 13713 (优先, 从 userData 的 port 文件读 hint),
  HOSTNAME: "127.0.0.1",   ← 强制 IPv4 loopback
  NODE_ENV: "production",
  PROJECT_ROOT: <userData>,
  CONTENT_ROOT: <bundled-content 路径>,
  NODE_PATH: <.next/node_modules>
}
```

**端口韧性**：首选 13713 冲突则随机，最多 3 次尝试。启动前 `cleanupStaleChild` 清理上次孤儿子进程。

**退出清理**：`app.on("before-quit")` → `serverProcess.kill()` + 删 pid 文件。

**BrowserWindow**：`1200×800`, `titleBarStyle:"hiddenInset"`, `contextIsolation:true`, `nodeIntegration:false`, `devTools:!isPackaged`, `setWindowOpenHandler` 一律 `shell.openExternal + deny`。

### 8.2 IPC 通道

| 通道 | 用途 |
|---|---|
| `store:getApiKey / setApiKey` | BYOK Key（**发行版被硬短路**） |
| `store:getSessionToken / setSessionToken` | 经 `safeStorage`（OS keychain/DPAPI）加密存储 |
| `app:getVersion / isPackaged` | 版本信息 |
| `device:getId / getInfo` | `machineIdSync` → sha256 截 16 位 |
| `window:toggleMaximize` | 窗口控制 |
| `pdf:export` | 离屏 BrowserWindow `printToPDF`（A4 + 页码 footer） |
| `shell:openSocratopia` | **仅允许** `https://socratopia.app{path}` |
| `update:check/download/cancel/install/getLastStatus` | 更新流程 |
| `update-status`（推送） | 主进程 → 渲染 |

### 8.3 前端 SSE 解析器（主对话循环）

```js
let x = resp.body?.getReader();
let h = new TextDecoder, f="", g="", b="", v=false, y=[];
for (;;) {
  let { done, value } = await x.read(); if (done) break;
  let a = (b += h.decode(value, {stream:true})).split("\n\n");
  b = a.pop() || "";
  for (let e of a) if (e.startsWith("data: ")) try {
    let t = JSON.parse(e.slice(6));
    if      (t.type === "text")               e9.current = f += t.text, ta();
    else if (t.type === "reasoning_content")  g += t.text;
    else if (t.type === "thinking_observed")  t.value === true && r && et(r);
    else if (t.type === "tool_use")           { let e={name:t.name,input:{},label:t.label}; y.push(e); e6([...y]); }
    else if (t.type === "tool_result")        { /* 按 name 回填 label */; e6([...y]); }
    else if (t.type === "usage")              { let e=(t.inputTokens||0)+(t.outputTokens||0); e>0 && (ea(r,e), a_(e)); }
    else if (t.type === "companion_note")     t.text?.trim() && ed(r, t.text.trim());
    else if (t.type === "reading_range")      rI({startPage,endPage,totalPages});
    else if (t.type === "error")              { v=true; /* 哨兵映射 */ }
  } catch {}
}
```

### 8.4 引用标记前端解析

```js
let tt = /〔§(\d{1,4})(?:[｜|]([^〕\n]{0,120}))?〕/g,
    tr = /〔§[^〕\n]{0,120}(?=\n|$)/g,
    ts = /〔§[^〕\n]{0,200}〕/g;

function tl(e){
  if (!e.includes("〔\xa7")) return e;
  let { t, restore } = tn(e);  // tn: 用 \0Q<idx>\0 占位符保护代码块，最多 8 轮
  return restore(t.replace(tt, (m, p) => `（\xa7${p}）`)
                   .replace(ts, "").replace(tr, ""));
}
```

### 8.5 客户端拼接的 prompt（全表）

**结论：发行版前端不做 system prompt 拼装，也不直连 LLM SDK**。但客户端会**注入几处 user 消息文本**：

1. **翻页教学触发**（`isPostJump:true`）：`请从第 ${e} 页开始教学。`
2. **默认宠物人设**：领养时随 `POST /api/pet/profile` 的 `persona_md` 字段上送
3. **语音预览示例**：`Hi, I'm your study companion. Let's start today's lesson together.`

### 8.6 语音功能

- **合成**：`AudioContext` + `voicePlayer` 单例队列，调 `synthesize(text, lang, key, abortSignal, "classroom")` 走远端后端
- **数据模型**：pet profile 带 `voice_language`, `voice_key`（如 `mimo_bingtang`、`mimo_milo`）, `voice_speed`
- **配额**："Voice Pack" 余额机制
- **音频留存**：结束课程时询问是否保留本课音频
- **/voice-test 独立路由**：配合 `public/voice-samples/` 试听

### 8.7 自动更新

`electron-updater`：`autoDownload=false`, `autoInstallOnAppQuit=false`, `allowDowngrade=false`, generic feed `https://releases.socratopia.app`。

---

## 第九部分：数据存储全景

**根目录**：`PROJECT_ROOT/`（Windows 上为 `%APPDATA%/Roaming/Socratopia/`）。

```
PROJECT_ROOT/
├─ device_id                        (12 位 [a-z0-9]，惰性生成)
├─ accounts/
│  ├─ account_map.json              (lastActiveAccountId, email, lastLogin)
│  └─ <accountId>/
│     ├─ forum_key                  (社区匿名账号 key)
│     ├─ pet_unlock.json            (孵化解锁进度)
│     └─ profiles/
│        ├─ profiles.json           (账号列表 + pinHash/pinSalt)
│        └─ <profileId>/
│           ├─ avatar.<ext>          (user 头像)
│           ├─ pet/                  (宠物子系统)
│           │  ├─ state.json         (level/lifetime_card_count/...)
│           │  ├─ profile.md
│           │  ├─ pet_relations.md
│           │  ├─ knowledge_digest.md
│           │  ├─ summaries_archive.md
│           │  ├─ avatar.png
│           │  ├─ summaries/<NNN>.md
│           │  ├─ cards/<uuid>.md
│           │  ├─ lessons/<ts>.md
│           │  └─ conversations/<sid>.json
│           ├─ custom_companions/
│           │  ├─ index.json
│           │  └─ <ct_xx>.{md,png,jpg,...}
│           ├─ flashcards/
│           │  ├─ favorites.json
│           │  └─ <textbookId>.json
│           └─ worlds/
│              ├─ active.json       ({worldId, textbookId})
│              └─ <XX>/            (2 位大写字母)
│                 ├─ world_meta.json
│                 ├─ story.md
│                 ├─ learner_profile.md
│                 ├─ npc_a.md / npc_b.md / npc_c.md
│                 ├─ relation_npc_a/b/c.md
│                 ├─ pal_moments.md
│                 ├─ world_records.md
│                 ├─ companions/npc_[abc].{png,jpg,webp}
│                 ├─ groupchat/
│                 │  ├─ recent.md
│                 │  ├─ last_read.txt
│                 │  ├─ broadcasted.json
│                 │  ├─ broadcast_attempts.json
│                 │  └─ archive/<YYYY-MM>.md
│                 ├─ diary/<YYYY-MM>.md
│                 ├─ concept-summaries/<cid>.json
│                 ├─ lesson_summaries/<cid>.md
│                 ├─ textbooks/
│                 │  ├─ textbook_index.json
│                 │  └─ <tid>/
│                 │     ├─ <原文件> 或 <加密>.qbook
│                 │     ├─ pages.json          (manifest, 非 PDF)
│                 │     ├─ preface.json        (contentStartPage + method)
│                 │     ├─ toc.json            (PDF LLM 抽取)
│                 │     ├─ progress.md
│                 │     ├─ current_reading.md  (textbook 级 fallback)
│                 │     ├─ session_plan.md     (伙伴课中临时)
│                 │     └─ handoff/
│                 │        ├─ last_tail.json
│                 │        └─ last_meta.json
│                 └─ conversations/<cid>/
│                    ├─ current_reading.md       (conv 级优先)
│                    ├─ current_reading_summary.json
│                    ├─ reading_log.json
│                    ├─ initial_reading.json
│                    └─ handoff.json             (per-conv 交接)
```

**关键设计**：**文件即记忆**——完全用 Markdown/JSON 当"结构化 embedding"存长期上下文，让 LLM 自己读写；比向量库更可解释、可回滚（`/api/rollback`）、可导出。整个系统里**没有向量库、没有 RAG、没有 embedding 索引**。

---

## 第十部分：提示词模板与状态管理方案总结

### 10.1 提示词模板机制（无引擎，四种朴素做法）

1. **JS 模板字符串** `` `...${var}...` `` — 最常见，变量在闭包捕获
2. **`{{PLACEHOLDER}}` 双大括号** + `.replace()` — 用于静态多语言模板，运行时替换（`{{PET_NAME}}`、`{{pet_name}}`）
3. **`%%TOKEN%%` 双百分号** + `.replace()` — 用于运行时条件段落（`%%FAREWELL_NARRATION_NOTE%%` 按 hideNarration 选择插入哪段）
4. **拼接式**：`[...].join("\n\n---\n\n")` — 段落级组装，每段可条件添加/跳过

同一份 prompt 也可能**远程加载 + 本地拼接**（教学规则从 `/rules` 拉，本地包一层）。

### 10.2 多轮状态管理策略（全靠文件系统）

| 状态 | 存储 | 载入方式 |
|---|---|---|
| 角色人设 | `npc_*.md` | 每次请求整份读入 system prompt |
| 世界背景 | `story.md` | 同上 |
| 角色关系 | `relation_npc_*.md` | 同上，下课后 LLM 覆写（缓慢演化） |
| 学习者档案 | `learner_profile.md` | 同上 |
| 教材进度 | `textbooks/<tid>/progress.md` | 下课时 LLM 生成、覆写；保留最近 5 节课 |
| 教材当前窗口 | `current_reading.md` | LLM 通过 `read_textbook_pages` 拉入，后端存 |
| 教材"可引用片段" | `pal_moments.md` | 下课时 LLM 追加新条目，超长删旧 |
| 长会话溢出 | `lesson_summaries/<cid>.md` | 后台 deepseek 压缩，`<!-- windowStart -->` 哨兵 |
| 跨会话交接 | `handoff/last_tail.json` + `last_meta.json` | 下课写入尾部 N 条，下次开课自动 seed 一条虚构 user 消息 |
| 教练分析 | 进程内 `Map` | 上一轮 TAE 结果 → 下一轮 system prompt 补丁 |
| 阅读窗口态 | 进程内 `dq: Map<convId, {...}>` | jump / tool_use / 扩窗时更新 |
| 前后半摘要缓存 | `current_reading_summary.json` + 内存 | deepseek 生成 |
| 教材 pipeline | `preface.json` + `toc.json` + `pages.json` | LLM 初次导入时确定 |

**上下文压缩**：
- 主对话 `chunks/73909:Yn()`：保留 user/assistant 最近 10 条，总 token ≤1500，单条超限截末尾 + `[...]`
- 更早消息由后台 lesson-summary 压缩到 `lesson_summaries/<cid>.md`
- Pet 对话固定 `slice(-24)`，无摘要压缩
- 群聊 recent.md 尾部 3000 字符

**语言切换协议**：换 teachingLanguage 且历史里已有 assistant 消息时，服务端**手工插入一条虚构 assistant 消息**：`（语言切换确认。从现在起，我将全程使用 X 回答。）`——用假 assistant 消息让 LLM"承诺"过。

### 10.3 结构化输出协议

系统里有**三种输出协议并存**，按场景选择：

| 协议 | 用于 | 例子 |
|---|---|---|
| **分隔符 `===TAG===`** | 复杂多段落覆写（非流式或流式都行） | 下课六段产物 |
| **`response_format:"json_object"`** | 需要严格 JSON 但没有真正 tool_call | 评教 submit_review、concept-summary、教材 preface/toc/元信息 |
| **OpenAI tool_calls** | 交互对话，工具执行 | 主对话的 read_textbook_pages / read_file / write_file / get_textbook_toc |

**JSON 修复器 `chunks/65705:f()`** — 专门处理 LaTeX 反斜杠 + 游离引号 + 位置探测式补引号（最多 50 轮），是这个系统能容忍 LLM JSON 输出错误的核心。

---

## 第十一部分：值得学习的十个设计模式

1. **文件即记忆**
   Markdown/JSON 当结构化长期状态，比向量库更可解释、可回滚、可导出、可让用户直接编辑；`/api/system` 甚至给出前端编辑 UI。

2. **双 LLM 元监督**
   主 LLM 说话，教练 LLM（deepseek-chat 固定）观察 10 轮对话后写下一轮的 system prompt 补丁 + `contentProgress` 二值。防"绕圈子/飘离/批评作者/空洞回答"，并驱动自适应翻页。

3. **假 tool_call**
   服务端在首轮伪造一次 `read_textbook_pages`，让前端看到"翻开教材"动画，但实际教材已通过 system prompt 直塞——UX 与技术实现解耦。

4. **手工插入虚构消息**
   跨会话交接时插入一条虚构 user 消息说明"这是上节课末尾发生的"；语言切换时插入一条虚构 assistant 消息让 LLM 承诺——**用消息历史本身当额外的 prompt 通道**。

5. **manifest-based 反幻觉**
   下课时把用户所有 user 消息编号列成清单，反复强调"清单外 = 虚构"；`user_quote` 服务端与 manifest 逐字比对，对不上会被清空。**幻觉可执行地被压制**。

6. **三层前置知识建模**（pet）
   把"学生的知识"分成"教过的卡 / 开悟笔记 / 学科前置基础自动校准"。让 LLM 既表现出对基础的娴熟，又表现出对被教内容的天真——这是 pet 系统的核心心智模式。

7. **教练评教信必须具体化**
   评教 prompt 明令"不能说'讲得不够生动'，必须给'下次先讲一个生活场景，再落定义'"，并且每次都要指出**最佳瞬间**并**引用老师原话**——好的行为被看见才会被重复。

8. **重叠+末页守恒的滑动窗口**
   自适应翻页时：新窗 = 旧窗后半 ⊕ 新内容（重叠保持话题连续）+ 末页取倒数第二个页标记（避免把只露一半的最后一页当已读完）。

9. **占位符保护式翻译**
   翻译时用 `⟦Mi⟧` 抽出代码块 / LaTeX / URL 等不可翻译片段，翻译后还原并校验完整性——**用 LLM 做通用文本翻译时的通用模式**。

10. **分隔符协议做多产物覆写**
    下课时用 `===TAG===` 让 LLM 单次生成 6 段各自落盘的文件——比多次 tool_call 更省 token，比 JSON 更抗解析错误（每段是自由 Markdown），比六次 LLM 调用更快。前提是段落间语义正交（告别 / 记录 / 进度 / 日记 / 关系 / 寄语），不需要跨段引用。

---

## 附录 A：全部 40+ API 路由一览表

| 路由 | 方法 | LLM | 用途 |
|---|---|---|---|
| `/api/account/init` | POST | 否 | 账号迁移 |
| `/api/chat` | POST(SSE) | ★ | 主对话 / 女娲 / 下课 三合一 |
| `/api/companion/avatar` | GET/POST/DELETE | 否 | 头像文件 |
| `/api/companion/reconcile-persona` | POST | ★ | 字段级人设同步 |
| `/api/concept-summary` | GET/POST | ★ | 课堂笔记（8-section JSON）|
| `/api/conversations` | GET/POST/DELETE | 否 | 会话 CRUD + 级联删除 |
| `/api/custom-companions` | GET/POST/PATCH/DELETE | 否 | 自定义伙伴 CRUD |
| `/api/custom-companions/avatar` | GET/POST/DELETE | 否 | 头像文件 |
| `/api/custom-companions/merge-persona` | POST | ★ | 拼装 persona 文档 |
| `/api/diary` | GET/POST | 否 | 日记读写 |
| `/api/flashcard` | GET/POST | ★ | 生成 MCQ + SM-2 |
| `/api/forum` | GET/POST | 否 | 社区 BFF |
| `/api/groupchat` | GET/PUT/PATCH/DELETE | ★(SSE) | 多角色群聊 |
| `/api/jump-page` | POST | 否 | 跳页预取 |
| `/api/lesson-summary` | GET/POST | ★ | 窗口压缩（内部触发）|
| `/api/pdf-assets` | GET | 否 | KaTeX CSS + 字体 |
| `/api/pet/auto-teach` | POST | ★ | 教学助理 |
| `/api/pet/avatar` | GET/POST/DELETE | 否 | 宠物头像 |
| `/api/pet/cards` | GET/PATCH | 否 | 卡片 CRUD |
| `/api/pet/chat` | POST(SSE) | ★ | 宠物主对话 |
| `/api/pet/conversation` | GET/POST/DELETE | 否 | 单会话 CRUD |
| `/api/pet/conversations` | GET | 否 | 会话列表 |
| `/api/pet/end-lesson` | POST | ★★ | 苏格拉底评教（2 次并行 LLM）|
| `/api/pet/enlighten` | POST | ★★★ | 升级开悟（3 次 LLM）|
| `/api/pet/lesson` | GET | 否 | 单 lesson 读取 |
| `/api/pet/lessons` | GET | 否 | lesson 列表 |
| `/api/pet/profile` | GET/POST/DELETE | 否 | 领养/改料 |
| `/api/pet/summaries` | GET | 否 | 开悟 summaries 读 |
| `/api/pet/unlock-status` | GET/POST | 否 | 孵化解锁进度 |
| `/api/profile` | GET/POST/PATCH/DELETE | 否 | user profile CRUD |
| `/api/profile/avatar` | GET/POST/DELETE | 否 | 头像 |
| `/api/profile/reset` | POST | 否 | 递归删除当前 profile |
| `/api/reading-context` | GET | 否 | 阅读范围 + TOC |
| `/api/rollback` | POST | 否 | 派生态修复 |
| `/api/search` | GET | 否 | 会话全文检索 |
| `/api/stats` | GET | 否 | 学习时长/连击 |
| `/api/system` | GET/POST | 否 | 世界文件编辑 |
| `/api/test-key` | POST | 否 | **stub, 恒返 BYOK_NOT_AVAILABLE** |
| `/api/textbook` | GET/POST/PATCH/DELETE | ★ | 教材导入 + LLM 三阶段分析 |
| `/api/textbook-section` | GET | 否 | 查看引用原文（非 PDF）|
| `/api/translate` | POST | ★ | 占位符保护翻译 |
| `/api/world` | GET/POST/PATCH/DELETE | 否 | 世界 CRUD |

其中 `★` = 有 LLM 调用；PET 的 end-lesson 与 enlighten 是**单请求内串/并行多次 LLM**。

---

## 附录 B：一次主对话请求的完整流水（时序图）

以"用户在教材第 5 页界面发送一条消息"为例：

```
[前端]                              [Next server / route.js]                   [代理 llm.socratopia.app]

POST /api/chat  ─────────────────►  1. 认证 X-Session-Token / device_id
{messages, character, textbookId,   2. 若首消息: 假 tool_call read_textbook_pages
 conversationId, teachingLanguage,     → chunks/3358.js: extract PDF page 5→17
 accessMode:"hosted", sessionToken}    → 写 conversations/<cid>/current_reading.md
                                    3. 检查 handoff tail 是否存在
                                       → 若有: 把 tail 消息注射到 messages 前面
                                    4. 若 [下课] 前缀 → 走课后产物分支
                                    5. 后台从 M map 取上一轮 TAE 结果
                                       → 渲染成教练分析块拼到 system 末尾
                                    6. buildSystemPrompt (Ex):
                                       - 远程拉 /rules?lang=... (缓存 1h)
                                       - 读 npc_a.md / relation_npc_a.md
                                       - 读 story / learner_profile / pal_moments
                                       - 读 world_meta / groupchat/recent 尾 500
                                       - 读 textbook entry + progress + current_reading
                                       - 拼 20+ 段 (\n\n---\n\n)
                                    7. streamLLM (zf) with tools:
                                       [read_textbook_pages, get_toc, read_file, write_file]

                                       POST /v1/chat/completions  ──────────► 分发到 deepseek-v4-flash
                                       Headers: X-Session-Token,               (or 用户选的其他家)
                                                X-Force-Provider (hosted),
                                                X-Socratopia-Purpose: chat

                                    ◄─── SSE stream 增量事件 ───

data: {type:"text", text:"嗯……"}    ◄── 服务端翻译并转发                    ◄── openai SDK 事件
data: {type:"text", text:"你问"}     ◄── 中间可能穿插:
data: {type:"tool_use",              ◄── tool_use 拦截 → chunks/3358.js:o8
       name:"read_file",                 → 执行 read_file (读 diary/2026-06.md)
       label:"翻看日记..."}
data: {type:"tool_result",           ◄── 结果不发给前端 (只发 label)
       name:"read_file",
       label:"翻看日记..."}          [服务端把工具结果 tool 消息插回 messages, 再调 LLM 继续]
data: {type:"text", text:"..."}
data: {type:"reasoning_content",     ◄── deepseek-reasoner/chat 才有
       text:"..."}
data: {type:"usage",                 ◄── LLM 最终 usage
       inputTokens:5432,
       outputTokens:198}
data: {type:"done"}

                                    8. 后台异步:
                                       - 触发 TAE 分析 (chat/route.js:I → deepseek-chat)
                                         结果存入 M map, 下次请求消费
                                       - 若 TAE 判定 second_half 累计够
                                         → 加锁 WN(cid), 执行 xC 扩窗
                                         → 生成新前后半摘要 (deepseek)
```

**关键洞察**：一次用户消息可能触发**多达 3-4 次 LLM 调用**（主对话 + 教练分析 + 前后半摘要 + 潜在的工具循环回环）——用户感知不到，但每一次都在为下一轮准备更好的 prompt。

---

## 附录 C：所有已挖出的完整 Prompt 索引

按主题分类，供后续查阅时定位到具体文件：

**主对话教学**：
- 远程规则（rules）：`https://llm.socratopia.app/rules?lang=X[&noEnd=1]` — Lemin 可远程调
- 教练分析：`chat/route.js:462+`（zh `O` / en `P`）
- AI 代答：`chat/route.js:693+`

**下课六段产物**：
- 主指令：`chat/route.js:1-260`（zh `K` / en `L`）
- Manifest + 铁律注入：`chat/route.js:611+`

**女娲世界管理**：
- 女娲人设 + 第一铁律：`chunks/4026.js` module `35684:_()` 约 250 行

**群聊**：
- 群聊生成器：`groupchat/route.js:184+`（函数 `B` 自带完整 prompt）
- 群聊课后摘要器：`groupchat/route.js:164+`（函数 `C`）

**宠物**：
- Pet 主人设：`chunks/2361.js` module `12361`（zh `g` / en `h` / zh-TW `i`）
- 语言段：`chunks/2361.js` `j/k/l`（三语，`m(lang)` 选择）
- 苏格拉底评教：`chunks/2570.js` module `41901`（zh `e`，`g(petName,lang)` 附加语言规则）
- 评教 user prompt：`chunks/2570.js:189` 函数 `f/OU`
- 下课寄语 pet_note：`pet/end-lesson/route.js:12+`（三语）
- 开悟主 prompt：`pet/enlighten/route.js:1+`（zh `D` / en `E` / zh-TW `F`）
- 开悟归档压缩：`pet/enlighten/route.js` `G/H/I`
- 知识画像文案：`pet/enlighten/route.js` `J/K/L`
- 教学助理 auto-teach：`pet/auto-teach/route.js:1+`

**教材导入**：
- TOC 选起始节：`chunks/2751.js:3-66`（zh `t` / en `u`）
- 教材信息提取：`chunks/2751.js:69-140`（zh `C` / en `D`）
- TOC 结构化抽取：`chunks/2751.js:171-215`（zh `F` / en `G`）
- 教材原文引用标记规则：`chunks/86363.n5(lang)` 三语

**课后产物**：
- 长会话摘要：`lesson-summary/route.js` 常量 `C/D`（zh/en）
- 长摘要二级压缩：`lesson-summary/route.js` `E/F`
- 概念摘要 8-section：`concept-summary/route.js` `M`(zh) / `P`(en)（`K+L` / `N+O` 两部分拼合）
- 闪卡 MCQ 生成：`flashcard/route.js` `Q`(zh) / `R`(en)

**Companion 管理**：
- reconcile-persona 人设同步：`reconcile-persona/route.js`（三语，字段级外科手术）
- merge-persona 拼装：`custom-companions/merge-persona/route.js`（3 条规则短 prompt）
- translate 占位符保护：`translate/route.js`

---

**报告完**。全程只读，`D:\Socratopia` 下的**原始**文件未做任何修改（本报告为新增文件，位于 `D:\Socratopia\REVERSE-ENGINEERING-REPORT.md`）。系统的所有关键设计——LLM 抽象层、五个子系统的完整 prompt、教材 pipeline、宠物子系统、Electron 前后端边界——均已覆盖。
