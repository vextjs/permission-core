# 快速开始

先跑通一次真实鉴权，再选择接入路径。下面的 First Success 使用 `MemoryAdapter`，不依赖数据库和 Web 框架；生产环境可以在闭环跑通后再切换持久化适配器。

## 安装并跑通 First Success

使用 npm 已发布的稳定版时，先创建一个空白消费项目：

```bash
mkdir permission-core-first-success
cd permission-core-first-success
npm init -y
npm install permission-core
```

创建 `first-success.mjs`，内容直接引用仓库维护的同一份示例：

```js file="<root>/../examples/docs-first-success.mjs"

```

执行：

```bash
node first-success.mjs
```

预期输出：

```text
[first-success] allowed=true blocked=true
```

如果要验证当前仓库预览版，则运行隔离消费项目 smoke：

```bash
git clone https://github.com/vextjs/permission-core.git
cd permission-core
npm ci
npm run docs:first-success
```

预览版命令会先构建并打包，再把 tarball 安装进临时空项目，最后通过安装后的包运行同一份示例，不会偷用源码目录完成验证。

## 跑不起来时怎么恢复

| 失败阶段 | 先检查 | 恢复动作 |
|----------|--------|----------|
| 安装 | Node.js / npm 版本、registry 连通性、包名 | 使用 Node.js 20 或 22，再执行 `npm install permission-core` |
| 预览版构建 | 根依赖和生成的 `dist/` | 先执行 `npm ci`，再执行 `npm run build` |
| 运行时 | 是否调用 `await pc.init()`、`userId` 是否为字符串、资源名是否一致 | 与 `examples/docs-first-success.mjs` 对照；结束时关闭实例 |

看到预期输出后，再选择与你的应用匹配的路径：

- `HTTP-only`：接口、菜单、按钮和 API guard 权限。
- `DB-only`：Service / DAO 中的集合、行级和字段权限。
- `Full standard stack`：接口权限、数据权限、管理 API、缓存和持久化一起接入。

## 选择下一条路径

| 路径 | 资源类型 | 最常用 API | 常见存储 | 典型场景 |
|------|----------|------------|----------|---------|
| `HTTP-only` | `<METHOD>:<path>` | `assert`、`can`、`getResources` | `MemoryAdapter`、`FileAdapter`、`MonSQLizeStorageAdapter` | API guard、菜单、按钮、路由显隐 |
| `DB-only` | `db:<collection>[:<field>]` | `can`、`assert`、`getRowScope`、`filterRows`、`filterFields` | 任意适配器 | Service / DAO 数据权限、行级范围、字段过滤 |
| `Full standard stack` | 两者 | 运行时检查加 `roles` / `users` | `MonSQLizeStorageAdapter` + `cache-hub` | 管理后台、接口与数据权限、生产持久化 |

## 必须记住的规则

- 使用公共 API 前先执行 `await pc.init()`。
- 传入字符串 `userId`；未登录请求应在调用 permission-core 前处理。
- 资源形式与存储选择彼此独立：HTTP-only 可以持久化，DB-only 也可以先用内存。

## HTTP-only

```typescript
import { MemoryAdapter, PermissionCore } from 'permission-core';

const pc = new PermissionCore({
  storage: new MemoryAdapter(),
});

await pc.init();

await pc.roles.create('operator', { label: 'Operator' });
await pc.roles.allow('operator', 'invoke', 'GET:/api/orders');
await pc.roles.allow('operator', 'invoke', 'POST:/api/orders');

await pc.users.setUserRoles('u-1', ['operator']);

await pc.assert('u-1', 'invoke', 'GET:/api/orders');
const resources = await pc.getResources('u-1', 'invoke');
```

`getResources()` 返回可用于菜单或按钮显隐的资源字符串：

```json
[
  "GET:/api/orders",
  "POST:/api/orders"
]
```

带参数的接口优先使用命中的模板路径，例如 `DELETE:/api/orders/:id`，不要把实际 URL `DELETE:/api/orders/123` 写成规则。

## DB-only

```typescript
import { MemoryAdapter, PermissionCore } from 'permission-core';

const pc = new PermissionCore({
  storage: new MemoryAdapter(),
});

await pc.init();

await pc.roles.create('auditor', { label: 'Auditor' });
await pc.roles.allow('auditor', 'read', 'db:transactions', {
  where: {
    field: 'merchantId',
    op: 'eq',
    valueFrom: 'merchantId',
  },
});
await pc.roles.allow('auditor', 'read', 'db:transactions:id');
await pc.roles.allow('auditor', 'read', 'db:transactions:status');

await pc.users.setUserRoles('u-2', ['auditor']);

const scope = await pc.getRowScope('u-2', 'read', 'db:transactions', {
  merchantId: 'm-100',
});

const visibleRows = await pc.filterRows('u-2', 'read', 'db:transactions', rows, {
  merchantId: 'm-100',
});

const safeRow = await pc.filterFields('u-2', 'read', 'db:transactions', visibleRows[0]);
```

能把 scope 下推到 SQL 或 MongoDB 时，优先在查询前使用 `getRowScope()`；`filterRows()` 适合作为已加载记录的运行时安全网。

## Full standard stack

```typescript
import MonSQLize from 'monsqlize';
import { MonSQLizeStorageAdapter, PermissionCore } from 'permission-core';

const msq = new MonSQLize({
  type: 'mongodb',
  databaseName: 'permission_core',
  config: { uri: process.env.MONGO_URI! },
  cache: { defaultTtl: 300_000, maxEntries: 1000 },
});

await msq.connect();

const pc = new PermissionCore({
  storage: new MonSQLizeStorageAdapter({
    msq,
    namespace: 'permission_core',
    ownsConnection: true,
  }),
  cache: msq.getCache(),
});

await pc.init();
```

这条路径适合支付和金融管理后台：接口访问、账本行、敏感字段、角色管理与缓存失效需要保持可审计。

## 下一步

- 资源模型：[资源路径模型](/zh/guide/resource-paths)
- 运行时鉴权：[权限鉴权](/zh/guide/check-permission)
- 行级范围：[行级权限](/zh/guide/row-level)
- 字段过滤：[字段过滤](/zh/guide/field-filter)
- 管理后台：[管理后台接入](/zh/guide/site-preview-release)
