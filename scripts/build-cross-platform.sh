#!/bin/bash
# 构建 Codex Web Gateway 跨平台发行包（Linux / macOS）
# 用法: bash build-cross-platform.sh <web-gateway-dir> <webview-dir> <output-dir> <version>
set -euo pipefail

GATEWAY_DIR="${1:?usage: build-cross-platform.sh <gateway-dir> <webview-dir> <output-dir> <version>}"
WEBVIEW_SRC="${2:?}"
OUTPUT_DIR="${3:?}"
VERSION="${4:?}"

RELEASE_NAME="codex-web-v${VERSION}"
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT

echo "=== Codex Web Gateway 跨平台打包 ==="
echo "版本: $VERSION"
echo "Gateway: $GATEWAY_DIR"
echo "Webview: $WEBVIEW_SRC"
echo "输出: $OUTPUT_DIR"

# ── 1. 编译 gateway ──────────────────────────────────────
echo ""
echo "--- 1/5 编译 TypeScript ---"
cd "$GATEWAY_DIR"
npm ci 2>&1 | tail -2
npm run build:gateway 2>&1

# ── 2. 组装包结构 ──────────────────────────────────────
echo ""
echo "--- 2/5 组装包 ---"
PKG="$BUILD_DIR/$RELEASE_NAME"
mkdir -p "$PKG/gateway/dist"
mkdir -p "$PKG/cache/official-bundle/webview"
mkdir -p "$PKG/web-shell"

# gateway 编译产物 + 源码
cp -r "$GATEWAY_DIR/gateway/dist/"* "$PKG/gateway/dist/"
cp "$GATEWAY_DIR/package.json" "$PKG/"
cp "$GATEWAY_DIR/start-web.mjs" "$PKG/"

# web-shell（登录页 + polyfill）
cp -r "$GATEWAY_DIR/web-shell/"* "$PKG/web-shell/"

# 预提取好的 webview（前端 UI）
cp -r "$WEBVIEW_SRC/"* "$PKG/cache/official-bundle/webview/"
echo "{\"version\":\"$VERSION\",\"source\":\"cross-platform-build\"}" > "$PKG/cache/official-bundle/manifest.json"

# ── 3. 生成启动脚本 ──────────────────────────────────────
echo ""
echo "--- 3/5 生成启动脚本 ---"

cat > "$PKG/start.sh" << 'LAUNCHER'
#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# 加载用户配置（如果存在）
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a; source "$SCRIPT_DIR/.env"; set +a
fi

# 首次运行：安装依赖
if [ ! -d "node_modules" ]; then
  echo "[codex-web] 首次运行，安装依赖..."
  npm install --omit=dev --no-audit --no-fund
fi

export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-3737}"
export CODEX_WEB_OFFICIAL_BUNDLE_DIR="${CODEX_WEB_OFFICIAL_BUNDLE_DIR:-$SCRIPT_DIR/cache/official-bundle}"

echo "[codex-web] =========================================="
echo "[codex-web]  Codex Web Gateway v${CODEX_WEB_VERSION:-unknown}"
echo "[codex-web]  地址: http://${HOST}:${PORT}"
echo "[codex-web]  后端: ${CODEX_APP_SERVER_CMD:-codex app-server --listen stdio://}"
echo "[codex-web] =========================================="

if [ -f "$SCRIPT_DIR/start-web.mjs" ]; then
  exec node "$SCRIPT_DIR/start-web.mjs"
else
  exec node gateway/dist/server.js
fi
LAUNCHER

echo "${VERSION}" > "$PKG/VERSION"
chmod +x "$PKG/start.sh"

# Windows 启动脚本（内容跟 .bat 一致，放在同一个包里）
cat > "$PKG/start.bat" << 'BATLAUNCHER'
@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (echo Node.js was not found. Install Node.js 18+ from https://nodejs.org && pause && exit /b 1)
where codex >nul 2>nul
if errorlevel 1 (echo Codex CLI was not found. Install with: npm install -g @openai/codex && pause && exit /b 1)
if not exist "node_modules\" (
  echo [codex-web] Installing dependencies...
  call npm install --omit=dev --no-audit --no-fund
)
set HOST=%HOST%
if "%HOST%"=="" set HOST=127.0.0.1
set PORT=%PORT%
if "%PORT%"=="" set PORT=3737
echo [codex-web] Codex Web Gateway
echo [codex-web] http://%HOST%:%PORT%
node start-web.mjs
BATLAUNCHER

# ── 4. 打包 ────────────────────────────────────────────
echo ""
echo "--- 4/4 打包 ---"
ARCHIVE="$OUTPUT_DIR/${RELEASE_NAME}-web.zip"
mkdir -p "$OUTPUT_DIR"
(cd "$BUILD_DIR" && zip -qr "$ARCHIVE" "$RELEASE_NAME")
echo "  → $(du -h "$ARCHIVE" | cut -f1)  $ARCHIVE"

echo ""
echo "=== 打包完成 ==="
echo "$ARCHIVE"
