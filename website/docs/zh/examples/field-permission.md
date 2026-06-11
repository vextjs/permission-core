# 字段权限示例

这个示例对应 `DB-only` 路径，重点展示字段过滤。它解决的不是“这个用户能不能访问整个集合”，而是“在已经允许访问集合的前提下，哪些字段还能被继续返回或写入”。

## 读场景示例

```typescript
await pc.roles.create('viewer', { label: '查看者' });
await pc.roles.allow('viewer', 'read', 'db:users');
await pc.roles.allow('viewer', 'read', 'db:users:name');
await pc.roles.allow('viewer', 'read', 'db:users:avatar');
await pc.users.assign('user-001', 'viewer');

const safe = await pc.filterFields('user-001', 'read', 'db:users', {
  name: 'Alice',
  avatar: '/a.png',
  email: 'alice@example.com',
});
```

结果应只保留：

- `name`
- `avatar`

而 `email` 因为没有字段级读取权限被过滤掉。

## 这个例子真正说明了什么

- `db:users` 负责集合级访问
- 如果还有限制“只能看自己的记录”，应先走行级范围判断
- `db:users:name`、`db:users:avatar` 负责字段级访问
- `filterFields()` 会把对象中的每个字段映射为新的字段资源，再逐个判断是否保留

也就是说，字段过滤不是替代集合权限，而是建立在集合权限之上的第二层控制。

## 一个写场景提醒

如果你要过滤写入 payload，更推荐显式使用 `create` 或 `update`：

```typescript
const payload = await pc.filterFields('user-001', 'update', 'db:users', {
  name: 'Alice',
  email: 'alice@example.com',
  internalLevel: 3,
});
```

这里不建议直接使用 `write`，因为请求侧 `write` 是 `create && update` 的 AND 语义，通常会比预期更严格。

## 一般放在哪用

这个示例更适合放在：

- Service 层返回对象前做脱敏
- DAO 层写入前做字段白名单过滤
- 管理后台不同角色可见字段差异控制

## 常见误区

- 只有字段权限，没有集合级权限
- 以为 `filterFields()` 会自动处理嵌套字段
- 在读写场景都默认传 `write`

当前 v1 只覆盖顶层字段，不覆盖嵌套字段。行级权限已经单独纳入方案，但应通过 `getRowScope()` / `canRow()` / `filterRows()` 先收口记录范围，而不是让字段过滤替代它。如果你想先理解主 API 的动作语义，可以回到 [PermissionCore](/zh/api/permission-core)。