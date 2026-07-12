# Socratopia 逆向项目 · 对话上下文快照

> **用途**：跨设备 / 跨会话延续讨论时，把这份文件（+ 另外两份 md）喂给新 AI 助手，让它快速进入状态。
> **快照时间**：2026-07-03
> **前置阅读**：
> - `REVERSE-ENGINEERING-REPORT.md`（71 KB，系统架构完整逆向）
> - `AI-DRIVEN-DEVELOPMENT-INSIGHTS.md`（15 KB，方法论）

---

## 一、项目背景

用户希望**逆向分析 `D:\Socratopia`**（一个 Electron 桌面 app，v3.2.0，作者 Lemin），主要目标：**理解其提示词交互方案 + 系统架构**，最终为自己做类似项目做参考。

**关键约束**：全程只读，不修改 `D:\Socratopia\` 下的**原始应用文件**（新增的分析文档除外）。

---

## 二、已完成产出

### 1. `D:\Socratopia\REVERSE-ENGINEERING-REPORT.md`（71 KB）

完整逆向报告，覆盖：
- 宏观架构（Electron shell + Next.js standalone 子进程）
- LLM 抽象层（`callLLM` / `streamLLM`，OpenAI 兼容代理）
- 五大 LLM 子系统（主对话 / 女娲 / 下课 / 教练 TAE / 群聊）
- 宠物子系统（角色反转：用户是老师）
- 教材导入 pipeline（三阶段 LLM 分析 + 自适应翻页）
- 40+ API 路由一览
- 所有 prompt 的文件定位索引

### 2. `D:\Socratopia\AI-DRIVEN-DEVELOPMENT-INSIGHTS.md`（15 KB）

方法论篇：
- Socratopia 里人力 vs AI 的分布拆解
- 做同体量项目必须自己具备的三种能力
- 四阶段路径（产品定义 → 黄金路径 → prompt 迭代 → 横向铺开 → 发布工程）
- 5 个可复制的 prompt 模板（针对不同场景怎么和 AI 对话）
- 5 个常见陷阱
- 元技能：对 AI 说 NO

### 3. 本文件（`CONVERSATION-CONTEXT.md`）

---

## 三、已达成的关键理解（浓缩版）

1. **系统架构**：Electron 壳 + `child_process.fork` 一个 Next.js standalone 服务器（`localhost:13713`），前端 SSE 消费，业务代码几乎全部在 Next 服务端未混淆的 `route.js` 里
2. **LLM 调用链**：前端 → 本地 Next server → `https://llm.socratopia.app/v1/chat/completions`（OpenAI 兼容代理）→ 分发到 deepseek / anthropic / openai / gemini / qwen / moonshot / minimax
3. **发行版关键事实**：**BYOK 已被剥离**（`NEXT_PUBLIC_ALLOW_BYOK=false` + `verify-byok-stripped.sh` 校验），主进程 `store:getApiKey` 硬短路成 `return ""`。这是纯 hosted 版本
4. **提示词方案核心特征**：
   - **文件即记忆**（没有 RAG，全用 md 文件 + 每次读入 system prompt）
   - **双 LLM 元回路**（主 LLM 说话 + deepseek 教练 LLM 后台监督，教练的 JSON 结果注射进下一轮 system prompt）
   - **三种结构化输出协议**（`===TAG===` / `response_format:json_object` / tool_calls）
   - **manifest 反幻觉**（下课时把用户所有消息列成清单，禁止清单外引用）
   - **假 tool_call**（服务端伪造教材读取工具调用给前端演动画）
   - **手工插入虚构消息**（跨会话 / 语言切换时把假 user/assistant 消息注射进 messages）
5. **教学规则 `/rules` endpoint** 是远程加载的（缓存 1h，Lemin 可远程灰度调），返回 markdown 教学指令
6. **9 个内置角色 + 3 大类**（female / male / legend），每个角色几百字深度心理侧写，明显是人手写的
7. **产品设计有骨相**：明确不做 RAG / 生图 / 移动端 / 多用户协作 / 订阅制内容库

---

## 四、用户当前明确的意向

**用户想做的事**：**让 Socratopia 走自己的 LLM**（不用官方 hosted）。

**已给出的方案**（详见对话末端）：

### 方案 A（推荐）：环境变量 + 自建代理

1. 写 30 行 Node 代理：
   - `GET /rules` 返回自己写的教学规则 markdown（≥100 字符、以 `#` 开头）
   - `POST /v1/chat/completions` 透传到用户自己的 LLM
2. 启动：
   ```bat
   set SOCRATOPIA_PROXY_URL=http://localhost:8787/v1
   "D:\Socratopia\Socratopia.exe"
   ```
