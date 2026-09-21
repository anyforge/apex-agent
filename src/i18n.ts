// Bilingual message dictionary (zh/en), default English. The TUI selects language via
// config.lang. UI strings are bilingual; code comments are English-only per project convention.
import { slash, arg, ICON_WARNING, ICON_OK, ICON_ERR } from "./tui/brand.js";
import type { SessionCostMeta } from "./types.js";

export type Lang = "en" | "zh";

// Format a token count with a compact magnitude suffix (k / m / b), so a 464635-input reply
// renders as "464.6k" instead of a six-digit wall. Kept here (not in tui.tsx) so the reply meta
// line and the status bar share the same formatter without i18n depending on the TUI module.
function fmtNum(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1).replace(/\.0$/, "") + "b";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "m";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

// Format a millisecond duration with a human unit (ms / s / m / h), so a 6158ms first-token
// latency renders as "6.2s" instead of "6158ms". Sub-second stays in ms (e.g. "420ms"); minutes
// and hours kick in past 60s / 60m.
function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1).replace(/\.0$/, "")}m`;
  return `${(ms / 3_600_000).toFixed(1).replace(/\.0$/, "")}h`;
}

export interface Strings {
  tagline: string;
  // slash commands
  slashHint: string;
  slashHelp: string;
  slashCommands: { name: string; desc: string }[];
  // welcome panel
  quickHelpTitle: string;
  quickHelpHint: string;
  commonCommandsLabel: string;
  skillsLabel: (n: number) => string;
  noSkills: string;
  // message labels
  thinkingLabel: string;
  verifiedLabel: string;
  verifyPass: string;
  verifyFail: string;
  verifyNa: string;
  // clarify
  clarifyHint: string;
  clarifyChoiceHint: string;
  clarifyMultiHint: string;
  clarifyOther: string;
  clarifyOtherHint: string;
  confirmHint: string;
  // high-risk approval
  approveTitle: string;
  approvePrompt: (name: string, args: string) => string;
  approveOnce: string;
  approveAlways: string;
  approvePermanent: string;
  approveNo: string;
  // input / status
  inputHint: string;
  busy: string;
  queuedHint: (text: string) => string;
  steerHint: (text: string) => string;
  unknownCommand: (cmd: string) => string;
  // three-state verdict (mouth)
  verdictTrue: string;
  verdictFalse: string;
  verdictUnknown: string;
  // model info (slash /model)
  modelTitle: string;
  provider: string;
  modelField: string;
  baseUrl: string;
  apiKey: string;
  mockKey: string;
  maxSteps: string;
  // resource slash commands (/config /memory /tools /mcp /cron /approvals)
  configTitle: string;
  approvalMode: string;
  approvalTitle: string;
  browserTitle: string;
  browserInstall: string;
  browserUsage: string;
  verdictEnabled: string;
  maxRoundsLabel: string;
  memoryTitle: string;
  memoryNotes: string;
  userProfile: string;
  factsLabel: string;
  noMemory: string;
  toolsTitle: string;
  noTools: string;
  mcpTitle: string;
  noMcp: string;
  cronTitle: string;
  cronPaused: string;
  noCron: string;
  cronUsage: string;
  cronAdded: (id: string) => string;
  cronRemoved: string;
  cronNotFound: string;
  cronResumed: string;
  // sessions panel (slash /sessions)
  sessionsTitle: string;
  sessionsEmpty: string;
  sessionsHint: string;
  sessionsOpen: string;
  sessionsDelete: string;
  sessionsRename: string;
  sessionsFork: string;
  sessionsBack: string;
  sessionsDeleted: string;
  sessionsRenamed: string;
  sessionsForked: string;
  sessionsCost: (n: number) => string;
  // per-reply cost line (time / first token / speed / input / output / cache)
  replyMetaLine: (ts: number, cost: SessionCostMeta) => string;
}

const EN: Strings = {
  tagline: "Work like a human",
  slashHint: "type /help for commands",
  slashCommands: [
    { name: "help", desc: "list commands" },
    { name: "model", desc: "show model config" },
    { name: "config", desc: "show agent config" },
    { name: "memory", desc: "show long-term memory" },
    { name: "skills", desc: "list skills" },
    { name: "sessions", desc: "browse saved sessions" },
    { name: "tools", desc: "list registered tools" },
    { name: "mcp", desc: "list MCP servers" },
    { name: "cron", desc: "list scheduled jobs" },
    { name: "approvals", desc: "show approval mode" },
    { name: "browser", desc: `browser status | connect [port] | disconnect` },
    { name: "clear", desc: "clear conversation" },
    { name: "language", desc: `switch UI language (usage: ${slash("language")} ${arg("en|zh")})` },
    { name: "new", desc: "start a fresh session" },
    { name: "exit", desc: "quit" },
  ],
  slashHelp: `${slash("model")}              show model config
