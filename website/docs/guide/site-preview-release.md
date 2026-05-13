# 管理后台接入

这页面向的是把 permission-core 接进管理后台、运营后台或权限配置后台的人。它关心的不是某个单独 API 怎么调用，而是把 `roles`、`users`、缓存失效和错误响应串成一条真正可落地的管理链路。

## 一、先把后台职责拆开

一个常见误区是把“角色规则编辑”和“用户角色绑定”混成一个接口层。更稳妥的拆法通常是：

- 角色页：维护角色基本信息和角色自身规则
- 用户页：维护某个用户绑定了哪些角色
- 运行时校验：继续由 `can()` / `assert()` / `getRowScope()` / `filterRows()` / `filterFields()` 负责

这样分开以后，角色规则变化和用户绑定变化的缓存失效语义也更清楚。

## 二、角色详情页一般怎么做

一个常见的角色详情页至少会涉及这几块：

1. 角色基本信息：`roles.get()` / `roles.update()`
2. 角色自身规则：`roles.getRules()`
3. 角色最终生效规则与继承链：`roles.inspect()`
3. 删除角色：`roles.delete()`

这里最容易忽略的一点是：`getRules()` 返回的是角色自身规则，不含继承链。后台详情页展示时，要把它理解成“这个角色自己配置了什么”，而不是“这个角色最终生效了什么”。

如果页面同时还要展示继承链或 effective rules，就直接加上：

```typescript
const inspection = await pc.roles.inspect('operator');
```

最小加载片段可以先记成：

```typescript
const role = await pc.roles.get('operator');
const rules = await pc.roles.getRules('operator');
```

## 三、为什么示例里总是逐条 `allow()`

快速开始和基础示例里的逐条 `allow()`，主要是为了把最小闭环讲清楚：

- 角色怎么创建
- 规则怎么进入
- 用户怎么绑定
- 运行时怎么校验

这不等于你的后台页面必须设计成“点一次按钮就发一次 `allow()` 请求”。

更稳妥的后台保存方式通常是：

1. 前端把当前角色页整理成一份规则数组
2. 提交给你自己的后端保存接口
3. 后端统一做去重、校验和最终写入

## 四、当前公开 API 下，角色规则怎么保存更稳妥

当前公开的 `RoleManager` 仍以这些方法为主：

- `allow()` / `deny()`
- `revokeRule()`
- `clearRules()`
- `getRules()`

也就是说，公开层还没有把“整表覆盖角色规则”收口成一个单独方法。对于后台场景，更合理的做法通常不是让前端直接逐条调公开 API，而是由后端封装一层保存服务：

```typescript
type RoleRuleInput = {
	type: 'allow' | 'deny';
	action: string;
	resource: string;
	where?: RowCondition;
};

async function saveRoleRules(roleId: string, rules: RoleRuleInput[]) {
	const normalized = dedupeRules(rules);

	await pc.roles.clearRules(roleId);

	for (const rule of normalized) {
		if (rule.type === 'allow') {
			await pc.roles.allow(roleId, rule.action, rule.resource, {
				where: rule.where,
			});
			continue;
		}

		await pc.roles.deny(roleId, rule.action, rule.resource, {
			where: rule.where,
		});
	}
}
```

如果你想进一步减少写入次数，可以在自己的服务层先做差异计算，再分别调用 `allow()`、`deny()` 和 `revokeRule()`。这更适合规则量较大或保存频率较高的后台。

## 五、行级权限在后台里应该怎么存

当你开始配置“只能看自己的订单”“只能处理本租户数据”这类规则时，不要把 MongoDB Query 或 SQL 片段直接塞进后台表单。

更稳妥的做法是让后台维护统一的规则结构：

```typescript
const rules: RoleRuleInput[] = [
	{
		type: 'allow',
		action: 'read',
		resource: 'db:orders',
		where: { field: 'ownerId', op: 'eq', valueFrom: 'userId' },
	},
];
```

这样有三个直接好处：

- 后台保存结构可以直接持久化
- 运行时可以继续走 `getRowScope()` / `filterRows()`
- 后续如果你要做不同数据库的查询翻译，也有统一中间表示可以转换

