#!/bin/bash
# ============================================================================
# Apex Agent Setup Script
# ============================================================================
# 一键安装脚本：下载源码后运行 `bash install.sh` 即可完成安装 + 交互配置。
# One-shot installer: clone/download the source, then run `bash install.sh`.
#
# 流程 / Flow:
#   1. 检测 Node.js / npm（>= 22）/ Check Node.js / npm (>= 22)
#   2. npm install + npm run build（编译到 dist/）/ install deps + build
#   3. 安装到 ~/.apex-agent/（dist + node_modules + skills + bin）/ install into ~/.apex-agent/
#   4. symlink apex → ~/.local/bin/apex / symlink the CLI
#   5. PATH 写入 shell profile（.zshrc / .bashrc）/ add ~/.local/bin to PATH
#   6. 交互配置：大模型（必填）+ 飞书消息（可选）/ interactive config: model (required) + Feishu (optional)
#   7. 凭据写 ~/.apex-agent/.env（绝不进 config.yaml）/ credentials → .env (never config.yaml)
#
# 风格对齐业界 setup 脚本：分步骤、颜色提示、read -p 交互、完成引导。
# ============================================================================

set -e

# ---- Colors / 颜色 --------------------------------------------------------
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

APEX_HOME="$HOME/.apex-agent"
APEX_ENV="$APEX_HOME/.env"
LOCAL_BIN="$HOME/.local/bin"

echo ""
echo -e "${CYAN}⚡ Apex Agent Setup${NC} — 努力向人一样工作 / Work like a human"
echo ""

# ============================================================================
# 1. Node.js / npm check / 检测 Node.js / npm
# ============================================================================

echo -e "${CYAN}→${NC} 检测 Node.js... / Checking Node.js..."

if ! command -v node &> /dev/null; then
    echo -e "${RED}✗${NC} 未找到 Node.js，请先安装 / Node.js not found. Install it first:"
    echo "    https://nodejs.org/  (Node.js >= 22)"
    echo "    或 / or: brew install node"
    exit 1
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo "0")
if [ "$NODE_MAJOR" -lt 22 ]; then
    echo -e "${RED}✗${NC} 需要 Node.js >= 22（当前 v$(node -v)）/ Node.js >= 22 required (found v$(node -v))."
    echo "    node:sqlite 内置模块需要 Node 22+（会话/定时任务/审批/网关账本依赖）。"
    exit 1
fi
echo -e "${GREEN}✓${NC} 找到 Node.js $(node -v) / Node.js $(node -v) found"

if ! command -v npm &> /dev/null; then
    echo -e "${RED}✗${NC} 未找到 npm（随 Node.js 一起安装）/ npm not found (bundled with Node.js)."
    exit 1
fi
echo -e "${GREEN}✓${NC} 找到 npm $(npm -v) / npm $(npm -v) found"

# ============================================================================
# 2. Dependencies + build / 依赖 + 编译
# ============================================================================

echo ""
echo -e "${CYAN}→${NC} 安装依赖... / Installing dependencies..."
# 成功时完全静默（npm 的 "added N packages" 走 stdout，需一并重定向）；
# 失败时去掉重定向重跑一次，让真实 npm 报错可见。
# Quiet on success (npm's summary goes to stdout); re-run WITHOUT redirection on failure.
if ! npm install --loglevel=error >/dev/null; then
    npm install --loglevel=error
    echo -e "${RED}✗${NC} 依赖安装失败（见上方 npm 报错）/ Dependency install failed (see npm error above)."
    exit 1
fi
echo -e "${GREEN}✓${NC} 依赖安装完成 / Dependencies installed"

echo -e "${CYAN}→${NC} 编译中（tsc + 提示词资源）... / Building (tsc + prompt assets)..."
if ! npm run build --silent >/dev/null; then
    npm run build --silent
    echo -e "${RED}✗${NC} 编译失败，可手动运行 'npm run build' 看完整报错 / Build failed. Run 'npm run build' manually."
    exit 1
fi
echo -e "${GREEN}✓${NC} 编译完成 / Build complete"

# ============================================================================
# 3. Install into ~/.apex-agent/ / 安装到 ~/.apex-agent/
# ============================================================================

echo ""
echo -e "${CYAN}→${NC} 安装到 ${APEX_HOME} ... / Installing into ${APEX_HOME} ..."
node scripts/install.mjs

# ============================================================================
# 4. Symlink apex → ~/.local/bin/apex / 软链 CLI
# ============================================================================

