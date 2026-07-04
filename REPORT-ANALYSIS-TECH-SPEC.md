# 月报与评分表分析系统 · 技术方案 v0.1

> **写在前面**：这份文档是我们讨论到目前为止的整合，也是**你和我一起趟坑的地图**。方案会随实际情况迭代，v0.1 的目标不是"完美"，而是"能让我们看清楚接下来 3 个月会遇到什么问题"。
>
> **日期**：2026-07-04
> **状态**：讨论稿，待用户对若干决策点确认后进入 v0.2
> **参考**：借鉴了 `REVERSE-ENGINEERING-REPORT.md` 里 Socratopia 的几个模式（文件即记忆、双 LLM 元回路、manifest 反幻觉、分隔符协议、串行队列）

---

## 目录

- 一、背景与目标
- 二、核心概念与术语
- 三、系统架构
- 四、数据模型
- 五、Pipeline 与状态机
- 六、文件分类器（五关）
- 七、Schema 设计原则
- 八、Prompt 分层策略
- 九、报告生成
- 十、权限与协作
- 十一、实施路径（5 周计划）
- 十二、风险与坑（重点章节）
- 十三、明确不做什么
- 十四、待决问题清单

---

## 一、背景与目标

### 1.1 场景

用户每月要收集：
- **月报**：由运营方产出，针对**实体建筑**和**实体客户**，作者不同、格式基本模板化但小节自由
- **评分表**：由**下级监管部门**产出，针对**实体建筑**打分

单月约 60+ 份文件，**持续增量到达**（不是一次性批量）。

### 1.2 目标产出（三种切片）

| 报告类型 | 输入 | 频率 |
|---|---|---|
| **单文件分析** | 一份文件 | 每份来一次 |
| **维度汇总** | 某月所有文件 · 按维度切片 | 每月每维度一份 |
| **跨月分项** | 某实体 · 某维度 · 多月 | 按需 |

### 1.3 非目标（此系统不做）

- 不做实时数据看板（月度批处理够用）
- 不做移动端
- 不做多租户 SaaS
- 不做 RAG / 向量库（学 Socratopia：文件即记忆更合适你这个体量）
- 不做 BI 工具的替代（Metabase/Superset 那种）

---

## 二、核心概念与术语

| 概念 | 说明 |
|---|---|
| **实体 (Entity)** | 建筑或客户，是数据分析的主体。有稳定 ID（BLD-001 / CUS-001） |
| **维度 (Dimension)** | 安全 / 运营 / 财务 / 客户满意度等，是数据分析的切片方向 |
| **期间 (Period)** | `YYYY-MM` 格式，是数据分析的时间轴 |
| **文件 (File)** | 一份 PDF 原始文件 |
| **抽取 (Extract)** | 一份 PDF 对应的结构化 JSON |
| **发现 (Finding)** | 抽取产物里的一条 issue / highlight / finding，有跨月追踪的 cluster_id |
| **度量 (Metric)** | 抽取产物里的一个数字（分数、能耗、投诉数等），打平存表 |
| **主档 (Master Data)** | 实体清单 + 别名 + 维度定义，由人工维护 |
| **分诊 (Triage)** | 分类器无法自动定位实体时的人工介入 |
| **审核 (Review)** | 抽取结果的人工校正（OCR 错字等） |

---

## 三、系统架构

```
┌──────────────────────────────────────────────────────────────┐
│  浏览器（团队成员）                                            │
│    - 上传 PDF                                                  │
│    - 分诊 / 抽取校正                                            │
│    - 触发/查看报告                                              │
│    - 实体主档管理                                               │
└─────────────────────┬────────────────────────────────────────┘
                      │ HTTPS + session
┌─────────────────────▼────────────────────────────────────────┐
│  Next.js 应用（app router）                                    │
│    · 认证：magic link 或简单账号密码                            │
│    · 路由：/api/upload、/api/files、/api/report、/api/entity  │
│    · 统一 LLM 入口：callLLM(purpose, messages, opts)           │
└─────────────────────┬─────────────────┬───────────────────────┘
                      │                 │
                      ▼                 ▼
              ┌───────────────┐   ┌──────────────────────────┐
              │  PostgreSQL   │   │  Worker 进程（Node/Python）│
              │               │   │    轮询 jobs 表           │
              │  详见 §4      │   │    执行以下阶段：           │
              └───────────────┘   │      1. MinerU            │
                                  │      2. 分类器 5 关        │
                                  │      3. LLM 抽取           │
                                  └────┬─────────────────────┘
                                       │
                        ┌──────────────┴────────┐
                        ▼                       ▼
                ┌──────────────┐      ┌─────────────────────┐
                │  MinerU      │      │  LLM 网关             │
                │  (本地或 API) │      │  (DeepSeek/Claude...) │
                └──────────────┘      └─────────────────────┘

  文件系统:
    D:\report-analysis\
      ├─ raw\<YYYY-MM>\*.pdf                  ← 原始文件
      ├─ mineru\<file-uuid>\{full.md,images/, content_list.json}
      └─ backup\<date>\pg_dump.sql
```

