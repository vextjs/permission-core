# 用户角色 API

## 用途与前置条件

`scoped.userRoles` 管理某个用户在一个完整 scope 内的直接角色集合。它不创建用户，也不认证用户。引用的每个角色必须已存在于同一 scope。

## 签名

```ts
assign(userId: string, roleId: string, options?: MutationOptions): Promise<MutationResult<UserRoleBindingSet>>
revoke(userId: string, roleId: string, options?: MutationOptions): Promise<MutationResult<UserRoleBindingSet>>
set(userId: string, roleIds: readonly string[], options: RequiredRevisionOptions): Promise<MutationResult<UserRoleBindingSet>>
clear(userId: string, options: RequiredRevisionOptions): Promise<MutationResult<UserRoleBindingSet>>
getDirect(userId: string): Promise<VersionedResult<UserRoleBindingSet>>
getEffective(userId: string): Promise<VersionedResult<UserEffectiveRoles>>
listUsersByRole(roleId: string, query?: CursorQuery): Promise<PageResult<UserRoleBindingSet>>
```

`assign` 是针对单个角色的追加操作，并具备幂等语义。`set` 替换完整直接角色集合，因此需要当前 user-role-set revision。`revoke` 移除一个角色；`clear` 将集合替换为空。

## 响应与副作用

变更在 `data` 中返回完整持久化直接集合；发生变化时推进 RBAC/user revision、写入审计证据并使受影响主体缓存失效。读取会区分直接绑定与继承得到的有效角色。

```json
{
  "data": {
    "userId": "u-1",
    "roleIds": ["order-reader", "operator"],
    "revision": 2,
    "persisted": true
  },
  "revision": 2,
  "operationId": "operation_...",
  "auditId": "audit_..."
}
```

## 失败与限制

角色不存在返回 `ROLE_NOT_FOUND`；替换 revision 过期返回 `REVISION_CONFLICT`。一个用户最多有 `128` 个直接角色。有效展开上限为 `1024` 个角色、`20000` 条语义规则、`50000` 个来源和 `8 MiB` 快照。空的/未持久化用户会被显式表示，而不是被当作缺失的用户实体。

## 示例

```ts
await scoped.userRoles.assign('u-1', 'order-reader');
const before = await scoped.userRoles.getDirect('u-1');
const replaced = await scoped.userRoles.set('u-1', ['operator'], {
  expectedRevision: before.data.revision,
});
```

```json
{
  "before": ["order-reader"],
  "after": ["operator"]
}
```

`set` 不会在旧角色旁追加 `operator`，而是替换直接集合。

## 相关内容

参见[检查权限](/zh/guide/check-permission)、[角色继承](/zh/guide/role-inheritance)和[角色 API](/zh/api/roles)。