echo -e "${CYAN}→${NC} 设置 apex 命令... / Setting up apex command..."
mkdir -p "$LOCAL_BIN"
ln -sf "$APEX_HOME/app/bin/apex" "$LOCAL_BIN/apex"
echo -e "${GREEN}✓${NC} 已软链 apex → $LOCAL_BIN/apex / Symlinked apex → $LOCAL_BIN/apex"

# ============================================================================
# 5. PATH setup / PATH 设置
# ============================================================================

SHELL_CONFIG=""
if [[ "$SHELL" == *"zsh"* ]]; then
    SHELL_CONFIG="$HOME/.zshrc"
elif [[ "$SHELL" == *"bash"* ]]; then
    SHELL_CONFIG="$HOME/.bashrc"
    [ ! -f "$SHELL_CONFIG" ] && SHELL_CONFIG="$HOME/.bash_profile"
else
    [ -f "$HOME/.zshrc" ] && SHELL_CONFIG="$HOME/.zshrc"
    [ -z "$SHELL_CONFIG" ] && [ -f "$HOME/.bashrc" ] && SHELL_CONFIG="$HOME/.bashrc"
    [ -z "$SHELL_CONFIG" ] && [ -f "$HOME/.bash_profile" ] && SHELL_CONFIG="$HOME/.bash_profile"
fi

if [ -n "$SHELL_CONFIG" ]; then
    touch "$SHELL_CONFIG" 2>/dev/null || true
    if ! grep -q '\.local/bin' "$SHELL_CONFIG" 2>/dev/null; then
        echo "" >> "$SHELL_CONFIG"
        echo "# Apex Agent — ensure ~/.local/bin is on PATH" >> "$SHELL_CONFIG"
        echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$SHELL_CONFIG"
        echo -e "${GREEN}✓${NC} 已将 ~/.local/bin 加入 PATH（$SHELL_CONFIG）/ Added ~/.local/bin to PATH in $SHELL_CONFIG"
    else
        echo -e "${GREEN}✓${NC} ~/.local/bin 已在 PATH 中 / ~/.local/bin already on PATH"
    fi
fi

# ============================================================================
# 6. Interactive configuration / 交互配置
# ============================================================================

APEX_BIN="$APEX_HOME/app/bin/apex"
mkdir -p "$APEX_HOME"

