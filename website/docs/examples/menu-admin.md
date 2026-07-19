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

### 1. Create the menu and API ownership model

<!-- docs:operation id=menu-model calls=menus.create,apiBindings.create outputs=created -->

**Purpose and target.** Three `menus.create` calls persist a directory, page, and button. `apiBindings.create` then binds the export endpoint to its owning button and declares the API permission that must also pass.

**State, arguments, and result.** Parent IDs build the tree; page/button permission descriptors define UI resources; the API binding records method, path, authorization mode, required owner, and canonical owner. Their committed IDs produce `created` and each mutation carries audit evidence.

**Failure and next step.** Invalid hierarchy, duplicate IDs, malformed resources, or a missing/invalid owner rejects the affected mutation. Fix the backend model first; do not compensate with a frontend-only menu item or an unbound route.

**API reference.** See [Menus](/api/menus) and [API Bindings](/api/api-bindings) for inputs, ownership, mutation results, and errors.

### 2. Create the role identity used by the workflow

<!-- docs:operation id=menu-role calls=roles.create,userRoles.assign outputs=subjectRuntime -->

**Purpose and target.** `roles.create` creates `order-operator` in the admin application scope, and `userRoles.assign` adds it to `u-menu` before any runtime projection is requested.

**State, arguments, and result.** This step establishes who can receive the later menu grant; it does not itself authorize the page, button, API, or data template. Those capabilities are generated only after the reviewed grant succeeds.

**Failure and next step.** A missing role or failed assignment leaves the subject without the workflow. Repair the scoped role/binding and verify direct roles before investigating frontend visibility.

**API reference.** See [Roles](/api/roles) and [User Roles](/api/user-roles).

### 3. Preview and commit the role-menu grant

<!-- docs:operation id=menu-grant calls=menuPermissions.preview,menuPermissions.grant,menuPermissions.getDirect outputs=roleGrant -->

**Purpose and target.** `menuPermissions.preview` expands the selected page into descendants, buttons, required APIs, and data permissions. `menuPermissions.grant` commits that exact plan with its expected revisions and preview token; `menuPermissions.getDirect` reads the durable grant and source status.

**State, arguments, and result.** The selection starts from `orders`; include flags control expansion, while `apiChoices` resolves optional choices. A successful commit generates four provenance-bearing rule sources and one direct grant, which form `roleGrant`.

**Failure and next step.** Conflicts make the preview non-executable; stale revisions or a stale/changed token reject commit. Show conflicts to the administrator, refresh the preview, review the new plan, then commit that new token rather than bypassing preview.

**API reference.** See [Role Menu Permissions](/api/role-menu-permissions) for selection expansion, previews, tokens, grants, and source integrity.

### 4. Update presentation state with a revision

<!-- docs:operation id=menu-update calls=menus.update outputs=update -->

**Purpose and target.** `menus.update` targets `orders` and changes the page title to `Order management` without changing its permission identity or route.

**State, arguments, and result.** The call uses the page's current `revision` as `expectedRevision`; the committed response supplies the new title and revision `2` recorded in `update`.

**Failure and next step.** A concurrent menu edit makes the revision stale and rejects the update. Re-read the node, merge the administrator's intended presentation change, and retry with the new revision.

**API reference.** See [Menus](/api/menus) for mutable fields, revision options, and update results.

### 5. Project the user's visible runtime state

<!-- docs:operation id=menu-subject calls=forSubject,getVisibleTree,getButtonMap,getRouteState outputs=subjectRuntime -->

**Purpose and target.** `forSubject` creates the request-time user context; `getVisibleTree`, `getButtonMap` for `orders`, and `getRouteState` for `/orders` derive navigation, button, and route state from the same effective authorization sources.

**State, arguments, and result.** The visible tree includes the directory/page but not the button as a navigation node. The button map reports its UI decision plus required API risk, and route state reports authorization and navigation reachability. These values produce `subjectRuntime`.

**Failure and next step.** Missing identity, stale/integrity-invalid generated sources, unavailable bindings, or denied API requirements fail closed. Diagnose the reason/risk fields and repair backend grants or bindings; never enable a button solely because it exists in the manifest.

**API reference.** See [Core and Contexts](/api/core-and-contexts), [Menus](/api/menus), and [Role Menu Permissions](/api/role-menu-permissions).

### 6. Export the frontend manifest

<!-- docs:operation id=menu-manifest calls=menus.manifest.export outputs=manifest -->

**Purpose and target.** `menus.manifest.export` emits the versioned menu/API definition that a frontend can consume as structure; it does not pre-authorize a user.

**State, arguments, and result.** The exported `schemaVersion`, three nodes, and one API binding produce `manifest`. Per-user visibility still comes from the subject projection in the previous step.

**Failure and next step.** Export can fail when persisted menu/binding state is invalid or unavailable. Repair the backend model and regenerate the manifest; do not cache a malformed or stale structure indefinitely.

**API reference.** See [Menus](/api/menus) for manifest export and [API Bindings](/api/api-bindings) for the embedded binding contract.

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
    "exportButton": {
      "visible": true,
      "enabled": true,
      "reason": "allowed",
      "action": "invoke",
      "resource": "ui:button:orders.export",
      "apiRisks": {
        "total": 1,
        "items": [
          {
            "bindingId": "orders-export-api",
            "required": true,
            "allowed": true
          }
        ],
        "truncated": false,
        "digest": "tLtCyOJN4gP1FKjpuujpqJC7WfPZPYQkWlncDHSbiMY"
      }
    },
    "route": { "allowed": true, "reason": "allowed", "navigationReachable": true }
  },
  "manifest": { "schemaVersion": 2, "nodeCount": 3, "apiBindingCount": 1 }
}
```

<!-- docs:output group=created producer=menu-model -->

**`created` provenance.** Three `menus.create` responses and the `apiBindings.create` response supply the committed IDs; this is the durable backend model that later grants reference.

<!-- docs:output group=update producer=menu-update -->

**`update` provenance.** The revision-checked `menus.update` response supplies the new title and revision, proving the presentation change was committed rather than edited only in the output object.

<!-- docs:output group=roleGrant producer=menu-grant -->

**`roleGrant` provenance.** `menuPermissions.grant` supplies `generatedSources`; `menuPermissions.getDirect` supplies grant count and source status. `auditRecorded` checks that all six management mutations returned non-empty audit IDs.

<!-- docs:output group=subjectRuntime producer=menu-subject -->

**`subjectRuntime` provenance.** `getVisibleTree`, `getButtonMap`, and `getRouteState` responses are read independently. The nested API risk proves button enablement includes its required backend binding, not only the UI permission.

<!-- docs:output group=manifest producer=menu-manifest -->

**`manifest` provenance.** `menus.manifest.export` supplies its schema version and complete node/binding arrays; the example reports their counts so consumers can verify the expected structure.

## Production boundary

The example is a backend administration flow, not a frontend-only menu filter. Protect every management endpoint and every bound business API independently. Persist administrator identity/reason/request correlation and require preview tokens for high-impact changes.

## Related

See [Manage Menus](/guide/menu-management), [Bind APIs](/guide/api-bindings), and [Authorize Role Menus](/guide/role-menu-authorization).
