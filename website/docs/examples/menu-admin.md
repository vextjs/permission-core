# Menu Administration

## Scenario

This example creates a directory, page, button, and API binding; grants the page workflow to a role; updates presentation state; projects a user's visible tree/button/route state; and exports a frontend manifest with audit evidence.

## Run

```bash
npm run example:menu-admin
```

The canonical source is `examples/menu-admin.mjs`, between `docs:menu-admin:start` and `docs:menu-admin:end`.

## Source walkthrough

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

The selection includes descendants, buttons, required APIs, and data templates. The grant creates four provenance-bearing rule sources; UI projection then evaluates those sources for the user.

## Expected output

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

## Production boundary

The example is a backend administration flow, not a frontend-only menu filter. Protect every management endpoint and every bound business API independently. Persist administrator identity/reason/request correlation and require preview tokens for high-impact changes.

## Related

See [Manage Menus](/guide/menu-management), [Bind APIs](/guide/api-bindings), and [Authorize Role Menus](/guide/role-menu-authorization).
