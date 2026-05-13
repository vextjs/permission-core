# 快速开始

permission-core 提供三条官方接入路径。开始前先选路径，不要一上来就默认自己属于完整标准栈。对这个项目来说，最容易混淆的是两件事：

- 你是否需要 `db:` 资源
- 你是否要把规则持久化到 `monsqlize`

这两件事不是一回事。接入路径决定你要用哪些资源和 API，存储适配器只决定规则和绑定数据放在哪里。

## 先判断自己属于哪条路径

| 路径 | 资源类型 | 最常用 API | 常见存储 | 典型场景 |
|------|----------|------------|----------|---------|
| `HTTP-only` | `<METHOD>:<path>`（`path` 为规范化路由路径） | `assert`、`can`、`getResources` | `MemoryAdapter` / `FileAdapter` / `MonSQLizeStorageAdapter` | 接口权限、菜单、按钮、路由显隐 |
| `DB-only` | `db:<collection>[:<field>]` | `can`、`assert`、`getRowScope`、`filterRows`、`filterFields` | `MemoryAdapter` / `FileAdapter` / `MonSQLizeStorageAdapter` | Service / DAO 层数据权限、行级范围、字段脱敏 |
| `Full standard stack` | 两者同时启用 | `assert`、`getRowScope`、`filterRows`、`filterFields`、`getResources`、`roles/users` | 官方推荐 `MonSQLizeStorageAdapter` + `cache-hub` | 接口权限 + 数据权限 + 行级范围 + 管理能力 |

## 开始前先记住三件事

无论你选择哪条路径，都先记住这几条约束：

- 所有公共 API 在使用前都必须先执行 `await pc.init()`
- `userId` 约定由调用方保证为字符串；未登录请求应在中间件或 Service 入口直接当作无权限处理
- 资源类型和存储方式彼此独立：`HTTP-only` 也可以用 `MonSQLizeStorageAdapter`，`DB-only` 也可以先用 `MemoryAdapter`

## 1. `HTTP-only`

### 适合场景

- 只做接口权限
- 需要菜单、按钮、路由显隐
- 暂时不做字段过滤和数据权限

### 最小可运行示例

```typescript
import { MemoryAdapter, PermissionCore } from 'permission-core';

const pc = new PermissionCore({
  storage: new MemoryAdapter(),
});

await pc.init();

await pc.roles.create('operator', { label: '接口操作员' });
await pc.roles.allow('operator', 'invoke', 'GET:/api/orders');
await pc.roles.allow('operator', 'invoke', 'POST:/api/orders');

await pc.users.setUserRoles('u-1', ['operator']);

await pc.assert('u-1', 'invoke', 'GET:/api/orders');
const resources = await pc.getResources('u-1', 'invoke');
```

如果你只想先确认 `getResources()` 的最小返回结构，结果就是字符串数组：

```json
[
  "GET:/api/orders",
  "POST:/api/orders"
]
```

### 这个示例做了什么

- 完成运行时初始化
- 建立角色、规则和用户绑定
- 用 `assert()` 做接口放行
- 用 `getResources()` 输出给菜单或按钮使用的资源列表

如果你的接口本身带参数，接口资源里的 `path` 也应优先使用命中的模板路径。例如命中 `/api/orders/:id` 时，规则应写成 `DELETE:/api/orders/:id`，而不是把 `DELETE:/api/orders/123` 这种实际 URL 直接写进规则。

这里故意使用逐条 `allow()` 的写法，是为了把最小接入闭环讲清楚：角色怎么创建、规则怎么进入、用户怎么绑定、运行时怎么校验。

如果你在做管理后台或初始化脚本，不需要把前端交互设计成“用户点一次按钮就发一次 `allow()`”。更稳妥的方式通常是：前端维护一份规则数组，提交给你自己的后端保存接口，再由后端统一做去重、校验和写入。

### 如果你要撤回规则或解绑角色

```typescript
await pc.roles.revokeRule('operator', 'invoke', 'POST:/api/orders');
await pc.users.revoke('u-1', 'operator');

// 如果你要整体清空，也可以：
// await pc.roles.clearRules('operator');
// await pc.users.clearUserRoles('u-1');
```

- `revokeRule()` 适合移除角色上的某条具体规则
- `revoke()` 适合从某个用户上解绑一个角色
- `clearRules()` / `clearUserRoles()` 更适合整体清空，而不是单点撤回

### 先不用管什么

- 只需要 `<METHOD>:<path>` 资源；其中 `path` 指规范化后的命中路由路径
- 不要求出现任何 `db:` 规则
- 不要求接入 `filterFields()`
- `getResources()` 适合做菜单显隐，最终权限判断仍以 `can/assert` 为准

