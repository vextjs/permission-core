# Menu Administration

## Scenario

This example shows the complete backend menu path: save one `MenuConfigInput`, grant a role its page, API, action, and response-field permissions, then read user runtime menu state and project the API response.

## Run

```bash
npm run example:menu-admin
```

The canonical source is the `docs:menu-admin:start` to `docs:menu-admin:end` block in `examples/menu-admin.mjs`.

## First Check the Result

A successful run should include `roleGrant.generatedSources`, `roleGrant.auditRecorded`, `subjectRuntime.exportEnabled`, and `subjectRuntime.projectedResponse`. These values prove that role sources were generated, important writes were audited, the user can use the export action, and the API response was projected by field permissions.

## Source walkthrough

```js
const runtime = await startExampleCore("menu-admin");
const scope = { tenantId: "acme", appId: "admin" };
const scoped = runtime.core.scope(scope);

const configPreview = await scoped.menus.config.preview(menuConfig, { actorId: "admin" });
const savedConfig = await scoped.menus.config.save(menuConfig, {
  ...configPreview.expected,
  previewToken: configPreview.previewToken,
  actorId: "admin",
  idempotencyKey: "example-menu-config-save",
});

await scoped.roles.create({ id: "order-operator", label: "Order operator" });
const selection = {
  configId: "admin",
  views: ["orders-list"],
  responseFields: [{
    apiResource: "api:GET:/api/orders",
    fields: ["orderNo", "status"],
  }],
  include: { loads: true, actions: true, responseFields: "none" },
};
const grantPreview = await scoped.roles.menuPermissions.preview(
  "order-operator",
  { operation: "grant", selection },
  { actorId: "admin" },
);
const granted = await scoped.roles.menuPermissions.grant("order-operator", selection, {
  ...grantPreview.expected,
  previewToken: grantPreview.previewToken,
  actorId: "admin",
  idempotencyKey: "example-menu-role-grant",
});
await scoped.userRoles.assign("u-menu", "order-operator");

const subjectMenus = runtime.core.forSubject({ userId: "u-menu", scope }).menus;
const tree = await subjectMenus.getViewTree({ configId: "admin" });
const viewState = await subjectMenus.getViewState({ configId: "admin", viewId: "orders-list" });
const actions = await subjectMenus.getActionMap({ configId: "admin", viewId: "orders-list" });
const projected = await subjectMenus.filterResponse("api:GET:/api/orders", rawOrders);
const directGrant = await scoped.roles.menuPermissions.getDirect("order-operator");
```

The snippet omits the `menuConfig` and `rawOrders` definitions; the full file declares the `orders-list` page, the `api:GET:/api/orders` load API, the `export` action, and the response fields.

### 1. Preview and save the menu config

<!-- docs:operation id=menu-model calls=menus.config.preview,menus.config.save outputs=config -->

**Purpose and target.** `menus.config.preview` validates `menuConfig` before writing and shows which internal menu, API, and response-field assets will be produced. `menus.config.save` writes the same config with the returned `expected` vector and `previewToken`. This step produces `config`, showing that the config was saved and whether the internal manifest changed.

**State, arguments, and result.** `menuConfig.configId` is the key used later by role grants and runtime reads. `load.resource` uses `api:GET:/api/orders`, so no separate `action: 'invoke'` is needed. `response` declares the fields that can later be granted. The save call returns `MutationResult<MenuConfigSaveResult>`; `savedConfig.data.config` is the snapshot and `savedConfig.data.manifestOperations` summarizes internal synchronization.

**Failure and next step.** If preview is not executable, the config has conflicts, invalid resources, or would break existing grant sources. Show `conflicts`, fix the config, and preview again. Do not skip preview, and do not reuse an old token for changed input.

**API reference.** See [Menus API](/api/menus) for `MenuConfigInput`, preview/save signatures, response envelopes, and error boundaries.

### 2. Create the role identity used by the workflow

<!-- docs:operation id=menu-role calls=roles.create outputs=subjectRuntime -->

**Purpose and target.** `roles.create` creates the `order-operator` role that will receive the menu grant. The user role assignment happens after the grant is committed, making the example separate "the role exists" from "the user has permissions".

**State, arguments, and result.** `id` is the stable role ID and `label` is display text. Creating the role does not grant any menu, API, action, or response-field permission. Those abilities appear only after `menuPermissions.grant` succeeds. This step ultimately feeds `subjectRuntime`, because runtime projection depends on the role participating in effective permissions.

**Failure and next step.** If the role already exists, reuse it or start with a clean example database. If the role is missing, the later grant fails. Do not patch around this with manual `roles.allow`, because that loses menu provenance and response-field semantics.

