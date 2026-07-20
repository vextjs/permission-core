# Bind APIs
<!-- docs:inline-parity `orders` `id='orders-export'` `code='orders.export'` `create()` `apiBindings.create()` `MutationResult<ApiBinding>` `method/path` `authorization` `mode='all'` `owners` `canonicalOwner` `create(input, options?)` `data.revision` `authorization.mode: 'all'` `'any'` `get('orders-export-start')` `get('orders-export-download')` `required: true` `apiRisks` `availabilityGroup` `availabilityMode: 'any'` `apiChoices.bindingIds` `any` `apiChoices.permissionsByBinding` `get` `list` `method` `path` `status` `purpose` `ownerId` `expectedRevision` `get(bindingId)` `VersionedResult<ApiBinding>` `current.data.revision` `list(query?)` `PageResult<ApiBinding>` `update(bindingId, patch, options)` `updated.data` `previewUpdate/executeUpdate` `previewUpdate` `executeUpdate` `buttonMap.data` `getButtonMap()` `detailBudget` `orders.export` `subject.menus.getButtonMap()` `subject.assert` `api:` -->

API bindings connect real backend endpoints to the menu, page, or button that owns them. They describe both the permission required by the endpoint and whether an unavailable endpoint should disable the UI owner.

## Binding Structure

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

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
## One Button Can Own Multiple APIs

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

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
## Read and Update Bindings

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

```ts
const current = await scoped.apiBindings.get('orders-export-api');
const updated = await scoped.apiBindings.update(
  'orders-export-api',
  { description: 'Starts an order export' },
  { expectedRevision: current.data.revision },
);
```
## Runtime Availability

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

```ts
const subject = pc.forSubject({
  userId: 'u-1',
  scope: { tenantId: 'acme', appId: 'admin' },
});
const buttonMap = await subject.menus.getButtonMap('orders');
const exportButton = buttonMap.data['orders.export'];
```
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
Continue with [Authorize Role Menus](/guide/role-menu-authorization).
