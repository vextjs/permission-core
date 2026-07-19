# 多租户

## 场景

在两个 scope 中创建相同 `userId` 与 `roleId`。每个主体只能读取自身完整租户/应用 scope 内授予的资源，证明 ID 本身不是全局授权身份。

## 运行

```bash
npm run example:multi-tenant
```

规范源码是 `examples/multi-tenant.mjs` 中 `docs:multi-tenant:start` 到 `docs:multi-tenant:end` 的内容。

## 源码解读

```js
const scopeA = { tenantId: 'tenant-a', appId: 'admin' };
const scopeB = { tenantId: 'tenant-b', appId: 'admin' };
const tenantA = core.scope(scopeA);
const tenantB = core.scope(scopeB);

await tenantA.roles.create({ id: 'manager', label: 'Tenant A manager' });
await tenantA.roles.allow('manager', {
  action: 'read', resource: 'ui:page:tenant-a-dashboard',
});
await tenantA.userRoles.assign('same-user', 'manager');

await tenantB.roles.create({ id: 'manager', label: 'Tenant B manager' });
await tenantB.roles.allow('manager', {
  action: 'read', resource: 'ui:page:tenant-b-dashboard',
});
await tenantB.userRoles.assign('same-user', 'manager');

const subjectA = core.forSubject({ userId: 'same-user', scope: scopeA });
const subjectB = core.forSubject({ userId: 'same-user', scope: scopeB });
const rolesA = await tenantA.userRoles.getDirect('same-user');
const rolesB = await tenantB.userRoles.getDirect('same-user');
const aOwn = await subjectA.can('read', 'ui:page:tenant-a-dashboard');
const aCross = await subjectA.can('read', 'ui:page:tenant-b-dashboard');
const bOwn = await subjectB.can('read', 'ui:page:tenant-b-dashboard');
const bCross = await subjectB.can('read', 'ui:page:tenant-a-dashboard');
```

每个 scope 都有自己的 `manager` 定义与绑定集合。跨租户检查使用租户 A 的授权状态，因此返回 false。

### 1. 构建租户 A 的授权状态

<!-- docs:operation id=tenant-state-a calls=scope,roles.create,roles.allow,userRoles.assign outputs=tenantA -->

**目的与目标。** `scope`（通过 `core.scope(scopeA)`）为 `{ tenantId: 'tenant-a', appId: 'admin' }` 创建管理上下文。在该完整 scope 内，`roles.create` 创建 `manager`，`roles.allow` 只授予租户 A dashboard，`userRoles.assign` 绑定 `same-user`。

**状态、参数与结果。** 可见 ID 有意设计为可复用；normalized scope key 会参与每次角色、规则和用户角色查询。因此 `tenantA` 输出包含租户 A 的直接角色，以及只根据租户 A 状态得出的判定。

**失败与下一步。** scope 不完整/无效、同 scope 角色重复、角色不存在或 mutation 失败时，对应步骤会被拒绝。应在当前 scope 内修正记录并重试，不能回退到无 scope 查询，也不能借用租户 B 状态。

**API 参考。** 参见[核心与上下文 API](/zh/api/core-and-contexts)、[角色 API](/zh/api/roles)和[用户角色 API](/zh/api/user-roles)。

`core.scope(scopeA)` 同步返回 tenantA 管理 facade；其后的 create/allow/assign 分别返回独立 mutation envelope。相同字符串 ID 可复用，是因为每次持久化读写都包含规范化完整 scope key。

### 2. 构建租户 B 的授权状态

<!-- docs:operation id=tenant-state-b calls=scope,roles.create,roles.allow,userRoles.assign outputs=tenantB -->

**目的与目标。** `scope`（通过 `core.scope(scopeB)`）选择 `{ tenantId: 'tenant-b', appId: 'admin' }`；`roles.create`、`roles.allow` 和 `userRoles.assign` 复用相同角色/用户 ID，但改为授予租户 B dashboard。