**关键设计决定**：

1. **文件系统 + 数据库分工明确**：大文件（PDF、MinerU 输出）走文件系统，结构化数据走 PG。数据库里存路径引用。
2. **单一 LLM 入口**（学 Socratopia 的 `callLLM`）：所有 LLM 调用走一个函数，未来换 provider / 加限流 / 加日志一处改。
3. **数据库轮询队列**：60 份/月量级不需要 Celery/BullMQ。一张 `jobs` 表 + `SELECT ... FOR UPDATE SKIP LOCKED` 够用。
4. **本地部署或轻云**：一台服务器（能跑 Postgres + Next.js + Worker）即可。团队 <10 人。

---

## 四、数据模型

### 4.1 实体主档

```sql
CREATE TABLE entities (
  id VARCHAR(20) PRIMARY KEY,           -- BLD-001, CUS-001
  type VARCHAR(20) NOT NULL,            -- building | customer
  canonical_name VARCHAR(200) NOT NULL,
  aliases TEXT[],                       -- ["望京SOHO", "望京S0HO", "SOHO T2"]
  filename_patterns TEXT[],             -- 正则数组
  active BOOLEAN DEFAULT true,
  metadata JSONB,                       -- 面积、地址、投用日期等
  created_at TIMESTAMPTZ,
  created_by VARCHAR(50)
);

CREATE TABLE dimensions (
  code VARCHAR(50) PRIMARY KEY,         -- safety, operations, financial, ...
  name_zh VARCHAR(100),
  description TEXT,
  sub_items JSONB,                      -- [{key:"fire", name:"消防"}, ...]
  display_order INT
);

-- 别名审计日志
CREATE TABLE entity_alias_log (
  id UUID PRIMARY KEY,
  entity_id VARCHAR(20) REFERENCES entities(id),
  alias TEXT NOT NULL,
  source VARCHAR(30),          -- initial_seed | manual_review | llm_suggested
  added_from_file_id UUID,
  added_by VARCHAR(50),
  added_at TIMESTAMPTZ
);
```

### 4.2 文件与抽取

```sql
CREATE TABLE files (
  id UUID PRIMARY KEY,
  original_filename VARCHAR(500),
  raw_path TEXT,
  raw_hash CHAR(64) UNIQUE,             -- 防重复上传
  raw_size_bytes BIGINT,
  raw_page_count INT,                   -- PDF 页数，用于 MinerU 配额规划

  file_type VARCHAR(50),                -- monthly_report | scoring_table | unknown
  period VARCHAR(10),                   -- 2026-06
  entity_ids VARCHAR(20)[],             -- 多实体文件用数组
  author_dept VARCHAR(100),

  mineru_path TEXT,
  mineru_version VARCHAR(20),
  mineru_processed_at TIMESTAMPTZ,

  classification_status VARCHAR(20),    -- pending|auto_matched|needs_review|confirmed|conflict
  classification_source VARCHAR(30),    -- filename_hash|regex|content|llm|human
  classification_confidence VARCHAR(20),
  classified_by VARCHAR(50),
  classified_at TIMESTAMPTZ,

  supersedes UUID REFERENCES files(id), -- 补正/修订版链

  upload_by VARCHAR(50),
  uploaded_at TIMESTAMPTZ,
  status VARCHAR(20)                    -- uploaded|mineru_running|mineru_done
                                        --   |classified|extracting|extracted
                                        --   |reviewed|failed|superseded
);

CREATE TABLE extracts (
  file_id UUID PRIMARY KEY REFERENCES files(id),
  schema_version VARCHAR(20),
  prompt_version VARCHAR(20),           -- 追溯是哪版 prompt 抽的
  llm_model VARCHAR(50),
  data JSONB NOT NULL,                  -- 抽取全文
  original_data JSONB,                  -- 人工校正前的原始 LLM 输出

  extracted_at TIMESTAMPTZ,
  reviewed_by VARCHAR(50),
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT
);
```

