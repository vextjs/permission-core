# 多租户权限

新的 subject API 支持真实租户范围。旧的 `userId` API 仍可用，并映射到默认 scope `{ tenantId: "default" }`。

```ts
import { PermissionCore } from "permission-core";

const pc = new PermissionCore();
await pc.init();

const scope = { tenantId: "tenant-a", appId: "admin" };
const subject = { ...scope, userId: "u-1" };
const tenant = pc.scope(scope);

await tenant.roles.create("admin", { label: "管理员" });
await tenant.roles.allow("admin", "read", "ui:menu:system.user");
await tenant.users.assign(subject.userId, "admin");

console.log(await pc.canSubject(subject, "read", "ui:menu:system.user")); // true
console.log(await pc.canSubject(
  { ...subject, tenantId: "tenant-b" },
  "read",
  "ui:menu:system.user",
)); // false

await pc.close();
```

仓库内的双租户反证可以直接运行：

```bash
npm run example:multi-tenant
```

`PermissionScope` 字段：

| 字段 | 用途 |
|---|---|
| `tenantId` | 真实租户边界 |
| `appId` | 同一租户内的应用边界 |
| `moduleId` | 可选模块边界 |
| `namespace` | 可选权限域边界 |

官方存储适配器和规则缓存都会包含 `scopeKey`，同一个 `userId` 和 `roleId` 可以在不同租户下拥有不同权限。

`MonSQLizeStorageAdapterOptions.namespace` 只是物理 collection 前缀，不是业务租户，也不等于 `PermissionScope.namespace`。

## 边界规则

- 每个 subject API 都要求非空 `tenantId`；JavaScript 运行时缺少该字段时会直接失败，不会退回默认租户。
- `pc.scope(scope).forSubject(subject)` 要求 subject scope 与绑定 scope 完全一致。
- 相同 `userId` 和 `roleId` 可以存在于多个租户，但角色、规则、用户绑定、缓存、菜单资产、revision 和审计都按 `scopeKey` 分区。
- 旧的 `can(userId, ...)`、`roles`、`users` 只使用配置的 `defaultScope`。租户请求内不要把旧 API 与 subject API 混用。

## 生产存储

`MemoryAdapter` 只能证明隔离，重启后数据会丢失。单进程可使用 `FileAdapter`，共享生产环境使用 `MonSQLizeStorageAdapter`。如果同时启用菜单模块，还必须配置对应的 `FileMenuStorageAdapter` 或 `MonSQLizeMenuStorageAdapter`；核心 storage 不会自动持久化菜单资产。

## 失败恢复

| 错误 | 含义 | 恢复方式 |
|---|---|---|
| `INVALID_ARGUMENT`: `tenantId must be a non-empty string` | subject 没有显式租户 | 先恢复认证得到的租户身份，不要用全局默认值替代 |
| `INVALID_ARGUMENT`: `subject scope does not match` | subject 跨越了已绑定 scope | 使用认证 subject 重新创建 scoped context |
| 用户正确但无权限 | 角色或用户绑定创建在另一个 scope | 通过同一个 `pc.scope(scope)` 检查角色和绑定 |

框架中的 header/claim 冲突处理见 [vext 适配器](/zh/guide/vext-adapter)。
