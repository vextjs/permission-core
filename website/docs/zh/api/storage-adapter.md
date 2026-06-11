# StorageAdapter

`StorageAdapter` 是 permission-core 唯一依赖的持久化契约。你可以把它理解成“权限核心要求外部存储至少提供哪些能力”，而不是“某个具体数据库驱动”。

内置的 `MemoryAdapter`、`FileAdapter`、`MonSQLizeStorageAdapter` 都是它的实现。如果你要接自己的数据库或 KV，也需要实现这套抽象。

## 最小心智模型

一个 `StorageAdapter` 只负责三类数据：

- 角色本身
- 角色规则
- 用户与角色绑定

它不负责：

- 改写 `allow/deny` 语义
- 决定 `write` 怎么展开
- 直接做权限判断

## 抽象方法一览

| 方法 | 返回值 | 用途 |
|------|--------|------|
| `init()` | `Promise<void>` | 初始化底层资源 |
| `close()` | `Promise<void>` | 关闭底层资源 |
| `getRoles()` | `Promise<Map<string, RoleData>>` | 读取全部角色 |
| `getRole(id)` | `Promise<RoleData \| null>` | 读取单个角色 |
| `setRole(id, roleData)` | `Promise<void>` | 保存单个角色 |
| `deleteRole(id)` | `Promise<void>` | 删除单个角色 |
| `getUserRoles(userId)` | `Promise<string[]>` | 读取用户直接绑定的角色 ID |
| `setUserRoles(userId, roleIds)` | `Promise<void>` | 覆盖写入用户直接绑定的角色 ID |
| `getUsersByRole(roleId)` | `Promise<string[]>` | 反查某角色直接绑定了哪些用户 |
| `getRules(roleId)` | `Promise<PermissionRule[]>` | 读取某角色的规则数组 |
| `setRules(roleId, rules)` | `Promise<void>` | 覆盖写入某角色规则数组 |
| `deleteRules(roleId)` | `Promise<void>` | 删除某角色全部规则 |

## 自定义适配器最容易做错的地方

### 不要在存储层改写权限模型

比如：

- 不要把 `write` 预展开后再存
- 不要在存储层私自调换 `deny` / `allow` 优先级
- 不要在存储层提前把 `where` 算成最终结果

### `setUserRoles()` 和 `setRules()` 是覆盖语义

它们不是 append，而是把当前快照整体写回去。管理后台“整体保存”场景也是建立在这个语义上。

### `init()` / `close()` 只做资源准备和释放

它们可以做连接、建索引、flush 写盘，但不应该偷偷修正业务数据含义。

## 内置实现

- [MemoryAdapter](/zh/api/memory-adapter)
- [FileAdapter](/zh/api/file-adapter)
- [MonSQLizeStorageAdapter](/zh/api/monsqlize-storage-adapter)

## 更适合从哪里继续看

- 如果你想先选现成适配器：继续看 [存储适配器](/zh/guide/adapters)
- 如果你要自己实现：继续看 [自定义适配器](/zh/guide/custom-adapter)
