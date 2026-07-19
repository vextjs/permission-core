# 多租户模型

租户隔离属于每个授权身份的一部分，不是靠约定附加的 filter。角色、用户绑定、规则、菜单、接口绑定、修订、审计状态、缓存键和数据操作都位于规范化 scope 内。

## 关系模型

```mermaid
erDiagram
  TENANT ||--o{ SCOPE : contains
  SCOPE ||--o{ ROLE : defines
  SCOPE ||--o{ USER_ROLE_SET : owns
  USER ||--o{ USER_ROLE_SET : has
  USER_ROLE_SET }o--o{ ROLE : binds
  ROLE ||--o{ RULE : grants_or_denies
  ROLE ||--o{ MENU_GRANT : receives
  SCOPE ||--o{ MENU_NODE : contains
  MENU_NODE ||--o{ API_BINDING : owns
```

`tenantId` 必填，`appId`、`moduleId` 和 `namespace` 是可选附加维度。用户由 `userId` 加完整 scope 标识；role ID 也只在相同完整 scope 内有意义。

## 相同标识、隔离状态

```ts
const scopeA = { tenantId: 'tenant-a', appId: 'admin' };
const scopeB = { tenantId: 'tenant-b', appId: 'admin' };
const tenantA = pc.scope(scopeA);
const tenantB = pc.scope(scopeB);

await tenantA.roles.create({ id: 'manager', label: 'A manager' });
await tenantA.roles.allow('manager', {
  action: 'read', resource: 'ui:page:tenant-a-dashboard',
});
await tenantA.userRoles.assign('same-user', 'manager');

await tenantB.roles.create({ id: 'manager', label: 'B manager' });
await tenantB.roles.allow('manager', {
  action: 'read', resource: 'ui:page:tenant-b-dashboard',
});
await tenantB.userRoles.assign('same-user', 'manager');
```

```json
{
  "tenantAOwnResource": true,
  "tenantACrossResource": false,
  "tenantBOwnResource": true,
  "tenantBCrossResource": false
}
```

数据库可以在两个租户保存相同 `roleId` 与 `userId`，但它们的规范 scope key 和索引不同。公开管理 API 不存在全局角色查询或无 scope 用户分配。

## 构造可信 subject

scope 必须来自服务端已认证状态或可信服务端 resolver。不能因为请求里存在任意 `x-tenant-id` 或 body 字段，就直接复制到 `PermissionSubject`。两个可信来源不一致时返回 `SCOPE_CONFLICT`，不能任选一个。

```ts
const subject = pc.forSubject({
  userId: session.userId,
  scope: {
    tenantId: session.tenantId,
    appId: 'admin',
  },
  claims: { merchantId: session.merchantId },
});
```

scope 与 subject ID 会去除首尾空白，限制为 128 UTF-8 字节，并拒绝控制字符、异常 Unicode、未知字段和保留标识。

## 在业务数据中强制 scope

授权集合必须给使用中的每个 scope 维度配置字段映射：

```ts
const orders = subject.data.collection('orders', {
  resource: 'db:orders',
  scopeFields: {
    tenantId: 'tenantId',
    appId: 'applicationId',
  },
});
```

读写会为这些字段添加精确标量相等条件。数组、对象、缺失或不一致值都不算该租户值。插入会注入可信 scope 值；更新不能把 scope 字段改到授权范围外。

## 持久化、缓存与审计隔离

权限集合使用规范 scope key 和 scope 感知唯一索引，修订向量也在该 scope 内推进。语义缓存键包含 core namespace、scope、subject、claims/context 指纹和读取族；失效只针对受影响的 scope/role/user 键族，不会清理另一个租户。

变更审计证据包含 scope 所属修订与操作身份。日志和指标应暴露租户安全 hash 或已批准标签，不能把不可信租户字符串作为唯一关联键。

## 运维检查

- 在两个 scope 使用相同用户和角色 ID，包含跨资源拒绝测试。
- 对每个 `scopeFields` 维度测试 find、count、insert、update 和 delete。
- 每个服务实例与 Vext 认证接入必须使用相同 scope 维度。
- scope 模型变化属于 Schema 契约变化，不是一个 UI 配置项。

先运行[多租户示例](/zh/examples/multi-tenant)，再通过[核心与上下文 API](/zh/api/core-and-contexts)查看准确 subject 与 scope 签名。
