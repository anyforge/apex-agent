# 声明 / Disclaimer

## 项目性质 / Nature of This Project

Apex Agent 是一个**独立开源项目**，由 AnyForge 组织维护。本项目的开发、发布与维护，不代表任何企业、机构或个人的立场，亦与任何特定组织、产品、商业实体无关联。

Apex Agent is an **independent open-source project** maintained by the AnyForge organization. Its development, release, and maintenance do not represent the position of any company, institution, or individual, and it is not affiliated with any specific organization, product, or commercial entity.

## 不构成任何承诺 / No Warranties

本项目按「现状」提供，不附带任何明示或默示的保证，包括但不限于对**适销性、特定用途适用性、不侵权**的保证。

This project is provided "as is", without warranty of any kind, express or implied, including but not limited to the warranties of **merchantability, fitness for a particular purpose, and non-infringement**.

## 使用风险自担 / Use at Your Own Risk

- 本项目是一个**智能体框架**，会执行本地命令、读写文件、调用外部 API、连接消息平台。使用者须**自行承担**由此产生的一切后果，包括但不限于数据丢失、命令误执行、第三方服务费用、账户风险等。
- 在启用「验真」（verification）的情况下，工具执行结果会经过确定性校验；但**没有任何软件能保证绝对安全**。请在受控环境中谨慎使用，并在涉及敏感数据或高危操作前自行评估。
- 本项目**不存储、不上传**你的凭据；凭据仅保存在本地 `~/.apex-agent/.env`。但请自行妥善保管，防止泄露。

This is an **agent framework** that executes local commands, reads/writes files, calls external APIs, and connects to messaging platforms. You **assume full responsibility** for all consequences, including but not limited to data loss, unintended command execution, third-party service fees, and account risk.
With verification enabled, tool results are deterministically checked — but **no software can guarantee absolute safety**. Use with caution in a controlled environment, and assess risks yourself before sensitive data or high-risk operations.
This project **does not store or upload** your credentials; they live only in your local `~/.apex-agent/.env`. Still, keep them safe yourself.

## 第三方内容 / Third-Party Content

本项目的部分内置技能（skills）来自社区或第三方贡献，其版权归原作者所有，遵循各自原始许可。使用者应自行遵守相关许可条款。

Some bundled skills originate from the community or third-party contributors; their copyright belongs to the original authors under their respective licenses. You are responsible for complying with those licenses.

## 商标 / Trademarks

本项目文档中出现的任何第三方名称、商标、服务标识均为其各自所有者的财产，仅用于识别目的，不代表任何背书或关联关系。

Any third-party names, trademarks, or service marks appearing in this project's documentation are the property of their respective owners, used for identification purposes only and do not imply endorsement or affiliation.

---

*使用本项目即表示你已阅读并同意上述声明。/ By using this project, you acknowledge that you have read and agree to this disclaimer.*
