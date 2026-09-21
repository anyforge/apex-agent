# ============================================================================
# Apex Agent Windows Setup Script
# ============================================================================
# Windows 一键安装脚本：下载源码后在 PowerShell 里运行 `.\install.ps1`（或双击 install.cmd）。
# Windows one-shot installer: run `.\install.ps1` (or double-click install.cmd).
#
# 流程 / Flow（对齐 install.sh）:
#   1. 检测 Node.js / npm（>= 20）
#   2. npm install + npm run build
#   3. 安装到 %USERPROFILE%\.apex-agent\
#   4. 把 app\bin 加入用户 PATH
#   5. 交互配置：大模型（必填）+ 飞书消息（可选）
#   6. 凭据写 .env（绝不进 config.yaml）
# ============================================================================

$ErrorActionPreference = "Stop"

# ---- Colors / 颜色 ----
$GREEN = [ConsoleColor]::Green
$YELLOW = [ConsoleColor]::Yellow
$CYAN = [ConsoleColor]::Cyan
$RED = [ConsoleColor]::Red

function Write-Color([ConsoleColor]$color, [string]$text) {
    $prev = [Console]::ForegroundColor
    [Console]::ForegroundColor = $color
    Write-Host $text -NoNewline
    [Console]::ForegroundColor = $prev
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

$ApexHome = Join-Path $HOME ".apex-agent"
$ApexEnv = Join-Path $ApexHome ".env"
$BinDir = Join-Path $ApexHome "app\bin"

Write-Host ""
Write-Color $CYAN "⚡ Apex Agent Setup"
Write-Host " — 努力向人一样工作 / Work like a human"
Write-Host ""

# ============================================================================
# 1. Node.js / npm check / 检测 Node.js / npm
# ============================================================================

Write-Color $CYAN "→ "
Write-Host "检测 Node.js... / Checking Node.js..."

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Color $RED "✗ "
    Write-Host "未找到 Node.js，请先安装 / Node.js not found. Install it first:"
    Write-Host "    https://nodejs.org/  (Node.js >= 20)"
    exit 1
}

$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 20) {
    Write-Color $RED "✗ "
    Write-Host "需要 Node.js >= 20（当前 $(node -v)）/ Node.js >= 20 required."
    exit 1
}
Write-Color $GREEN "✓ "
Write-Host "找到 Node.js $(node -v) / Node.js found"

$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) {
    Write-Color $RED "✗ "
    Write-Host "未找到 npm（随 Node.js 一起安装）/ npm not found."
    exit 1
}
Write-Color $GREEN "✓ "
Write-Host "找到 npm $(npm -v) / npm found"

# ============================================================================
# 2. Dependencies + build / 依赖 + 编译
# ============================================================================

Write-Host ""
Write-Color $CYAN "→ "
Write-Host "安装依赖... / Installing dependencies..."
# 成功时完全静默；失败时重跑显示真实报错。
npm install --loglevel=error *> $null
if ($LASTEXITCODE -ne 0) {
    npm install --loglevel=error
    Write-Color $RED "✗ "
    Write-Host "依赖安装失败（见上方 npm 报错）/ Dependency install failed."
    exit 1
}
Write-Color $GREEN "✓ "
Write-Host "依赖安装完成 / Dependencies installed"

Write-Color $CYAN "→ "
Write-Host "编译中... / Building..."
npm run build --silent *> $null
if ($LASTEXITCODE -ne 0) {
    npm run build --silent
    Write-Color $RED "✗ "
    Write-Host "编译失败，可手动运行 'npm run build' 看完整报错 / Build failed."
    exit 1
}
Write-Color $GREEN "✓ "
Write-Host "编译完成 / Build complete"

# ============================================================================
# 3. Install into %USERPROFILE%\.apex-agent\ / 安装
# ============================================================================

Write-Host ""
Write-Color $CYAN "→ "
Write-Host "安装到 $ApexHome ... / Installing into $ApexHome ..."
node scripts\install.mjs
if ($LASTEXITCODE -ne 0) {
    Write-Color $RED "✗ "
    Write-Host "安装失败 / Install failed."
    exit 1
}

