# 字段过滤

字段过滤移除当前用户不能访问的字段。

## 字段资源格式

```text
db:<collection>:<field>
```

```text
db:transactions:id
db:transactions:status
db:transactions:amount
db:refunds:internalNote
```

## 授权字段

```typescript
await pc.roles.allow('support', 'read', 'db:refunds:id');
await pc.roles.allow('support', 'read', 'db:refunds:status');
await pc.roles.allow('support', 'read', 'db:refunds:reason');
```

## 过滤对象

```typescript
const safeRefund = await pc.filterFields(
  'u-1',
  'read',
  'db:refunds',
  refund,
);
```

`action` 参数必填，字段过滤因此与 `can()` 使用同一权限模型。

一个最小闭环同时包含集合和字段授权：

```typescript
await pc.roles.allow('support', 'read', 'db:refunds');
await pc.roles.allow('support', 'read', 'db:refunds:id');
await pc.roles.allow('support', 'read', 'db:refunds:status');
await pc.users.assign('u-1', 'support');

const safeRefund = await pc.filterFields('u-1', 'read', 'db:refunds', refund);
```

## 集合权限仍然有效

字段规则不能绕过集合检查。先授权集合，再授权允许的字段；先做行级授权，再做字段过滤。字段授权绝不能让主体看到原本无权访问的行。

## Create 与 update

写入 payload 优先使用明确动作：

```typescript
await pc.filterFields('u-1', 'create', 'db:refunds', payload);
await pc.filterFields('u-1', 'update', 'db:refunds', payload);
```

除非确实要求 create 与 update 同时成立，否则不要在请求侧使用 `write`。

## 当前边界

- v1 只过滤对象顶层属性。
- 返回新的局部对象，不修改原对象。
- 没有字段授权时移除字段，不是写入 `undefined`。
- Context 可提供规则变量，不能替换 API subject/user。
- 字段过滤本身不是校验、脱敏、加密或数据库 projection。

大批量读取时，尽量在数据库查询中只选择已授权字段，并在序列化边界保留 `filterFields()` 作为纵深防护。

## 不适用场景

字段过滤不能决定接口是否可调用、某行是否属于主体，也不能验证嵌套领域对象。分别使用接口、集合、行级检查和 schema validator。

常见错误包括：计算安全副本后仍返回原对象、漏掉集合授权、把前端隐藏当安全控制，以及实际只更新却传入 `write`。

继续看 [字段权限示例](/zh/examples/field-permission) 和 [PermissionCore API](/zh/api/permission-core)。
