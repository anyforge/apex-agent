# ============================================================================
# Apex Agent Windows Setup Script — 努力向人一样工作 / Work like a human
# ============================================================================
# Windows 一键安装脚本：下载源码后在 PowerShell 里运行 `.\install.ps1`（或双击 install.cmd）。
# Windows one-shot installer: run `.\install.ps1` (or double-click install.cmd).
# ============================================================================

$ErrorActionPreference = "Stop"

# Enable ANSI escape sequence support (RGB truecolor) on Windows console.
if ($host.UI.SupportsVirtualTerminal -eq $false) {
    try {
        Add-Type -MemberDefinition '[DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleMode(IntPtr h, uint m); [DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int d);' -Name Native -Namespace Win32
        $h = [Win32.Native]::GetStdHandle(-11)
        [Win32.Native]::SetConsoleMode($h, 0x7) | Out-Null
    } catch {}
}

# ---- Colors (RGB truecolor, clack-style) ----------------------------------
$ACCENT       = "$([char]27)[38;2;59;109;245m"     # blue
$ACCENT_BRIGHT = "$([char]27)[38;2;108;92;231m"  # blue-purple
$INFO         = "$([char]27)[38;2;91;140;245m"   # info blue
$SUCCESS      = "$([char]27)[38;2;47;191;113m"   # green
$WARN         = "$([char]27)[38;2;255;176;32m"   # amber
$ERROR        = "$([char]27)[38;2;226;61;45m"    # red
$MUTED        = "$([char]27)[38;2;139;127;119m"  # gray
$BOLD         = "$([char]27)[1m"
$NC           = "$([char]27)[0m"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

$ApexHome = Join-Path $HOME ".apex-agent"
$ApexEnv = Join-Path $ApexHome ".env"
$BinDir = Join-Path $ApexHome "app\bin"

# ---- clack-style helpers ---------------------------------------------------
function clack_intro([string]$title) {
    Write-Host ""
    Write-Host "${ACCENT}┌${NC}  ${BOLD}${title}${NC}"
    Write-Host "${ACCENT}│${NC}"
}
function clack_step([string]$msg) {
    Write-Host "${ACCENT}│${NC}  ${msg}"
}
function clack_outro([string]$msg) {
    Write-Host "${ACCENT}│${NC}"
    Write-Host "${ACCENT}└${NC}  ${msg}"
    Write-Host ""
}

clack_intro "Apex Agent Installer"
clack_step "${MUTED}努力向人一样工作 · Work like a human${NC}"

# ============================================================================
# 1. Node.js / npm check
# ============================================================================

clack_step "${ACCENT}◆${NC} 检测 Node.js..."

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host "${ERROR}◆${NC} 未找到 Node.js，请先安装："
    Write-Host "   ${MUTED}https://nodejs.org/  (Node.js >= 22)${NC}"
    exit 1
}

$nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 22) {
    Write-Host "${ERROR}◆${NC} 需要 Node.js >= 22（当前 $(node -v)）"
    Write-Host "   ${MUTED}node:sqlite 内置模块需要 Node 22+（会话/定时任务/审批/网关账本依赖）${NC}"
    exit 1
}
clack_step "${SUCCESS}◆${NC} Node.js $(node -v) 已就绪"

$npm = Get-Command npm -ErrorAction SilentlyContinue
if (-not $npm) {
    Write-Host "${ERROR}◆${NC} 未找到 npm（随 Node.js 一起安装）"
    exit 1
}
clack_step "${SUCCESS}◆${NC} npm $(npm -v) 已就绪"

# ============================================================================
# 2. Dependencies + build
# ============================================================================

clack_step "${ACCENT}◆${NC} 安装依赖..."
npm install --loglevel=error *> $null
if ($LASTEXITCODE -ne 0) {
    npm install --loglevel=error
    Write-Host "${ERROR}◆${NC} 依赖安装失败（见上方 npm 报错）"
    exit 1
}
clack_step "${SUCCESS}◆${NC} 依赖安装完成"

