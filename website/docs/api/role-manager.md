# RoleManager

`pc.roles` 负责角色和规则的管理。你可以把它理解成“配置权限规则这一侧”，而不是运行时判断这一侧。换句话说，`can/assert/getRowScope/filterRows/filterFields` 解决的是“当前用户有没有权限”，`pc.roles` 解决的是“权限规则本身怎么定义和变化”。

## 完整 API

### 角色操作

| 方法 | 签名 | 说明 |
|------|------|------|
| `create` | `(id, opts)` | 创建角色；父角色如果存在，必须先存在 |
| `update` | `(id, opts)` | 更新标签、描述或父角色；改 parent 时需要检测循环继承 |
| `delete` | `(id)` | 删除角色；有子角色时应拒绝 |
| `get` | `(id)` | 读取单个角色 |
| `list` | `()` | 读取所有角色 |
| `getRoleChain` | `(roleId)` | 读取当前角色到更高父角色的继承链 |

### 规则操作

| 方法 | 签名 | 说明 |
|------|------|------|
| `allow` | `(roleId, actions, resource, options?)` | 添加 allow 规则；`actions` 支持 `string | string[]` |
| `deny` | `(roleId, actions, resource, options?)` | 添加 deny 规则；`actions` 支持 `string | string[]` |
| `revokeRule` | `(roleId, actions, resource, options?)` | 精确删除匹配规则 |
| `clearRules` | `(roleId)` | 清空角色自身规则 |
| `getRules` | `(roleId)` | 读取角色自身规则，不含继承链 |
| `getEffectiveRules` | `(roleId)` | 读取角色连同父链展开后的有效规则 |
| `inspect` | `(roleId)` | 一次返回 `role`、`ownRules`、`effectiveRules`、`roleChain` |

## 关键行为

### v1 只支持单继承

一个角色最多只有一个父角色。这样做是为了先把继承展开、缓存失效和删除语义稳定下来。

### 所有规则变更都触发 `invalidateAll()`

这条规则很关键，因为角色规则变化会影响继承链上的下游用户，不只是直接绑定该角色的用户。首版方案优先选择“简单且安全”的全量失效策略。

### `getRules()` 不含继承链

这个方法返回的是角色自身规则，而不是最终展开后的有效规则。

如果你需要按角色维度查看“这个角色最终生效了什么”，应该改用：

- `getRoleChain()`：看继承链
- `getEffectiveRules()`：看展开后的有效规则
- `inspect()`：一次把角色详情页常用数据都拿回来

如果你需要某个用户最终拥有的完整规则，则继续看运行时 API `getPermissions()`。

### 后台保存角色规则时，不要把最小示例当成页面交互设计

快速开始里的逐条 `allow()` / `deny()`，主要是为了把最小闭环讲清楚，不代表后台页面必须逐条提交。

如果你的角色详情页会一次性编辑多条规则，更稳妥的方式通常是：

1. 前端维护一份规则数组
2. 提交给你自己的后端保存接口
3. 后端统一做去重、校验和最终写入

当前公开 API 仍然以 `allow()`、`deny()`、`revokeRule()`、`clearRules()` 为主，所以更适合由后端封装保存逻辑，而不是让前端直接逐条调管理 API。

### 行级权限规则怎么传

当规则需要表达“只能看自己的数据”时，把条件放进 `options.where`：

```typescript
await pc.roles.allow('sales', 'read', 'db:orders', {
	where: { field: 'ownerId', op: 'eq', valueFrom: 'userId' },
});
```

这层 `where` 会跟着规则一起持久化，供运行时的 `getRowScope()` / `filterRows()` 继续使用。

### 重复规则和冲突规则怎么理解

管理后台里最好先按下面这组边界理解角色规则：

- 相同的 `type + action + resource + where` 应视为重复项，提交前先去重
- `allow` 与 `deny` 针对同一 `action + resource` 可以同时存在
- 一旦同时存在，运行时仍按现有语义解释：`deny` 优先于 `allow`
- `getRules()` 更适合展示角色自身规则，不适合直接当成用户最终权限结果

## `roles.delete(id)` 为什么比看起来更重

删除角色时，通常要做这些步骤：

1. 检查该角色没有子角色
2. 清理该角色自身规则
3. 从所有直接绑定该角色的用户上移除绑定
4. 删除角色数据
5. `invalidateAll()`

这里最容易误解的一点是：删除角色不会去“反向清理继承链上的间接用户”，因为间接拥有该角色的情况在父角色删除后会自然失效。

## 更新或删除角色怎么调用

```typescript
await pc.roles.update('editor', { label: '高级编辑角色' });
await pc.roles.delete('editor');
```

- `update()` 适合修改角色标签、描述或父角色
- `delete()` 适合整体移除角色；删除前要先确认没有子角色依赖它

