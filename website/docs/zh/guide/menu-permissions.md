# 菜单权限

`permission-core/menu` 在核心 RBAC 之上提供后台管理系统常见的菜单、页面、按钮、接口绑定、授权树、manifest 导入、校验和审计能力。

它用于导航可见性和角色授权页面，不应替代后端接口鉴权。

```ts
import { PermissionCore } from "permission-core";
import { createMenuPermission } from "permission-core/menu";

const pc = new PermissionCore();
await pc.init();

const scope = { tenantId: "tenant-a", appId: "admin" };
const subject = { ...scope, userId: "u-1" };
const tenant = pc.scope(scope);
await tenant.roles.create("operator", { label: "操作员" });
await tenant.roles.allow("operator", "read", "ui:menu:system.user");
await tenant.roles.allow("operator", "read", "ui:page:system.user.list");
await tenant.roles.allow("operator", "invoke", "ui:button:system.user.create");
await tenant.roles.allow("operator", "invoke", "api:POST:/api/users");
await tenant.users.assign(subject.userId, "operator");

const menu = createMenuPermission({ core: pc, strictApiBindings: true });

await menu.importFrontendManifest(scope, {
  nodes: [
    { id: "system", type: "directory", title: "系统管理" },
    {
      id: "system.user",
      parentId: "system",
      type: "menu",
      title: "用户管理",
      path: "/system/users",
      resource: { action: "read", resource: "ui:menu:system.user" },
    },
    {
      id: "system.user.list",
      parentId: "system.user",
      type: "page",
      title: "用户列表",
      path: "/system/users",
      hidden: true,
      resource: { action: "read", resource: "ui:page:system.user.list" },
    },
    {
      id: "system.user.create",
      pageId: "system.user.list",
      type: "button",
      code: "create",
      title: "创建用户",
      resource: { action: "invoke", resource: "ui:button:system.user.create" },
    },
  ],
  apiBindings: [{
    id: "create-user",
    ownerType: "button",
    ownerId: "system.user.create",
    method: "POST",
    path: "/api/users",
    resource: "api:POST:/api/users",
    purpose: "operation",
    required: true,
  }],
});

const tree = await menu.getVisibleMenuTree(subject);
const buttons = await menu.getVisibleButtons(subject, "system.user.list");
console.log(tree[0]?.children?.[0]?.id); // system.user
console.log(buttons.create.visible, buttons.create.enabled); // true true

await menu.close();
await pc.close();
```

仓库内维护的完整版本可以直接运行：

```bash
npm run example:menu
```

推荐资源分层：

| 层级 | 资源 | 含义 |
|---|---|---|
| 菜单 | `ui:menu:system.user` | 导航入口是否显示 |
| 页面 | `ui:page:system.user.list` | 直接访问页面是否允许 |
| 按钮 | `ui:button:system.user.create` | 页面操作是否显示或可用 |
| 接口 | `api:POST:/api/users` | 后端最终鉴权 |

后端接口仍应执行 `assertSubject(subject, "invoke", "api:POST:/api/users")`。

## 生产存储

核心角色规则存储和菜单资产存储是两份独立契约，生产环境必须同时持久化。

```ts
import { PermissionCore, MonSQLizeStorageAdapter } from "permission-core";
import { MonSQLizeMenuStorageAdapter, createMenuPermission } from "permission-core/menu";

const core = new PermissionCore({ storage: new MonSQLizeStorageAdapter({ msq }) });
await core.init();
const menu = createMenuPermission({
  core,
  storage: new MonSQLizeMenuStorageAdapter({ msq }),
  strictApiBindings: true,
});
await menu.init();
```

单进程部署可以使用 `FileMenuStorageAdapter({ path })`。它保证同一进程内的原子文件替换，但不是分布式多写者存储。`MemoryMenuStorageAdapter` 只用于测试和短示例。

关闭时先执行 `menu.close()`，再执行 `core.close()`。只有某个 adapter 确实拥有 MonSQLize 连接时，才在该 adapter 上设置 `ownsConnection: true`，不能让多个 adapter 重复关闭同一连接。

## Manifest 与授权工作流

- `importFrontendManifest()` 和 `importApiManifest()` 默认使用 `mode: "replace"`，旧资产会删除，结果包含 inserted、updated、unchanged、deleted、revision 和稳定 ID 列表。
- 只有明确做局部导入时才使用 `mode: "merge"`。
- 管理端开放保存前先执行 `validate(scope)`；error 会阻断导入，warning 用于提示陈旧规则或角色、按钮、接口不一致。
- `getAuthorizationTree(scope, roleId)` 会返回 `sourceRoleIds`，前端可以解释权限来自当前角色还是父角色。
- `saveRoleAuthorization()` 会先校验资产、计算审计 diff；规则写入或审计追加失败时恢复旧规则。

## 失败恢复

| 现象 | 原因 | 恢复方式 |
|---|---|---|
| `ROLE_NOT_FOUND` | 示例跳过了角色创建 | 先创建角色，再执行 `allow()` 或绑定用户 |
| `Menu manifest validation failed: V-03` | 按钮引用的 page 不存在，或父节点缺失 | 一次导入完整的目录、菜单、页面、按钮关系 |
| 按钮可见但 disabled | strict 模式下 required API 未授权 | `any` 组至少授权一项，`all` 组授权全部项 |
| 导入提示已恢复旧状态 | 存储或审计持久化失败 | 修复存储后重试完整导入，不要手工补写部分资产 |

精确签名、错误和 storage contract 见 [Menu Module API](/zh/api/menu)。
