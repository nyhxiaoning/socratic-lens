# 审计流程改进 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复审计系统的结果指向性问题和操作便利性缺陷

**Architecture:** 6 个独立改动，从后端到前端逐步推进：先修覆盖度审计的多会话支持 + 删除激进截断 → 修 prompt 矛盾 → 修 UI 结果指向性 → 修会话选择器信息

**Tech Stack:** Next.js 15 / React 19 / TypeScript

## 全局约束

- 不改 `.gitignore` 之外的配置文件
- 不改现有测试文件，不改 prompt 的整体结构
- 改 prompt 时只加条件式说明，不删原行格式约束

---

## 文件映射

| 文件 | 改动 |
|------|------|
| `lib/audit.ts` | 修改 `runCoverageAudit`：加载所有 sids 的 transcript，合并呈现；删 `truncateTranscript` 调用；加 500k 安全网 |
| `prompts/fidelity_extract.md` | 行格式约束段末尾加条件式 JSON 说明 |
| `prompts/fidelity_reconcile.md` | 同上 + `ac3` 前缀统一 → `cr3` 说明 |
| `prompts/coverage_reconcile.md` | 同上 + `cr*` 前缀改为 `ac*` |
| `app/page.tsx` | 报告标题用 `AUDIT_DIMENSIONS.find` 映射 |
| `components/useSession.ts` | `audit_done` 时刷新历史；失败时保留参数 + 报告区内重试 |
| `components/AuditPanel.tsx` | 会话选择器每行补 `节奏 · N/max 轮` |
| `components/CoverageSidebar.tsx` | `var(--fg)` → `var(--text)` |

---

### Task 1: 覆盖度审计支持多会话 + 删截断

**Files:**
- Modify: `lib/audit.ts` (runCoverageAudit 函数, 第 445-580 行区域)

**改动内容：**
- 加载所有 sids 的 transcript 并合并：按 `--- 会话 <sid>（<画像>）---` 分段拼入
- 删除 `truncateTranscript` 函数（第 557-572 行）和相关调用（第 510-513 行）
- 加 500k 字符安全网：`const MAX_TRANSCRIPT_CHARS = 500000`，仅在超过时截断前 20 + 后 20 轮，标注「基于截断对话」
- `sidCount` 从硬编码 `1` 改为 `sids.length`
- 截断时 `report.json` 写入 `truncated: true`
- 截断时报告头部标注 `⚠️ 本报告基于截断对话`

### Task 2: Prompt 自相矛盾修复

**Files:**
- Modify: `prompts/fidelity_extract.md`
- Modify: `prompts/fidelity_reconcile.md`
- Modify: `prompts/coverage_reconcile.md`

**改动内容：**
- 三个文件的行格式约束段末尾加：
  > 若本次以函数/工具形式调用，请忽略上面的行格式约束，直接按函数 schema 输出；否则按以下行格式输出。
- `coverage_reconcile.md`：`cr*` 前缀说明改为 `ac*`
- `fidelity_reconcile.md`：`cr3` 引用改为 `ac3`

### Task 3: UI 结果指向性修复

**Files:**
- Modify: `app/page.tsx`（第 391 行附近）
- Modify: `components/useSession.ts`（第 599-668 行区域）

**改动内容：**
- `page.tsx`：报告标题从三元表达式改为 `AUDIT_DIMENSIONS.find(x => x.id === s.auditDimension)?.label ?? s.auditDimension`
- `useSession.ts`：`audit_done` 时把新条目 push 进 `auditHistory`
- `useSession.ts`：审计失败时在报告区内显示「审计失败：<错误信息>」+ 重试按钮，保留 `pickedSids`/`selectedSample`/`auditDimension`

### Task 4: 会话选择器信息增强 + CSS 修复

**Files:**
- Modify: `components/AuditPanel.tsx`（第 295 行附近，会话 label 区域）
- Modify: `components/CoverageSidebar.tsx`（第 143 行）

**改动内容：**
- `AuditPanel.tsx`：每行补 `节奏 · N/max 轮`，sid 截断显示
- `CoverageSidebar.tsx`：`var(--fg)` → `var(--text)`