${slash("config")}             show agent config
${slash("memory")}             show long-term memory
${slash("skills")}             list skills
${slash("sessions")}           browse saved sessions
${slash("tools")}              list registered tools
${slash("mcp")}                list MCP servers
${slash("cron")}               list scheduled jobs
${slash("approvals")}          show approval mode
${slash("browser")} ${arg("status|connect [port]|disconnect")}  manage live browser
${slash("clear")}              clear conversation
${slash("language")} ${arg("en|zh")}   switch UI language
${slash("new")}                start a fresh session
${slash("exit")}               quit`,
  quickHelpTitle: "? quick help",
  quickHelpHint: "type /help for the full panel",
  commonCommandsLabel: "Common commands",
  skillsLabel: (n) => `Skills (${n} · type /skill-name to try)`,
  noSkills: "(no skills loaded)",
  thinkingLabel: "thinking",
  verifiedLabel: "verified=",
  verifyPass: "pass",
  verifyFail: "fail",
  verifyNa: "n/a",
  clarifyHint: "type your answer in the input box below, Enter to submit (Esc to cancel)",
  clarifyChoiceHint: "↑/↓ pick an option (Enter) or type a custom answer in the box below",
  clarifyMultiHint: "↑/↓ move · space toggles [x] · Enter submits the checked set (Esc to cancel)",
  clarifyOther: "Other (type your own answer)",
  clarifyOtherHint: "type your answer in the box below, then Enter to submit",
  confirmHint: "↑/↓ to select, Enter to confirm, Esc to cancel",
  approveTitle: "Approval required",
  approvePrompt: (name, args) => `Allow this high-risk action?  ${name} ${args}`,
  approveOnce: "[y] allow this once",
  approveAlways: "[a] always allow (this session)",
  approvePermanent: "[p] allow permanently (write config)",
  approveNo: "[n] deny",
  inputHint: "type a message to chat (exit to quit; shell commands need approval)",
  busy: "(previous task still running…)",
  queuedHint: (text) => `⏳ queued (runs after the current task): ${text}`,
  steerHint: (text) => `🧭 steering (injected mid-turn): ${text}`,
  unknownCommand: (cmd) => `unknown command: ${cmd} — type /help for commands`,
  verdictTrue: "True",
  verdictFalse: "False",
  verdictUnknown: "Unverifiable",
  modelTitle: "Model config",
  provider: "provider",
  modelField: "model",
  baseUrl: "baseUrl",
  apiKey: "apiKey",
  mockKey: "(mock, no key needed)",
  maxSteps: "maxSteps",
  configTitle: "Agent config",
  approvalMode: "approval mode",
  approvalTitle: "Approvals",
  browserTitle: "Browser",
  browserInstall: "install",
  browserUsage: "usage",
  verdictEnabled: "verification",
  maxRoundsLabel: "maxRounds",
  memoryTitle: "Memory",
  memoryNotes: "notes",
  userProfile: "user profile",
  factsLabel: "facts",
  noMemory: "(empty)",
  toolsTitle: "Tools",
  noTools: "(no tools registered)",
  mcpTitle: "MCP servers",
  noMcp: "(no MCP servers)",
  cronTitle: "Cron jobs",
  cronPaused: "(paused)",
  noCron: "(no cron jobs)",
  cronUsage: "usage: /cron list | add <schedule> <prompt> | remove <id> | run <id> | pause <id> | resume <id>",
  cronAdded: (id) => `added ${id}`,
  cronRemoved: "removed",
  cronNotFound: "not found:",
  cronResumed: "resumed",
  sessionsTitle: "Sessions",
  sessionsEmpty: "(no sessions yet)",
  sessionsHint: "↑/↓ select · Enter open · r rename · d delete · f fork · Esc back",
  sessionsOpen: "open",
  sessionsDelete: "delete",
  sessionsRename: "rename",
  sessionsFork: "fork",
  sessionsBack: "back",
  sessionsDeleted: "deleted",
  sessionsRenamed: "renamed",
  sessionsForked: "forked",
  sessionsCost: (n) => `cost ${n} tok`,
  replyMetaLine: (ts, c) => {
    const d = new Date(ts);
    const p = (x: number) => String(x).padStart(2, "0");
    const time = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    return `${time} · first ${fmtDuration(c.firstTokenMs)} · ${c.tokPerSec.toFixed(1)} tok/s · in ${fmtNum(c.promptTokens)} · out ${fmtNum(c.completionTokens)} · cache ${fmtNum(c.cacheReadTokens)}`;
  },
};

const ZH: Strings = {
  tagline: "努力向人一样工作",
  slashHint: "输入 /help 查看命令",
  slashCommands: [
    { name: "help", desc: "列出命令" },
    { name: "model", desc: "查看模型配置" },
    { name: "config", desc: "查看配置" },
    { name: "memory", desc: "查看长期记忆" },
    { name: "skills", desc: "列出技能" },
    { name: "sessions", desc: "浏览已保存会话" },
    { name: "tools", desc: "列出已注册工具" },
    { name: "mcp", desc: "列出 MCP 服务器" },
    { name: "cron", desc: "列出定时任务" },
    { name: "approvals", desc: "查看审批模式" },
    { name: "browser", desc: `浏览器 status | connect [端口] | disconnect` },
    { name: "clear", desc: "清空对话" },
    { name: "language", desc: `切换界面语言（用法：${slash("language")} ${arg("en|zh")}）` },
    { name: "new", desc: "开始新会话" },
    { name: "exit", desc: "退出" },
  ],
  slashHelp: `${slash("model")}              查看模型配置