### 4.3 打平表（跨月分析的关键）

```sql
CREATE TABLE metrics (
  file_id UUID REFERENCES files(id),
  entity_id VARCHAR(20) REFERENCES entities(id),
  period VARCHAR(10),
  dimension VARCHAR(50) REFERENCES dimensions(code),
  metric_key VARCHAR(100),              -- score, energy_kwh, complaint_count, ...
  metric_value NUMERIC,
  metric_unit VARCHAR(20),              -- kwh, %, count, score, ...
  confidence VARCHAR(20),
  source_quote TEXT,                    -- 反幻觉：原文引用
  source VARCHAR(20),                   -- self_report | regulator
  PRIMARY KEY (file_id, dimension, metric_key)
);

CREATE INDEX ON metrics (entity_id, dimension, period);
CREATE INDEX ON metrics (period, dimension);

CREATE TABLE findings (
  id UUID PRIMARY KEY,
  file_id UUID REFERENCES files(id),
  entity_id VARCHAR(20),
  period VARCHAR(10),
  dimension VARCHAR(50),
  severity VARCHAR(20),                 -- high|medium|low
  finding_type VARCHAR(20),             -- self_issue|regulator_finding|highlight
  description TEXT,
  source_quote TEXT,
  cluster_id UUID                       -- 跨月同类问题归到一个 cluster
);
```

### 4.4 报告

```sql
CREATE TABLE reports (
  id UUID PRIMARY KEY,
  report_type VARCHAR(30),              -- single_file|dimension_summary|cross_month
  scope JSONB,                          -- {entity_id, dimension, period, from, to}
  content_md TEXT,
  input_file_ids UUID[],
  input_extract_hashes TEXT[],          -- 用于判断"报告是否已陈旧"
  prompt_version VARCHAR(20),
  llm_model VARCHAR(50),
  generated_by VARCHAR(50),
  generated_at TIMESTAMPTZ,
  stale BOOLEAN DEFAULT false           -- 输入被修订后自动置 true
);
```

### 4.5 任务队列

```sql
CREATE TABLE jobs (
  id UUID PRIMARY KEY,
  job_type VARCHAR(30),                 -- mineru|classify|extract
  file_id UUID REFERENCES files(id),
  status VARCHAR(20),                   -- queued|running|done|failed
  attempts INT DEFAULT 0,
  error_message TEXT,
  locked_by VARCHAR(50),                -- worker instance id
  locked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
CREATE INDEX ON jobs (status, job_type);
```

---

## 五、Pipeline 与状态机

每个文件的生命周期：

```
uploaded (files.status)
    │
    ▼ [job: mineru]
mineru_running
    │
    ▼
mineru_done
    │
    ▼ [job: classify]
classified (成功)  →  extracting
或  needs_review  →  等人工分诊  →  classified
或  conflict      →  等人工裁决
    │
    ▼ [job: extract]
extracted
    │
    ▼ [人工在 UI 里点"审核通过"]
reviewed  ←← 只有 reviewed 状态的文件参与最终报告 ←←
    │
    ▼ (可回退到 extracted 重新审核)

失败路径：
  * → failed (记 error_message, UI 显示"重试"按钮)

修订路径：
  新文件.supersedes = 老文件.id
  老文件.status = superseded
  → 老文件的 metrics / findings 从跨月分析中排除
  → 引用了老文件的报告 stale = true
```

**关键守门**：
- **只有 reviewed 状态的文件**参与最终报告生成 —— 数据质量的核心防线
- **classification_status = confirmed** 才允许进入 extract 阶段 —— 免得抽出来才发现挂错了实体

---

## 六、文件分类器（五关）

按顺序尝试，命中即停。**每关命中都记录 `classification_source`**，未来出错能追溯。