# ============================================================================
# 4. Add bin dir to user PATH / 加入 PATH
# ============================================================================

Write-Color $CYAN "→ "
Write-Host "设置 apex 命令... / Setting up apex command..."

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$BinDir*") {
    $newPath = if ([string]::IsNullOrEmpty($userPath)) { $BinDir } else { "$userPath;$BinDir" }
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Write-Color $GREEN "✓ "
    Write-Host "已将 app\bin 加入用户 PATH / Added app\bin to user PATH"
} else {
    Write-Color $GREEN "✓ "
    Write-Host "app\bin 已在 PATH 中 / app\bin already on PATH"
}

# ============================================================================
# 5. Interactive configuration / 交互配置
# ============================================================================

$ApexCmd = Join-Path $BinDir "apex.cmd"
New-Item -ItemType Directory -Force -Path $ApexHome | Out-Null

if (-not (Test-Path $ApexEnv)) { New-Item -ItemType File -Path $ApexEnv -Force | Out-Null }

Write-Host ""
Write-Color $CYAN "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host ""
Write-Color $CYAN "  配置大模型 / Configure the model"
Write-Color $YELLOW "  (必需 / required)"
Write-Host ""
Write-Color $CYAN "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host ""
Write-Host "  提供者 provider:  openai（OpenAI 兼容，含 DeepSeek/Qwen/GLM 等）| anthropic"
Write-Host ""

# --- provider / 提供者 ---
do {
    $PROVIDER = Read-Host "  provider [openai]"
    if ([string]::IsNullOrWhiteSpace($PROVIDER)) { $PROVIDER = "openai" }
    if ($PROVIDER -ne "openai" -and $PROVIDER -ne "anthropic") {
        Write-Color $RED "✗ "
        Write-Host "请输入 openai 或 anthropic / enter openai or anthropic"
        $PROVIDER = ""
    }
} while ([string]::IsNullOrEmpty($PROVIDER))

# --- name / 名称 ---
$PROVIDER_NAME = Read-Host "  提供者名称 providerName [default]"
if ([string]::IsNullOrWhiteSpace($PROVIDER_NAME)) { $PROVIDER_NAME = "default" }

# --- baseUrl ---
if ($PROVIDER -eq "openai") {
    $BASE_URL = Read-Host "  baseUrl（OpenAI 兼容端点，如 https://api.deepseek.com/v1）"
} else {
    $BASE_URL = Read-Host "  baseUrl（留空 = 官方端点 / empty = official）"
}

# --- apiKey / API 密钥 ---
$API_KEY = Read-Host "  apiKey（输入不回显 / hidden）" -AsSecureString
$API_KEY_PLAIN = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($API_KEY))
if ([string]::IsNullOrWhiteSpace($API_KEY_PLAIN)) {
    Write-Color $YELLOW "⚠ "
    Write-Host "apiKey 为空，稍后可用环境变量补（OPENAI_API_KEY / ANTHROPIC_API_KEY）"
}

# --- model / 模型 ---
if ($PROVIDER -eq "openai") {
    $MODEL = Read-Host "  模型 model [deepseek-chat]"
    if ([string]::IsNullOrWhiteSpace($MODEL)) { $MODEL = "deepseek-chat" }
} else {
    $MODEL = Read-Host "  模型 model [claude-sonnet-4-5]"
    if ([string]::IsNullOrWhiteSpace($MODEL)) { $MODEL = "claude-sonnet-4-5" }
}

Write-Host ""
Write-Color $GREEN "✓ "
Write-Host "大模型配置完成，正在写入... / Model config done, writing..."

# write apiKey → .env (credential)
if (-not [string]::IsNullOrWhiteSpace($API_KEY_PLAIN)) {
    if ($PROVIDER -eq "openai") {
        Add-Content -Path $ApexEnv -Value "OPENAI_API_KEY=$API_KEY_PLAIN"
    } else {
        Add-Content -Path $ApexEnv -Value "ANTHROPIC_API_KEY=$API_KEY_PLAIN"
    }
}

