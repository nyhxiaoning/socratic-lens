# 审计流程改进设计

## 背景

对审计系统做了一次完整的检视，找到 20+ 个具体问题，按「操作便利性」和「结果指向性」分类。用户批准了改动方向，此文档是最终设计规范。

## 改动 1：覆盖度审计支持多会话

**现状**：`runCoverageAudit`（[lib/audit.ts:466](S:\Code\工作探索\书的审计\lib\audit.ts:466)）只取 `sids[0]` 的 meta 和 transcript，忽略其余会话。面板显示「N 会话」但只审一个。

**目标**：选中的多个会话全部参与审计——多会话的 transcript 合并呈现给 LLM，或按 session 分段展示。

**设计**：
- `runCoverageAudit` 加载所有 sids 的 transcript，合并为统一对话文本。多个会话按 session 分段（`--- 会话 <sid>（<画像>）---`），每段含完整 transcript。
- `sidCount` 从硬编码 `1` 改为 `sids.length`
- `sectionIds` 从 `[sm.sectionId]` 改为去重后的完整列表
- `sid` 只用于定位第一个 session 获取 bookSlug 等元信息（同 `runAudit` 的 `collectMaterial` 首条校验逻辑）

**不做的**：跨书审计（`collectMaterial` 已有校验，暂不修改）

## 改动 2：截断策略重设计

**现状**：`truncateTranscript`（[lib/audit.ts:558](S:\Code\工作探索\书的审计\lib\audit.ts:558)）在 >16k 字符时保留前 2 + 后 8 轮，中间 90% 对话丢弃。报告不标注截断。

**目标**：审计覆盖度时看到完整对话，不因截断丢失教学内容证据。

**设计**：
- 删除 `truncateTranscript` 函数和相关调用
- 仅在 >500k 字符时触发安全网截断（保留前 20 轮 + 最后 20 轮），标注「基于截断对话（保留 N/M 轮）」
- 安全网阈值写入 `MAX_TRANSCRIPT_CHARS = 500000` 常量
- 截断时在报告头部写入 `⚠️ 本报告基于截断对话` 标注
- 截断状态写入 `report.json` 的 `truncated: true` 字段

**理由**：DeepSeek 1M 上下文窗口，实际对话（几十轮、~20k 字符）远不到上限。500k 字符约等于 500 轮以上对话，你的 pacing 控制下不可能达到这个量，安全网只为极端异常准备。

## 改动 3：Prompt 自相矛盾修复

**现状**：`fidelity_extract.md`、`fidelity_reconcile.md`、`coverage_reconcile.md` 三个 prompt 里写「不要 JSON」，但主路径是 `callLLMWithTool`（JSON schema 输出），模型收到矛盾的指令。

**目标**：主路径（tool calling）和降级路径（纯文本）各自有清晰、不矛盾的指令。

**设计**：
- 在三个文件的行格式约束段末尾统一加一句话：
  > 若本次以函数/工具形式调用，请忽略上面的行格式约束，直接按函数 schema 输出；否则按以下行格式输出。
- 统一 id 前缀：`coverage_reconcile.md` 里的 `cr*` 前缀改为 `ac*`（与 `fidelity_extract.md` 的 `AC|` 行、category `criteria` 保持一致）

## 改动 4：UI 结果指向性修复

**现状**：三处影响结果指向性的 UI 问题。

**设计**：

**4a. 报告标题**（[app/page.tsx:391](S:\Code\工作探索\书的审计\app\page.tsx:391)）
- 从 `审计报告 · {s.auditDimension === "teacher" ? "教师教学质量" : "书质量"}`
- 改为 `审计报告 · ${AUDIT_DIMENSIONS.find(x => x.id === s.auditDimension)?.label ?? s.auditDimension}`
- 四个维度各自正确显示：审书 / 审教学 / 教学覆盖度 / 保真度

**4b. 审计历史刷新**（[components/useSession.ts:629](S:\Code\工作探索\书的审计\components\useSession.ts:629)）
- `audit_done` 事件时，把新条目 push 进 `auditHistory` 状态
- 新条目格式：`{ aid, dimension, bookSlug, sectionIds, sidCount, verdict, ts }`
- 若 `audit_done` 没有携带 verdict，用 `report.raw` 的前 60 字截取

**4c. 错误态 + 重试**（[components/useSession.ts:631](S:\Code\工作探索\书的审计\components\useSession.ts:631)）
- 审计失败时（`audit_error` 或 catch），在报告区内显示「审计失败：<错误信息>」+ 重试按钮
- 保留 `pickedSids`/`selectedSample`/`auditDimension` 以便原地重试
- 重试按钮复用 `runAudit` 逻辑，用相同参数重新提交
- 关闭面板时清除错误状态

## 改动 5：会话选择器信息增强（[components/AuditPanel.tsx:295](S:\Code\工作探索\书的审计\components\AuditPanel.tsx:295)）

**现状**：每行只显示 `sid` + 画像 label + `status`，缺轮数/pacing/覆盖度。

**设计**：
- 每行补 `节奏 · N/max 轮`（数据来自 `SessionListItem.turnsSoFar`、`maxTurns` 和 meta 的 pacing）
- 覆盖度维度下，如果有实时覆盖度数据，显示覆盖率
- sid 截断显示（取前 12 字符 + `…`）

## 改动 6：CSS 变量修复（[components/CoverageSidebar.tsx:143](S:\Code\工作探索\书的审计\components\CoverageSidebar.tsx:143)）

- `color: "var(--fg)"` → `color: "var(--text)"`

## 不改的范围

- `hasAllTags` 不改为可执行性校验（prompt 质量本身更重要）
- coverage 报告不做 markdown 渲染（纯 `<pre>` 可读，后续 UI 打磨再做）
- fidelity 空状态不做可操作入口（样本机制是 CLI 导入的）
- 严重度历史聚合不做（配合 dashboard 类需求再做）
- `reopenAudit` 状态混乱问题不单独修（改动 4c 的重试机制替代了 reopen 的用例）
- 维度切换时 `selectedSample` 串味问题不修（后续做 UI 重构时统一处理）

## 文件清单

| 文件 | 改动类型 |
|------|----------|
| `lib/audit.ts` | 修改 `runCoverageAudit`：多会话 + 删截断 + 安全网 |
| `prompts/fidelity_extract.md` | 加条件式 JSON 说明 |
| `prompts/fidelity_reconcile.md` | 加条件式 JSON 说明，统一 id 前缀 |
| `prompts/coverage_reconcile.md` | 加条件式 JSON 说明，统一 id 前缀 |
| `app/page.tsx` | 报告标题映射 |
| `components/useSession.ts` | 审计历史刷新 + 错误态重试 |
| `components/AuditPanel.tsx` | 会话选择器信息增强 |
| `components/CoverageSidebar.tsx` | CSS 变量修复 |

## 边界与风险

- **多会话覆盖度审计**：如果多个会话的 pacing 不同，以第一个会话的 pacing 为准（同 `runAudit` 的 `collectMaterial` 首条校验逻辑）
- **安全网标注**：截断只在极端情况下触发，标注确保读者知道报告基于截断对话
- **重试按钮**：仅在当前对话中有效，刷新页面后丢失（中间状态只存内存）
