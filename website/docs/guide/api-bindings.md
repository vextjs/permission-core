# Bind APIs

An API binding connects a real backend endpoint to the menu, page, or button that uses it. It answers two separate questions: which permission requirements protect the endpoint, and whether failure to call it should disable its owner in the UI.

## Binding anatomy

```ts
const created = await scoped.apiBindings.create({
  id: 'orders-export-api',
  method: 'POST',
  path: '/api/orders/export',
  purpose: 'importExport',
  authorization: {
    mode: 'all',
    permissions: [
      { action: 'invoke', resource: 'api:POST:/api/orders/export' },
      { action: 'read', resource: 'db:orders' },
    ],
  },
  owners: [
    { type: 'button', id: 'orders-export', required: true },
  ],
  canonicalOwner: { type: 'button', id: 'orders-export' },
});
```

```json
{
  "changed": true,
  "data": {
    "id": "orders-export-api",
    "method": "POST",
    "path": "/api/orders/export",
    "purpose": "importExport",
    "revision": 1
  }
}
```

`authorization.mode: 'all'` requires every permission; `'any'` requires at least one. `canonicalOwner` identifies the primary documentation and administration owner but does not erase the other owner relations.

## One button with multiple APIs

Create one binding per real endpoint and point each relation at the same button. This preserves endpoint-level audit and permission semantics.

```ts
await scoped.apiBindings.create({
  id: 'orders-export-start',
  method: 'POST',
  path: '/api/orders/exports',
  purpose: 'operation',
  authorization: {
    mode: 'all',
    permissions: [{ action: 'invoke', resource: 'api:POST:/api/orders/exports' }],
  },
  owners: [{ type: 'button', id: 'orders-export', required: true }],
});
await scoped.apiBindings.create({
  id: 'orders-export-download',
  method: 'GET',
  path: '/api/orders/exports/:id',
  purpose: 'detail',
  authorization: {
    mode: 'all',
    permissions: [{ action: 'invoke', resource: 'api:GET:/api/orders/exports/:id' }],
  },
  owners: [{ type: 'button', id: 'orders-export', required: true }],
});
```

Each ungrouped `required: true` binding must be available or the button is disabled. Optional relations appear in `apiRisks` but do not disable the owner.

When several endpoints are alternatives, assign the same `availabilityGroup` and `availabilityMode: 'any'` to their required owner relations. Role authorization then requires an explicit `apiChoices.bindingIds` selection. For an API binding whose own authorization mode is `any`, `apiChoices.permissionsByBinding` selects at least one requirement. The preview returns unresolved choices instead of guessing.

## Read and update bindings

Use `get`, cursor-based `list`, and filters for `method`, `path`, `status`, `purpose`, or `ownerId`. A description or purpose-only update uses `expectedRevision`:

```ts
const current = await scoped.apiBindings.get('orders-export-api');
await scoped.apiBindings.update(
  'orders-export-api',
  { description: 'Starts an order export' },
  { expectedRevision: current.data.revision },
);
```

Changing method, path, authorization, owners, or canonical owner can invalidate role-generated sources. Use `previewUpdate` and `executeUpdate` with an explicit source rewrite decision. Status changes, removal, and complete replacement also have impact previews.

## Runtime availability

Subject menu projection evaluates each enabled binding's authorization requirements against the same subject. The owner receives bounded risk entries:

```json
{
  "orders.export": {
    "visible": true,
    "enabled": false,
    "reason": "api-unavailable",
    "apiRisks": {
      "items": [
        { "bindingId": "orders-export-api", "required": true, "allowed": false }
      ]
    }
  }
}
```

This state is an experience projection. The backend endpoint must independently enforce the same `api:` requirement through `subject.assert` or the Vext route guard.

Continue with [Role Menu Authorization](/guide/role-menu-authorization) to grant bindings through a menu selection, or use the exact [API Bindings reference](/api/api-bindings).
