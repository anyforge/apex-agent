#!/usr/bin/env node
// release-body.mjs — assemble the GitHub Release body: install guide + feature summary
// (fixed, from README) + the auto-generated changelog (from changelogen). Reads the changelog
// from stdin, writes the full body to stdout (redirected to a file by the workflow).
import { readFileSync } from "node:fs";

const changelog = readFileSync(0, "utf-8").trim();

const header = `## 安装 / Install

**环境要求 / Requirements:** Node.js ≥ 22

\`\`\`bash
# macOS / Linux
bash install.sh
\`\`\`

\`\`\`bat
# Windows — 双击 install.cmd / double-click install.cmd
# 或在 PowerShell 运行 / or run in PowerShell: .\\install.ps1
install.cmd
\`\`\`

## 特性 / Highlights

- **确定性信任根** — 每个工具调用过硬闸门（denylist）+ 证据验真（verify），模型无法绕过
- **软硬分离** — 模型（软层）与验真（硬层）物理分开，换模型不动信任根
- **长期记忆 + 离线进化** — 结构化事实 / 三段画像 / 前瞻 / 经验，错峰蒸馏
- **32 个内置技能** — docx / pdf / xlsx / github / research / creative …
- **多平台消息** — 飞书（Lark）已上线，干净的平台对接契约

完整说明见 [README.md](https://github.com/${process.env.GITHUB_REPOSITORY}#readme)。

---

${changelog}
`;

process.stdout.write(header);
