# MonSQLize 适配器示例

这个示例对应 `Full standard stack` 路径，适合需要同时处理接口权限、数据权限、缓存和持久化的场景。它解决的不是“怎么打开 `db:` 权限”本身，而是“怎么把规则、绑定、缓存和生产持久化放进同一套默认方案里”。

## 什么时候该用它

- 同时需要接口权限和数据权限
- 希望把 `cache-hub + monsqlize` 作为默认生产方案
- 需要统一规则持久化和后台管理能力

## 最简单初始化示例

```typescript
import { MonSQLizeStorageAdapter, PermissionCore } from 'permission-core';

const msq = /* 已 connect() 的 MonSQLize 实例 */;

const pc = new PermissionCore({
  storage: new MonSQLizeStorageAdapter({ msq, namespace: 'permission_core' }),
  cache: msq.getCache(),
});

await pc.init();
```

## 再往下会怎么接

```typescript
await pc.roles.create('editor', { label: '编辑' });
await pc.roles.allow('editor', 'invoke', 'GET:/api/articles');
await pc.roles.allow('editor', 'write', 'db:articles');
await pc.users.assign('user-003', 'editor');

await pc.assert('user-003', 'invoke', 'GET:/api/articles');
await pc.assert('user-003', 'read', 'db:articles');
```

## 这条路径的核心组成

- `MonSQLizeStorageAdapter` 负责角色、规则和绑定的持久化
- `cache-hub` 负责用户规则展开结果缓存
- `PermissionCore` 负责统一接口权限、数据权限和字段过滤语义

## 推荐这样使用它

- 接口权限用 `assert(userId, 'invoke', resource)`
- 数据权限用 `assert(userId, 'read/update/...', 'db:...')`
- 字段过滤用 `filterFields()`
- 菜单资源拉取用 `getResources(userId, 'invoke')`
- 后台管理用 `roles` 和 `users`

## 两个必须记住的边界

- 这条路径是官方默认生产路径，不是所有人都必须从这里开始
- 使用 `MonSQLizeStorageAdapter` 不等于你必须启用全部 `db:` 资源；存储方式和资源类型仍然是两回事

## 当前数据库支持边界

在当前内置官方路径里，可以直接把数据库持久化理解成 `MonSQLizeStorageAdapter -> monsqlize -> MongoDB`。

如果你要接其他数据库，当前更合适的方式仍然是自定义 `StorageAdapter`。完整边界说明看 [存储适配器](/zh/guide/adapters)。

## 常见误区

- 把它误当成“唯一支持的接法”
- 把 `db:` 权限和存储持久化能力混为一谈
- 初始化后忘记在应用关闭阶段调用 `await pc.close()`

如果你还没决定自己是否需要完整标准栈，建议先回看 [快速开始](/zh/guide/quick-start)。

启用菜单模块时，另配 `MonSQLizeMenuStorageAdapter` 和独立 namespace。共享同一个 msq 时只能有一个 `ownsConnection:true`，关闭顺序为 menu 后 core。备份、迁移和回滚必须同时覆盖核心 role/rule/user binding 与菜单 node/API binding/revision/audit。
