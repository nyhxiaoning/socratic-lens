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
GITIGNORE_GUARD_LINES=("# 内部开发文档，不公开" "_dev/" "CLAUDE.md")

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
  # -X theirs：冲突时优先用 master 版本（内部文件后面统一剥离，gitignore 后面统一修复）
  if git merge master --no-commit --no-ff -X theirs 2>&1; then
    echo "✅ merge 完成（无冲突）"
  else
    # 自动解决 .gitignore 冲突（-X theirs 不能消解 add/add 冲突）
    if git diff --name-only --diff-filter=U 2>/dev/null | grep -qx '.gitignore'; then
      echo "🔧 auto-resolve .gitignore (keep public version)..."
      git checkout --ours .gitignore
      git add .gitignore
    fi
    # 自动解决内部文件的 modify/delete 冲突（public 删了、master 改了）
    # 内部文件在 public 上就该不存在，直接 git rm 即可
    for f in "${INTERNAL_FILES[@]}"; do
      if git diff --name-only --diff-filter=U 2>/dev/null | grep -qx "$f"; then
        echo "🔧 auto-resolve internal file conflict (remove): $f"
        git rm "$f" 2>/dev/null || true
      fi
    done
    # 检查是否还有未解决的冲突
    if git diff --name-only --diff-filter=U 2>/dev/null | grep -q .; then
      echo "⚠️  仍有未解决的冲突，请手动处理后回车继续..."
      read -r
    fi
  fi
else
  # 模式 2：cherry-pick 指定范围
  echo "cherry-pick $* ..."
  git cherry-pick "$@"
fi

# 确保 .gitignore 包含内部文件条目（-X theirs 合并后可能被 master 版本覆盖）
for line in "${GITIGNORE_GUARD_LINES[@]}"; do
  if ! grep -qFx "$line" .gitignore 2>/dev/null; then
    echo "" >> .gitignore
    echo "$line" >> .gitignore
    git add .gitignore
    echo "🔧 ensured .gitignore guard: $line"
  fi
done

# 剥离内部文件（只删 index 里的，不管磁盘上有没有）
for f in "${INTERNAL_FILES[@]}"; do
  if git ls-files --error-unmatch "$f" 2>/dev/null; then
    git rm -r --cached "$f" 2>/dev/null || git rm --cached "$f" 2>/dev/null
    echo "🗑️  stripped from public: $f"
  fi
done

# 没有待提交的改动就跳过
if git diff --cached --quiet 2>/dev/null; then
  echo "没有新的改动需要提交"
else
  git commit -m "sync: master → public (auto-strip _dev/ CLAUDE.md)"
  echo "✅ sync committed"
fi

echo "---"
echo "now on branch: public"
echo "next: git push github public:main"
