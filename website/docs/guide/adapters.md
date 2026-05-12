# 存储适配器

permission-core 通过统一的 `StorageAdapter` 抽象管理角色、规则和用户绑定。你可以把适配器理解成“这些权限数据放在哪里、启动和关闭时该怎么处理”，而不是“它决定你能不能用哪种资源类型”。

## 适配器到底负责什么

一个合格的适配器至少要解决四件事：

- 角色读写
- 规则读写
- 用户与角色绑定读写
- `init()` / `close()` 生命周期语义

它不应该负责：

- 决定你是否启用 `db:` 资源
- 改写 `allow/deny` 的优先级
- 改写 `write` 的语义
- 把业务权限判断逻辑塞回存储层

## 内置适配器对比

| 适配器 | 适合场景 | 生命周期特点 | 优点 | 注意事项 |
|-------|---------|--------------|------|---------|
| `MemoryAdapter` | 开发、测试、最小验证 | `init/close` 基本为 no-op | 最轻、最快、零外部依赖 | 进程退出即丢失数据 |
| `FileAdapter` | 单机、本地演示、文档演示 | `init()` 读盘，`close()` flush 写盘 | 比内存更接近真实持久化 | 不适合多实例共享和生产高并发 |
| `MonSQLizeStorageAdapter` | 官方默认生产路径 | `init()` 建立访问器，`close()` 清理资源 | 与官方标准栈一致，便于统一运维 | 需要可用的 MonSQLize 实例和命名空间规划 |

## 选择顺序建议

如果你还在验证文档或跑最小用例，优先按这个顺序选择：

1. 本地验证或单测：`MemoryAdapter`
2. 单机演示或文档复核：`FileAdapter`
3. 正式生产环境：`MonSQLizeStorageAdapter`

这个顺序是为了降低接入成本，不是为了暗示不同路径只能绑定某一种适配器。

## 资源模式和存储模式是两回事

这件事必须单独强调，因为它是接入时最常见的误解来源：

- `HTTP-only` 可以把规则存到 `monsqlize`
- `DB-only` 可以先用 `MemoryAdapter` 跑通字段过滤
- `Full standard stack` 只是官方默认生产路径，不是唯一被支持的接法

换句话说：

- 接入模式决定你启用 `<METHOD>:<path>` 还是 `db:<collection>[:<field>]`
- 存储模式决定角色、规则和用户绑定放在哪里

## 初始化和关闭的建议写法

```typescript
const pc = new PermissionCore({
	storage: new FileAdapter({ path: './permission-data.json' }),
});

await pc.init();

try {
	// run app
} finally {
	await pc.close();
}
```

虽然 `MemoryAdapter` 看起来几乎不用做事，但仍然建议统一保留 `init()` 和 `close()`。这样后面切换到 `FileAdapter` 或 `MonSQLizeStorageAdapter` 时，不用改调用结构。

## 官方标准栈为什么默认是 MonSQLize

生产环境默认更推荐 `MonSQLizeStorageAdapter + cache-hub`。原因主要有三点：

- 便于统一规则、绑定和管理后台的数据放在哪里
- 与官方缓存方案一起更容易形成稳定的维护方式
- 对同时需要接口权限、数据权限和后台管理的场景更容易形成统一接法

但这不意味着 `permission-core` 本身被改成了 MongoDB 专属权限库。`StorageAdapter` 抽象仍然保留，`FileAdapter` 和 `MemoryAdapter` 仍然是正式备用方案。

## 当前数据库持久化支持边界

这点最好单独说清楚，因为它很容易被误读。

当前内置的数据库持久化路径是：

- 当前只有 `MonSQLizeStorageAdapter` 这一条内置数据库持久化路径

这条路径底层实际支持的数据库是：

- `mongodb`

也就是说，**就当前 v1 文档冻结的内置能力而言，数据库持久化这条官方路径实际上就是 MongoDB**。

更准确地说：

- `permission-core` 的权限模型本身不是 MongoDB 专属
- 但当前内置数据库适配器路径只有 `MonSQLizeStorageAdapter`
- 当前 `monsqlize` 运行时底层数据库类型也只有 MongoDB

因此如果你现在要接：

- MySQL
- PostgreSQL
- 其他数据库或存储系统

当前更合理的路径不是“等内置适配器”，而是自己实现 `StorageAdapter`。

## 自定义适配器应该遵守什么

如果内置适配器不够，可以实现自己的 `StorageAdapter`。建议遵守以下边界：

- 存原始规则，不要在存储层提前展开 `write`
- 保持 `role/rule/user-role` 三类数据职责清晰
- `init()` 只做资源准备，不偷做业务规则修正
- `close()` 只做资源释放或 flush，不应悄悄改数据含义

## 常见误区

- 把“是否使用 `db:` 权限”误写成“是否使用 MonSQLize”
- 忘记在统一入口执行 `await pc.init()` 和 `await pc.close()`
- 在自定义适配器里改写 `allow/deny` 或 `write` 语义
- 把适配器和框架集成逻辑耦合到一起

下一篇继续看 [权限缓存](/guide/cache)。