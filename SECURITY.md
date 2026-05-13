# Security Policy

permission-core 是一层权限内核，不直接替业务托管身份认证、接口鉴权链路或数据库隔离策略。
这份文档只声明本仓库的安全维护范围、漏洞报告方式和使用边界。

## Supported Versions

我们只对当前维护线提供安全修复。

| Version | Supported | Notes |
|---------|:----------:|-------|
| 0.2.x | ✅ | 当前正式发布线；在 `1.0.0` 正式发布前继续作为安全修复基线 |
| < 0.2.0 | ❌ | 早期骨架阶段版本不再维护 |

## Reporting a Vulnerability

如果你发现了安全问题，请不要在公开 Issue、PR、文档页或示例中直接披露漏洞细节。

推荐流程：

1. 优先通过仓库的 GitHub Security / private advisory 通道私下报告。
2. 如果当前仓库没有启用 private advisory，请仅发送“需要安全联系方式”的最小公开通知，不要附带复现细节、凭据、日志片段或攻击脚本。
3. 报告中尽量包含：影响范围、触发前提、最小复现步骤、风险判断、建议修复方向。

当前仓库的公开地址：

- GitHub: https://github.com/vextjs/permission-core
- Security: https://github.com/vextjs/permission-core/security

## Response Expectations

- 维护者会先确认是否属于真实安全问题，而不是一般功能缺陷或文档偏差。
- 在问题被确认和修复前，不建议公开讨论可直接复现的攻击细节。
- 修复完成后，建议通过 release note 或 changelog 明确说明受影响范围与升级路径。

## Security Boundaries

permission-core 负责的是“权限规则如何表达、如何判定、如何过滤”的运行时能力，不负责替代以下安全职责：

- 身份认证与会话管理
- 请求来源可信性校验
- 数据库本身的账号隔离与网络访问控制
- 审计日志平台、告警平台和密钥管理

使用时请特别注意：

- 不要把 `getResources()` 的结果当成最终鉴权结论；真正的放行仍应使用 `can()` 或 `assert()`。
- 不要把未校验的 `userId`、`action`、`resource` 直接暴露给外部调用方拼接。
- 如果你启用 `FileAdapter`，请把权限数据文件放在受控目录，避免和公开静态资源、日志目录或可下载目录混放。
- 如果你使用 `MonSQLizeStorageAdapter`，数据库层仍应继续配置访问控制、备份、审计和网络边界。

## Sensitive Data and Examples

- 不要在 issue、PR、示例或文档中提交真实凭据、真实用户标识或生产数据。
- 示例中的 `userId`、角色名和资源路径都应视为演示值，而不是线上约定。
- 如果需要贴日志，请先去除 token、cookie、连接串、数据库地址和个人信息。