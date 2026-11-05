#!/bin/bash
# 构建 Codex Web Gateway 跨平台发行包（Linux / macOS）
# 用法: bash build-cross-platform.sh <web-gateway-dir> <webview-dir> <output-dir> <version>
set -euo pipefail

GATEWAY_DIR="${1:?usage: build-cross-platform.sh <gateway-dir> <webview-dir> <output-dir> <version>}"
WEBVIEW_SRC="${2:?}"
OUTPUT_DIR="${3:?}"
VERSION="${4:?}"

GATEWAY_DIR="$(cd "$GATEWAY_DIR" && pwd)"
WEBVIEW_SRC="$(cd "$WEBVIEW_SRC" && pwd)"
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"

RELEASE_NAME="codex-web-v${VERSION}"
BUILD_DIR="$(mktemp -d)"
trap 'rm -rf "$BUILD_DIR"' EXIT

echo "=== Codex Web Gateway 跨平台打包 ==="
echo "版本: $VERSION"
echo "Gateway: $GATEWAY_DIR"
echo "Webview: $WEBVIEW_SRC"
echo "输出: $OUTPUT_DIR"

if [ ! -f "$WEBVIEW_SRC/index.html" ] || ! ls "$WEBVIEW_SRC"/assets/*.js >/dev/null 2>&1; then
  echo "ERROR: webview source is incomplete: $WEBVIEW_SRC" >&2
  echo "Expected index.html and assets/*.js." >&2
  exit 1
fi

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
cp "$GATEWAY_DIR/package-lock.json" "$PKG/"
cp "$GATEWAY_DIR/start-web.mjs" "$PKG/"

# web-shell（登录页 + polyfill）
cp -r "$GATEWAY_DIR/web-shell/"* "$PKG/web-shell/"

# 预提取好的 webview（前端 UI）
cp -r "$WEBVIEW_SRC/"* "$PKG/cache/official-bundle/webview/"
cat > "$PKG/cache/official-bundle/manifest.json" << EOF
{
  "schemaVersion": 3,
  "sourceAppPath": "",
  "sourceResourcesPath": "",
  "sourceAsarPath": "",
  "sourceCodexBinaryPath": "",
  "sourceLayoutKind": "preextracted-web-package",
  "sourcePlatformHint": "cross-platform",
  "bundleIdentifier": "openai-codex-electron",
  "version": "$VERSION",
  "build": "cross-platform-build",
  "sourceAsarSize": 0,
  "sourceAsarMtimeMs": 0,
  "processedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF

# ── 3. 生成管理脚本 ──────────────────────────────────────
echo ""
echo "--- 3/5 生成管理脚本 ---"

cat > "$PKG/install.sh" << 'INSTALLER'
#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
if ! command -v node >/dev/null 2>&1; then
  echo "[codex-web] Node.js was not found. Install Node.js 18+ from https://nodejs.org"
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "[codex-web] npm was not found. Install Node.js 18+ from https://nodejs.org"
  exit 1
fi
if ! command -v codex >/dev/null 2>&1; then
  echo "[codex-web] Codex CLI was not found. Install with: npm install -g @openai/codex"
  exit 1
fi
echo "[codex-web] Installing gateway dependencies..."
npm install --omit=dev --no-audit --no-fund --ignore-scripts
node -e 'for (const dep of Object.keys(require("./package.json").dependencies || {})) require.resolve(dep)'
echo "[codex-web] Install complete."
INSTALLER

cat > "$PKG/start.sh" << 'LAUNCHER'
#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# 加载用户配置（如果存在）
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a; source "$SCRIPT_DIR/.env"; set +a
fi

if ! node -e 'for (const dep of Object.keys(require("./package.json").dependencies || {})) require.resolve(dep)' >/dev/null 2>&1; then
  echo "[codex-web] Dependencies are not installed. Run: bash install.sh"
  exit 1
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

cat > "$PKG/stop.sh" << 'STOPPER'
#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a; source "$SCRIPT_DIR/.env"; set +a
fi
PORT="${PORT:-3737}"
PIDS=""
if command -v lsof >/dev/null 2>&1; then
  PIDS="$(lsof -ti "tcp:${PORT}" 2>/dev/null || true)"
elif command -v fuser >/dev/null 2>&1; then
  PIDS="$(fuser "${PORT}/tcp" 2>/dev/null || true)"
else
  echo "[codex-web] Install lsof or psmisc/fuser to stop by port, or stop the node process manually."
  exit 1
fi
if [ -z "$PIDS" ]; then
  echo "[codex-web] No gateway process is listening on port ${PORT}."
  exit 0
fi
echo "[codex-web] Stopping gateway on port ${PORT}: ${PIDS}"
kill $PIDS
STOPPER

cat > "$PKG/status.sh" << 'STATUS'
#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a; source "$SCRIPT_DIR/.env"; set +a
fi
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-3737}"
CHECK_HOST="$HOST"
if [ "$CHECK_HOST" = "0.0.0.0" ]; then
  CHECK_HOST="127.0.0.1"
fi
URL="http://${CHECK_HOST}:${PORT}/api/health"
if command -v curl >/dev/null 2>&1; then
  if curl -fsS "$URL" >/dev/null; then
    echo "[codex-web] running: $URL"
  else
    echo "[codex-web] not responding: $URL"
    exit 1
  fi
else
  node -e "require('http').get('$URL', r => { process.exit(r.statusCode >= 200 && r.statusCode < 300 ? 0 : 1) }).on('error', () => process.exit(1))"
  echo "[codex-web] running: $URL"
fi
STATUS

echo "${VERSION}" > "$PKG/VERSION"
chmod +x "$PKG"/*.sh

cat > "$PKG/install.bat" << 'BATINSTALLER'
@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (echo Node.js was not found. Install Node.js 18+ from https://nodejs.org && pause && exit /b 1)
where npm >nul 2>nul
if errorlevel 1 (echo npm was not found. Install Node.js 18+ from https://nodejs.org && pause && exit /b 1)
where codex >nul 2>nul
if errorlevel 1 (echo Codex CLI was not found. Install with: npm install -g @openai/codex && pause && exit /b 1)
echo [codex-web] Installing gateway dependencies...
call npm install --omit=dev --no-audit --no-fund --ignore-scripts
if errorlevel 1 (echo [codex-web] dependency installation failed && pause && exit /b 1)
node -e "for (const dep of Object.keys(require('./package.json').dependencies || {})) require.resolve(dep)"
if errorlevel 1 (echo [codex-web] dependency verification failed && pause && exit /b 1)
echo [codex-web] Install complete.
pause
BATINSTALLER

cat > "$PKG/start.bat" << 'BATLAUNCHER'
@echo off
setlocal
cd /d "%~dp0"
if exist ".env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do set "%%A=%%B"
)
where node >nul 2>nul
if errorlevel 1 (echo Node.js was not found. Install Node.js 18+ from https://nodejs.org && pause && exit /b 1)
where codex >nul 2>nul
if errorlevel 1 (echo Codex CLI was not found. Install with: npm install -g @openai/codex && pause && exit /b 1)
node -e "for (const dep of Object.keys(require('./package.json').dependencies || {})) require.resolve(dep)" >nul 2>nul
if errorlevel 1 (
  echo [codex-web] Dependencies are not installed. Run install.bat first.
  pause
  exit /b 1
)
set HOST=%HOST%
if "%HOST%"=="" set HOST=127.0.0.1
set PORT=%PORT%
if "%PORT%"=="" set PORT=3737
echo [codex-web] Codex Web Gateway
echo [codex-web] http://%HOST%:%PORT%
node start-web.mjs
BATLAUNCHER

cat > "$PKG/stop.bat" << 'BATSTOPPER'
@echo off
setlocal
cd /d "%~dp0"
if exist ".env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do set "%%A=%%B"
)
if "%PORT%"=="" set PORT=3737
powershell -NoProfile -ExecutionPolicy Bypass -Command "$port=[int]$env:PORT; $listeners=Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue; if(-not $listeners){ Write-Host '[codex-web] No gateway process is listening on port' $port; exit 0 }; foreach($l in $listeners){ Write-Host '[codex-web] Stopping PID' $l.OwningProcess 'on port' $port; Stop-Process -Id $l.OwningProcess -Force -ErrorAction SilentlyContinue }"
BATSTOPPER

cat > "$PKG/status.bat" << 'BATSTATUS'
@echo off
setlocal
cd /d "%~dp0"
if exist ".env" (
  for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do set "%%A=%%B"
)
if "%HOST%"=="" set HOST=127.0.0.1
if "%PORT%"=="" set PORT=3737
powershell -NoProfile -ExecutionPolicy Bypass -Command "$hostName=$env:HOST; if($hostName -eq '0.0.0.0'){ $hostName='127.0.0.1' }; $url='http://'+$hostName+':'+$env:PORT+'/api/health'; try { $r=Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 3; if($r.StatusCode -ge 200 -and $r.StatusCode -lt 300){ Write-Host '[codex-web] running:' $url; exit 0 } } catch {}; Write-Host '[codex-web] not responding:' $url; exit 1"
BATSTATUS

# ── 4. 打包 ────────────────────────────────────────────
echo ""
echo "--- 4/5 打包 ---"
ARCHIVE="$OUTPUT_DIR/${RELEASE_NAME}-web.zip"
mkdir -p "$OUTPUT_DIR"
if command -v zip >/dev/null 2>&1; then
  (cd "$BUILD_DIR" && zip -qr "$ARCHIVE" "$RELEASE_NAME")
elif command -v python3 >/dev/null 2>&1; then
  (cd "$BUILD_DIR" && python3 - "$RELEASE_NAME" "$ARCHIVE" << 'PYZIP'
import os
import sys
import zipfile

source_root, archive_path = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    for current_root, _, files in os.walk(source_root):
        for file_name in files:
            file_path = os.path.join(current_root, file_name)
            archive_name = os.path.relpath(file_path, ".")
            entry = zipfile.ZipInfo.from_file(file_path, archive_name)
            entry.compress_type = zipfile.ZIP_DEFLATED
            if os.access(file_path, os.X_OK):
                entry.external_attr = (0o100755 << 16)
            archive.writestr(entry, open(file_path, "rb").read())
PYZIP
)
else
  echo "ERROR: zip or python3 is required to create $ARCHIVE" >&2
  exit 1
fi
echo "  → $(du -h "$ARCHIVE" | cut -f1)  $ARCHIVE"

echo ""
echo "=== 打包完成 ==="
echo "$ARCHIVE"