| 关卡 | 依据 | 成本 | 说明 |
|---|---|---|---|
| **1. 文件名 hash** | 见过的完全相同文件名 | 0 | 用户上传习惯稳定时命中率高 |
| **2. 文件名 regex** | entity.filename_patterns | 0 | 手动维护正则数组 |
| **3. 内容 alias 扫描** | MinerU 前 500 字对 entity.aliases 扫 | 0 | 支持编辑距离 ≤2 的模糊匹配（应对 OCR 错字）|
| **4. LLM 兜底** | 文件名+前 1000 字+全实体清单 | 一次 LLM 调用 | 输出 confidence 与 reasoning |
| **5. 人工分诊** | UI 里一屏一份，可勾"以后自动归到该实体" | 人工 | **每次分诊都在训练关卡 1/2/3** |

### 6.1 关卡 4 的 LLM Prompt 草案

```
你是一位文件分类助手。任务：判断这份文件属于哪个实体、什么月份、什么文件类型。

已知实体清单（只能从这里选）：
- BLD-001: 望京SOHO T2 (别名: 望京SOHO, SOHO T2, 望京索厚)
- BLD-002: 国贸三期 (别名: CWTC, 国贸)
- ...

文件类型：monthly_report | scoring_table

文件名: <filename>
内容前 1000 字（MinerU 输出）:
---
<mineru_snippet>
---
上传时间参考: 2026-07-15  ← 用于推断跨年时的 period

严格 JSON 输出（response_format:"json_object"）：
{
  "entity_ids": ["BLD-001"] 或 [],     // 允许多实体或空
  "entity_confidence": "high|medium|low",
  "entity_reasoning": "≤50 字，必须引用原文或文件名的具体片段",
  "period": "YYYY-MM" 或 null,
  "period_confidence": "high|medium|low",
  "file_type": "monthly_report|scoring_table|unknown",
  "needs_human_review": true|false
}

规则：
- entity_ids 只能从清单里选，找不到宁可返回空数组
- confidence 是 medium/low 时 needs_human_review=true
- period 缺年份时用上传时间辅助推断，但跨年边缘（12月/1月）必须 needs_human_review=true
- reasoning 必须引用具体证据，不许"根据整体判断"
```

### 6.2 学习曲线预期

| 阶段 | 文件量 | 手动率 |
|---|---|---|
| 第 1 个月 | 60 份历史 | ~80%（aliases 库空）|
| 第 2 个月 | 20 份新增 | ~30% |
| 第 3 个月 | 20 份新增 | ~10% |
| 6 个月+ | 稳态 | ~5%（只在新实体首次出现时）|

**第一个月痛，但不是白痛**：aliases 库在这一个月内被攒出来。

---

## 七、Schema 设计原则

参考 Socratopia 的经验，抽取 schema 遵循这些原则：

1. **稳定 ID**：每个 issue / finding 有全局唯一 id，供跨报告引用
2. **原文引用字段**：`quote` / `quotes[]` 逐字复制原文，后续合成报告时**只允许引用清单里的话**（manifest 反幻觉）
3. **数字与描述分离**：`numeric_metrics` 独立字段，跨月做趋势直接用
4. **每字段可 null**：LLM 找不到就填 null，绝不猜
5. **schema_version 必填**：改 schema 就升版本号，抽取缓存自动失效重抽
6. **confidence 与来源**：每个数字带 confidence 与 source_quote，人工校正时能快速定位
7. **实体归一化**：LLM 从原文抽出的名字要归一到 `entity_id`，用主档的 aliases 辅助

（具体 schema 骨架见前面几轮对话，此处不再重复；v0.2 会附具体 monthly_report.v1.json / scoring_table.v1.json）

---

## 八、Prompt 分层策略

学 Socratopia 的双 LLM 元回路思路：

| 层级 | 用途 | 推荐模型 | 何时触发 |
|---|---|---|---|
| **Level 1 抽取** | markdown → JSON | DeepSeek-chat 或 Haiku | 每份文件必做 |
| **Level 2 校验**（可选） | 复核 Level 1 输出的可疑项 | Sonnet 或 DeepSeek-v4 | Level 1 confidence low、数字异常、schema 修复过 |
| **单文件报告合成** | JSON → 500 字执行摘要 | Sonnet 或 DeepSeek-v4 | 用户请求 |
| **维度汇总合成** | 多 JSON → 分节报告 | Sonnet 或 DeepSeek-v4 | 每月每维度触发 |
| **跨月分项合成** | 时间序列 JSON → 趋势叙事 | Sonnet 或 DeepSeek-v4 | 按需触发 |

