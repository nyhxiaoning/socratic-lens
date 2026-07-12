# Git 双分支工作流备忘

## 分支说明

| 分支 | 用途 | 内容 |
|---|---|---|
| `master` | 本地开发 | 全量：源代码 + 内部文档（CLAUDE.md / PLAN.md / docs / tests / 全书）|
| `public` | 推给远端 | 精简：源代码 + README，不含内部文档 |

## 日常开发

**所有开发在 `master` 上做**：

```bash
git checkout master
# ... 写代码、改 prompt、跑测试 ...
git add -A
git commit -m "做了什么改动"
```

## 同步到 public（推公开）

当你要把最新代码推给别人时，执行三步：

```bash
# 1. 切到 public，合入 master 的最新代码
git checkout public
git merge master

# 2. 处理冲突——.gitignore 冲突时，保留 public 的版本
#    （如果这一步不熟，就问 Claude "帮我 sync public"）

# 3. 推 public 分支到远端的 master
git push origin public:master
```

> **注意**：第 3 步是把本地 `public` 分支推到远端的 `master` 分支。远端你只有一个分支（master），它是公开的。

## 如果合并出问题

合并 master → public 时可能出现：
- `.gitignore` 冲突 → 保留 public 版本（`git checkout --ours .gitignore`）
- 内部文档又出现了 → 重新移除跟踪（`git rm --cached CLAUDE.md PLAN.md docs/ lib/__tests__/ data/books/除了example/`）
- 不确定怎么办 → **复制这段话给 Claude：**「帮我同步 public，master 已经是最新的」

## 文件对照

| 文件/目录 | master（本地） | public（公开） |
|---|---|---|
| `app/` `lib/` `components/` `prompts/` `scripts/` | ✓ | ✓ |
| `README.md` | ✓ | ✓ |
| `data/books/example/` | ✓ | ✓ |
| `CLAUDE.md` `AGENTS.md` | ✓ | ✗ |
| `PLAN.md` `STATUS.md` | ✓ | ✗ |
| `REVERSE-ENGINEERING-REPORT.md` | ✓ | ✗ |
| `AI-DRIVEN-DEVELOPMENT-INSIGHTS.md` | ✓ | ✗ |
| `CONVERSATION-CONTEXT.md` | ✓ | ✗ |
| `docs/` | ✓ | ✗ |
| `lib/__tests__/` | ✓ | ✗ |
| `data/books/makesi/` | ✓ | ✗ |
| `prompts/learner_critic/mid/novice.md` | ✓ | ✗ |
| `GIT-WORKFLOW.md` | ✓ | ✗ |
| `.env.local` | ✓ | ✗（.gitignore 始终拦截）|
| `data/sessions/` `data/audits/` | ✗ | ✗（.gitignore 始终拦截）|