**状态、参数与结果。** 租户 B 拥有独立的角色、规则、revision 和 assignment 记录。因此 `tenantB.directRoles` 也可以包含 `manager`，却不会与租户 A 共享角色对象或允许的资源。

**失败与下一步。** 失败必须在完整租户 B scope 内处理，并检查包含 `appId` 在内的所有维度。复用 `tenantId` 却丢掉另一个活动维度会指向不同 scope，必须失败，不能静默扩大访问。

**API 参考。** 参见[核心与上下文 API](/zh/api/core-and-contexts)、[角色 API](/zh/api/roles)和[用户角色 API](/zh/api/user-roles)。

tenantB 的三个 mutation 与 tenantA 形状相同，但 revision、audit 和数据记录彼此独立；返回值不能跨 facade 当作 expected revision 使用。

### 3. 对比本 scope 与跨 scope 判定

<!-- docs:operation id=tenant-decisions calls=forSubject,userRoles.getDirect,can outputs=identity,tenantA,tenantB -->

**目的与目标。** 两次 `forSubject` 为同一 `userId` 在不同完整 scope 中创建请求上下文；`userRoles.getDirect` 读取各自绑定集合，随后 `can` 分别检查自身 dashboard 和另一租户 dashboard。

**状态、参数与结果。** 两个 own-resource 结果都是 `true`；两个 cross-resource 结果都是 `false`，因为对应 subject 的 scope 中没有该资源 allow。`identity` 字符串概括四次判定共同证明的不变量。

**失败与下一步。** scope 必须来自已认证服务器状态或可信 resolver。可信来源冲突时应以 scope conflict 拒绝请求；不能从任意 header 选 scope，也不能改用另一租户重试。

**API 参考。** 参见[核心与上下文 API](/zh/api/core-and-contexts)了解 subject 判定，参见[用户角色 API](/zh/api/user-roles)了解 scoped 直接角色读取。

| 方法 | 调用次数 | 原始返回 |
|---|---:|---|
| `forSubject({ userId, scope })` | 2 | 同步返回两个请求期 facade，不是登录结果 |
| `userRoles.getDirect(userId)` | 2 | 各自 `VersionedResult<UserRoleBindingSet>`；汇总只取 `data.roleIds` |
| `subject.can(action, resource)` | 4 | 四个独立 boolean；own true、cross false |

## 预期输出

以下 JSON 是 `printExample()` 把两个 direct-role 响应和四个 boolean 组合后的**示例汇总输出**，不是任何单一 API 的原始响应。

```json
{
  "example": "multi-tenant",
  "ok": true,
  "identity": "the same userId and roleId are scoped independently",
  "tenantA": {
    "directRoles": ["manager"],
    "ownResource": true,
    "crossTenantResource": false
  },
  "tenantB": {
    "directRoles": ["manager"],
    "ownResource": true,
    "crossTenantResource": false
  }
}
```

<!-- docs:output group=identity producer=tenant-decisions -->

**`identity` 来源。** 该摘要在两次 `userRoles.getDirect` 读取和四次 `can` 判定全部完成后输出；它是对下方证据的解释，不是数据库字段。

<!-- docs:output group=tenantA producer=tenant-state-a -->

**`tenantA` 来源。** `getDirect` 提供 `directRoles`；租户 A subject 提供自身与跨租户 `can` 结果。cross 结果为 false，证明租户 A 授权状态内执行默认拒绝。

<!-- docs:output group=tenantB producer=tenant-state-b -->

**`tenantB` 来源。** `userRoles.getDirect` 与 `can` 在租户 B 的独立 scope 上执行。相同 ID 配合不同资源判定，正是预期的隔离证据。

## 生产边界

Fixture scope 是固定测试数据。生产 scope 必须来自已认证服务器状态或可信 resolver，不能直接来自请求头/请求体。业务 collection 还必须通过 `scopeFields` 映射每个活动 scope 维度。

## 相关内容

参见[多租户模型](/zh/guide/multi-tenant)、[认证边界](/zh/guide/authentication-boundary)和[授权集合 API](/zh/api/authorized-collection)。
