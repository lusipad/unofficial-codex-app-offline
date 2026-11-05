#!/bin/bash
# Codex Web Gateway — Linux 引导式安装脚本
# 用法: bash setup-linux.sh
set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
GITHUB_REPO="lusipad/unofficial-codex-app-offline"
INSTALL_DIR="${CODEX_WEB_INSTALL_DIR:-${HOME}/codex-web}"
DEFAULT_PORT=80
DEFAULT_HOST="0.0.0.0"
SERVICE_NAME="codex-web"
ACTION="${1:-install}"

usage() {
  cat << EOF
Usage: bash setup-linux.sh [install|start|stop|status|restart|update]

Commands:
  install   Interactive install wizard (default)
  start     Start the installed gateway
  stop      Stop the installed gateway
  status    Show gateway status
  restart   Restart the installed gateway
  update    Download the latest Web package, keep .env, reinstall deps

Environment:
  CODEX_WEB_INSTALL_DIR  Install directory (default: ${HOME}/codex-web)
EOF
}

require_install_dir() {
  if [ ! -d "$INSTALL_DIR" ]; then
    echo -e "${RED}未找到安装目录：${INSTALL_DIR}${NC}"
    echo "请先运行：bash setup-linux.sh"
    exit 1
  fi
}

systemd_service_exists() {
  command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files "${SERVICE_NAME}.service" >/dev/null 2>&1
}

run_gateway_script() {
  local script_name="$1"
  require_install_dir
  if [ ! -f "$INSTALL_DIR/$script_name" ]; then
    echo -e "${RED}缺少 ${script_name}。请运行 update 或重新安装。${NC}"
    exit 1
  fi
  cd "$INSTALL_DIR"
  bash "$script_name"
}

manage_gateway() {
  local command="$1"
  case "$command" in
    start|stop|restart)
      if systemd_service_exists; then
        sudo systemctl "$command" "$SERVICE_NAME"
      else
        case "$command" in
          start) run_gateway_script "start.sh" ;;
          stop) run_gateway_script "stop.sh" ;;
          restart)
            run_gateway_script "stop.sh"
            run_gateway_script "start.sh"
            ;;
        esac
      fi
      ;;
    status)
      if systemd_service_exists; then
        systemctl status --no-pager "$SERVICE_NAME"
      else
        run_gateway_script "status.sh"
      fi
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

