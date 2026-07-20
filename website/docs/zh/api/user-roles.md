# 用户角色 API

## 用途与前置条件

`scoped.userRoles` 管理某个用户在一个完整 scope 内的直接角色集合。它不创建用户，也不认证用户。引用的每个角色必须已存在于同一 scope。

## 我想做什么

| 目标 | 入口 |
|---|---|
| 给用户增量添加或移除角色 | [`assign()`](#user-roles-assign)、[`revoke()`](#user-roles-revoke) |
| 保存完整角色勾选结果 | [`getDirect()`](#user-roles-get-direct) 后 [`set()`](#user-roles-set) |
| 清空用户直接角色 | [`clear()`](#user-roles-clear) |
| 查看直接角色和继承后的有效角色 | [`getDirect()`](#user-roles-get-direct)、[`getEffective()`](#user-roles-get-effective) |
| 反查某角色绑定了哪些用户 | [`listUsersByRole()`](#user-roles-list-users-by-role) |

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

## 参数与返回字段

共享的 `MutationOptions`、`RequiredRevisionOptions`、`MutationResult`、`VersionedResult` 和 `PageResult` 见[核心与公共合同](/zh/api/core-and-contexts#common-response-contracts)。

<!-- docs:params owner=UserRoleManager locale=zh -->

| 参数 | 类型 | 必填 | 来源/约束 | 说明 |
|---|---|:---:|---|---|
| `userId` | `string` | 是 | 宿主用户目录或认证结果；trim 后 1..128 bytes | 只作为权限主体 ID，permission-core 不创建用户。 |
| `roleId` | `string` | assign/revoke/list 时是 | 当前 scope 中已存在的角色 ID | 不会跨 scope 查找同名角色。 |
| `roleIds` | `readonly string[]` | set 时是 | 目标完整直接角色集合；去重后最多 128 个 | 不是增量列表；未列出的旧角色会被移除。 |
| `options.expectedRevision` | `number` | set/clear 时是 | 最新 `getDirect().data.revision` | 用于防止覆盖其他管理员刚完成的修改。 |
| `query.first` | `number` | 否 | 默认 50，范围 1..200 | `listUsersByRole` 每页数量。 |
| `query.after` | `string` | 否 | 上一页 `pageInfo.endCursor` | 不要自行解析或拼接 cursor。 |

`UserRoleBindingSet` 字段：

| 字段 | 含义 |
|---|---|
| `userId` | 该直接角色集合属于哪个用户。 |
| `roleIds` | 当前 scope 内的直接角色 ID；不含父角色继承。 |
| `revision` | 该用户角色集合的并发修订号。 |
| `persisted` | 是否已有持久化集合；未绑定过角色的用户也会返回显式空集合。 |
| `createdAt/updatedAt` | 持久化集合存在时的时间戳。 |

## 方法详解

<span id="user-roles-assign"></span>
### `assign(userId, roleId, options?)`

<!-- docs:method name=userRoles.assign locale=zh -->

- **用途**：在用户现有直接角色旁追加一个角色，适合“给用户再加一个角色”。
- **参数**：`userId`、`roleId` 必填；`options` 可带 actor/reason/request/idempotency key，不需要先读 revision。
- **状态影响**：角色不存在时失败；已绑定同一角色时是幂等/no-op，不会产生重复 ID。
- **原始返回**：`MutationResult<UserRoleBindingSet>`；`data.roleIds` 是追加后的完整直接集合，`changed` 表示本次是否真的新增。
- **不要混用**：保存后台多选框的完整结果时使用 `set`，不要循环 assign 后再猜哪些旧角色要删除。

<span id="user-roles-revoke"></span>
### `revoke(userId, roleId, options?)`

<!-- docs:method name=userRoles.revoke locale=zh -->

- **用途**：从直接角色集合中移除一个角色。
- **参数**：`userId`、`roleId` 必填；options 与 assign 相同。
- **状态影响**：只移除直接绑定，不修改角色本身，也不删除通过其他直接角色继承到的有效角色。
- **原始返回**：`MutationResult<UserRoleBindingSet>`；检查 `data.roleIds` 和 `changed`。
- **注意**：角色本来就未绑定时通常是 no-op；需要清空所有直接角色时使用 `clear`。

<span id="user-roles-set"></span>
### `set(userId, roleIds, options)`

<!-- docs:method name=userRoles.set locale=zh -->

- **用途**：把用户的完整直接角色集合替换成 `roleIds`，适合管理后台一次保存。
- **参数**：先调用 `getDirect(userId)`，把 `before.data.revision` 传为 `expectedRevision`；`roleIds` 是最终集合。
- **状态影响**：原子新增列表中新角色并移除未列出的旧角色；不会修改角色继承关系。
- **原始返回**：`MutationResult<UserRoleBindingSet>`；`data.roleIds` 是提交后的最终集合。
- **常见失败**：任一角色不存在返回 `ROLE_NOT_FOUND`；revision 过期返回 `REVISION_CONFLICT`，应重新读取并让管理员处理冲突。

<span id="user-roles-clear"></span>
### `clear(userId, options)`

<!-- docs:method name=userRoles.clear locale=zh -->

- **用途**：把用户的直接角色集合原子替换为空。
- **参数**：`userId` 和最新 `expectedRevision` 必填。
- **状态影响**：移除全部直接绑定；用户仍然存在于宿主用户目录，permission-core 不删除用户。
- **原始返回**：`MutationResult<UserRoleBindingSet>`，成功后 `data.roleIds=[]`。
- **区别**：等价目标可用 `set(userId, [], options)`，`clear` 更清楚地表达意图。

<span id="user-roles-get-direct"></span>
### `getDirect(userId)`

<!-- docs:method name=userRoles.getDirect locale=zh -->

- **用途**：读取管理后台可编辑的直接角色集合，并取得 set/clear 所需 revision。
- **参数**：`userId` 必填。
- **状态影响**：只读。
- **原始返回**：`VersionedResult<UserRoleBindingSet>`；使用 `data.roleIds` 展示选中项，使用 `data.revision` 做后续 CAS。
- **边界**：不展开父角色；要展示最终生效角色请用 `getEffective`。

<span id="user-roles-get-effective"></span>
### `getEffective(userId)`

<!-- docs:method name=userRoles.getEffective locale=zh -->

- **用途**：诊断用户的直接角色经父链展开后有哪些角色真正参与授权。
- **参数**：`userId` 必填。
- **状态影响**：只读。
- **原始返回**：`VersionedResult<UserEffectiveRoles>`；`data.direct` 是直接集合，`data.effective.items` 每项说明 `direct/viaRoleIds/depth/included/excludedReason`。
- **边界**：它只解释角色，不直接列出最终规则；最终规则与冲突用 `subject.getPermissions()`。

<span id="user-roles-list-users-by-role"></span>
### `listUsersByRole(roleId, query?)`

<!-- docs:method name=userRoles.listUsersByRole locale=zh -->

- **用途**：分页查询哪些用户直接绑定了指定角色，适合角色详情页和删除影响排查。
- **参数**：`roleId` 必填；`query.first/after` 可选。
- **状态影响**：只读，不包含“仅通过子角色间接获得该角色”的用户。
- **原始返回**：`PageResult<UserRoleBindingSet>`；渲染 `items`，按 `pageInfo` 继续翻页。
- **失败**：角色不存在返回 `ROLE_NOT_FOUND`；无用户时返回空 `items`，不是 404。

<span id="user-roles-assign-vs-set"></span>
## `assign` 与 `set` 怎么选

| 需求 | 使用方法 | 原因 |
|---|---|---|
| 给用户额外增加一个角色 | `assign` | 追加且幂等，不移除其他直接角色。 |
| 后台多选框保存完整选中结果 | `getDirect` -> `set` | CAS 替换完整集合，能同时处理新增和取消。 |
| 移除一个已知直接角色 | `revoke` | 只处理该角色。 |
| 清空全部直接角色 | `getDirect` -> `clear` | 意图明确并防并发覆盖。 |
| 查看用户实际生效角色 | `getEffective` | 展开父角色并解释来源。 |

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

上面的 JSON 是示例为便于对比而组装的**汇总输出**，不是 `set()` 的原始响应。`set()` 的原始响应是 `MutationResult<UserRoleBindingSet>`，其中提交后的角色位于 `replaced.data.roleIds`。`set` 不会在旧角色旁追加 `operator`，而是替换直接集合。

## 相关内容

参见[检查权限](/zh/guide/check-permission)、[角色继承](/zh/guide/role-inheritance)和[角色 API](/zh/api/roles)。
