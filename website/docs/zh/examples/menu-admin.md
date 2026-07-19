# 菜单管理

## 场景

该示例创建目录、页面、按钮和 API binding；将页面工作流授权给角色；更新展示状态；投影用户可见树/按钮/路由状态；并导出带审计证据的前端 manifest。

## 运行

```bash
npm run example:menu-admin
```

规范源码是 `examples/menu-admin.mjs` 中 `docs:menu-admin:start` 到 `docs:menu-admin:end` 的内容。

## 源码解读

```js
const preview = await scoped.roles.menuPermissions.preview(
  'order-operator',
  { operation: 'grant', selection },
);
if (!preview.executable) throw new Error('Grant is not executable');
const granted = await scoped.roles.menuPermissions.grant('order-operator', selection, {
  ...preview.expected,
  previewToken: preview.previewToken,
});

const visible = await subject.menus.getVisibleTree();
const buttons = await subject.menus.getButtonMap('orders');
```

Selection 包含后代节点、按钮、必需 API 和数据模板。Grant 创建 4 个携带来源的规则 source；随后 UI projection 针对用户判断这些来源。

## 预期输出

```json
{
  "example": "menu-admin",
  "ok": true,
  "created": {
    "nodes": ["operations", "orders", "orders-export"],
    "apiBinding": "orders-export-api"
  },
  "update": { "title": "Order management", "revision": 2 },
  "roleGrant": {
    "generatedSources": 4,
    "grantCount": 1,
    "sourceStatus": { "integrity": "valid", "availability": "active", "drift": "current" },
    "auditRecorded": true
  },
  "subjectRuntime": {
    "visibleNodeIds": ["operations", "orders"],
    "exportButton": { "visible": true, "enabled": true, "reason": "allowed" },
    "route": { "allowed": true, "reason": "allowed", "navigationReachable": true }
  },
  "manifest": { "schemaVersion": 2, "nodeCount": 3, "apiBindingCount": 1 }
}
```

## 生产边界

该示例是后端管理流程，不是只在前端过滤菜单。每个管理 endpoint 和绑定的业务 API 都要独立保护。保存管理员身份/reason/request 关联，并对高影响变更要求 preview token。

## 相关内容

参见[管理菜单](/zh/guide/menu-management)、[绑定接口](/zh/guide/api-bindings)和[角色菜单授权](/zh/guide/role-menu-authorization)。