download_latest_web_zip() {
  rm -rf /tmp/codex-dl
  mkdir -p /tmp/codex-dl
  rm -f /tmp/codex-web.zip

  if command -v gh &>/dev/null && gh auth status &>/dev/null 2>&1; then
    echo "  通过 gh CLI 下载..."
    gh release download --repo "$GITHUB_REPO" --pattern '*-web.zip' --dir /tmp/codex-dl
  else
    echo "  通过 curl 下载（无认证，可能触发速率限制）..."
    LATEST_URL=$(curl -s "https://api.github.com/repos/${GITHUB_REPO}/releases/latest" \
      | grep -o '"browser_download_url": *"[^"]*-web.zip"' \
      | head -1 \
      | cut -d'"' -f4)
    if [ -z "$LATEST_URL" ]; then
      echo -e "${RED}无法获取最新版本下载链接。${NC}"
      echo "请手动从 https://github.com/${GITHUB_REPO}/releases 下载 *-web.zip 并解压到 ${INSTALL_DIR}"
      exit 1
    fi
    curl -L -o /tmp/codex-web.zip "$LATEST_URL"
  fi

  DL_FILE=$(ls -t /tmp/codex-web.zip /tmp/codex-dl/*-web.zip 2>/dev/null | head -1)
  if [ ! -f "$DL_FILE" ]; then
    echo -e "${RED}下载失败。${NC}"
    exit 1
  fi
}

unpack_web_zip() {
  local target_dir="${1:-$INSTALL_DIR}"
  echo "  解压到 ${target_dir}..."
  mkdir -p "$target_dir"
  unzip -qo "$DL_FILE" -d "$target_dir"
  # 如果 zip 内有一层目录，展平
  if [ "$(ls -1 "$target_dir" | wc -l)" = "1" ] && [ -d "$target_dir/$(ls -1 "$target_dir")" ]; then
    INNER="$(ls -1 "$target_dir")"
    mv "$target_dir/$INNER"/* "$target_dir/"
    rmdir "$target_dir/$INNER"
  fi
  # 修复 Windows 构建可能引入的 CRLF 换行符
  CR=$(printf '\r')
  for f in $(find "$target_dir" -name '*.sh' -o -name '*.mjs' 2>/dev/null); do
    tr -d "$CR" < "$f" > "${f}.tmp" && mv "${f}.tmp" "$f"
  done
  chmod +x "$target_dir"/*.sh 2>/dev/null || true

  WEBVIEW_DIR="$target_dir/cache/official-bundle/webview"
  if [ ! -f "$target_dir/start-web.mjs" ] ||
     [ ! -f "$target_dir/gateway/dist/server.js" ] ||
     [ ! -f "$target_dir/start.sh" ]; then
    echo -e "${RED}下载的 Web 包缺少 gateway 启动文件。${NC}"
    echo "请重新下载最新 *-web.zip，或等待发布包重新构建后再运行此脚本。"
    exit 1
  fi
  if [ ! -f "$target_dir/cache/official-bundle/manifest.json" ] ||
     [ ! -f "$WEBVIEW_DIR/index.html" ] ||
     ! find "$WEBVIEW_DIR/assets" -maxdepth 1 -type f -name '*.js' 2>/dev/null | grep -q .; then
    echo -e "${RED}下载的 Web 包缺少预提取 Codex UI（webview）。${NC}"
    echo "这会导致 WebView 空白或 gateway 启动时找不到 app.asar。"
    echo "请重新下载最新 *-web.zip，或等待发布包重新构建后再运行此脚本。"
    exit 1
  fi
  rm -f "$DL_FILE"
}

install_gateway_deps() {
  cd "$INSTALL_DIR"
  if [ -f "$INSTALL_DIR/install.sh" ]; then
    bash install.sh
  else
    echo "  当前 Web 包没有 install.sh，使用兼容安装流程..."
    npm install --omit=dev --no-audit --no-fund --ignore-scripts
    node -e 'for (const dep of Object.keys(require("./package.json").dependencies || {})) require.resolve(dep)'
  fi
}

update_gateway() {
  require_install_dir
  ENV_BACKUP=""
  UPDATE_DIR=""
  WAS_SYSTEMD=0
  WAS_ACTIVE=0

  if [ -f "$INSTALL_DIR/.env" ]; then
    ENV_BACKUP="$(mktemp)"
    cp "$INSTALL_DIR/.env" "$ENV_BACKUP"
  fi

  if systemd_service_exists; then
    WAS_SYSTEMD=1
    if systemctl is-active --quiet "$SERVICE_NAME"; then
      WAS_ACTIVE=1
      sudo systemctl stop "$SERVICE_NAME"
    fi
  else
    if [ -f "$INSTALL_DIR/stop.sh" ]; then
      bash "$INSTALL_DIR/stop.sh" || true
    fi
  fi

  echo -e "${GREEN}下载最新 Web 包...${NC}"
  download_latest_web_zip
  UPDATE_DIR="$(mktemp -d)"
  unpack_web_zip "$UPDATE_DIR"
  for item in "$INSTALL_DIR"/* "$INSTALL_DIR"/.[!.]* "$INSTALL_DIR"/..?*; do
    [ -e "$item" ] || continue
    [ "$(basename "$item")" = ".env" ] && continue
    rm -rf "$item"
  done
  for item in "$UPDATE_DIR"/* "$UPDATE_DIR"/.[!.]* "$UPDATE_DIR"/..?*; do
    [ -e "$item" ] || continue
    mv "$item" "$INSTALL_DIR/"
  done
  rmdir "$UPDATE_DIR"
  if [ -n "$ENV_BACKUP" ]; then
    cp "$ENV_BACKUP" "$INSTALL_DIR/.env"
    rm -f "$ENV_BACKUP"
  fi

  echo -e "${GREEN}安装 gateway 依赖...${NC}"
  install_gateway_deps

  if [ "$WAS_SYSTEMD" = "1" ]; then
    sudo systemctl daemon-reload
    if [ "$WAS_ACTIVE" = "1" ]; then
      sudo systemctl start "$SERVICE_NAME"
    fi
  fi

  echo -e "${GREEN}更新完成。${NC}"
  if [ "$WAS_SYSTEMD" = "1" ]; then
    echo "状态：systemctl status --no-pager ${SERVICE_NAME}"
  else
    echo "启动：bash setup-linux.sh start"
  fi
}

case "$ACTION" in
  install) ;;
  start|stop|status|restart)
    manage_gateway "$ACTION"
    exit 0
    ;;
  update)
    update_gateway
    exit 0
    ;;
  -h|--help|help)
    usage
    exit 0
    ;;
  *)
    usage
    exit 1
    ;;
esac

echo ""
echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║   Codex Web Gateway — Linux 安装向导    ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
echo ""

if [ "$(id -u)" = "0" ]; then
  echo -e "${YELLOW}注意：检测到以 root 运行。建议使用普通用户安装，或确保了解风险。${NC}"
  echo ""
fi

# ── 1. 检查基础依赖 ──
echo -e "${YELLOW}[1/7]${NC} 检查系统依赖..."

if ! command -v node &>/dev/null; then
  echo -e "${RED}未找到 Node.js。${NC}"
  read -p "要自动安装 Node.js 吗？(Ubuntu/Debian) [Y/n] " -r
  if [[ "$REPLY" =~ ^[Nn] ]]; then
    echo "请先安装 Node.js 18+ 后重试: https://nodejs.org"
    exit 1
  fi
  echo -e "${GREEN}安装 Node.js...${NC}"
  sudo apt-get update -qq && sudo apt-get install -y -qq nodejs npm
fi

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo -e "${RED}Node.js 版本过低 ($(node -v))，需要 18+。${NC}"
  exit 1
fi
echo -e "  Node.js $(node -v)  ${GREEN}✓${NC}"

if ! command -v npm &>/dev/null; then
  echo -e "${RED}未找到 npm。${NC}"
  exit 1
fi
echo -e "  npm $(npm -v)  ${GREEN}✓${NC}"

for tool in unzip curl; do
  if ! command -v $tool &>/dev/null; then
    echo "  安装 $tool..."
    sudo apt-get install -y -qq $tool 2>/dev/null || true
  fi
done

# ── 2. 安装目录 ──
echo ""
echo -e "${YELLOW}[2/7]${NC} 安装目录"
read -p "安装目录 [${INSTALL_DIR}]: " USER_DIR
INSTALL_DIR="${USER_DIR:-$INSTALL_DIR}"

if [ -d "$INSTALL_DIR" ] && [ "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
  read -p "目录已存在且非空，覆盖？[y/N] " -r
  if [[ ! "$REPLY" =~ ^[Yy] ]]; then
    echo "已取消。"
    exit 0
  fi
  rm -rf "$INSTALL_DIR"
fi
mkdir -p "$INSTALL_DIR"

# ── 3. 下载最新版 ──
echo ""
echo -e "${YELLOW}[3/7]${NC} 下载最新 Web 包..."

download_latest_web_zip
unpack_web_zip
echo -e "  ${GREEN}✓${NC}"

# ── 4. 安装 Codex CLI ──
echo ""
echo -e "${YELLOW}[4/7]${NC} Codex CLI"

if command -v codex &>/dev/null; then
  echo -e "  codex $(codex --version)  ${GREEN}✓${NC}"
else
  read -p "是否安装 Codex CLI？(需要 npm) [Y/n] " -r
  if [[ ! "$REPLY" =~ ^[Nn] ]]; then
    echo "  安装 @openai/codex..."
    npm install -g @openai/codex
    echo -e "  ${GREEN}✓${NC}"
  else
    echo -e "  ${YELLOW}跳过。请手动安装: npm install -g @openai/codex${NC}"
  fi
fi

# ── 5. 安装 gateway 依赖 ──
echo ""
echo -e "${YELLOW}[5/7]${NC} 安装 gateway 依赖"
cd "$INSTALL_DIR"
install_gateway_deps
echo -e "  ${GREEN}✓${NC}"

# ── 6. 配置 ──
echo ""
echo -e "${YELLOW}[6/7]${NC} 配置"

read -p "监听地址 [${DEFAULT_HOST}]: " HOST_INPUT
HOST="${HOST_INPUT:-$DEFAULT_HOST}"

read -p "端口 [${DEFAULT_PORT}]: " PORT_INPUT
PORT="${PORT_INPUT:-$DEFAULT_PORT}"

if [ "$HOST" != "127.0.0.1" ] && [ "$HOST" != "localhost" ]; then
  while true; do
    read -p "公网密码（至少 8 位，留空自动生成）: " PASSWORD
    if [ -z "$PASSWORD" ]; then
      PASSWORD=$(openssl rand -base64 24 2>/dev/null || node -e "console.log(require('crypto').randomBytes(24).toString('base64'))")
      echo "  已生成随机密码: ${PASSWORD}"
      break
    elif [ ${#PASSWORD} -lt 8 ]; then
      echo -e "${RED}密码太短，至少 8 位。${NC}"
    else
      break
    fi
  done
fi

read -p "允许 Web UI 访问的目录（逗号分隔，留空跳过）: " WORKSPACES

# 写入 .env
cat > "$INSTALL_DIR/.env" << ENVFILE
HOST=${HOST}
PORT=${PORT}
CODEX_WEB_PASSWORD=${PASSWORD:-}
CODEX_WEB_WORKSPACE_ROOTS=${WORKSPACES:-}
ENVFILE
echo -e "  ${GREEN}✓${NC}"

# ── 7. 启动选项 ──
echo ""
echo -e "${YELLOW}[7/7]${NC} 部署选项"
echo ""
echo "  1) 仅前台启动（测试用）"
echo "  2) 注册 systemd 服务（开机自启）"
echo "  3) 暂不启动"
echo ""
read -p "选择 [1-3]: " DEPLOY_CHOICE

cd "$INSTALL_DIR"

case "$DEPLOY_CHOICE" in
  1)
    echo -e "${GREEN}启动 gateway...${NC}"
    set -a; source .env; set +a
    bash start.sh
    ;;
  2)
    # 用 node 真实路径
    NODE_BIN=$(which node)
    sudo tee "/etc/systemd/system/${SERVICE_NAME}.service" > /dev/null << UNIT
[Unit]
Description=Codex Web Gateway
After=network.target

[Service]
Type=simple
User=${USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${INSTALL_DIR}/.env
ExecStart=${NODE_BIN} start-web.mjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

    sudo systemctl daemon-reload
    sudo systemctl enable --now "$SERVICE_NAME"

    # 等待启动
    echo -n "等待服务启动"
    for i in $(seq 1 10); do
      if curl -s "http://127.0.0.1:${PORT}/api/health" > /dev/null 2>&1; then
        echo ""
        echo -e "${GREEN}✓ 服务已就绪${NC}"
        break
      fi
      echo -n "."
      sleep 1
    done

    IP_ADDR=$(hostname -I 2>/dev/null | awk '{print $1}')
    echo ""
    echo -e "${CYAN}══════════════════════════════════════════${NC}"
    echo -e "${GREEN}Codex Web Gateway 已部署！${NC}"
    echo ""
    echo -e "  地址: ${CYAN}http://${IP_ADDR:-127.0.0.1}:${PORT}${NC}"
    if [ -n "$PASSWORD" ]; then
      echo -e "  密码: ${CYAN}${PASSWORD}${NC}"
    fi
    echo ""
    echo -e "  管理: ${YELLOW}sudo systemctl [start|stop|restart|status] ${SERVICE_NAME}${NC}"
    echo -e "  日志: ${YELLOW}sudo journalctl -u ${SERVICE_NAME} -f${NC}"
    echo -e "${CYAN}══════════════════════════════════════════${NC}"
    ;;
  *)
    IP_ADDR=$(hostname -I 2>/dev/null | awk '{print $1}')
    echo ""
    echo -e "${GREEN}文件已就位，手动启动：${NC}"
    echo "  cd ${INSTALL_DIR} && bash start.sh"
    if [ -f "$INSTALL_DIR/status.sh" ]; then
      echo "  cd ${INSTALL_DIR} && bash status.sh"
    fi
    echo ""
    echo -e "  地址: http://${IP_ADDR:-127.0.0.1}:${PORT}"
    if [ -n "$PASSWORD" ]; then
      echo -e "  密码: ${PASSWORD}"
    fi
    ;;
esac
