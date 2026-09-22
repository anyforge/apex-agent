#!/bin/bash
# ============================================================================
# Apex Agent Setup Script — 努力向人一样工作 / Work like a human
# ============================================================================
# 一键安装脚本：下载源码后运行 `bash install.sh` 即可完成安装 + 交互配置。
# One-shot installer: clone/download the source, then run `bash install.sh`.
# ============================================================================

set -e

# ---- Colors (RGB truecolor, clack-style) ----------------------------------
ACCENT='\033[38;2;59;109;245m'        # blue
ACCENT_BRIGHT='\033[38;2;108;92;231m' # blue-purple
INFO='\033[38;2;91;140;245m'          # info blue
SUCCESS='\033[38;2;47;191;113m'       # green
WARN='\033[38;2;255;176;32m'          # amber
ERROR='\033[38;2;226;61;45m'          # red
MUTED='\033[38;2;139;127;119m'        # gray
BOLD='\033[1m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

APEX_HOME="$HOME/.apex-agent"
APEX_ENV="$APEX_HOME/.env"
LOCAL_BIN="$HOME/.local/bin"

# ---- clack-style intro/step/outro -----------------------------------------
clack_intro() {
    echo ""
    echo -e "${ACCENT}┌${NC}  ${BOLD}$1${NC}"
    echo -e "${ACCENT}│${NC}"
}
clack_step() {
    echo -e "${ACCENT}│${NC}  $1"
}
clack_outro() {
    echo -e "${ACCENT}│${NC}"
    echo -e "${ACCENT}└${NC}  $1"
    echo ""
}

clack_intro "Apex Agent Installer"
clack_step "${MUTED}努力向人一样工作 · Work like a human${NC}"

# ============================================================================
# 1. Node.js / npm check
# ============================================================================

clack_step "${ACCENT}◆${NC} 检测 Node.js..."

if ! command -v node &> /dev/null; then
    echo -e "${ERROR}◆${NC} 未找到 Node.js，请先安装："
    echo -e "   ${MUTED}https://nodejs.org/  (Node.js >= 22)${NC}"
    echo -e "   ${MUTED}或 brew install node${NC}"
    exit 1
fi

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo "0")
if [ "$NODE_MAJOR" -lt 22 ]; then
    echo -e "${ERROR}◆${NC} 需要 Node.js >= 22（当前 v$(node -v)）"
    echo -e "   ${MUTED}node:sqlite 内置模块需要 Node 22+（会话/定时任务/审批/网关账本依赖）${NC}"
    exit 1
fi
clack_step "${SUCCESS}◆${NC} Node.js $(node -v) 已就绪"

if ! command -v npm &> /dev/null; then
    echo -e "${ERROR}◆${NC} 未找到 npm（随 Node.js 一起安装）"
    exit 1
fi
clack_step "${SUCCESS}◆${NC} npm $(npm -v) 已就绪"

# ============================================================================
# 2. Dependencies + build
# ============================================================================

clack_step "${ACCENT}◆${NC} 安装依赖..."
# 成功时完全静默（npm 的 "added N packages" 走 stdout）；失败时重跑显示真实报错。
if ! npm install --loglevel=error >/dev/null; then
    npm install --loglevel=error
    echo -e "${ERROR}◆${NC} 依赖安装失败（见上方 npm 报错）"
    exit 1
fi
clack_step "${SUCCESS}◆${NC} 依赖安装完成"

clack_step "${ACCENT}◆${NC} 编译中（tsc + 提示词资源）..."
if ! npm run build --silent >/dev/null; then
    npm run build --silent
    echo -e "${ERROR}◆${NC} 编译失败，可手动运行 'npm run build' 看完整报错"
    exit 1
fi
clack_step "${SUCCESS}◆${NC} 编译完成"

# ============================================================================
# 3. Install into ~/.apex-agent/
# ============================================================================

clack_step "${ACCENT}◆${NC} 安装到 ${APEX_HOME}..."
node scripts/install.mjs

# ============================================================================
# 4. Symlink apex → ~/.local/bin/apex
# ============================================================================

clack_step "${ACCENT}◆${NC} 设置 apex 命令..."
mkdir -p "$LOCAL_BIN"
ln -sf "$APEX_HOME/app/bin/apex" "$LOCAL_BIN/apex"
clack_step "${SUCCESS}◆${NC} 已软链 apex → $LOCAL_BIN/apex"

# ============================================================================
# 5. PATH setup
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
        clack_step "${SUCCESS}◆${NC} 已将 ~/.local/bin 加入 PATH（$SHELL_CONFIG）"
    else
        clack_step "${SUCCESS}◆${NC} ~/.local/bin 已在 PATH 中"
    fi
fi

# ============================================================================
# 6. Interactive configuration
# ============================================================================

APEX_BIN="$APEX_HOME/app/bin/apex"
mkdir -p "$APEX_HOME"

# ensure .env exists (append-friendly)
[ -f "$APEX_ENV" ] || touch "$APEX_ENV"
chmod 600 "$APEX_ENV" 2>/dev/null || true

echo ""
echo -e "${ACCENT}┌${NC}  ${BOLD}配置大模型${NC}  ${WARN}(必需)${NC}"
echo -e "${ACCENT}│${NC}"
echo -e "${ACCENT}│${NC}  ${MUTED}provider: openai（OpenAI 兼容，含 DeepSeek/Qwen/GLM 等）| anthropic${NC}"
echo -e "${ACCENT}│${NC}"