**API reference.** See [Roles API](/api/roles) and [User Roles API](/api/user-roles) for role creation, user assignment, and response shapes.

### 3. Preview and commit the role-menu grant

<!-- docs:operation id=menu-grant calls=menuPermissions.preview,menuPermissions.grant,menuPermissions.getDirect outputs=roleGrant -->

**Purpose and target.** `menuPermissions.preview` expands `selection` into the page, load API, action, and response fields. `menuPermissions.grant` commits the allow grant using the preview. `menuPermissions.getDirect` reads the saved grant and response-field sources. This step produces `roleGrant`.

**State, arguments, and result.** `selection.configId` points at the `admin` config, `views` selects `orders-list`, `include.loads/actions` automatically includes the page load API and export action, and `responseFields` grants only `orderNo/status` for `api:GET:/api/orders`. The grant returns `generatedSources`, `generatedResponseFields`, and `grantIds`; the direct read returns `responseFields.total`.

**Failure and next step.** If a selected view, action, or field does not exist, preview rejects the input. If revisions or the token expire, grant execution fails. Refresh the config and role state, preview again, then submit the new token.

**API reference.** See [Role Menu Permissions API](/api/role-menu-permissions) for `MenuBusinessPermissionSelection`, `responseFields`, `selectedResponseFields`, and `generatedSources`.

### 4. Project the user's menu runtime and response

<!-- docs:operation id=menu-subject calls=forSubject,getViewTree,getViewState,getActionMap,filterResponse outputs=subjectRuntime -->

**Purpose and target.** `forSubject` binds the current user and scope. `getViewTree` returns visible navigation, `getViewState` checks page access, `getActionMap` checks action state, and `filterResponse` projects the API response by response-field permissions. This step produces `subjectRuntime`.

**State, arguments, and result.** After `userRoles.assign` gives `order-operator` to `u-menu`, the subject runtime can see the grant. `filterResponse("api:GET:/api/orders", rawOrders)` first checks invoke permission, then removes `internalCost` and other ungranted fields from `items` while preserving `total`.

**Failure and next step.** If the user lacks the role, the config ID is wrong, the view is not granted, or the API permission is missing, runtime fails closed. Do not rely on frontend hiding alone; business APIs still need `subject.assert` or the Vext plugin guard.

**API reference.** See [Core and Contexts API](/api/core-and-contexts), [Menus API](/api/menus), and [Role Menu Permissions API](/api/role-menu-permissions).

## Expected output

The following JSON is the **Example summary output** generated by `printExample()`. It combines selected fields from several API responses and is not the raw response of one method.

```json
{
  "example": "menu-admin",
  "ok": true,
  "config": {
    "id": "admin",
    "menuCount": 1,
    "manifestChanged": true
  },
  "roleGrant": {
    "generatedSources": 3,
    "generatedResponseFields": 2,
    "grantCount": 1,
    "responseFieldCount": 2,
    "auditRecorded": true
  },
  "subjectRuntime": {
    "viewTreeIds": ["orders"],
    "viewAllowed": true,
    "exportEnabled": true,
    "projectedResponse": {
      "items": [{ "orderNo": "O-1001", "status": "paid" }],
      "total": 1
    }
  }
}
```

<!-- docs:output group=config producer=menu-model -->

**`config` provenance.** `menus.config.save` returns the saved config snapshot and internal synchronization summary. The example prints only `configId`, menu count, and whether internal assets changed; the raw response still carries revision, auditId, and cache outcome.

<!-- docs:output group=roleGrant producer=menu-grant -->

**`roleGrant` provenance.** `menuPermissions.grant` provides `generatedSources`, `generatedResponseFields`, and audit evidence. `menuPermissions.getDirect` provides grant count and response-field count. Together they prove the role received menu-sourced grants rather than hand-built rules.

<!-- docs:output group=subjectRuntime producer=menu-subject -->

**`subjectRuntime` provenance.** `filterResponse` produces `projectedResponse`; `getViewTree`, `getViewState`, and `getActionMap` produce visible navigation, page state, and action state. This summary is the user runtime view, not the backend configuration inventory.

## Production boundary

This is a backend management flow, not frontend menu filtering. In production, saving menu configs, granting role-menu permissions, assigning user roles, and accessing business APIs should all be protected backend operations. Response-field projection belongs on the server before returning data, not only in the browser.

## Related

See [Manage Menus](/guide/menu-management), [Configure APIs and Response Fields](/guide/api-bindings), and [Authorize Role Menus](/guide/role-menu-authorization).