${slash("config")}             查看配置
${slash("memory")}             查看长期记忆
${slash("skills")}             列出技能
${slash("sessions")}           浏览已保存会话
${slash("tools")}              列出已注册工具
${slash("mcp")}                列出 MCP 服务器
${slash("cron")}               列出定时任务
${slash("approvals")}          查看审批模式
${slash("browser")} ${arg("status|connect [端口]|disconnect")}  管理浏览器连接
${slash("clear")}              清空对话
${slash("language")} ${arg("en|zh")}   切换界面语言
${slash("new")}                开始新会话
${slash("exit")}               退出`,
  quickHelpTitle: "? 快速帮助",
  quickHelpHint: "输入 /help 查看完整面板",
  commonCommandsLabel: "常用命令",
  skillsLabel: (n) => `技能 (${n} · 输入 /技能名 直接体验)`,
  noSkills: "(无技能)",
  thinkingLabel: "思考",
  verifiedLabel: "验真=",
  verifyPass: "通过",
  verifyFail: "失败",
  verifyNa: "n/a",
  clarifyHint: "在下方输入框输入回答，回车提交（Esc 取消）",
  clarifyChoiceHint: "↑/↓ 选择选项（Enter），或在下方输入框输入自定义答案",
  clarifyMultiHint: "↑/↓ 移动 · 空格切换 [x] · Enter 提交已选项（Esc 取消）",
  clarifyOther: "其他（自定义输入）",
  clarifyOtherHint: "在下方输入框输入你的答案，然后回车提交",
  confirmHint: "↑/↓ 选择，Enter 确认，Esc 取消",
  approveTitle: "需要授权",
  approvePrompt: (name, args) => `是否允许这个高风险操作？  ${name} ${args}`,
  approveOnce: "[y] 允许本次",
  approveAlways: "[a] 本次会话始终允许",
  approvePermanent: "[p] 永久允许（写入配置）",
  approveNo: "[n] 拒绝",
  inputHint: "输入消息对话（exit 退出；shell 命令需人工批准）",
  busy: "(上一个任务还在执行…)",
  queuedHint: (text) => `⏳ 已排队（当前任务结束后执行）：${text}`,
  steerHint: (text) => `🧭 已转向（中途注入）：${text}`,
  unknownCommand: (cmd) => `未知命令：${cmd} — 输入 /help 查看命令`,
  verdictTrue: "真",
  verdictFalse: "假",
  verdictUnknown: "不可验",
  modelTitle: "模型配置",
  provider: "provider",
  modelField: "model",
  baseUrl: "baseUrl",
  apiKey: "apiKey",
  mockKey: "(mock，无需 key)",
  maxSteps: "maxSteps",
  configTitle: "Agent 配置",
  approvalMode: "审批模式",
  approvalTitle: "审批",
  browserTitle: "浏览器",
  browserInstall: "安装",
  browserUsage: "用法",
  verdictEnabled: "验真",
  maxRoundsLabel: "maxRounds",
  memoryTitle: "记忆",
  memoryNotes: "笔记",
  userProfile: "用户画像",
  factsLabel: "结构化事实",
  noMemory: "(空)",
  toolsTitle: "工具",
  noTools: "(未注册工具)",
  mcpTitle: "MCP 服务器",
  noMcp: "(无 MCP 服务器)",
  cronTitle: "定时任务",
  cronPaused: "(已暂停)",
  noCron: "(无定时任务)",
  cronUsage: "用法：/cron list | add <schedule> <prompt> | remove <id> | run <id> | pause <id> | resume <id>",
  cronAdded: (id) => `已添加 ${id}`,
  cronRemoved: "已删除",
  cronNotFound: "未找到：",
  cronResumed: "已恢复",
  sessionsTitle: "会话",
  sessionsEmpty: "(暂无会话)",
  sessionsHint: "↑/↓ 选择 · Enter 打开 · r 重命名 · d 删除 · f 复制 · Esc 返回",
  sessionsOpen: "打开",
  sessionsDelete: "删除",
  sessionsRename: "重命名",
  sessionsFork: "复制",
  sessionsBack: "返回",
  sessionsDeleted: "已删除",
  sessionsRenamed: "已重命名",
  sessionsForked: "已复制",
  sessionsCost: (n) => `消耗 ${n} tok`,
  replyMetaLine: (ts, c) => {
    const d = new Date(ts);
    const p = (x: number) => String(x).padStart(2, "0");
    const time = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    return `${time} · 首token ${fmtDuration(c.firstTokenMs)} · ${c.tokPerSec.toFixed(1)} tok/s · 输入 ${fmtNum(c.promptTokens)} · 输出 ${fmtNum(c.completionTokens)} · 缓存命中 ${fmtNum(c.cacheReadTokens)}`;
  },
};

export function i18n(lang?: Lang): Strings {
  return lang === "zh" ? ZH : EN;
}

// Map a language-neutral verdict enum to its localized display label.
export function verdictLabel(verdict: string, lang?: Lang): string {
  const s = i18n(lang);
  if (verdict === "true") return s.verdictTrue;
  if (verdict === "false") return s.verdictFalse;
  return s.verdictUnknown;
}

// Re-export the icons used by non-UI layers (kept here so i18n stays the single import).
export { ICON_WARNING, ICON_OK, ICON_ERR };
