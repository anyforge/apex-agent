# Uninstall

```bash
apex uninstall
```

## What it removes (program only)

| Item | Removed |
|------|---------|
| `~/.apex-agent/app/` (runtime: dist + node_modules + bin) | ✅ |
| `~/.local/bin/apex` symlink | ✅ |
| `~/.local/bin` PATH line in `.zshrc` / `.bashrc` / `.bash_profile` | ✅ |
| background gateway service (launchd / systemd / schtasks), if installed | run `apex gateway uninstall` separately |

## What it KEEPS (your data)

| Data | Kept |
|------|------|
| `~/.apex-agent/config.yaml` | ✅ |
| `~/.apex-agent/.env` (credentials) | ✅ |
| `~/.apex-agent/workspaces/` (sessions, memory, persona) | ✅ |
| `~/.apex-agent/crons/` (scheduled jobs) | ✅ |
| `~/.apex-agent/state/` (delegations, delivery records) | ✅ |
| `~/.apex-agent/logs/` | ✅ |

The uninstall deliberately **never deletes user data** — sessions, memory, config, and credentials are irreplaceable. The command prints the data directory and tells you how to wipe it manually if you really want to.

## Full wipe (everything)

If you want to remove **everything** including your data:

```bash
rm -rf ~/.apex-agent
```

## Uninstall the gateway service only

`apex uninstall` removes the CLI + runtime; the background gateway service is managed separately:

```bash
apex gateway uninstall    # remove the launchd/systemd/schtasks service
apex gateway status       # check whether a service is installed/running
```
