# Changelog

本项目的所有重要变更都会记录在此文件。
All notable changes to this project are documented here.

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。
The format is based on Keep a Changelog, and this project adheres to Semantic Versioning.

---

## [0.1.0] - 首个版本

首版发布：一个自托管的「软硬分离」智能体框架，固定信任根（gate 闸门 + verify 验真）在硬层，其余能力作为可替换服务跑在软层。

### 核心架构

- **软硬分离信任根**（`src/kernel/`）——确定性 denylist 闸门（`gate.ts`）+ 证据验真（`verify.ts`，支持 `exit_code` / `file_exists` / `file_contains` / `nonempty` / `schema_valid`）+ 高风险审批（`approval.ts`，off / smart / manual 三档）。信任根是容器外的纯模块，插件/模型无法绕过。
- **器官化架构**（`src/organ/`）——insula（遥测/环路检测）、limbic（任务级验收）、body（工具调度，唯一的 gate→execute→verify 路径）、nerve（子智能体委派）、mouth（报告/裁决）、learner（学习）、evolver（离线记忆蒸馏）、memory（长期+结构化记忆）、cortex（模型适配）、skin（注入扫描）、life（网关 host）。
- **双层循环**——微循环（`loop/run.ts`，工具调用内环）+ OODA 宏循环（`loop/evolve.ts`，感知→决策→执行→反馈→记忆→进化外环）。
- **Cordis 插件容器**——所有器官/服务都是可替换的 Cordis 服务，装配顺序在 `cordis.config.ts` 声明。
- **Vercel AI SDK v7 模型层**——`openai`（OpenAI 兼容，`chat`/`responses` 协议）与 `anthropic` 双提供者，统一消息形状转换（`models/convert.ts`）。

### 智能体能力

- **确定性验真开关**（`agent.verdict.enabled`）——关闭时工具照常执行但诚实标注 `unverified`，绝不谎报 `ok`。
- **长期记忆**——结构化事实（`facts.jsonl`）、三段用户画像（`USER.md`）、前瞻（foresight）、可复用经验（AgentCase）。
- **离线进化引擎**（evolver）——facts / profile / case / skill-review 四条蒸馏链路，turn-based 错峰触发（默认 10/20/15/15 轮），post-turn 串行，绝不与主循环抢模型。
- **无进展守卫**（`kernel/guardrails.ts`）——三防线：精确失败（2 告警/5 阻断）、同工具失败（3 告警/8 停止）、无进展（幂等工具 hash 检测，2 告警/5 阻断），每 turn 重置，只对幂等工具生效。
- **无 goal 验收兜底**——任务结束时若还有 pending/in_progress 的 todo，注入「还有 N 项未完成」提示，上限 2 次。
- **上下文压缩**（`loop/compactor.ts`）——三分区（head/protect/tail）+ 结构化摘要 + 确定性预处理（剥 reasoning、脱敏 API key、body 截断），阈值 0.50，REFERENCE-ONLY 前置指令。
- **子智能体委派**（nerve）——`delegate` 命令 + 并行 fan-out，进度事件经 Cordis 事件总线回传（`subagent-progress` / `delegation-done`）。
- **审批建议**（approvals）——从审批历史挖掘 allowlist 提案（`approvals suggest --apply`）。

### 工具与资源

- **14 个内置工具**——`fs_read` / `fs_write` / `fs_list` / `shell_exec` / `web_search` / `web_fetch` / `memory_add` / `memory_search` / `skill_load` / `skill_create` / `skill_patch` / `todo_write` / `delegate` / `media_send`。
- **路径沙箱**——工作区门禁 + 可配置 grants，`fs_*` 越界抛错（shell_exec 是唯一绕行口）。
- **工具重名检测**——注册时重名抛错，防止静默覆盖。
- **技能系统**（skills）——递归扫描 + frontmatter 解析 + CRUD + `install`（从目录装）+ 内置 32 个通用技能。
- **MCP 支持**（mcps）——stdio / SSE / streamable-http 三传输客户端。
- **会话管理**（session）——SQLite + FTS5 全文检索 + 成本快照 + fork/rename。
- **定时任务**（cron）——add/edit/remove/run/pause/resume + 持久执行历史 + monitor（脚本/URL 哈希变更检测）+ 每任务 notepad。
- **浏览器**（browser）——CDP 连接实时 Chrome（status/connect/disconnect）。

### 消息平台

- **飞书（Lark）适配器**（`message/feishu.ts`）——官方 SDK 长连接（websocket），@提及门禁、markdown 渲染、流式回复、处理中 reaction、bot 身份自动发现、卡片按钮交互（clarify/审批）+ 文本捕获回退。
- **平台对接契约**（`message/types.ts` + `interaction.ts`）——`Channel`（收）/ `PlatformChannel`（收发）双接口 + 平台无关的交互协议（clarify/approve），对接新平台只需实现契约，无需读 agent 内部。
- **网关**（gateway）——前台 `run` + 后台系统服务（launchd / systemd / schtasks）+ 进程锁 + 投递账本 + 崩溃恢复。

### 界面

- **CLI**——14 个资源分组 60+ 命令，双语命令表。
- **TUI**（`tui/`）——vendor ink 渲染器，斜杠命令、会话历史、选区复制、明暗主题、审批/clarify 内联面板、子智能体进度树。
- **国际化**（`i18n.ts`）——中英双语，`Lang = "en" | "zh"`。

### 配置与安装

- **配置层**（`config/`）——单源真相：类型、默认值、注解模板、注释保留的 `updateConfig`（dot-path setIn）、schema 版本化迁移。
- **schema 迁移**——`schema_version: 2` + `apex migrate` 命令（幂等，v0→v1 结构迁移 + v1→v2 字段迁移）。
- **一键安装**——`install.sh`（macOS/Linux）+ `install.ps1` / `install.cmd`（Windows），交互式配置大模型 + 飞书，凭据写 `.env`（绝不进 config.yaml），`.env` 自动加载（dotenv）。
- **程序级卸载**——`apex uninstall` 删运行时 + symlink + PATH，用户数据（会话/记忆/配置/定时任务/凭据）有意保留。

### 开发体验

- **测试**——16 个测试脚本覆盖器官、宏/微循环、信任根、审批、验真、并行、输出 schema、cron、turn-lease、守卫/压缩/todo 对齐、配置迁移。
- **文档**——README（中英）+ docs/（安装/配置/卸载/开发/插件/平台）。
- **CI**——push 跑 typecheck + build + test（Linux/macOS）；push `v*` tag 自动生成 changelog + 发 GitHub Release。