## 六、重复规则和冲突规则怎么理解

角色规则在后台里最好先按下面这组边界理解：

- 相同的 `type + action + resource` 应视为重复项，提交前应先去重
- `allow` 和 `deny` 针对同一 `action + resource` 可以同时存在
- 一旦同时存在，运行时仍按现有规则解释：`deny` 优先于 `allow`
- `getRules()` 更适合用来展示角色自身规则；若要看角色最终生效结果，应改用 `inspect()` 或 `getEffectiveRules()`

换句话说，后台页真正要维护的是“角色自己的规则集”，而不是把所有继承后的最终权限都摊平成一张编辑表。

## 七、用户角色页为什么更适合 `setUserRoles()`

用户角色绑定和角色规则保存不一样。角色页通常在编辑一组规则，而用户页更常见的是“整体覆盖这个用户现在拥有哪些角色”。

所以用户角色页更适合按下面方式理解：

- `getUserRoles(userId)`：加载当前用户角色
- `setUserRoles(userId, roleIds)`：整体保存当前用户角色
- `assign()` / `revoke()`：更适合单点变更，不一定适合整表保存

最小加载/保存片段可以先记成：

```typescript
const currentRoleIds = await pc.users.getUserRoles('user-001');
await pc.users.setUserRoles('user-001', ['viewer', 'auditor']);
```

如果你的页面是多选框、穿梭框或批量选择角色，`setUserRoles()` 往往比多次 `assign()` / `revoke()` 更贴近页面语义。

如果你想直接看一段把 `roles.getRules()`、`roles.inspect()`、`getUserRoles()`、`setUserRoles()`、`getResources()` 串起来的后台代码，可继续看 [管理后台保存示例](/examples/management-backend)。

如果保存后还要刷新菜单或调试视图，通常会继续调用：

```typescript
const menuResources = await pc.getResources('user-001', 'invoke');
const permissions = await pc.getPermissions('user-001');
```

## 八、保存后还要不要手工清缓存

大多数情况下，不需要再额外手工清缓存，因为管理 API 本身已经带了失效语义：

- 角色规则变化：`invalidateAll()`
- 用户角色绑定变化：`invalidate(userId)`

这两者要区分开理解：

- 角色规则会影响继承链和多个用户，所以默认更偏向全量失效
- 用户绑定只影响单个用户，所以更适合精确失效

## 九、管理后台常见错误怎么回

后台接口最常见的几类错误通常是：

- `ROLE_NOT_FOUND`
- `ROLE_ALREADY_EXISTS`
- `CIRCULAR_INHERITANCE`
- `INVALID_ARGUMENT`
- `STORAGE_ERROR`

常见 HTTP 映射可以先按下面理解：

- `ROLE_NOT_FOUND`：`404`
- `ROLE_ALREADY_EXISTS`：`409`
- `CIRCULAR_INHERITANCE`：`409`
- `INVALID_ARGUMENT`：`400`
- `STORAGE_ERROR`：`500`

如果你需要把错误结构固定成统一响应体，可以继续看 [错误处理与响应映射](/guide/error-response-mapping)。

## 十、一个更贴近后台的落地顺序

如果你准备真正做后台页面，推荐顺序通常是：

1. 先确认资源字符串怎么写：看 [资源路径模型](/guide/resource-paths)
2. 再确认角色和规则边界：看 [角色与规则](/guide/roles-and-rules)
3. 再看角色与用户管理入口：看 [RoleManager](/api/role-manager) 和 [UserRoleManager](/api/user-roles)
4. 最后补错误响应和缓存失效：看 [错误处理与响应映射](/guide/error-response-mapping) 和 [权限缓存](/guide/cache)

## 下一步看什么

- 想先确认角色管理入口的具体方法：看 [RoleManager](/api/role-manager)
- 想先确认用户角色绑定入口：看 [UserRoleManager](/api/user-roles)
- 想直接看角色页和用户角色页怎么把管理 API 串起来：看 [管理后台保存示例](/examples/management-backend)
- 想把后台错误结构返回给前端：看 [错误处理与响应映射](/guide/error-response-mapping)