**关键纪律**（学 Socratopia）：
- 用 `===TAG===` 分隔符协议做多段落覆写，不用 JSON（更抗解析错误）
- 每个 prompt 里塞 manifest（本次涉及的所有原文引用），明令"清单外 = 虚构 = 禁止"
- 每个 prompt 有 **schema_version + prompt_version** 存进 `extracts` 表，方便追溯"这条数据是哪一版 prompt 抽的"
- Prompt 迭代时**保留旧版本**，可以随时回滚
- 每次改 prompt 前跑 5-10 份代表性文件的回归测试

---

## 九、报告生成

三种报告 = 三个查询函数。数据已结构化，token 用量小。

### 9.1 单文件报告

**输入**：`extracts.data` (JSONB) 一行
**Prompt 要点**：
- 500 字以内执行摘要
- 三个亮点 + 三个风险（引用 issue.id）
- 所有引用必须使用 `quote` 字段原文
- 输出 markdown

### 9.2 维度汇总

**输入**：某月所有 metrics 里该维度的行 + 相关 findings + 相关 quotes
**Prompt 要点**：
- 全局评分分布（用 SQL 算好塞进去，不让 LLM 算）
- 跨实体共性问题（先聚类，让 LLM 命名 cluster）
- 自评 vs 监管评分差异大的实体（SQL 算好差值 top-N）
- 分节：`===OVERVIEW=== ===COMMON_ISSUES=== ===GAP=== ===ACTIONS===`

**关键**：**能用 SQL 算的数就用 SQL**，LLM 只负责叙事。别让 LLM 加减法。

### 9.3 跨月分项

**输入**：某实体 · 某维度 · 多月的 metrics + findings（含 cluster_id）
**Prompt 要点**：
- 数字趋势用 SQL 算好塞成表格
- findings 按 cluster 分组，标记"反复出现"
- 3 条具体建议

---

## 十、权限与协作

小团队场景（<10 人），最简化设计：

| 角色 | 权限 |
|---|---|
| **admin** | 全部 + 实体主档 + 用户管理 |
| **analyst** | 上传、分诊、抽取审核、生成报告 |
| **viewer** | 只读文件与报告 |

- 认证：magic link（邮件收链接登录）或简单账号密码
- session 存 cookie（HttpOnly + Secure）
- 所有写操作记 audit log（谁在什么时候改了什么）
- 分诊/审核操作显示"最后修改者"和时间

**协作坑防范**：
- 同一份文件同时被两人审核 → **锁定机制**：`extracts.reviewing_by` + `reviewing_started_at`，5 分钟无操作自动释放
- 实体主档并发修改 → optimistic lock（`updated_at` 版本号）

---

## 十一、实施路径（5 周计划）

### Week 1：跑通单文件端到端
- Next.js + Postgres 起项目
- files/extracts 两张表
- 手动上传 1 份 PDF → 手动触发 MinerU → 手动调 LLM 抽取 → 存 JSON → 页面显示
- **成功标准**：能看到一份文件的结构化数据
- **不做**：队列、认证、批量、UI 美化

### Week 2：schema 迭代 + 抽取质量
- 拿 10 份真实文件跑抽取
- 每份看输出，记失败样例，加 prompt 负面规则
- 加最简单的校正 UI（丑没关系）
- **成功标准**：这 10 份的抽取结果你信得过

### Week 3：批量 + 分类器
- 加 jobs 表和 worker
- 实现分类器 5 关
- 建实体主档（先手工把你已知的建筑/客户填进去）
- 批量导入 60 份历史文件
- **成功标准**：60 份全部完成分诊 + 抽取 + 审核

### Week 4：第一份维度汇总报告
- 挑你**现在最痛**的报告类型（比如"月度安全维度汇总"）
- 写 prompt 模板 → 生成 → 和你手写的对比 → 迭代
- **成功标准**：你愿意用它替代手写

### Week 5：铺开与协作
- 加认证 + 团队邀请
- 加第二、第三种报告
- 加最基础的 SQL 仪表盘（各建筑本月分数排名等）

---

## 十二、风险与坑（重点章节）

按遇到时间的早晚粗略排序。**每一条都是"我们知道会遇到，先商量好怎么办"**。

### A. 数据层面

#### A1. **一份 PDF 包含多个实体**
评分表可能是"监管科 · 6 月 · 3 栋建筑打分"——一份 PDF 里多个实体的数据。
**对策**：schema 里 `entity_ids` 是数组；抽取 prompt 明确"允许多实体"；metrics 表按 entity 拆行。