clack_step "${ACCENT}◆${NC} 编译中..."
npm run build --silent *> $null
if ($LASTEXITCODE -ne 0) {
    npm run build --silent
    Write-Host "${ERROR}◆${NC} 编译失败，可手动运行 'npm run build' 看完整报错"
    exit 1
}
clack_step "${SUCCESS}◆${NC} 编译完成"

# ============================================================================
# 3. Install into %USERPROFILE%\.apex-agent\
# ============================================================================

clack_step "${ACCENT}◆${NC} 安装到 $ApexHome..."
node scripts\install.mjs
if ($LASTEXITCODE -ne 0) {
    Write-Host "${ERROR}◆${NC} 安装失败"
    exit 1
}

# ============================================================================
# 4. Add bin dir to user PATH
# ============================================================================

clack_step "${ACCENT}◆${NC} 设置 apex 命令..."

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$BinDir*") {
    $newPath = if ([string]::IsNullOrEmpty($userPath)) { $BinDir } else { "$userPath;$BinDir" }
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    clack_step "${SUCCESS}◆${NC} 已将 app\bin 加入用户 PATH"
} else {
    clack_step "${SUCCESS}◆${NC} app\bin 已在 PATH 中"
}

# ============================================================================
# 5. Interactive configuration
# ============================================================================

$ApexCmd = Join-Path $BinDir "apex.cmd"
New-Item -ItemType Directory -Force -Path $ApexHome | Out-Null

if (-not (Test-Path $ApexEnv)) { New-Item -ItemType File -Path $ApexEnv -Force | Out-Null }

Write-Host ""
Write-Host "${ACCENT}┌${NC}  ${BOLD}配置大模型${NC}  ${WARN}(必需)${NC}"
Write-Host "${ACCENT}│${NC}"
Write-Host "${ACCENT}│${NC}  ${MUTED}provider: openai（OpenAI 兼容，含 DeepSeek/Qwen/GLM 等）| anthropic${NC}"
Write-Host "${ACCENT}│${NC}"

# --- provider ---
do {
    $PROVIDER = Read-Host "${ACCENT}│${NC}  ${MUTED}provider${NC} [openai]"
    if ([string]::IsNullOrWhiteSpace($PROVIDER)) { $PROVIDER = "openai" }
    if ($PROVIDER -ne "openai" -and $PROVIDER -ne "anthropic") {
        Write-Host "${WARN}│${NC}  请输入 openai 或 anthropic"
        $PROVIDER = ""
    }
} while ([string]::IsNullOrEmpty($PROVIDER))

# --- name ---
$PROVIDER_NAME = Read-Host "${ACCENT}│${NC}  ${MUTED}providerName${NC} [default]"
if ([string]::IsNullOrWhiteSpace($PROVIDER_NAME)) { $PROVIDER_NAME = "default" }

# --- baseUrl ---
if ($PROVIDER -eq "openai") {
    $BASE_URL = Read-Host "${ACCENT}│${NC}  ${MUTED}baseUrl${NC}（如 https://api.deepseek.com/v1）"
} else {
    $BASE_URL = Read-Host "${ACCENT}│${NC}  ${MUTED}baseUrl${NC}（留空 = 官方端点）"
}

# --- apiKey ---
$API_KEY = Read-Host "${ACCENT}│${NC}  ${MUTED}apiKey${NC}（输入不回显）" -AsSecureString
$API_KEY_PLAIN = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($API_KEY))
if ([string]::IsNullOrWhiteSpace($API_KEY_PLAIN)) {
    Write-Host "${WARN}│${NC}  apiKey 为空，稍后可用环境变量补（OPENAI_API_KEY / ANTHROPIC_API_KEY）"
}

# --- model ---
if ($PROVIDER -eq "openai") {
    $MODEL = Read-Host "${ACCENT}│${NC}  ${MUTED}model${NC} [deepseek-chat]"
    if ([string]::IsNullOrWhiteSpace($MODEL)) { $MODEL = "deepseek-chat" }
} else {
    $MODEL = Read-Host "${ACCENT}│${NC}  ${MUTED}model${NC} [claude-sonnet-4-5]"
    if ([string]::IsNullOrWhiteSpace($MODEL)) { $MODEL = "claude-sonnet-4-5" }
}

