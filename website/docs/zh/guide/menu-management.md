# 管理菜单

菜单管理保存由后端负责的导航模型。节点本身不是一条权限：它携带权限要求、可选数据模板、层级元数据和修订状态；角色授权是下一项独立任务。

## 节点类型

| 类型 | 用途 | 必填字段 |
|---|---|---|
| `directory` | 结构化导航分组 | `id`、`title` |
| `menu` | 没有组件的可导航菜单 | `path`、`name`、`permission` |
| `page` | 可导航应用页面 | `path`、`name`、`component`、`permission` |
| `button` | 菜单或页面中的操作 | `code`、`permission` |
| `external` | 外部 URL 入口 | `url`、`permission` |
| `iframe` | 带内部路由的嵌入 URL | `url`、`path`、`name`、`permission` |

按钮不会作为导航节点出现在树中，而是由 subject 按所属页面或菜单返回按钮状态表。

## 创建并读取节点

```ts
const scoped = pc.scope({ tenantId: 'acme', appId: 'admin' });

const root = await scoped.menus.create({
  id: 'operations',
  type: 'directory',
  title: 'Operations',
});
const page = await scoped.menus.create({
  id: 'orders',
  parentId: 'operations',
  type: 'page',
  title: 'Orders',
  path: '/orders',
  name: 'orders',
  component: 'OrdersPage',
  permission: { action: 'read', resource: 'ui:page:orders' },
  dataPermissions: [
    { action: 'read', resource: 'db:orders', label: 'Read orders' },
  ],
});
```

```json
{
  "committed": true,
  "changed": true,
  "data": {
    "id": "orders",
    "parentId": "operations",
    "type": "page",
    "revision": 1
  },
  "revision": 2,
  "auditId": "..."
}
```

管理页面可使用 `get(nodeId)`、游标式 `list(filter)` 或 `getTree({ rootId?, includeHidden? })`。这些方法返回包含停用和隐藏节点的管理状态，与 subject 运行时投影有意不同。

## 更新元数据与结构

简单元数据变更使用实体修订：

```ts
const current = await scoped.menus.get('orders');
const updated = await scoped.menus.update(
  'orders',
  { title: 'Order management', icon: 'shopping-cart' },
  { expectedRevision: current.data.revision },
);
```

路径、权限、数据模板等带来源字段的修改，必须先 `previewUpdate` 再 `executeUpdate`。预览会列出必须替换或撤销的全部角色来源。移动、排序、状态变更和删除在影响后代或角色授权时也采用相同 preview/execute 模式。

```ts
const preview = await scoped.menus.previewMove({
  nodeId: 'orders',
  parentId: null,
});
if (!preview.executable) throw new Error('Resolve conflicts first');
await scoped.menus.move(
  { nodeId: 'orders', parentId: null },
  { ...preview.expected, previewToken: preview.previewToken },
);
```

出现 `REVISION_CONFLICT` 或 `PREVIEW_STALE` 时，管理界面必须重新加载当前状态，不能用旧预览操作已经变化的层级。

## 安全移除

先读取影响，再预览准确的级联决定：

```ts
const impact = await scoped.menus.getRemovalImpact('orders');
const preview = await scoped.menus.previewRemove('orders', {
  cascade: true,
});
```

影响结果会列出后代、接口绑定和角色来源。依赖或来源重写未解决时不能移除。`cascade: true` 会原子删除后代，但不会静默拆除无关角色规则。

## 导入和导出 manifest

`nodes` 是完整菜单节点声明的有序列表；`apiBindings` 是后端接口及其 owner 的有序列表。两者放在版本 2 manifest 中，使前端路由声明与后端授权清单可以作为一个整体审查。

```ts
const manifest = {
  schemaVersion: 2,
  mode: 'replace',
  nodes: [
    { id: 'operations', type: 'directory', title: 'Operations', order: 0 },
    {
      id: 'orders', parentId: 'operations', type: 'page', title: 'Orders',
      path: '/orders', name: 'orders', component: 'OrdersPage', order: 0,
      permission: { action: 'read', resource: 'ui:page:orders' },
    },
  ],
  apiBindings: [],
};
const preview = await scoped.menus.manifest.preview(manifest);
if (preview.executable) {
  await scoped.menus.manifest.import(manifest, {
    ...preview.expected,
    previewToken: preview.previewToken,
  });
}
const exported = await scoped.menus.manifest.export();
```

`merge` 修改已声明 ID 并保留其他项；`replace` 让 manifest 成为该 scope 的权威清单。两种模式都有修订、审计、容量边界和来源完整性检查。

下一步在[接口绑定](/zh/guide/api-bindings)挂接真实接口，再通过[角色菜单授权](/zh/guide/role-menu-authorization)给角色分配结构。
