#!/usr/bin/env bash
# sync-to-public.sh —— 把 master 的改动同步到 public 分支，自动剥离内部文档
#
# 用法（在 master 分支上跑）：
#   bash scripts/sync-to-public.sh                   合并全部新改动
#   bash scripts/sync-to-public.sh <commit-hash>     只 cherry-pick 一个 commit
#   bash scripts/sync-to-public.sh <a>..<b>          只 cherry-pick 一段 range
#
# 内部文件（_dev/、CLAUDE.md）在 public 上会被自动移除。

set -euo pipefail

INTERNAL_FILES=("_dev" "CLAUDE.md" "scripts/sync-to-public.sh")

echo "=== 同步 master → public ==="

# 确保工作区干净
if ! git diff-index --quiet HEAD -- 2>/dev/null; then
  echo "❌ 工作区有未提交的改动，先 commit 或 stash"
  exit 1
fi

CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "master" ]; then
  echo "⚠️  当前在 '$CURRENT_BRANCH'，建议切到 master 再跑"
  read -p "继续？(y/n) " -r
  [[ "$REPLY" =~ ^[Yy]$ ]] || exit 0
fi

# 切到 public
git checkout public

if [ $# -eq 0 ]; then
  # 模式 1：合并 master 全部改动
  echo "合并 master 全量改动..."
  if git merge master --no-commit --no-ff 2>/dev/null; then
    echo "✅ merge 完成（无冲突）"
  else
    echo "⚠️  有冲突，请手动解决后回车继续..."
    read -r
  fi
else
  # 模式 2：cherry-pick 指定范围
  echo "cherry-pick $* ..."
  git cherry-pick "$@"
fi

# 剥离内部文件（只删 index 里的，不管磁盘上有没有）
for f in "${INTERNAL_FILES[@]}"; do
  if git ls-files --error-unmatch "$f" 2>/dev/null; then
    git rm -r --cached "$f" 2>/dev/null || git rm --cached "$f" 2>/dev/null
    echo "🗑️  已从 public 剥离: $f"
  fi
done

# 没有待提交的改动就跳过
if git diff --cached --quiet 2>/dev/null; then
  echo "没有新的改动需要提交"
else
  git commit -m "sync: master → public（自动剥离 _dev/ CLAUDE.md）"
  echo "✅ 已提交同步"
fi

echo "---"
echo "当前分支: public"
echo "下一步: git push github public:main"
