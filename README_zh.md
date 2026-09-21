# Apex Agent

<p align="center">
  <img src="assets/logo-wordmark.svg" alt="Apex Agent" width="360" />
</p>

**努力向人一样工作 · Work like a human**

Apex Agent 是一个自托管的「软硬分离」智能体框架。固定的**信任根**（确定性 gate 闸门 + verify 验真）放在硬层，模型永远无法绕过；其余部分——感知 → 决策 → 执行 → 反馈 → 记忆 → 进化——作为可替换的服务跑在软层。

> **核心信念**：模型负责「说」，代码负责「验」。验真是确定性的，不是靠 prompt 商量的。验真关掉时，agent 诚实标注 `unverified`——绝不把「跳过了校验」谎报成「ok」。

---

## 特性

- **确定性信任根**——每个工具调用都过硬闸门（denylist），每个结果都用证据验真（`file_exists` / `file_contains` / `exit_code` / …）。模型骗不过它。
- **软硬分离**——模型（软层）和验真（硬层）物理分开，换模型不用碰信任根。
- **器官化架构**——insula（遥测）、limbic（验收）、body（调度）、nerve（子智能体）、mouth（报告）、learner（学习）、evolver（记忆蒸馏）都是独立、可替换的服务。
- **长期记忆**——结构化事实、三段用户画像、前瞻、可复用经验，离线错峰蒸馏（绝不和主循环抢模型）。
- **离线进化**——facts / profile / case / skill-review 各自节奏，post-turn 串行触发。
- **技能**——内置 32 个通用技能（docx / pdf / xlsx / github / research / creative / …），也可自建。
- **MCP、定时任务、子智能体、浏览器、插件**——全部一等公民。
- **多平台消息**——飞书（Lark）已上线；干净的平台对接契约，可自行接 Telegram / Discord / …。

---

## 环境要求

- **Node.js ≥ 20**（含 npm）

---

## 安装

### macOS / Linux

```bash
bash install.sh
```

### Windows

双击 `install.cmd`，或在 PowerShell 里运行 `.\install.ps1`。

安装脚本会：

1. 检测 Node.js / npm
2. 装依赖 + 编译
3. 安装到 `~/.apex-agent/`
4. 软链 `apex` 到 `~/.local/bin`
5. 把 `~/.local/bin` 写进 shell PATH
6. 交互配置**大模型**（必填）和**飞书消息**（可选）

凭据写入 `~/.apex-agent/.env`——绝不进 `config.yaml`。非敏感配置进 `~/.apex-agent/config.yaml`。

```bash
source ~/.zshrc    # 或 ~/.bashrc
apex               # 开始对话（TUI）
```

详见 [docs/installation.md](docs/installation.md)。

---

## 快速开始

```bash
# 启动终端界面
apex

# 跑一个一次性任务
apex run "你好"

# 查看全部命令
apex --help
```

---

## 命令总览

| 分组     | 命令                                                                    |
| -------- | ----------------------------------------------------------------------- |
| 会话     | `tui`, `run`, `task`, `resume`, `repl`, `delegate`          |
| 配置     | `config`, `config set`, `migrate`, `uninstall`                  |
| 工作区   | `workspace list/create/switch/current`                                |
| 会话管理 | `sessions list/show/search/create/delete/rename/fork`                 |
| 记忆     | `memory list/add/rm/fact/fact-list/fact-rm`                           |
| 技能     | `skills list/show/create/install/delete`                              |
| 审批     | `approvals suggest [--apply]`                                         |
| 插件     | `plugins list/load/unload`                                            |
| MCP      | `mcp list/add/remove`                                                 |
| 定时任务 | `cron list/add/edit/remove/run/pause/resume/runs/status/tick/notepad` |
| 网关     | `gateway run/install/uninstall/start/restart/status`                  |
| 工具     | `tools list/enable/disable`                                           |
| 浏览器   | `browser status/connect/disconnect`                                   |

跑 `apex --help` 看完整列表。

---

## 配置

所有配置在 `~/.apex-agent/config.yaml`（首次运行自动生成）和 `~/.apex-agent/.env`（凭据）。

- **大模型**——`openai`（OpenAI 兼容：DeepSeek / Qwen / GLM / …）或 `anthropic`。设 `provider`、`providerName`、`model`、`baseUrl`；api key 放 `.env`。
- **飞书**——`gateway.feishu.*`；app id / secret 放 `.env`。

```bash
apex config            # 查看生效配置
apex config set <key> <value>
apex migrate           # 迁移配置到当前 schema
```

每个字段详见 [docs/configuration.md](docs/configuration.md)。

---

## 卸载

```bash
apex uninstall
```

只删**程序**（运行时 + `apex` 软链 + PATH 条目）。你的**数据**（会话、记忆、配置、定时任务、凭据）有意保留在 `~/.apex-agent/`——输出里会告诉你如何彻底清空。

---

## 文档

| 文档                                          | 内容             |
| --------------------------------------------- | ---------------- |
| [docs/installation.md](docs/installation.md)   | 完整安装流程     |
| [docs/configuration.md](docs/configuration.md) | 每个配置字段     |
| [docs/uninstall.md](docs/uninstall.md)         | 卸载 + 数据保留  |
| [docs/development.md](docs/development.md)     | 架构、构建、测试 |
| [docs/plugins.md](docs/plugins.md)             | 写插件           |
| [docs/platforms.md](docs/platforms.md)         | 接入消息平台     |
| [CHANGELOG.md](CHANGELOG.md)                   | 版本记录         |
| [DISCLAIMER.md](DISCLAIMER.md)                 | 声明             |

---

## 许可证

MIT