#### A2. **一份 PDF 包含多个月份**
罕见但存在（半年汇总、跨月补交）。
**对策**：schema 里 `period` 可以是数组或 `period_range: {from, to}`。默认按数组处理，跨月的记录在 metrics 表按月拆行。

#### A3. **同一建筑在不同来源里叫不同名字**
月报口径叫"望京SOHO T2"，评分表口径叫"望京 A 区"。
**对策**：先做实体主档梳理，把跨口径映射写进 aliases。**这是业务问题，不是技术问题——必要时你要跟下级监管部门对齐口径**。如果就是不能对齐，主档里显式建模"1 对多"关系（一个建筑对应多个 regulator_regions）。

#### A4. **年份缺失**
"6 月月报"没写年份，跨年时（12 月 vs 次年 1 月）容易错。
**对策**：分类器 4 关 LLM prompt 里塞入 upload_time 作为参考；跨年边缘强制人工审核。

#### A5. **补交 / 修订版**
"望京SOHO_202605_修订版.pdf" 应该覆盖旧的还是新增？
**对策**：`files.supersedes` 字段 + UI 显式选择"这是修订版，覆盖 XXX"。被 supersede 的文件从跨月分析中排除，但保留可查。**规则**：一份文件只能被 supersede 一次链上，不允许分叉。

#### A6. **PDF 损坏 / 加密 / 空文件**
上传时校验，标记为 `broken`。**不消耗 MinerU 配额**（上传时先本地检测）。

#### A7. **OCR 错字**
"望京SOHO" → "望京S0HO"（数字 0）——直接匹配失败。
**对策**：aliases 里主动收录常见 OCR 变体；分类器关卡 3 用**编辑距离 ≤2 的模糊匹配**。

#### A8. **数字识别错误**
`87.5%` 被识别成 `875%` 或 `87.5X`。
**对策**：抽取 prompt 明令"数字必须能在原文找到且合理，找不到或异常填 null 并标 low confidence"；Level 2 校验对异常数字重抽；审核 UI 高亮 low confidence 字段。

#### A9. **表格跨页 / 表头嵌套**
MinerU 处理已经很强，但仍会出错。
**对策**：schema 允许 partial 结果；抽取时把 MinerU 的 `content_list.json`（保留了表格块的边界）也塞给 LLM 作为参考。

### B. 主档层面

#### B1. **实体列表本身漂移**
新建筑投用、老建筑退租、客户流失。
**对策**：`entities.active` 字段；报告生成时可选"包含已停用"；跨月分析明确显示"该实体 XX 月起停用"。

#### B2. **别名冲突**
"SOHO" 到底是望京SOHO 还是三里屯SOHO？
**对策**：新加 alias 时检查冲突，冲突则**强制加限定词**（如 "望京SOHO" 不能只叫 "SOHO"）；分类器命中多个实体时直接进人工分诊。

#### B3. **主档并发修改**
两人同时改 aliases，其中一人的改动被覆盖。
**对策**：optimistic lock（updated_at 版本号），冲突时 UI 提示"已被 XX 修改，请刷新"。

#### B4. **维度定义漂移**
"运营"维度里的子项 6 月是 [能耗, 保洁, 电梯]，9 月加了 [绿化] —— 跨月对比时新旧维度对不上。
**对策**：`dimensions.sub_items` 带 `effective_from` 时间戳；跨月报告显式标注"维度变更时间"。

### C. 抽取层面

#### C1. **Schema 演进**
schema v1 → v2 后，旧的 extracts 怎么办？
**对策**：`extracts.schema_version` 必存；报告生成时按 schema_version 分组处理（或强制 rerun 到最新版）；提供批量重跑工具。

#### C2. **Prompt 版本不一致**
6 月抽取用 prompt v1，7 月改到 v2 后跨月对比结果口径不一致。
**对策**：`extracts.prompt_version` 必存；每次改 prompt 前跑代表性回归测试；重大改动伴随批量重跑。

#### C3. **LLM 输出的 JSON 解析失败**
即使用 `response_format:"json_object"`，仍偶尔失败。
**对策**：至少 3 层 fallback（学 Socratopia）：贪婪 JSON 抓取 → 去尾逗号/控制字符重试 → LaTeX-aware 修复。仍失败 → 记为 `extract_failed` 进人工队列。

