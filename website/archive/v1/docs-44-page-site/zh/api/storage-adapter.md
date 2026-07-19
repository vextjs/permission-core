# StorageAdapter

`StorageAdapter` 是 `PermissionCore`、RBAC manager 与 checker 共用的持久化契约。

## 用途与导入

```typescript
import { StorageAdapter } from 'permission-core';
```

内置 memory、file、MonSQLize 持久化不适合目标数据库时继承它。

## 构造与类型

`StorageAdapter` 是无构造选项的抽象类。实现保存 `RoleData`、字符串用户角色绑定和 `PermissionRule[]`。

真实多租户持久化还应实现 `ScopedStorageAdapter`；否则 runtime 会包装旧 adapter，并只允许 `defaultScope`。

## 签名索引

| 范围 | 抽象方法 |
|---|---|
| 生命周期 | `init`；`close` |
| 角色 | `getRoles`；`getRole`；`setRole`；`deleteRole` |
| 用户绑定 | `getUserRoles`；`setUserRoles`；`getUsersByRole` |
| 规则 | `getRules`；`setRules`；`deleteRules` |

Scoped 实现增加相同操作，并把 `PermissionScope` 作为首个参数。

## 行为与默认值

Manager 负责校验、继承规则、去重和缓存失效。Adapter 应原样持久化收到的值，并按签名用空集合或 `null` 表示不存在数据。

`setUserRoles()` 与 `setRules()` 是覆盖写。`init()` 准备资源，`close()` 只释放 adapter 自己拥有的资源。

## 错误与限制

不要把授权语义移入 storage，也不要把低层 replacement write 暴露成管理 API。持久化失败应按需包装成 `PermissionCoreError(STORAGE_ERROR, ...)`，原始 cause 只作为内部数据。

Adapter 不执行业务查询，也不实现 `MenuPermissionStorageAdapter`。多实例一致性、事务、锁、迁移与备份由实现和运维负责。

## 最小示例

```typescript
class CustomAdapter extends StorageAdapter {
  async init() {}
  async close() {}
  // 实现角色、绑定、反向索引与规则方法。
}

const pc = new PermissionCore({ storage: new CustomAdapter() });
```

## 相关页面

参见 [自定义适配器](/zh/guide/custom-adapter)、[存储适配器](/zh/guide/adapters) 与 [MonSQLizeStorageAdapter](/zh/api/monsqlize-storage-adapter)。
