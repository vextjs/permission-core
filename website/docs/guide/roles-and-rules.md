# 角色与规则

permission-core 不是直接把权限一条条挂到用户身上，而是先把权限放进角色，再把角色绑定给用户。

## 为什么不是直接给用户挂规则

如果直接给用户挂规则，短期看起来更省事，但很快会遇到这几个问题：

- 同一组权限无法稳定复用
- 一旦角色职责变动，需要逐用户改规则
- 缓存失效和继承演进会非常混乱

所以 v1 明确选择：

- 角色承载规则
- 用户绑定角色
- 运行时从用户出发展开角色继承链与规则集合

## 角色

角色用于承载一组可复用权限，例如：

- `viewer`
- `editor`
- `admin`

v1 只支持单继承，也就是一个角色最多只有一个父角色。

### 单继承意味着什么

这不是少做功能，而是 v1 先把范围控制住。单继承能让下面这些问题先保持可控：

- 继承链展开顺序
- 规则合并结果
- 循环继承检测
- 删除角色时的影响范围

## 规则

规则由三部分组成：

- `type`: `allow` 或 `deny`
- `action`
- `resource`

示例：

```typescript
await pc.roles.allow('viewer', 'invoke', 'GET:/api/articles');
await pc.roles.allow('editor', 'write', 'db:articles');
await pc.roles.deny('editor', 'read', 'db:users:email');
```

### allow 和 deny 的角色

- `allow` 用来显式授予能力
- `deny` 用来显式切断某条能力

如果一个系统里只有 `allow` 没有 `deny`，复杂角色组合时很容易只能不断拆角色，最终把角色体系拆碎。`deny` 的存在，是为了让首版权限模型既可组合，又可局部收紧。

## 默认判定原则

- 默认 `strict=true`
- `deny` 全局优先于 `allow`
- 没命中任何 `allow` 时默认拒绝

这意味着首版是显式白名单模型，更适合权限系统而不是“默认放行”。

### 这套默认值的设计目的

它优先保证两件事：

- 安全性可解释
- 合并结果稳定

如果默认改成“最后命中的规则优先”或“默认放行”，多角色组合时会很快变得不可预测。

## 用户绑定

用户与角色是多对多关系。常见操作有：

- `assign`
- `revoke`
- `setUserRoles`
- `clearUserRoles`

这些 API 的职责是管理“用户拥有哪些角色”，而不是管理规则本身。规则变更应回到 `pc.roles`，不要在用户绑定层混写。

## 什么时候该拆角色

推荐拆角色的情况：

- 需要复用一组规则给多个用户
- 需要继承上层角色基础能力
- 需要把接口权限和数据权限组合进同一职责角色

不推荐的情况：

- 为单个临时用户创建一次性角色
- 把所有权限都堆在 `admin` 上后再用 deny 零散修补

## 一个更真实的角色组合例子

```typescript
await pc.roles.create('viewer', { label: '查看者' });
await pc.roles.allow('viewer', 'invoke', 'GET:/api/articles');
await pc.roles.allow('viewer', 'read', 'db:articles');

await pc.roles.create('editor', {
	label: '编辑者',
	parent: 'viewer',
});
await pc.roles.allow('editor', 'write', 'db:articles');
await pc.roles.deny('editor', 'read', 'db:articles:internalNotes');
```

这个例子体现的是：

- 父角色承载基础可见权限
- 子角色叠加写入能力
- `deny` 用来切掉不希望继承下来的敏感字段

## 常见误区

- 把角色当成用户分组标签，而不是权限职责边界
- 把所有差异都留给 `deny`，导致角色体系不可读
- 先绑定用户，再反过来推角色职责

想继续看运行时判断逻辑，下一篇看 [权限鉴权](/guide/check-permission)。

## 下一步看什么

- 想继续理解运行时怎么判断权限：看 [权限鉴权](/guide/check-permission)
- 想把角色页和用户角色页做成后台能力：看 [管理后台接入](/guide/site-preview-release)
- 想按稳定顺序进入接入：看 [接入阅读顺序](/guide/implementation-reading-order)
- 想直接看角色管理入口：看 [RoleManager](/api/role-manager)