Write-Host "${ACCENT}└${NC}  ${SUCCESS}◆${NC} 模型配置完成，正在写入..."

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

Write-Host "${SUCCESS}◆${NC} 模型已配置：$PROVIDER / $MODEL"

# ============================================================================
# 6. Feishu messaging (optional)
# ============================================================================

Write-Host ""
Write-Host "${ACCENT}┌${NC}  ${BOLD}配置消息平台${NC}  ${WARN}(可选)${NC}"
Write-Host "${ACCENT}│${NC}"
Write-Host "${ACCENT}│${NC}  ${MUTED}当前支持：飞书 Feishu（Lark）机器人${NC}"
Write-Host "${ACCENT}│${NC}"

$doFeishu = Read-Host "${ACCENT}│${NC}  是否配置飞书消息？[Y/n]"
if ($doFeishu -eq "" -or $doFeishu -match "^[Yy]") {
    $FEISHU_APP_ID = Read-Host "${ACCENT}│${NC}  ${MUTED}App ID${NC}"
    $FEISHU_SECRET = Read-Host "${ACCENT}│${NC}  ${MUTED}App Secret${NC}（输入不回显）" -AsSecureString
    $FEISHU_SECRET_PLAIN = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($FEISHU_SECRET))
    $FEISHU_DOMAIN = Read-Host "${ACCENT}│${NC}  ${MUTED}domain${NC} [feishu]（feishu 国内 | lark 国际）"
    if ([string]::IsNullOrWhiteSpace($FEISHU_DOMAIN)) { $FEISHU_DOMAIN = "feishu" }
    Write-Host "${ACCENT}└${NC}"

    if (-not [string]::IsNullOrWhiteSpace($FEISHU_APP_ID) -and -not [string]::IsNullOrWhiteSpace($FEISHU_SECRET_PLAIN)) {
        Add-Content -Path $ApexEnv -Value "FEISHU_APP_ID=$FEISHU_APP_ID"
        Add-Content -Path $ApexEnv -Value "FEISHU_APP_SECRET=$FEISHU_SECRET_PLAIN"
        & $ApexCmd config set gateway.feishu.enabled true | Out-Null
        & $ApexCmd config set gateway.feishu.domain $FEISHU_DOMAIN | Out-Null
        Write-Host "${SUCCESS}◆${NC} 飞书已配置（domain=$FEISHU_DOMAIN），凭据写入 .env"
    } else {
        Write-Host "${WARN}◆${NC} App ID/Secret 为空，飞书未启用"
    }
} else {
    Write-Host "${ACCENT}└${NC}"
    Write-Host "${WARN}◆${NC} 跳过飞书配置"
}

# ============================================================================
# 7. Done
# ============================================================================

clack_outro "${SUCCESS}◆${NC} 安装完成"

Write-Host "${BOLD}下一步：${NC}"
Write-Host ""
Write-Host "  ${MUTED}1.${NC} 打开一个新的终端（让 PATH 生效）："
Write-Host ""
Write-Host "  ${MUTED}2.${NC} 开始对话："
Write-Host "     ${INFO}apex${NC}"
Write-Host ""
Write-Host "  ${MUTED}3.${NC} 启动网关（飞书长连接 + 定时任务）："
Write-Host "     ${INFO}apex gateway run${NC}"
Write-Host ""
Write-Host "${BOLD}其他命令：${NC}"
Write-Host "  ${INFO}apex --help${NC}           # 查看全部命令"
Write-Host "  ${INFO}apex config${NC}           # 查看有效配置"
Write-Host "  ${INFO}apex migrate${NC}          # 迁移配置到当前 schema 版本"
Write-Host "  ${INFO}apex gateway install${NC}  # 安装网关为系统服务"
Write-Host ""
Write-Host "${MUTED}提示：凭据已写入 $ApexEnv（不进 config.yaml），修改后重启 apex 生效。${NC}"
Write-Host ""
