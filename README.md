# Socratopia — 教·学·审 多 Agent 试验台

一个 Socratopia 风格的"教学-审计"系统：**教师 agent** 按苏格拉底式教学法一对一讲课，**学生 agent**（三种画像）只能从教师的话里学，**审计 agent** 跨会话评估教学质量和内容覆盖。

## 快速开始

```bash
npm install
cp .env.example .env.local   # 填入 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
npx next dev                  # http://localhost:3000
```

`.env.local` 最小配置：

```env
LLM_BASE_URL=https://api.deepseek.com
LLM_API_KEY=sk-xxx
LLM_MODEL=deepseek-v4-flash
```

支持任意 OpenAI 兼容端点（DeepSeek、火山方舟、OpenAI 官方等）。可选按 purpose 分模型：`LLM_MODEL_TEACHER` / `LLM_MODEL_LEARNER` / `LLM_MODEL_COACH` / `LLM_MODEL_AUDIT`。

## 使用

### 1. 上传一本书

观察页顶栏「上传书…」→ 选 `.md` 文件或粘贴 markdown → 预览自动切节 → 导入。

书的结构：`## 导论` / `## 第X章` / `## 第X节` 三级标题自动切。也可手动放到 `data/books/<slug>/`：

```
data/books/<slug>/
  manifest.json          # { "title": "...", "author": "...", "sections": [...] }
  sections/
    01.md
    02.md
```

参考 `data/books/example/`。

### 2. 跑一堂教学会话

选书 → 选节 → 选学生画像（冷淡 / 适度 / 话痨）→ 选节奏 → 开始。

教师和学生各自独立上下文（学生看不到原文），实时 SSE 流输出。每轮末尾双教练并行分析，注入下一轮 system prompt。支持最多 200 轮、自适应翻页、中途 resume。

### 3. 审计

会话结束后，在审计面板勾选一个或多个会话 → 选维度 → 运行。

四个审计维度：

| 维度 | 审什么 |
|---|---|
| `book` | 审书本身——概念清晰度、硬点、矛盾、改进建议 |
| `teacher` | 审教师——教法、画像匹配、规则违规 |
| `fidelity` | 保真度——合成教学 vs 源材料，逐条勾稽 |
| `coverage` | 覆盖度——对话覆盖了多少知识点/评价标准/易错点 |

支持**跨会话合审**——比如同一节三种学生画像合起来看差异。

## 三种学生画像

| 画像 | 积极性 | 典型行为 |
|---|---|---|
| 冷淡型 (`passive`) | 很低 | 问一句答一句，几乎不主动提问 |
| 适度型 (`moderate`) | 中等 | 不懂就问，懂了正常回应 |
| 话痨型 (`active`) | 很高 | 兴奋、话多、敢猜敢联想，容易跑题 |

## 目录

```
app/           Next.js App Router（观察页 + API）
lib/           核心逻辑（llm / session / teacher / learner / coach / audit / fidelity / coverage）
components/    React 组件
prompts/       System prompt 模板（teacher / learner 画像 / coach / audit）
scripts/       工具脚本
data/books/    书（本地文件，不提交到 git）
```

## 设计要点

- **文件即记忆**——书、prompt、会话全部落盘为文件，不依赖数据库
- **唯一 LLM 入口** `lib/llm.ts`——所有 provider 切换、日志、计费统一管理
- **独立上下文**——教师和学生各自维护独立的 messages 数组，方向相反
- **引用协议** `〔§id｜片段〕`——教师引用原文时带标记，自动做逐字校验

## License

MIT