# ensure .env exists (append-friendly) / 确保 .env 存在（可追加）
[ -f "$APEX_ENV" ] || touch "$APEX_ENV"
chmod 600 "$APEX_ENV" 2>/dev/null || true

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}  配置大模型 / Configure the model${NC}  ${YELLOW}(必需 / required)${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  提供者 provider:  openai（OpenAI 兼容，含 DeepSeek/Qwen/GLM 等）| anthropic"
echo ""

# --- provider / 提供者 ---
while true; do
    read -p "  provider [openai]: " PROVIDER
    PROVIDER="${PROVIDER:-openai}"
    if [ "$PROVIDER" = "openai" ] || [ "$PROVIDER" = "anthropic" ]; then
        break
    fi
    echo -e "  ${RED}✗${NC} 请输入 openai 或 anthropic / enter openai or anthropic"
done

# --- name (providerName) / 提供者名称 ---
read -p "  提供者名称 providerName（用于引用 providers 列表）[default]: " PROVIDER_NAME
PROVIDER_NAME="${PROVIDER_NAME:-default}"

# --- baseUrl ---
if [ "$PROVIDER" = "openai" ]; then
    read -p "  baseUrl（OpenAI 兼容端点，如 https://api.deepseek.com/v1）: " BASE_URL
else
    read -p "  baseUrl（留空 = 官方端点 / empty = official）: " BASE_URL
fi

# --- apiKey / API 密钥 ---
read -sp "  apiKey（输入不回显 / hidden）: " API_KEY
echo ""
if [ -z "$API_KEY" ]; then
    echo -e "  ${YELLOW}⚠${NC} apiKey 为空，稍后可用环境变量补（OPENAI_API_KEY / ANTHROPIC_API_KEY）"
fi

# --- model / 模型 ---
if [ "$PROVIDER" = "openai" ]; then
    read -p "  模型 model [deepseek-chat]: " MODEL
    MODEL="${MODEL:-deepseek-chat}"
else
    read -p "  模型 model [claude-sonnet-4-5]: " MODEL
    MODEL="${MODEL:-claude-sonnet-4-5}"
fi

echo ""
echo -e "${GREEN}✓${NC} 大模型配置完成，正在写入... / Model config done, writing..."

# write apiKey → .env (credential) / 凭据写 .env
if [ -n "$API_KEY" ]; then
    if [ "$PROVIDER" = "openai" ]; then
        echo "OPENAI_API_KEY=$API_KEY" >> "$APEX_ENV"
    else
        echo "ANTHROPIC_API_KEY=$API_KEY" >> "$APEX_ENV"
    fi
fi

# write non-secret model config → config.yaml (via apex config set, comments preserved)
"$APEX_BIN" config set model.provider "$PROVIDER" >/dev/null 2>&1 || true
"$APEX_BIN" config set model.providerName "$PROVIDER_NAME" >/dev/null 2>&1 || true
"$APEX_BIN" config set model.model "$MODEL" >/dev/null 2>&1 || true
if [ -n "$BASE_URL" ]; then
    "$APEX_BIN" config set model.baseUrl "$BASE_URL" >/dev/null 2>&1 || true
fi

echo -e "${GREEN}✓${NC} 模型已配置：$PROVIDER / $MODEL / Model configured: $PROVIDER / $MODEL"

# ============================================================================
# 7. Feishu messaging (optional) / 飞书消息（可选）
# ============================================================================

echo ""
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${CYAN}  配置消息平台 / Configure messaging${NC}  ${YELLOW}(可选 / optional)${NC}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  当前支持：飞书 Feishu（Lark）机器人 / Currently supports: Feishu (Lark) bot"
echo ""

read -p "  是否配置飞书消息？/ Configure Feishu? [Y/n] " -n 1 -r
echo ""
if [[ $REPLY =~ ^[Yy]$ ]] || [[ -z $REPLY ]]; then
    read -p "  App ID: " FEISHU_APP_ID
    read -sp "  App Secret（输入不回显 / hidden）: " FEISHU_APP_SECRET
    echo ""
    read -p "  domain [feishu]（feishu 国内 | lark 国际）: " FEISHU_DOMAIN
    FEISHU_DOMAIN="${FEISHU_DOMAIN:-feishu}"

    if [ -n "$FEISHU_APP_ID" ] && [ -n "$FEISHU_APP_SECRET" ]; then
        echo "FEISHU_APP_ID=$FEISHU_APP_ID" >> "$APEX_ENV"
        echo "FEISHU_APP_SECRET=$FEISHU_APP_SECRET" >> "$APEX_ENV"
        "$APEX_BIN" config set gateway.feishu.enabled true >/dev/null 2>&1 || true
        "$APEX_BIN" config set gateway.feishu.domain "$FEISHU_DOMAIN" >/dev/null 2>&1 || true
        echo -e "${GREEN}✓${NC} 飞书已配置（domain=$FEISHU_DOMAIN），凭据写入 .env / Feishu configured, credentials → .env"
    else
        echo -e "${YELLOW}⚠${NC} App ID/Secret 为空，飞书未启用（稍后手动编辑 ~/.apex-agent/.env）/ App ID/Secret empty, Feishu not enabled"
    fi
else
    echo -e "${YELLOW}⚠${NC} 跳过飞书配置（稍后可用 'apex config set gateway.feishu.enabled true' 启用）/ Skipped Feishu (enable later via 'apex config set gateway.feishu.enabled true')"
fi

# ============================================================================
# 8. Done / 完成
# ============================================================================

echo ""
echo -e "${GREEN}✓ 安装完成！/ Setup complete!${NC}"
echo ""
echo "下一步 / Next steps:"
echo ""
if [ -n "$SHELL_CONFIG" ]; then
    echo "  1. 刷新 shell / Reload your shell:"
    echo "     source $SHELL_CONFIG"
    echo ""
fi
echo "  2. 开始对话 / Start chatting:"
echo "     apex"
echo ""
echo "  3. 启动网关（飞书长连接 + 定时任务）/ Start the gateway:"
echo "     apex gateway run"
echo ""
echo "其他命令 / Other commands:"
echo "  apex --help           # 查看全部命令 / see all commands"
echo "  apex config           # 查看有效配置 / show effective config"
echo "  apex migrate          # 迁移配置到当前 schema 版本 / migrate config schema"
echo "  apex gateway install  # 安装网关为系统服务 / install gateway as a service"
echo ""
echo -e "${YELLOW}提示 / Note:${NC} 凭据已写入 ~/.apex-agent/.env（不进 config.yaml），"
echo -e "     修改后直接编辑该文件，重启 apex 生效。"
echo ""
