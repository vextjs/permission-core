# 多租户

## 场景

在两个 scope 中创建相同 `userId` 与 `roleId`。每个主体只能读取自身完整租户/应用 scope 内授予的资源，证明 ID 本身不是全局授权身份。

## 运行

```bash
npm run example:multi-tenant
```

规范源码是 `examples/multi-tenant.mjs` 中 `docs:multi-tenant:start` 到 `docs:multi-tenant:end` 的内容。

## 源码解读

```js
const scopeA = { tenantId: 'tenant-a', appId: 'admin' };
const scopeB = { tenantId: 'tenant-b', appId: 'admin' };
await core.scope(scopeA).userRoles.assign('same-user', 'manager');
await core.scope(scopeB).userRoles.assign('same-user', 'manager');

const subjectA = core.forSubject({ userId: 'same-user', scope: scopeA });
const cross = await subjectA.can('read', 'ui:page:tenant-b-dashboard');
```

每个 scope 都有自己的 `manager` 定义与绑定集合。跨租户检查使用租户 A 的授权状态，因此返回 false。

## 预期输出

```json
{
  "example": "multi-tenant",
  "ok": true,
  "tenantA": {
    "directRoles": ["manager"],
    "ownResource": true,
    "crossTenantResource": false
  },
  "tenantB": {
    "directRoles": ["manager"],
    "ownResource": true,
    "crossTenantResource": false
  }
}
```

## 生产边界

Fixture scope 是固定测试数据。生产 scope 必须来自已认证服务器状态或可信 resolver，不能直接来自请求头/请求体。业务 collection 还必须通过 `scopeFields` 映射每个活动 scope 维度。

## 相关内容

参见[多租户模型](/zh/guide/multi-tenant)、[认证边界](/zh/guide/authentication-boundary)和[授权集合 API](/zh/api/authorized-collection)。
