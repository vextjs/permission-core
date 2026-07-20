# Vext Plugin API
<!-- docs:inline-parity `permission-core/plugins/vext` `>=20.19.0` `match` `>=18.0.0` `monsqlize` `resolveMonSQLize` `app.monsqlize` `authPlugin` `authentication` `RouteOptions.permission` `false` `true` `any` `all` `PermissionVextPluginOptions` `resolveMonSQLize(app)` `databasePlugin` `req.auth` `core` `PermissionCoreOptions` `resolveSubject(auth, req)` `PermissionSubject` `validateRouteManifest(event)` `invoke` `GET:/orders/:id` `{ action, resource? }` `{ mode:'all', requirements }` `1..32` `{ mode:'any', requirements }` `req.auth.permission` `can/assert` `permissionPlugin(options?)` `app.permission` `VextPlugin` `PermissionCore` `hasPermissionContext(req)` `req` `boolean` `PermissionVextRequest` `requirePermissionContext(req)` `Promise<VextRequestPermissionApi>` `subject/can/assert` `toApiBindingInputs(manifest)` `ApiBindingCreateInput[]` `VextRoutePermissionManifest` `apiBindings.create/replace` `vext:<routeKey>` `entry` `appExtensions.permission` `app.permission: PermissionCore` `requirePermissionContext()` `subject` `can` `assert` `toApiBindingInputs()` `purpose: 'entry'` `VEXT_MONSQLIZE_REQUIRED` `VEXT_MONSQLIZE_INCOMPATIBLE` `VEXT_AUTH_REQUIRED` `VEXT_APP_EXTENSION_CONFLICT` `VEXT_AUTH_EXTENSION_CONFLICT` `VEXT_ROUTE_PERMISSION_INVALID` `VEXT_ROUTE_RESTART_REQUIRED` `20000` `8 MiB` `32` `validateRouteManifest` -->

The Vext plugin exports the runtime integration, request context helpers, route manifest conversion, and `app.permission` extension surface.

## Purpose and preconditions

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

## What Do You Want To Do

| Goal | Entry point |
|---|---|
| Register the Vext permission plugin | [`permissionPlugin(options?)`](#vext-permission-plugin) |
| Get request permission context inside a handler | [`requirePermissionContext(req)`](#vext-require-permission-context) |
| Perform a side-effect-free type check | [`hasPermissionContext(req)`](#vext-has-permission-context) |
| Convert a route manifest into API binding input | [`toApiBindingInputs(manifest)`](#vext-to-api-binding-inputs) |
| Understand route `permission` syntax | [`RouteOptions.permission`](#route-options-permission) |

## Signatures

The signatures below are the public contract. The code block is kept executable-looking so TypeScript users can compare argument order, option requirements, and raw return wrappers quickly.

```ts
permissionPlugin(options?: PermissionVextPluginOptions): VextPlugin
hasPermissionContext(req: VextRequest): req is PermissionVextRequest
requirePermissionContext(req: VextRequest): Promise<VextRequestPermissionApi>
toApiBindingInputs(manifest: VextRoutePermissionManifest): readonly ApiBindingCreateInput[]
appExtensions.permission: PermissionCore

interface PermissionVextPluginOptions {
  monsqlize?: MonSQLizeInstance;
  resolveMonSQLize?: (app) => MonSQLizeInstance | Promise<MonSQLizeInstance>;
  databasePlugin?: string;
  authPlugin?: string;
  core?: Omit<PermissionCoreOptions, 'monsqlize'>;
  resolveSubject?: (auth, req) => PermissionSubject | Promise<PermissionSubject>;
  validateRouteManifest?: (event) => void | Promise<void>;
}
```
## Parameter Objects

The table explains object fields that are easy to confuse at call sites. Required fields are validated before the method mutates persistent authorization state.

<!-- docs:params owner=PermissionVextPluginOptions locale=en -->
### `PermissionVextPluginOptions`
<!-- docs:params owner=VextRoutePermission locale=en -->
### `RouteOptions.permission`
## Export Details

These exports are the Vext integration surface. Use them from Vext plugins, route metadata conversion, and request handlers that need authorization context.

<span id="vext-permission-plugin"></span>
### `permissionPlugin(options?)`
<!-- docs:method name=permissionPlugin locale=en -->

- **Purpose**: Use `permissionPlugin` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="vext-has-permission-context"></span>
### `hasPermissionContext(req)`
<!-- docs:method name=hasPermissionContext locale=en -->

- **Purpose**: Use `hasPermissionContext` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="vext-require-permission-context"></span>
### `requirePermissionContext(req)`
<!-- docs:method name=requirePermissionContext locale=en -->

- **Purpose**: Use `requirePermissionContext` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="vext-to-api-binding-inputs"></span>
### `toApiBindingInputs(manifest)`
<!-- docs:method name=toApiBindingInputs locale=en -->

- **Purpose**: Use `toApiBindingInputs` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="vext-app-extensions"></span>
### `appExtensions.permission`
<!-- docs:method name=appExtensions.permission locale=en -->

- **Purpose**: Use `appExtensions.permission` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

## Responses and side effects

Side effects are scoped and revisioned. Writes record audit evidence and invalidate affected semantic cache keys; reads preserve bounded detail metadata so callers can tell whether diagnostics were complete.

```json
{
  "manifest": { "schemaVersion": 1, "digest": "...", "routes": 12 },
  "apiBindingCandidates": 9,
  "appExtension": "permission"
}
```
## Failures and limits

Failures close authorization instead of widening it. Important limits are enforced before state is committed, and stale previews or revisions must be refreshed rather than guessed.

## Example

The example keeps one narrow path per page. It shows the raw method family and a compact response shape, while the full runnable scenarios live in the examples section.

```ts
import { permissionPlugin } from 'permission-core/plugins/vext';

const plugin = permissionPlugin({
  monsqlize: msq,
  authPlugin: 'authentication',
  validateRouteManifest: ({ manifest, apiBindings }) => {
    routeContracts.store({ digest: manifest.digest, apiBindings });
  },
});
```
```json
{ "pluginName": "permission-core", "dependencies": ["authentication"] }
```
## Related

Continue with the linked guide or neighboring API page when you need workflow context rather than only signatures.

Continue with [Basic RBAC](/examples/basic).