#### C4. **LLM 幻觉：编造数字或引用**
LLM 编造原文里没有的数字或"引用"。
**对策**：manifest 反幻觉（把 MinerU 原文分段编号塞进 prompt，规定引用必须来自 manifest）；抽取后**服务端做逐字校验**——`source_quote` 必须在原文中出现，否则字段清空并标 `verification_failed`。

#### C5. **抽取质量随时间 drift**
LLM 服务端可能升级模型，同样 prompt 输出变化。
**对策**：`extracts.llm_model` 存具体版本；建立**回归测试集**（10 份代表性文件的期望输出），每月跑一次检查基线。

### D. 报告层面

#### D1. **报告陈旧**
报告生成后，其输入文件被修订（supersede）。
**对策**：`reports.input_extract_hashes` 存输入哈希；文件被修订时自动扫描相关报告置 `stale=true`；UI 显示"输入已更新，建议重新生成"。

#### D2. **报告可复现性**
同一 scope 生成两次结果不一样，用户会疑惑。
**对策**：`reports` 表**只保留最新一份**（scope + report_type 唯一），旧版本移到 `reports_history`；显示时明确"生成于 XX，模型 XX，prompt vX"。

#### D3. **LLM 算错数字**
让 LLM 做加减法/百分比计算容易出错。
**对策**：**所有数字预先用 SQL 算好塞进 prompt**，LLM 只负责叙事，不做计算。Prompt 里明令"不要重算数字，只使用提供的数字"。

#### D4. **报告合成 token 超限**
汇总时 60 份文件全塞进去可能超模型上下文。
**对策**：预先在 SQL 层聚合（分数分布、top-N 问题等）；只塞聚合结果和引用样例；单个 findings 数量截断（保留 severity=high 的全部 + 其他抽样）。

#### D5. **叙事平庸 / "AI 味"重**
"总体运营良好，但存在一些安全隐患"——正确废话。
**对策**：报告 prompt 里塞禁用词清单（"总体良好"、"存在一些"、"整体来看"、"值得关注"）；要求每个论断必须**引用具体 finding.id 或 metric**。

#### D6. **报告能不能作为正式文件外发**
LLM 生成的报告有幻觉风险，作为管理内部工具 OK，但对外行文需要人工签发。
**对策**：产品定位上明确"辅助工具"；报告 UI 显式水印"AI 生成，需人工复核后使用"；提供"标记为已复核"操作。

### E. 协作层面

#### E1. **人工审核疲劳**
60 份 × 每份 5 分钟 = 5 小时的抽取审核。团队没人愿意做。
**对策**：优先审核 low confidence 字段（UI 高亮）；批量"审核通过高置信度部分"按钮；审核工作量做成看板（谁审了几份，透明化）。

#### E2. **分诊标准漂移**
张三把某文件归到 BLD-001，李四会归到 BLD-002。
**对策**：分类器关卡 4 的 LLM 结果 + reasoning 作为参考；分诊 UI 显示"历史上类似文件的归属"；争议文件标记 `conflict` 由 admin 裁决。

#### E3. **权限混乱**
viewer 想生成报告 / analyst 想改主档。
**对策**：三级 RBAC 从一开始就实施，不要"先都是 admin，以后再拆"——从来没人真的拆。

#### E4. **上传去重误伤**
同一份 PDF 内容改动一个字符 hash 就变——被当新文件；反之，两份内容完全一样但对应不同月份（罕见）会被误判重复。
**对策**：hash 冲突时 UI 提示"检测到相同文件，已有 XXX，确认新上传？"

### F. 运维层面

#### F1. **MinerU 配额爆表**
月初批量导入几百页，1000 页/天不够。
**对策**：Worker 有速率控制（每天可配置额度）；超额自动排队到次日；大文件（>50 页）单独队列低优先级；提前给用户预估"这次批量需要 3 天完成"。

#### F2. **LLM API 限速 / 掉线**
LLM 提供商 rate limit 或宕机。
**对策**：`callLLM` 统一入口做 retry + backoff；失败任务留在 jobs 表可手动重试；每次失败记录 error 便于事后分析；配置多 provider fallback。

#### F3. **数据库备份**
PG 挂了整个系统废。
**对策**：每日 `pg_dump` 到 `backup/` 目录；周备份异地（云盘 / 另一台机器）；每月做一次恢复演练。

