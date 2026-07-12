# Git 双分支工作流备忘

## 分支说明

| 分支 | 用途 | 内容 |
|---|---|---|
| `master` | 本地开发 | 全量：源代码 + `_dev/`（内部文档/测试/全书）+ `CLAUDE.md` |
| `public` | 推给远端 | 精简：源代码 + README，`.gitignore` 拦截 `_dev/` 和 `CLAUDE.md` |

## 日常开发

**所有开发在 `master` 上做**：

```bash
git checkout master
# ... 写代码、改 prompt、跑测试 ...
git add -A
git commit -m "做了什么改动"
```

## 同步到 public（推公开）

当你要把最新代码推给别人时：

```bash
# 1. 切到 public，合入 master 的最新代码
git checkout public
git merge master

# 2. .gitignore 冲突 → 保留 public 版本
git checkout --ours .gitignore

# 3. 推 public 分支到远端的 master
git push origin public:master
```

> 第 3 步是把本地 `public` 分支推到远端的 `master` 分支。

## 如果合并出问题

- `.gitignore` 冲突 → `git checkout --ours .gitignore`（保留 public 版本，只有 `_dev/` + `CLAUDE.md` 两行）
- `_dev/` 目录重新出现在 public → `git rm --cached -r _dev/`（public 上这个目录只应在 .gitignore 里，不应被跟踪）
- 不确定怎么办 → **复制这段话给 Claude：**「帮我 sync public，master 已经是最新的」

## 文件对照

| 内容 | master（本地） | public（公开） |
|---|---|---|
| 源代码 `app/` `lib/` `components/` `prompts/` `scripts/` | ✓ | ✓ |
| `README.md` `package.json` 等配置 | ✓ | ✓ |
| `data/books/example/` | ✓ | ✓ |
| `CLAUDE.md` | ✓ | ✗（.gitignore 拦截）|
| `_dev/`（全部内部文档/测试/书） | ✓ | ✗（.gitignore 拦截）|
| `.env.local` | ✓ | ✗（.gitignore 始终拦截）|
| `data/sessions/` `data/audits/` | ✗ | ✗（.gitignore 始终拦截）|

## public 的 .gitignore 只暴露

```
_dev/
CLAUDE.md
```

两行。新人完全看不出 `_dev/` 里面有什么。
