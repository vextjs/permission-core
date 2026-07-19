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

这是第二次 `menus.create()` 原始 `MutationResult<MenuNode>` 的节选；完整响应还含 `revisions/operationId/replayed/cache/warnings/detailBudget`。第一次创建 root 也会独立返回同结构响应。

| 调用 | 参数说明 | 状态变化与下一步 |
|---|---|---|
| [`pc.scope(scope)`](/zh/api/core-and-contexts#core-scope) | 可信 `tenantId`，本例还带 `appId` | 同步创建管理 facade，不写数据库。 |
| [`menus.create(input, options?)`](/zh/api/menus#menus-create) | `directory` 只需 id/type/title；`page` 还需 parentId/path/name/component/permission | 每次创建一个节点并返回其 revision；不会自动创建 API binding 或角色授权。 |

管理页面可使用 `get(nodeId)`、游标式 `list(filter)` 或 `getTree({ rootId?, includeHidden? })`。这些方法返回包含停用和隐藏节点的管理状态，与 subject 运行时投影有意不同。

| 读取方法 | 参数 | 原始返回 | 适合界面 |
|---|---|---|---|
| [`get(nodeId)`](/zh/api/menus#menus-get) | 节点 ID | `VersionedResult<MenuNode>` | 编辑单节点、取得 expectedRevision |
| [`list(query?)`](/zh/api/menus#menus-list) | `parentId/type/status/hidden/search/first/after` | `PageResult<MenuNode>` | 可筛选的管理列表 |
| [`getTree(options?)`](/zh/api/menus#menus-get-tree) | 可选 rootId/includeHidden | `VersionedResult<MenuTreeNode[]>` | 管理端完整嵌套树 |
| [`subject.menus.getVisibleTree(options?)`](/zh/api/menus#subject-menus-get-visible-tree) | subject 已绑定身份 | `SubjectRuntimeResult<VisibleMenuTreeNode[]>` | 当前用户导航；不可用于编辑库存 |

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

`get()` 的 `data.revision` 是单节点并发基线；`update()` 只接受 title/component/icon/hidden/i18nKey/meta 等非授权字段，返回更新后的原始 mutation envelope。`updated.data.revision` 可作为下一次简单更新的基线。

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

`previewMove(input)` 只生成 `ImpactPreview<MenuMovePlan>`；它的 `executable`、`conflicts`、`expected` 和 `previewToken` 决定能否执行。`move(input, options)` 的 input 必须与预览完全相同，执行后返回移动后的 `MutationResult<MenuNode>`。

出现 `REVISION_CONFLICT` 或 `PREVIEW_STALE` 时，管理界面必须重新加载当前状态，不能用旧预览操作已经变化的层级。

## 安全移除

先读取影响，再预览准确的级联决定：

```ts
const impact = await scoped.menus.getRemovalImpact('orders');
const preview = await scoped.menus.previewRemove('orders', {
  cascade: true,
});
if (!preview.executable) throw new Error('Resolve dependencies first');
const removed = await scoped.menus.remove(
  'orders',
  { cascade: true },
  { ...preview.expected, previewToken: preview.previewToken },
);
```

影响结果会列出后代、接口绑定和角色来源。依赖或来源重写未解决时不能移除。`cascade: true` 会原子删除后代，但不会静默拆除无关角色规则。

| 方法 | 原始返回 | 是否写入 |
|---|---|---|
| [`getRemovalImpact(nodeId)`](/zh/api/menus#menus-get-removal-impact) | `VersionedResult<MenuRemovalImpact>` | 否；快速清点依赖，不产生 token |
| [`previewRemove(nodeId, input)`](/zh/api/menus#menus-preview-remove) | `ImpactPreview<MenuRemovalPlan>` | 否；展开 nodes、detachedApiBindings、sourceImpacts |
| [`remove(nodeId, input, options)`](/zh/api/menus#menus-remove) | `MutationResult<BatchMutationSummary>` | 是；只有匹配预览才执行 |

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

| 方法 | 输入/输出 | 关键边界 |
|---|---|---|
| [`manifest.preview(manifest)`](/zh/api/menus#menus-manifest-preview) | 返回 node/binding 增删改及来源影响计划 | `replace` 会把未声明库存列为删除，必须先审查 |
| [`manifest.import(manifest, options)`](/zh/api/menus#menus-manifest-import) | 返回 `MutationResult<BatchMutationSummary>` | manifest 和 token 必须来自同一次可执行预览 |
| [`manifest.export()`](/zh/api/menus#menus-manifest-export) | 返回 `VersionedResult<FrontendMenuManifest>` | `exported.data` 才是 schemaVersion/nodes/apiBindings；大清单用 exportPage |

`merge` 修改已声明 ID 并保留其他项；`replace` 让 manifest 成为该 scope 的权威清单。两种模式都有修订、审计、容量边界和来源完整性检查。

下一步在[接口绑定](/zh/guide/api-bindings)挂接真实接口，再通过[角色菜单授权](/zh/guide/role-menu-authorization)给角色分配结构。
