# 兼容性矩阵

这页只回答一件事：当前 permission-core 明确依赖哪些运行时和配套库，以及哪些组合已经在本仓库里被真实验证过。

## 一、核心结论

- `permission-core` 自身声明的最低 Node.js 版本是 `>=18`
- 当前仓库内的主包构建、类型检查、单测、覆盖率和示例脚本都已经在**当前本地环境**通过
- 当前运行时依赖固定为 `cache-hub@^1.0.0` 与 `monsqlize@^1.3.0`
- 主包同时提供 ESM 和 CJS 入口

## 二、版本矩阵

| 组件 | 当前声明 / 当前安装 | 当前状态 | 说明 |
|------|----------------------|----------|------|
| Node.js | `>=18`（来自 `package.json`） | ✅ 支持 | permission-core 自身的最低运行时要求 |
| TypeScript | `^5.8.3` | ✅ 已验证 | 用于开发、类型检查和 DTS 生成 |
| Vitest | `^3.2.4` | ✅ 已验证 | 用于单元测试与覆盖率验证 |
| `@vitest/coverage-v8` | `^3.2.4` | ✅ 已验证 | 当前 `100%` 覆盖率基于该 provider 生成 |
| `cache-hub` | `^1.0.0` / `1.0.0` | ✅ 已验证 | 当前缓存底座；`PermissionCache` 和 example 已验证 |
| `monsqlize` | `^1.3.0` / `1.3.0` | ✅ 已验证 | `MonSQLizeStorageAdapter` 当前官方持久化路径 |

## 三、当前仓库里实际验证过什么

以下组合已经在当前仓库内通过真实命令验证：

| 项目 | 命令 | 状态 |
|------|------|------|
| 类型检查 | `npm run typecheck` | ✅ |
| 单元测试 + 覆盖率 | `npm run test:coverage` | ✅ |
| 主包构建 | `npm run build` | ✅ |
| 仓库级示例 | `npm run example:all` | ✅ |
| 文档站构建 | `cd website && npm run build` | ✅ |

如果你看到文档里提到某个能力，但它没有经过这些命令链路中的任何一条验证，就不应该把它当成“已在当前仓库证明过”的兼容性结论。

## 四、模块边界上的兼容性说明

### 1. ESM / CJS

主包当前同时提供：

- ESM 入口：`./dist/index.js`
- CJS 入口：`./dist/index.cjs`
- 子路径导出：`./match`

这意味着常见的 Node.js 项目可以按各自模块系统直接导入，不必自己再包一层兼容适配。

### 2. 存储适配器

| 适配器 | 适用环境 | 兼容性说明 |
|--------|----------|------------|
| `MemoryAdapter` | 开发、测试、示例 | 不依赖外部存储 |
| `FileAdapter` | 本地、单机、回退 | 依赖 Node.js 文件系统；不适合多实例共享写入 |
| `MonSQLizeStorageAdapter` | 正式持久化路径 | 依赖 `monsqlize@^1.3.0`；数据库边界由 monsqlize 侧负责 |

### 3. 浏览器环境

permission-core 当前是 Node.js 权限内核，不是浏览器端 SDK。

如果你需要前端权限显隐，建议让前端消费后端基于 `getResources()`、`getPermissions()` 或业务接口返回的结果，而不是直接把整个权限内核运到浏览器里执行。

## 五、升级时最应该先看什么

如果你准备升级下面这些依赖，建议先看对应边界：

- 升 Node.js：先确认 `package.json` 的最低版本要求，再复跑 `typecheck`、`test:coverage`、`build`
- 升 `cache-hub`：重点复核 `CacheLike` 接口是否有签名变化
- 升 `monsqlize`：重点复核 `MonSQLizeStorageAdapter` 依赖的 collection 行为、返回结构和生命周期方法

## 六、推荐做法

如果你要在自己的项目里长期依赖 permission-core，最稳妥的方式是：

1. 固定一条你自己的 Node.js 运行时线。
2. 固定一条你自己的 `cache-hub` / `monsqlize` 版本线。
3. 在升级前复跑本页列出的 5 个关键命令。

如果你已经准备进入生产落地，再继续看 [生产部署与监控](/guide/production-deployment)。