# --- provider ---
while true; do
    printf "${ACCENT}│${NC}  ${MUTED}provider${NC} [openai]: "
    read PROVIDER
    PROVIDER="${PROVIDER:-openai}"
    if [ "$PROVIDER" = "openai" ] || [ "$PROVIDER" = "anthropic" ]; then
        break
    fi
    echo -e "${WARN}│${NC}  请输入 openai 或 anthropic"
done

# --- name ---
printf "${ACCENT}│${NC}  ${MUTED}providerName${NC} [default]: "
read PROVIDER_NAME
PROVIDER_NAME="${PROVIDER_NAME:-default}"

# --- baseUrl ---
if [ "$PROVIDER" = "openai" ]; then
    printf "${ACCENT}│${NC}  ${MUTED}baseUrl${NC}（如 https://api.deepseek.com/v1）: "
    read BASE_URL
else
    printf "${ACCENT}│${NC}  ${MUTED}baseUrl${NC}（留空 = 官方端点）: "
    read BASE_URL
fi

# --- apiKey ---
printf "${ACCENT}│${NC}  ${MUTED}apiKey${NC}（输入不回显）: "
read -s API_KEY
echo ""
if [ -z "$API_KEY" ]; then
    echo -e "${WARN}│${NC}  apiKey 为空，稍后可用环境变量补（OPENAI_API_KEY / ANTHROPIC_API_KEY）"
fi

# --- model ---
if [ "$PROVIDER" = "openai" ]; then
    printf "${ACCENT}│${NC}  ${MUTED}model${NC} [deepseek-chat]: "
    read MODEL
    MODEL="${MODEL:-deepseek-chat}"
else
    printf "${ACCENT}│${NC}  ${MUTED}model${NC} [claude-sonnet-4-5]: "
    read MODEL
    MODEL="${MODEL:-claude-sonnet-4-5}"
fi

echo -e "${ACCENT}└${NC}  ${SUCCESS}◆${NC} 模型配置完成，正在写入..."

# write apiKey → .env (credential)
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

echo -e "${SUCCESS}◆${NC} 模型已配置：$PROVIDER / $MODEL"

# ============================================================================
# 7. Feishu messaging (optional)
# ============================================================================

echo ""
echo -e "${ACCENT}┌${NC}  ${BOLD}配置消息平台${NC}  ${WARN}(可选)${NC}"
echo -e "${ACCENT}│${NC}"
echo -e "${ACCENT}│${NC}  ${MUTED}当前支持：飞书 Feishu（Lark）机器人${NC}"
echo -e "${ACCENT}│${NC}"

printf "${ACCENT}│${NC}  是否配置飞书消息？[Y/n] "
read -n 1 -r REPLY
echo ""
if [[ $REPLY =~ ^[Yy]$ ]] || [[ -z $REPLY ]]; then
    printf "${ACCENT}│${NC}  ${MUTED}App ID${NC}: "
    read FEISHU_APP_ID
    printf "${ACCENT}│${NC}  ${MUTED}App Secret${NC}（输入不回显）: "
    read -s FEISHU_APP_SECRET
    echo ""
    printf "${ACCENT}│${NC}  ${MUTED}domain${NC} [feishu]（feishu 国内 | lark 国际）: "
    read FEISHU_DOMAIN
    FEISHU_DOMAIN="${FEISHU_DOMAIN:-feishu}"
    echo -e "${ACCENT}└${NC}"

    if [ -n "$FEISHU_APP_ID" ] && [ -n "$FEISHU_APP_SECRET" ]; then
        echo "FEISHU_APP_ID=$FEISHU_APP_ID" >> "$APEX_ENV"
        echo "FEISHU_APP_SECRET=$FEISHU_APP_SECRET" >> "$APEX_ENV"
        "$APEX_BIN" config set gateway.feishu.enabled true >/dev/null 2>&1 || true
        "$APEX_BIN" config set gateway.feishu.domain "$FEISHU_DOMAIN" >/dev/null 2>&1 || true
        echo -e "${SUCCESS}◆${NC} 飞书已配置（domain=$FEISHU_DOMAIN），凭据写入 .env"
    else
        echo -e "${WARN}◆${NC} App ID/Secret 为空，飞书未启用（稍后手动编辑 ~/.apex-agent/.env）"
    fi
else
    echo -e "${ACCENT}└${NC}"
    echo -e "${WARN}◆${NC} 跳过飞书配置（稍后可用 'apex config set gateway.feishu.enabled true' 启用）"
fi

# ============================================================================
# 8. Done
# ============================================================================

clack_outro "${SUCCESS}◆${NC} 安装完成"

echo -e "${BOLD}下一步：${NC}"
echo ""
if [ -n "$SHELL_CONFIG" ]; then
    echo -e "  ${MUTED}1.${NC} 刷新 shell："
    echo -e "     ${INFO}source $SHELL_CONFIG${NC}"
    echo ""
fi
echo -e "  ${MUTED}2.${NC} 开始对话："
echo -e "     ${INFO}apex${NC}"
echo ""
echo -e "  ${MUTED}3.${NC} 启动网关（飞书长连接 + 定时任务）："
echo -e "     ${INFO}apex gateway run${NC}"
echo ""
echo -e "${BOLD}其他命令：${NC}"
echo -e "  ${INFO}apex --help${NC}           # 查看全部命令"
echo -e "  ${INFO}apex config${NC}           # 查看有效配置"
echo -e "  ${INFO}apex migrate${NC}          # 迁移配置到当前 schema 版本"
echo -e "  ${INFO}apex gateway install${NC}  # 安装网关为系统服务"
echo ""
echo -e "${MUTED}提示：凭据已写入 ~/.apex-agent/.env（不进 config.yaml），修改后重启 apex 生效。${NC}"
echo ""