## 一个典型用法

```typescript
await pc.roles.create('viewer', { label: '只读角色' });
await pc.roles.create('editor', {
	label: '编辑角色',
	parent: 'viewer',
});

await pc.roles.allow('viewer', 'invoke', 'GET:/api/articles');
await pc.roles.allow('editor', 'write', 'db:articles');
await pc.roles.deny('editor', 'read', 'db:articles:internalNotes');
await pc.roles.allow('editor', 'read', 'db:articles', {
	where: { field: 'authorId', op: 'eq', valueFrom: 'userId' },
});
```

## 移除或清空规则怎么调用

```typescript
await pc.roles.revokeRule('editor', 'read', 'db:articles:internalNotes');
await pc.roles.clearRules('editor');
```

- `revokeRule()` 适合精确撤回某条规则
- `clearRules()` 更适合整体清空角色自身规则

## 调用结果示例

管理方法里最容易混淆的一点是：不是每个方法都会返回一段对象。

### 这些方法成功时都返回 `Promise<void>`

- `create`
- `update`
- `delete`
- `allow`
- `deny`
- `revokeRule`
- `clearRules`

也就是说，成功时返回值如下：

```typescript
await pc.roles.create('editor', { label: '编辑角色' });
// Promise<void>
```

### `get()` 返回单个角色

```typescript
const role = await pc.roles.get('editor');
```

返回结果结构如下：

```json
{
	"id": "editor",
	"label": "编辑角色",
	"parent": "viewer"
}
```

### `list()` 返回角色数组

```typescript
const roles = await pc.roles.list();
```

返回结果结构如下：

```json
[
	{
		"id": "viewer",
		"label": "只读角色"
	},
	{
		"id": "editor",
		"label": "编辑角色",
		"parent": "viewer"
	}
]
```

### `getRules()` 返回角色自身规则数组

```typescript
const rules = await pc.roles.getRules('editor');
```

这里返回的是规则数组，而且只包含该角色自身规则，不含继承链：

```json
[
	{
		"type": "allow",
		"action": "write",
		"resource": "db:articles"
	},
	{
		"type": "allow",
		"action": "read",
		"resource": "db:articles",
		"where": {
			"field": "authorId",
			"op": "eq",
			"valueFrom": "userId"
		}
	},
	{
		"type": "deny",
		"action": "read",
		"resource": "db:articles:internalNotes"
	}
]
```

### `getRoleChain()` 返回从当前角色到父角色的继承链

```typescript
const chain = await pc.roles.getRoleChain('editor');
```

返回结果结构如下：

```json
[
	{
		"id": "editor",
		"label": "编辑角色",
		"parent": "viewer",
		"ruleCount": 3
	},
	{
		"id": "viewer",
		"label": "只读角色",
		"parent": null,
		"ruleCount": 1
	}
]
```

### `getEffectiveRules()` 返回角色展开后的有效规则

```typescript
const effectiveRules = await pc.roles.getEffectiveRules('editor');
```

这里返回的是当前角色自身规则与父链规则合并后的去重结果，顺序按“当前角色 -> 父角色”展开：

```json
[
	{
		"type": "allow",
		"action": "write",
		"resource": "db:articles"
	},
	{
		"type": "allow",
		"action": "invoke",
		"resource": "GET:/api/articles"
	}
]
```

### `inspect()` 适合角色详情页或联调接口

```typescript
const inspection = await pc.roles.inspect('editor');
```

返回结果结构如下：

```json
{
	"role": {
		"id": "editor",
		"label": "编辑角色",
		"parent": "viewer"
	},
	"ownRules": [
		{
			"type": "allow",
			"action": "write",
			"resource": "db:articles"
		}
	],
	"effectiveRules": [
		{
			"type": "allow",
			"action": "write",
			"resource": "db:articles"
		},
		{
			"type": "allow",
			"action": "invoke",
			"resource": "GET:/api/articles"
		}
	],
	"roleChain": [
		{
			"id": "editor",
			"parent": "viewer",
			"ruleCount": 1
		},
		{
			"id": "viewer",
			"parent": null,
			"ruleCount": 1
		}
	]
}
```

## 更适合谁看

- 管理后台实现者
- 初始化脚本编写者
- 规则模型维护者

## 常见误区

- 以为 `getRules()` 会返回继承后的完整规则
- 角色详情页还在手动展开父链，而没有直接使用 `inspect()`
- 角色规则变化后只失效当前角色的直接用户缓存
- 在首版里按多继承去设计后台数据结构

如果你准备把角色和用户绑定做成后台页面，可继续看 [管理后台接入](/guide/site-preview-release)。

如果你接下来要看用户和角色怎么绑定，可继续看 [UserRoleManager](/api/user-roles)。