# write non-secret model config → config.yaml
& $ApexCmd config set model.provider $PROVIDER | Out-Null
& $ApexCmd config set model.providerName $PROVIDER_NAME | Out-Null
& $ApexCmd config set model.model $MODEL | Out-Null
if (-not [string]::IsNullOrWhiteSpace($BASE_URL)) {
    & $ApexCmd config set model.baseUrl $BASE_URL | Out-Null
}

Write-Color $GREEN "✓ "
Write-Host "模型已配置：$PROVIDER / $MODEL / Model configured"

# ============================================================================
# 6. Feishu messaging (optional) / 飞书消息（可选）
# ============================================================================

Write-Host ""
Write-Color $CYAN "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host ""
Write-Color $CYAN "  配置消息平台 / Configure messaging"
Write-Color $YELLOW "  (可选 / optional)"
Write-Host ""
Write-Color $CYAN "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
Write-Host ""
Write-Host "  当前支持：飞书 Feishu（Lark）机器人 / Currently supports: Feishu (Lark) bot"
Write-Host ""

$doFeishu = Read-Host "  是否配置飞书消息？/ Configure Feishu? [Y/n]"
if ($doFeishu -eq "" -or $doFeishu -match "^[Yy]") {
    $FEISHU_APP_ID = Read-Host "  App ID"
    $FEISHU_SECRET = Read-Host "  App Secret（输入不回显 / hidden）" -AsSecureString
    $FEISHU_SECRET_PLAIN = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($FEISHU_SECRET))
    $FEISHU_DOMAIN = Read-Host "  domain [feishu]（feishu 国内 | lark 国际）"
    if ([string]::IsNullOrWhiteSpace($FEISHU_DOMAIN)) { $FEISHU_DOMAIN = "feishu" }

    if (-not [string]::IsNullOrWhiteSpace($FEISHU_APP_ID) -and -not [string]::IsNullOrWhiteSpace($FEISHU_SECRET_PLAIN)) {
        Add-Content -Path $ApexEnv -Value "FEISHU_APP_ID=$FEISHU_APP_ID"
        Add-Content -Path $ApexEnv -Value "FEISHU_APP_SECRET=$FEISHU_SECRET_PLAIN"
        & $ApexCmd config set gateway.feishu.enabled true | Out-Null
        & $ApexCmd config set gateway.feishu.domain $FEISHU_DOMAIN | Out-Null
        Write-Color $GREEN "✓ "
        Write-Host "飞书已配置（domain=$FEISHU_DOMAIN），凭据写入 .env / Feishu configured"
    } else {
        Write-Color $YELLOW "⚠ "
        Write-Host "App ID/Secret 为空，飞书未启用 / App ID/Secret empty, Feishu not enabled"
    }
} else {
    Write-Color $YELLOW "⚠ "
    Write-Host "跳过飞书配置 / Skipped Feishu"
}

# ============================================================================
# 7. Done / 完成
# ============================================================================

Write-Host ""
Write-Color $GREEN "✓ 安装完成！/ Setup complete!"
Write-Host ""
Write-Host "下一步 / Next steps:"
Write-Host ""
Write-Host "  1. 打开一个新的终端（让 PATH 生效）/ Open a NEW terminal (so PATH applies):"
Write-Host ""
Write-Host "  2. 开始对话 / Start chatting:"
Write-Host "     apex"
Write-Host ""
Write-Host "  3. 启动网关（飞书长连接 + 定时任务）/ Start the gateway:"
Write-Host "     apex gateway run"
Write-Host ""
Write-Host "其他命令 / Other commands:"
Write-Host "  apex --help           # 查看全部命令 / see all commands"
Write-Host "  apex config           # 查看有效配置 / show effective config"
Write-Host "  apex migrate          # 迁移配置到当前 schema 版本 / migrate config schema"
Write-Host "  apex gateway install  # 安装网关为系统服务 / install gateway as a service"
Write-Host ""
Write-Color $YELLOW "提示 / Note:"
Write-Host " 凭据已写入 $ApexEnv（不进 config.yaml），修改后重启 apex 生效。"
Write-Host ""
