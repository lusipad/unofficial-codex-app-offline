#!/bin/bash
# Codex Web Gateway — Linux 引导式安装脚本
# 用法: bash setup-linux.sh
set -e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
GITHUB_REPO="lusipad/unofficial-codex-app-offline"
INSTALL_DIR="${HOME}/codex-web"
DEFAULT_PORT=80
DEFAULT_HOST="0.0.0.0"

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
echo -e "${YELLOW}[1/6]${NC} 检查系统依赖..."

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
echo -e "${YELLOW}[2/6]${NC} 安装目录"
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
echo -e "${YELLOW}[3/6]${NC} 下载最新 Web 包..."

# 判断用 gh 还是 curl
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

echo "  解压到 ${INSTALL_DIR}..."
unzip -qo "$DL_FILE" -d "$INSTALL_DIR"
# 如果 zip 内有一层目录，展平
if [ "$(ls -1 "$INSTALL_DIR" | wc -l)" = "1" ] && [ -d "$INSTALL_DIR/$(ls -1 "$INSTALL_DIR")" ]; then
  INNER="$(ls -1 "$INSTALL_DIR")"
  mv "$INSTALL_DIR/$INNER"/* "$INSTALL_DIR/"
  rmdir "$INSTALL_DIR/$INNER"
fi
# 修复 Windows 构建可能引入的 CRLF 换行符
CR=$(printf '\r')
for f in $(find "$INSTALL_DIR" -name '*.sh' -o -name '*.mjs' 2>/dev/null); do
  tr -d "$CR" < "$f" > "${f}.tmp" && mv "${f}.tmp" "$f"
done
chmod +x "$INSTALL_DIR"/*.sh 2>/dev/null || true
rm -f "$DL_FILE"
echo -e "  ${GREEN}✓${NC}"

# ── 4. 安装 Codex CLI ──
echo ""
echo -e "${YELLOW}[4/6]${NC} Codex CLI"

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

# ── 5. 配置 ──
echo ""
echo -e "${YELLOW}[5/6]${NC} 配置"

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

# ── 6. 启动选项 ──
echo ""
echo -e "${YELLOW}[6/6]${NC} 部署选项"
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
    SERVICE_NAME="codex-web"

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
    echo ""
    echo -e "  地址: http://${IP_ADDR:-127.0.0.1}:${PORT}"
    if [ -n "$PASSWORD" ]; then
      echo -e "  密码: ${PASSWORD}"
    fi
    ;;
esac