### 什么时候该升级到下一条路径

如果你开始需要：

- 在 Service / DAO 层判断集合读写权限
- 在查询前后收口行级范围
- 对返回字段做脱敏
- 对写入 payload 做字段白名单过滤

那就不再只是 `HTTP-only`，而应转向 `DB-only` 或 `Full standard stack`。

## 2. `DB-only`

### 适合场景

- 只做集合级、行级和字段级权限
- 想在 Service / DAO 层主动判断权限
- 暂时不接 HTTP 中间件

### 最小可运行示例

```typescript
import { MemoryAdapter, PermissionCore } from 'permission-core';

const pc = new PermissionCore({
  storage: new MemoryAdapter(),
});

await pc.init();

await pc.roles.create('analyst', { label: '数据分析员' });
await pc.roles.allow('analyst', 'read', 'db:reports');
await pc.roles.allow('analyst', 'read', 'db:reports:title');
await pc.roles.allow('analyst', 'read', 'db:reports:summary');
await pc.users.assign('u-2', 'analyst');

const canRead = await pc.can('u-2', 'read', 'db:reports');
const safe = await pc.filterFields('u-2', 'read', 'db:reports', {
  title: 'Q2',
  summary: 'good',
  rawCost: 100,
});

const scope = await pc.getRowScope('u-2', 'read', 'db:reports');
```

### 这个示例做了什么

- 用 `can/assert` 做集合级放行
- 可以用 `getRowScope()` / `filterRows()` 继续收口记录范围
- 用 `filterFields()` 做对象级字段过滤
- 不依赖 HTTP 中间件也能先跑通数据权限

和 `HTTP-only` 一样，这里逐条配置规则只是为了把最小示例讲清楚，不代表你的后台界面必须逐条提交规则。

### 先不用管什么

- 不要求配置 `invoke` 规则
- 不要求先引入 HTTP 中间件
- 读写权限由 `can/assert` 决定，行范围由 `getRowScope/filterRows` 决定，字段权限由 `filterFields()` 决定
- 写入过滤更推荐明确使用 `create` 或 `update`，不要默认用 `write`

### 一个容易忽略的点

`write` 在请求侧是 `create && update` 的 AND 语义。如果你在写入过滤里直接传 `write`，字段会变得比预期更严格，通常更适合显式传 `create` 或 `update`。

## 3. `Full standard stack`

### 适合场景

- 同时做接口权限和数据权限
- 准备按官方推荐方式上生产
- 需要统一缓存、持久化与管理能力

### 最小可运行示例

```typescript
import { MemoryCache } from 'cache-hub';
import { MonSQLizeStorageAdapter, PermissionCore } from 'permission-core';

const msq = /* 已 connect() 的 MonSQLize 实例 */;

const pc = new PermissionCore({
  storage: new MonSQLizeStorageAdapter({ msq, namespace: 'permission_core' }),
  cache: new MemoryCache({ defaultTtl: 300_000, maxEntries: 1000 }),
});

await pc.init();
```

### 一般会同时用到这些能力

- 接口权限：`assert(userId, 'invoke', resource)`
- 数据权限：`assert(userId, 'read/update/...', 'db:...')`
- 行级范围：`getRowScope()`、`canRow()`、`filterRows()`
- 字段过滤：`filterFields()`
- 菜单资源：`getResources(userId, 'invoke')`
- 后台管理：`roles`、`users`

如果你准备做角色配置页、用户角色页或运营后台，可以继续看 [管理后台接入](/guide/site-preview-release)。

### 先不用误会成什么

- 这是官方默认生产路径，不是所有场景唯一入口
- 只有在同时需要接口权限、数据权限和统一部署维护方式时，才建议直接从这条路径开始
- 如果你只是做简单接口权限，不要因为使用了 `monsqlize` 就误以为必须打开 `db:` 资源

## 常见误区

- `HTTP-only` 不等于只能用 `MemoryAdapter`
- `DB-only` 不等于必须用 `MonSQLizeStorageAdapter`
- `getResources()` 不是最终鉴权结果，而是前端先用来决定页面上显示什么的资源列表
- `write` 不是简单别名；规则侧和请求侧的语义不同

## 下一步读什么

- 想理解资源怎么写：看 [资源路径模型](/guide/resource-paths)
- 想理解角色和规则怎么组织：看 [角色与规则](/guide/roles-and-rules)
- 想理解运行时主 API：看 [PermissionCore](/api/permission-core)
- 想看框架接入：看 [框架接入](/guide/framework-integration)
- 想先解开最常见的接入疑问：看 [常见问题](/guide/faq)
- 想真正开始接入前做一次总检查：看 [接入检查清单](/guide/integration-checklist)