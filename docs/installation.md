# Installation

## Requirements

- **Node.js ≥ 20** (with npm)
- macOS / Linux / Windows

## One-shot install

### macOS / Linux

```bash
bash install.sh
```

### Windows

```bat
:: double-click, or in PowerShell:
.\install.ps1
```

`install.cmd` is a double-click wrapper that calls `install.ps1` with `-ExecutionPolicy Bypass` (so the default PowerShell execution policy doesn't block it).

The installer runs these steps in order:

```
1. Check Node.js / npm (>= 20)
2. npm install          (quiet on success, error visible on failure)
3. npm run build        (tsc + prompt assets)
4. Install into ~/.apex-agent/  (dist + node_modules + skills + bin)
5. Symlink apex → ~/.local/bin/apex
6. Add ~/.local/bin to shell PATH (.zshrc / .bashrc)
7. Interactive config:
   - Model (required): provider / baseUrl / apiKey / model
   - Feishu messaging (optional): app id / app secret / domain
8. Done + next-step guidance
```

## Where things go

| Path | What |
|------|------|
| `~/.apex-agent/app/` | the runtime (dist + node_modules + bin) |
| `~/.apex-agent/app/bin/apex` | CLI entry (Unix shebang) |
| `~/.apex-agent/app/bin/apex.cmd` | CLI entry (Windows wrapper) |
| `~/.apex-agent/config.yaml` | non-secret config |
| `~/.apex-agent/.env` | credentials (api keys, Feishu app secret) |
| `~/.apex-agent/skills/` | built-in + user skills |
| `~/.apex-agent/workspaces/` | per-workspace sessions / memory / persona |
| `~/.apex-agent/crons/` | scheduled jobs |
| `~/.apex-agent/logs/` | logs |
| `~/.local/bin/apex` | CLI symlink (macOS/Linux) |
| `%USERPROFILE%\.apex-agent\app\bin` | on user PATH (Windows) |

> On Windows the CLI entry is `apex.cmd` (a `.cmd` wrapper around `node …\dist\cli.js`) because Windows can't execute a shebang file. The gateway service (`apex gateway install`, backed by `schtasks`) points at `apex.cmd` accordingly.

## Credentials vs config

- **Credentials** (model api key, Feishu app id/secret) → `~/.apex-agent/.env`, loaded automatically at startup. Never commit it.
- **Non-secret settings** (provider, model name, baseUrl, domain) → `~/.apex-agent/config.yaml`.

Environment variables always win over `.env`, and `.env` wins over `config.yaml`.

| Setting | `.env` variable | config.yaml key |
|---------|-----------------|-----------------|
| OpenAI-compatible api key | `OPENAI_API_KEY` | `model.apiKey` (or `providers[].apiKey`) |
| Anthropic api key | `ANTHROPIC_API_KEY` | `model.apiKey` |
| Feishu app id | `FEISHU_APP_ID` | `gateway.feishu.appId` |
| Feishu app secret | `FEISHU_APP_SECRET` | `gateway.feishu.appSecret` |

## After install

```bash
source ~/.zshrc    # or: source ~/.bashrc
apex               # start the TUI
apex --help        # all commands
```

## Manual install (skip the wizard)

If you prefer to configure by hand, the installer's build steps are equivalent to:

```bash
npm install
npm run build
node scripts/install.mjs
ln -sf ~/.apex-agent/app/bin/apex ~/.local/bin/apex
```

…then edit `~/.apex-agent/config.yaml` and `~/.apex-agent/.env` directly.

## Upgrading

Re-run `bash install.sh`. It:

- overwrites the runtime (`app/`)
- merges built-in skills (never overwrites your edited/created skills)
- migrates `config.yaml` to the current schema (idempotent)
- **never touches** your sessions / memory / cron jobs / credentials

You can also run `apex migrate` explicitly to migrate the config schema.
