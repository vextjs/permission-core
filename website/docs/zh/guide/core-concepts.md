# 核心术语与心智模型

本页只解释后续示例里最常见的几个词。看完以后，你应该能分清“在哪个租户里判断谁的什么权限”，以及什么时候读 direct、什么时候读 effective。

## 先记住一条主线

```text
可信登录身份 -> subject（当前用户） -> 当前 scope 内的角色 -> 有效规则 -> 允许或拒绝
```

宿主应用先完成登录并确认用户身份，再把可信的 `userId` 和租户范围交给 permission-core。permission-core 不验证密码或令牌，只根据已保存的角色与规则回答“这个用户能不能操作这个资源”。

## 几个常用词

| 术语 | 通俗解释 | 在代码里怎么看 |
|---|---|---|
| scope | 一块互相隔离的权限空间，至少有 `tenantId` | `pc.scope(scope, defaults?)` |
| subject | 当前要判断权限的用户，包含 `userId` 和 `scope` | `pc.forSubject({ userId: 'u-1', scope })` |
| role | 一组权限的名字，例如“订单只读” | `scoped.roles.create(...)` |
| rule | 角色允许或拒绝的一个动作与资源组合 | `{ action: 'invoke', resource: 'api:GET:/api/orders' }` |
| direct | 直接保存到当前对象上的内容，例如用户直接绑定的角色 | `userRoles.getDirect()` |
| effective | 加上继承、状态和冲突规则后真正生效的结果 | `userRoles.getEffective()`、`roles.getEffectiveRules()` |
| default deny | 没有命中 allow 时默认拒绝 | `can()` 返回 `false` |
| revision | 一次可编辑数据的版本号，用来防止旧页面覆盖新数据 | `expectedRevision` |
| preview | 先预览影响，不立即写入 | `previewAccessUpdate()` |

## 租户、用户与角色的关系

- **租户不是角色。** `tenantId` 决定到哪一套权限数据中查询。
- **用户由宿主管理。** permission-core 只保存“这个用户 ID 在当前 scope 绑定了哪些角色”。
- **角色属于 scope。** 两个租户可以都有 `order-reader`，它们仍是两份互不共享的数据。
- **一个用户可以有多个直接角色。** 运行时会再合并父角色，得到有效角色。
- **没有 allow 就拒绝。** 不需要专门给每个不能访问的接口写 deny。

```ts
const scope = { tenantId: 'acme' };
const scoped = pc.scope(scope, {
  actorId: 'admin',
  requestId: 'req-admin',
}); // 管理 acme 租户的权限数据
const subject = pc.forSubject({ userId: 'u-1', scope }); // 判断 u-1 的权限
```

`scope()` 和 `forSubject()` 都只创建上下文，不会写数据库。管理写入建议在 `scope(scope, defaults)` 里一次绑定 `actorId/requestId`；真正的读取或写入发生在后续 `roles.*`、`userRoles.*`、`subject.can()` 等调用中。

## direct 和 effective 怎么选

一句话：**编辑页面看 direct，权限诊断看 effective。**

| 场景 | 推荐读取 | 原因 |
|---|---|---|
| 打开“给用户分配角色”的编辑页 | `userRoles.getDirect()` | 只显示后台直接勾选的角色 |
| 排查“为什么这个用户有权限” | `userRoles.getEffective()` | 会展开继承后的最终角色 |
| 编辑一个角色自己的规则 | `roles.getOwnRules()` | 只看这个角色直接保存的规则 |
| 解释一个角色最终拥有哪些规则 | `roles.getEffectiveRules()` | 会合并父角色规则 |

不要把有效结果原样保存回直接集合，否则会把继承关系拍平，后续很难维护。

## 下一步怎么读

| 你要做什么 | 下一页 |
|---|---|---|
| 给用户分配角色 | [管理角色与用户授权](/zh/guide/manage-roles-and-users) |
| 判断用户能不能访问接口 | [检查权限](/zh/guide/check-permission) |
| 理解父角色继承 | [角色继承](/zh/guide/role-inheritance) |