#### F4. **文件系统膨胀**
MinerU 输出 + 原文件 + 备份，一年后可能几十 GB。
**对策**：`raw/` 定期归档到冷存储；MinerU 中间产物（images/）可清理，md 保留；数据库 vacuum 定期跑。

#### F5. **敏感数据外流**
月报/评分表含敏感数据，走云 LLM 存在合规风险。
**对策**：（业务决策）如果敏感级别高，切换本地部署 LLM（性能下降接受）；LLM 请求日志脱敏（不记全文，只记 metadata）；团队签保密协议；LLM provider 选择时看数据处理条款。

### G. 业务 / 组织层面

#### G1. **下级监管部门抵触**
"你要用 AI 汇总我的评分？"
**对策**：产品定位为**辅助管理层**而非监督下级；输出报告显示"AI 汇总，非考核依据"；提前沟通用途。

#### G2. **老板期望值管理**
以为 AI 能"自动出结论"，实际仍需要人工判断。
**对策**：产品上线前展示 "AI 能做什么 + 不能做什么"清单；每份报告最后一节留"人工判断建议"占位。

#### G3. **系统一年后无人维护**
你换岗后系统烂掉。
**对策**：写详细的 README + 运维手册；关键 prompt 有完整版本历史；至少一个备份维护人熟悉全流程；schema 迁移脚本齐全。

---

## 十三、明确不做什么

学 Socratopia：产品有骨相是因为减法。

- ❌ **不做 RAG / 向量库**：你的量级用不上，文件即记忆更可解释
- ❌ **不做实时数据看板**：批处理够用
- ❌ **不做 AI 自动裁决**：所有争议进人工分诊
- ❌ **不做 AI 直接外发报告**：都是"辅助"，必须人工复核
- ❌ **不做 BYOK**：LLM provider 由 admin 统一配置
- ❌ **不做移动端**：桌面浏览器够用
- ❌ **不做多语言**：中文单一
- ❌ **不做插件系统 / 可视化规则编辑器**：规则写死在代码里，你的规模不需要
- ❌ **不做无 schema 抽取**：所有抽取必须走强 schema
- ❌ **不做 24/7 SLA**：能容忍偶尔停机

---

## 十四、待决问题清单

下面这些需要你在 v0.2 之前拍板：

### 高优先级
1. **实体主档规模**：你手上有多少个建筑？多少个客户？（决定第一版主档投入）
2. **下级监管部门口径**：月报口径与评分表口径能否对齐？如果不能，怎么建模映射？
3. **敏感级别**：数据能否走云 LLM？还是必须本地？（决定选型和成本）
4. **团队规模与角色**：谁做分诊、谁做审核、谁看报告？
5. **服务器**：本地一台机器还是云上？域名？

### 中优先级
6. **维度体系**：具体几个维度？每维度有哪些子项？
7. **报告类型清单**：你现在每月出哪些报告？哪份最痛？
8. **历史数据回溯**：要不要把过去 N 个月的历史文件也导入？
9. **报告受众**：给自己看 / 给团队看 / 给领导看 —— 决定叙事风格

### 低优先级
10. **UI 详细交互**：分诊页布局、审核页布局
11. **备份策略细节**：冷备频率、恢复演练频率
12. **审计日志**：留多久

---

## 附录：这一版技术方案的自我评估

**这份方案的强项**：
- 借鉴了 Socratopia 里已被验证的模式（文件即记忆、双 LLM、manifest 反幻觉、分隔符协议、串行队列）
- 明确了减法（第 13 节）
- 明确了坑（第 12 节）
- 有渐进实施路径（第 11 节）

**这份方案的弱项**：
- 没有具体 schema 细节（等你回答待决问题清单后进 v0.2）
- 没有具体 prompt 全文（同上）
- UI 只画了 ASCII 原型，正式做需要更详细的交互稿
- 成本估算缺失（60 份文件/月的 LLM 花费大约多少）
- 没有考虑数据迁移到未来系统的可能性（如果 3 年后要换栈）

**建议下一步**：先回答第十四节的**高优先级**问题（尤其是 1、2、3），再一起画 schema v1 和分类器 prompt v1，然后进 Week 1 的原型。

---

**方案结束**。这是 v0.1，不是最终版。真正的技术方案永远是**跑过几遍才成熟**的。我们边做边改。
