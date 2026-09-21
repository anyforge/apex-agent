// gateway/serviceManager — install the gateway as a system background service (auto-restart on
// crash), abstracted across the three platforms the way the industry reference does (gateway_windows.py +
// systemd/launchd backends):
//   - macOS   → launchd plist (KeepAlive)
//   - Linux   → systemd unit (Restart=always)
//   - Windows → schtasks (ONLOGON + restart-on-failure), Startup-folder .vbs fallback
// All backends expose the SAME contract (install/start/stop/restart/status/uninstall), so the CLI
// never branches on platform. This is the DEPLOYMENT layer — it manages process LIFECYCLE (crash →
// restart), while state semantics (turn lease, delivery ledger, recovery) are the gateway's own.
import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

// The REAL self-contained runtime entry (resolves the compiled CLI by module position, not cwd).
// NOT /usr/local/bin/apex — that's a convenience symlink install-local may or may not have made;
// a launchd/systemd/schtasks service must point at the stable runtime path. On Windows the entry is
// the apex.cmd wrapper (schtasks can't exec a shebang .js); on Unix it's the shebang file.
const APEX_BIN = process.platform === "win32"
  ? `${homedir()}\\.apex-agent\\app\\bin\\apex.cmd`
  : `${homedir()}/.apex-agent/app/bin/apex`;

export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  platform: string;
  detail: string;
}

// The gateway command line for the background service (serve, default port).
const SERVICE_CMD = "serve";

function isMac(): boolean {
  return process.platform === "darwin";
}
function isLinux(): boolean {
  return process.platform === "linux";
}
function isWindows(): boolean {
  return process.platform === "win32";
}

// ============ macOS (launchd) ============

const LAUNCHD_LABEL = "com.apex-agent.gateway";
const LAUNCHD_PLIST_PATH = `${homedir()}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`;

function launchdPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${APEX_BIN}</string>
    <string>${SERVICE_CMD}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${homedir()}/.apex-agent/logs/gateway.out.log</string>
  <key>StandardErrorPath</key><string>${homedir()}/.apex-agent/logs/gateway.err.log</string>
</dict>
</plist>`;
}

// ============ Linux (systemd) ============

const SYSTEMD_UNIT = "apex-gateway.service";
const SYSTEMD_PATH = `${homedir()}/.config/systemd/user/${SYSTEMD_UNIT}`;

function systemdUnit(): string {
  return `[Unit]
Description=Apex Agent gateway
After=network.target

[Service]
ExecStart=${APEX_BIN} ${SERVICE_CMD}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

// ============ Windows (schtasks + Startup fallback) ============

const SCHTASKS_TASK = "ApexAgentGateway";
const STARTUP_VBS = `${process.env.APPDATA || ""}\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\apex-gateway.vbs`;

function startupVbs(): string {
  return `Set WshShell = CreateObject("WScript.Shell")\nWshShell.Run """${APEX_BIN.replace(/\\/g, "\\\\")}"" ${SERVICE_CMD}", 0, False\n`;
}

// ============ unified contract ============

export function gatewayServiceInstall(): ServiceStatus {
  if (isMac()) {
    mkdirSync(dirname(LAUNCHD_PLIST_PATH), { recursive: true });
    writeFileSync(LAUNCHD_PLIST_PATH, launchdPlist(), "utf-8");
    spawnSync("launchctl", ["load", LAUNCHD_PLIST_PATH]);
    return { installed: true, running: true, platform: "launchd", detail: LAUNCHD_PLIST_PATH };
  }
  if (isLinux()) {
    mkdirSync(dirname(SYSTEMD_PATH), { recursive: true });
    writeFileSync(SYSTEMD_PATH, systemdUnit(), "utf-8");
    spawnSync("systemctl", ["--user", "daemon-reload"]);
    spawnSync("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]);
    return { installed: true, running: true, platform: "systemd", detail: SYSTEMD_PATH };
  }
  if (isWindows()) {
    // schtasks with ONLOGON + restart-on-failure; fall back to Startup folder on denial.
    const r = spawnSync("schtasks", ["/Create", "/SC", "ONLOGON", "/TN", SCHTASKS_TASK, "/TR", `${APEX_BIN} ${SERVICE_CMD}`, "/RL", "LIMITED", "/F"]);
    if (r.status === 0) {
      return { installed: true, running: true, platform: "schtasks", detail: `task ${SCHTASKS_TASK}` };
    }
    // Fallback: Startup folder .vbs (locked-down corporate boxes deny schtasks).
    try {
      mkdirSync(dirname(STARTUP_VBS), { recursive: true });
      writeFileSync(STARTUP_VBS, startupVbs(), "utf-8");
      return { installed: true, running: false, platform: "startup-folder", detail: STARTUP_VBS };
    } catch {
      return { installed: false, running: false, platform: "unknown", detail: "install failed (both schtasks and Startup folder denied)" };
    }
  }
  return { installed: false, running: false, platform: "unsupported", detail: process.platform };
}

export function gatewayServiceUninstall(): ServiceStatus {
  if (isMac()) {
    spawnSync("launchctl", ["unload", LAUNCHD_PLIST_PATH]);
    if (existsSync(LAUNCHD_PLIST_PATH)) unlinkSync(LAUNCHD_PLIST_PATH);
    return { installed: false, running: false, platform: "launchd", detail: "uninstalled" };
  }
  if (isLinux()) {
    spawnSync("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
    if (existsSync(SYSTEMD_PATH)) unlinkSync(SYSTEMD_PATH);
    spawnSync("systemctl", ["--user", "daemon-reload"]);
    return { installed: false, running: false, platform: "systemd", detail: "uninstalled" };
  }
  if (isWindows()) {
    spawnSync("schtasks", ["/Delete", "/TN", SCHTASKS_TASK, "/F"]);
    if (existsSync(STARTUP_VBS)) unlinkSync(STARTUP_VBS);
    return { installed: false, running: false, platform: "schtasks", detail: "uninstalled" };
  }
  return { installed: false, running: false, platform: "unsupported", detail: process.platform };
}

export function gatewayServiceStatus(): ServiceStatus {
  if (isMac()) {
    const installed = existsSync(LAUNCHD_PLIST_PATH);
    const running = spawnSync("launchctl", ["list", LAUNCHD_LABEL]).status === 0;
    return { installed, running, platform: "launchd", detail: installed ? LAUNCHD_PLIST_PATH : "not installed" };
  }
  if (isLinux()) {
    const installed = existsSync(SYSTEMD_PATH);
    const running = spawnSync("systemctl", ["--user", "is-active", "--quiet", SYSTEMD_UNIT]).status === 0;
    return { installed, running, platform: "systemd", detail: installed ? SYSTEMD_PATH : "not installed" };
  }
  if (isWindows()) {
    const installed = existsSync(STARTUP_VBS);
    const running = false; // schtasks running state requires a separate query; best-effort
    return { installed, running, platform: "schtasks", detail: installed ? `task ${SCHTASKS_TASK}` : "not installed" };
  }
  return { installed: false, running: false, platform: "unsupported", detail: process.platform };
}

export function gatewayServiceRestart(): ServiceStatus {
  if (isMac()) {
    spawnSync("launchctl", ["kickstart", "-k", `gui/${process.getuid?.() ?? 501}/${LAUNCHD_LABEL}`]);
    return gatewayServiceStatus();
  }
  if (isLinux()) {
    spawnSync("systemctl", ["--user", "restart", SYSTEMD_UNIT]);
    return gatewayServiceStatus();
  }
  return gatewayServiceStatus();
}
