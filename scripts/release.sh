#!/bin/sh
# ──────────────────────────────────────────────────────────
# 一键发版脚本 (POSIX sh)
#
# 自动完成：
#   1. 读取当前版本号并自动递增
#   2. 同步新版本号到 package.json / package-lock.json / jetbrains/gradle.properties
#   3. 提交 jetbrains 子模块版本变更并推送
#   4. 提交父仓库版本变更（含子模块指针更新）并推送
#   5. 基于旧版本号创建 v{新版本} 标签并推送
#
# 用法:
#   ./scripts/release.sh [--major|--minor|--patch] [--dry-run] [version]
#
# 默认递增 patch 版本（如 0.5.3 -> 0.5.4）。
# 也可显式指定版本号覆盖自动计算。
#
# 示例:
#   ./scripts/release.sh              # 0.5.3 -> 0.5.4
#   ./scripts/release.sh --minor      # 0.5.3 -> 0.6.0
#   ./scripts/release.sh --major      # 0.5.3 -> 1.0.0
#   ./scripts/release.sh 0.8.0        # 显式指定
#   ./scripts/release.sh --dry-run    # 预览模式
# ──────────────────────────────────────────────────────────

set -e

# ── 参数解析 ──────────────────────────────────────────────
DRY_RUN=0
BUMP_LEVEL="patch"
VERSION=""

for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        --major)   BUMP_LEVEL="major" ;;
        --minor)   BUMP_LEVEL="minor" ;;
        --patch)   BUMP_LEVEL="patch" ;;
        *)         VERSION="$arg" ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
JETBRAINS_DIR="$ROOT/jetbrains"

# ── 版本计算 ──────────────────────────────────────────────
read_current_version() {
    _ver=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([0-9][0-9]*\)\.\([0-9][0-9]*\)\.\([0-9][0-9]*\)".*/\1 \2 \3/p' "$ROOT/package.json" | head -1)
    if [ -z "$_ver" ]; then
        echo "错误: package.json 中未找到有效版本号" >&2
        exit 1
    fi
    echo "$_ver"
}

bump_version() {
    _major=$1; _minor=$2; _patch=$3; _level=$4
    case "$_level" in
        major) echo "$((_major + 1)).0.0" ;;
        minor) echo "$_major.$((_minor + 1)).0" ;;
        patch) echo "$_major.$_minor.$((_patch + 1))" ;;
        *)     echo "错误: 未知递增级别: $_level" >&2; exit 1 ;;
    esac
}

# 读取当前版本
read -r CUR_MAJOR CUR_MINOR CUR_PATCH <<EOF
$(read_current_version)
EOF
OLD_VERSION="$CUR_MAJOR.$CUR_MINOR.$CUR_PATCH"

# 计算新版本
if [ -n "$VERSION" ]; then
    if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
        echo "版本号格式无效: $VERSION" >&2
        exit 1
    fi
    NEW_VERSION="$VERSION"
else
    NEW_VERSION=$(bump_version "$CUR_MAJOR" "$CUR_MINOR" "$CUR_PATCH" "$BUMP_LEVEL")
fi

# ── 工具函数 ──────────────────────────────────────────────
run() {
    _label="$1"
    shift
    if [ "$DRY_RUN" -eq 1 ]; then
        printf '  \033[90m[dry-run] %s\033[0m\n' "$_label"
        return 0
    fi
    printf '  \033[36m▸ %s\033[0m\n' "$_label"
    "$@"
}

# ── 主流程 ──────────────────────────────────────────────
printf '\n\033[32m🚀 发版: %s → v%s\033[0m\n\n' "$OLD_VERSION" "$NEW_VERSION"

# ① 检查工作区是否干净
echo '▸ 检查工作区状态...'
PARENT_STATUS=$(run 'git status (parent)' git -C "$ROOT" status --porcelain)
if [ -n "$PARENT_STATUS" ]; then
    echo "" >&2
    echo "错误: 父仓库工作区有未提交的更改，请先处理：" >&2
    echo "$PARENT_STATUS" >&2
    exit 1
fi

JETBRAINS_STATUS=$(run 'git status (jetbrains)' git -C "$JETBRAINS_DIR" status --porcelain)
if [ -n "$JETBRAINS_STATUS" ]; then
    echo "" >&2
    echo "错误: jetbrains 子模块工作区有未提交的更改，请先处理：" >&2
    echo "$JETBRAINS_STATUS" >&2
    exit 1
fi

# ② 同步版本号
echo "▸ 同步版本号 → $NEW_VERSION"
run 'version:sync' node "$ROOT/scripts/release/sync-version.js" "$NEW_VERSION"

# ③ 验证版本一致性
echo '▸ 验证版本一致性...'
run 'verify:version' node "$ROOT/scripts/release/verify-version.js"

# ④ 提交 jetbrains 子模块
echo '▸ 提交 jetbrains 子模块...'
run 'git add (jetbrains)' git -C "$JETBRAINS_DIR" add -A
run 'git commit (jetbrains)' git -C "$JETBRAINS_DIR" commit -m "chore(release): prepare v$NEW_VERSION"
run 'git push (jetbrains)' git -C "$JETBRAINS_DIR" push origin main

# ⑤ 提交父仓库（含子模块指针更新）
echo '▸ 提交父仓库...'
run 'git add (parent)' git -C "$ROOT" add package.json package-lock.json jetbrains
run 'git commit (parent)' git -C "$ROOT" commit -m "chore(release): prepare v$NEW_VERSION"
run 'git push (parent)' git -C "$ROOT" push origin main

# ⑥ 打标签并推送
echo "▸ 创建标签 v$NEW_VERSION..."
run 'git tag' git -C "$ROOT" tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION"
run 'git push tag' git -C "$ROOT" push origin "v$NEW_VERSION"

# 完成
printf '\n\033[32m✅ 发版完成！\033[0m\n'
printf '   %s → v%s\n\n' "$OLD_VERSION" "$NEW_VERSION"
