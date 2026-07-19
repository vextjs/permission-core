# 基础 RBAC

## 场景

这是第一个完整 RBAC 路径：创建角色与规则、给用户分配角色、检查 allow/默认拒绝、对比追加型 `assign` 与替换型 `set`，并读取自身/有效授权状态。

## 运行

```bash
npm run example:basic
```

规范源码是 `examples/basic.mjs` 中 `docs:basic:start` 到 `docs:basic:end` 的内容，并使用 `examples/_support/host.mjs` 中的共享宿主 fixture。

## 源码解读

```js
await scoped.userRoles.assign('u-1', 'order-reader');
const subject = core.forSubject({ userId: 'u-1', scope });
const allowed = await subject.can('invoke', 'GET:/api/orders');
const cannotDelete = await subject.cannot('invoke', 'DELETE:/api/orders');

const before = await scoped.userRoles.getDirect('u-1');
await scoped.userRoles.set('u-1', ['order-reader'], {
  expectedRevision: before.data.revision,
});
```

`cannotDelete: true` 表示对应 `can()` 为 false，因为没有 delete allow。它不表示授予了 delete 权限，也不表示分配了单独 deny。

## 预期输出

```json
{
  "example": "basic",
  "ok": true,
  "userRoles": {
    "afterAssign": ["order-reader"],
    "beforeSet": ["operator", "order-reader"],
    "afterSet": ["order-reader"],
    "effective": ["order-reader"]
  },
  "permissionChecks": {
    "allowed": true,
    "cannotDelete": true,
    "deleteReason": "no-allow"
  },
  "reads": {
    "ownRules": ["allow:invoke:GET:/api/orders"],
    "effectiveRules": ["allow:invoke:GET:/api/orders"],
    "roleChain": ["order-reader"],
    "permissionRuleCount": 1,
    "resources": ["GET:/api/orders"]
  }
}
```

## 生产边界

示例只为可重复执行而启动内存 MongoDB replica set。生产环境由宿主提供已连接的 MonSQLize 3.1 实例、可信租户/用户身份、token secret 和进程生命周期。示例先关闭 PermissionCore，再关闭宿主数据库。

## 相关内容

参见[快速开始](/zh/guide/quick-start)、[检查权限](/zh/guide/check-permission)和[用户角色 API](/zh/api/user-roles)。