3. `D:\Socratopia\` 下一个字节都不改

### 需要注意的连带问题

- **sessionToken**：hosted 模式要求非空 sessionToken，如果 electron-store 里从未写过，需要想办法先塞一个（登录一次 / 拦截主进程 IPC / 或改主进程 main.js）
- **rules 内容**：用户已被建议**自己写**（而不是照抄 Lemin 的）——这变相是"用 Socratopia 当外壳跑自己的教学法"
- **`X-Session-Token` / `X-Device-Id` 等 header**：代理里可以完全忽略不校验
- **deepseek 特有的 `thinking` 参数**：如果用户 LLM 不支持，代理里 strip 掉再转发

### 用户还问过的相关问题

- **rules 怎么办**：已经给了方案（自己写 markdown 塞进代理）——**不是问题，反而是产品优势**
- **BYOK 是什么**：给了完整解释（Bring Your Own Key，被 Lemin 剥离掉的自带密钥模式）以及为什么剥离（商业化 / 质量控制 / 反滥用 / 合规）

---

## 五、待办 / 未决 / 可能的下一步

按可能性排序：

1. **实际动手搭代理跑起来**（用户可能自己做，也可能让 AI 帮做）
   - 关键卡点：sessionToken 问题的处理方式还没最终确认
2. **起草用户自己的教学 rules 内容**
   - 用户偏领域？教学法？还没聊到
3. **深挖 Socratopia 某个子系统的具体 prompt 原文**
   - 报告里有位置索引，可以按需展开逐字摘录
4. **讨论"完全无人工介入让 AI 复刻 Socratopia"** 的可行性和天花板（已聊过一轮，可深化）
5. **其它方向**（用户可能提出新的）

---

## 六、用户偏好观察（沟通风格）

- **偏好中文**，技术术语可英文
- **偏好直接落盘**：说"记录下来"、"写在 D 盘"意味着"写文件"，不是"回答一下"
- **不喜啰嗦**：一句话能说清就一句话
- **不满足于表面结论**：多次追问"为什么"、"影响多大"、"能做到什么程度"——喜欢真诚的、有量化的、不打包票的回答
- **不喜欢"AI 式积极"**：接受 AI 说"我做不到"或"我会撒谎"
- **约束遵守严格**：多次强调"不改任何东西"，任何写操作前要确认
- **有工程直觉**：能一眼看懂逆向报告里的技术细节，说明有编程/系统背景

---

## 七、下次继续的 Kickoff Prompt（复制这段到新 AI）

```
我想继续一个之前中断的项目讨论。项目是逆向分析一个 Electron 桌面应用 Socratopia（一个苏格拉底式陪读学习产品），最终目标是了解它的架构以便做类似产品，以及让它走我自己的 LLM。

先读这三份文档：
1. REVERSE-ENGINEERING-REPORT.md（系统逆向报告）
2. AI-DRIVEN-DEVELOPMENT-INSIGHTS.md（AI 协作方法论）
3. CONVERSATION-CONTEXT.md（对话上下文，你现在读的这份）

读完告诉我：
- 你已经理解 Socratopia 的核心架构（用一段话复述）
- 上次讨论到哪、哪些是未决的
- 我这次想继续深挖 [xxx，我会告诉你具体方向]

沟通风格：
- 直接、诚实，能说"不知道"或"做不到"就说
- 不用"AI 式积极"回复，不啰嗦
- 涉及改动 Socratopia 应用文件时，先确认再动
- 中文优先，技术术语可英文
- 写文档时直接落盘到 D:\Socratopia\ 下（如果我在同一台机器）或按当前工作目录（换机器了）
```

---

## 八、给未来 AI 的关键提醒

如果你是新 AI，请注意：

1. **别相信自己对 Socratopia 的"记忆"**——你没看过它。前面报告里的所有断言都是当时的 Claude 从代码里挖出来的**具体证据**。你要接续讨论前，先把三份 md 读完。
2. **别自作主张给用户加建议**——用户想清楚自己要什么。你的角色是"帮他执行 + 帮他挑战思路"，不是"帮他决定要不要做什么"。
3. **文件写入前先看一眼路径**——用户对"不改原始文件"这件事很敏感。新增的文档 OK，编辑他的应用文件 NOT OK 除非明确要求。
4. **前面两份 md 里的方法论，很多用户已经内化了**——不需要再重复"你应该手写 prompt 而不是让 AI 生成"这种话。他懂。
5. **BYOK 已剥离** + **hosted 需要 sessionToken** + **rules 是远程 markdown** ——这三个是让 Socratopia 走自定义 LLM 的核心技术障碍，方案已经给出，别再从头推导浪费时间。

---

**快照结束**。这份文档 + 前两份 md 加起来 ≈ 90 KB，能在任何 AI 助手的 context 窗口里放下。
