# Apex Agent

<p align="center">
  <img src="assets/logo-wordmark.svg" alt="Apex Agent" width="360" />
</p>

**努力向人一样工作 · Work like a human**

Apex Agent is a self-hosted, soft/hard-separated AI agent framework. A fixed **trust root** (deterministic gate + verify) sits in the hard layer and can never be bypassed by the model; the rest of the agent — perceive → decide → execute → feedback → memory → evolution — runs as swappable services on the soft layer.

> **The core belief:** the model *talks*, the code *verifies*. Verification is deterministic, not prompt-negotiated. When verification is off, the agent honestly reports `unverified` — it never claims `ok` for something it skipped.

---

## Features

- **Deterministic trust root** — every tool call passes a hard gate (denylist) and every result is verified with evidence (`file_exists` / `file_contains` / `exit_code` / …). The model can't lie its way past it.
- **Soft/hard separation** — the model (soft layer) and the verification (hard layer) are physically separate. Swap the model without touching the trust root.
- **Organ-based architecture** — insula (telemetry), limbic (acceptance), body (dispatch), nerve (sub-agents), mouth (report), learner (learning), evolver (memory distillation) are independent, replaceable services.
- **Long-term memory** — structured facts, a three-part user profile, foresights, and reusable agent cases, distilled offline on a staggered turn-based cadence (never competes with the live loop for the model).
- **Offline evolution** — facts / profile / case / skill-review run on their own cadence, post-turn and serial.
- **Skills** — 32 built-in skills (docx / pdf / xlsx / github / research / creative / …), plus your own.
- **MCP, cron, sub-agents, browser, plugins** — all first-class.
- **Multi-platform messaging** — Feishu (Lark) ships today; a clean public contract for adding Telegram / Discord / … yourself.

---

## Requirements

- **Node.js ≥ 20** (with npm)

---

## Install

### macOS / Linux

```bash
bash install.sh
```

### Windows

Double-click `install.cmd`, or in PowerShell run `.\install.ps1`.

The installer:

1. checks Node.js / npm
2. installs dependencies + builds
3. installs into `~/.apex-agent/`
4. symlinks `apex` into `~/.local/bin`
5. adds `~/.local/bin` to your shell PATH
6. interactively configures the **model** (required) and **Feishu messaging** (optional)

Credentials are written to `~/.apex-agent/.env` — never into `config.yaml`. Non-secret settings go into `~/.apex-agent/config.yaml`.

```bash
source ~/.zshrc    # or ~/.bashrc
apex               # start chatting (TUI)
```

See [docs/installation.md](docs/installation.md) for full details.

---

## Quick start

```bash
# Start the terminal UI
apex

# Run a one-shot task
apex run "hello"

# List / manage commands
apex --help
```

---

## Command surface

| Group | Commands |
|-------|----------|
| Chat | `tui`, `run`, `task`, `resume`, `repl`, `delegate` |
| Config | `config`, `config set`, `migrate`, `uninstall` |
| Workspace | `workspace list/create/switch/current` |
| Sessions | `sessions list/show/search/create/delete/rename/fork` |
| Memory | `memory list/add/rm/fact/fact-list/fact-rm` |
| Skills | `skills list/show/create/install/delete` |
| Approvals | `approvals suggest [--apply]` |
| Plugins | `plugins list/load/unload` |
| MCP | `mcp list/add/remove` |
| Cron | `cron list/add/edit/remove/run/pause/resume/runs/status/tick/notepad` |
| Gateway | `gateway run/install/uninstall/start/restart/status` |
| Tools | `tools list/enable/disable` |
| Browser | `browser status/connect/disconnect` |

Run `apex --help` for the full list.

---

## Configuration

Everything lives in `~/.apex-agent/config.yaml` (auto-generated on first run) and `~/.apex-agent/.env` (credentials).

- **Model** — `openai` (OpenAI-compatible: DeepSeek / Qwen / GLM / …) or `anthropic`. Set `provider`, `providerName`, `model`, `baseUrl`; the api key goes in `.env`.
- **Feishu** — `gateway.feishu.*`; app id / secret in `.env`.

```bash
apex config            # show effective config
apex config set <key> <value>
apex migrate           # migrate config to the current schema
```

See [docs/configuration.md](docs/configuration.md) for every field.

---

## Uninstall

```bash
apex uninstall
```

Removes the **program** (runtime + `apex` symlink + PATH entry). Your **data** (sessions, memory, config, cron jobs, credentials) is deliberately kept at `~/.apex-agent/` — the message tells you how to fully wipe it if you want.

---

## Documentation

| Doc | Contents |
|-----|----------|
| [docs/installation.md](docs/installation.md) | Full install walkthrough |
| [docs/configuration.md](docs/configuration.md) | Every config field |
| [docs/uninstall.md](docs/uninstall.md) | Uninstall + data retention |
| [docs/development.md](docs/development.md) | Architecture, building, testing |
| [docs/plugins.md](docs/plugins.md) | Writing a plugin |
| [docs/platforms.md](docs/platforms.md) | Adding a messaging platform |
| [CHANGELOG.md](CHANGELOG.md) | Release notes / 版本记录 |
| [DISCLAIMER.md](DISCLAIMER.md) | Disclaimer / 声明 |

---

## License

MIT
