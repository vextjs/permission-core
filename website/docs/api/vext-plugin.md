# Vext Plugin API

## Purpose and preconditions

`permission-core/plugins/vext` is the optional integration entry for Vext 0.3.26. It initializes PermissionCore in the Vext lifecycle, installs route guards, maps domain errors to HTTP responses, and exposes request-scoped permission APIs plus response-field projection for protected routes.

Before using it:

- Node.js is `>=20.19.0`.
- The host provides a connected MonSQLize 3.1 instance.
- The authentication plugin runs first and writes trusted identity to `req.auth`.
- Response-field projection requires the matching `api:` resource and fields to be saved through `menus.responses.set()` or `menus.config.save()`.

## Signatures

```ts
permissionPlugin(options?: PermissionVextPluginOptions): VextPlugin
hasPermissionContext(req: VextRequest): req is PermissionVextRequest
requirePermissionContext(req: VextRequest): Promise<VextRequestPermissionApi>
req.auth.permission.filterResponse(apiResource: ApiResource, payload: unknown, context?: PolicyContext): Promise<SubjectRuntimeResult<unknown>>
appExtensions.permission: PermissionCore

interface PermissionVextPluginOptions {
  monsqlize?: MonSQLizeInstance;
  resolveMonSQLize?: (app) => MonSQLizeInstance | Promise<MonSQLizeInstance>;
  databasePlugin?: string;
  authPlugin?: string;
  core?: Omit<PermissionCoreOptions, 'monsqlize'>;
  resolveSubject?: (auth, req) => PermissionSubject | Promise<PermissionSubject>;
}
```

`permission: true` checks `invoke + api:METHOD:/path`, for example `api:GET:/orders/:id`. Protected routes with caching enabled fail closed unless route caching is explicitly disabled, preventing user-specific projections from becoming shared cached responses.

## Parameters

<!-- docs:params owner=PermissionVextPluginOptions locale=en -->

### `PermissionVextPluginOptions`

| Field | Required/default | Meaning |
|---|---|---|
| `monsqlize` | One of three sources | Direct host-owned MonSQLize 3.1 instance. The plugin borrows it and does not close the database. |
| `resolveMonSQLize(app)` | One of three sources | Resolve the instance from the Vext app during setup; mutually exclusive with `monsqlize`. |
| auto-discovered `app.monsqlize` | When both previous sources are absent | Reads an own app extension property and verifies MonSQLize 3.1 compatibility. |
| `databasePlugin` | Optional | Name of the Vext plugin that provides the database instance, used for plugin ordering. |
| `authPlugin` | Default `authentication` | Authentication plugin name; it must write trusted `req.auth` first. |
| `core` | Optional | `PermissionCoreOptions` except `monsqlize`, such as `collectionPrefix/cache/tokenSecret`. |
| `resolveSubject(auth, req)` | Strict default resolver | Converts auth state to `PermissionSubject`; must not trust client-reported identity. |

### `RouteOptions.permission`

| Value | Route meaning |
|---|---|
| omitted or `false` | Public route, no permission guard. |
| `true` | Requires `invoke + api:METHOD:/path`. |
| `{ action, resource? }` | One requirement; omitted `resource` uses the current route `api:` resource. |
| `{ mode: 'all', requirements }` | All `1..32` requirements must pass. |
| `{ mode: 'any', requirements }` | At least one of `1..32` requirements must pass. |

## Method details

<span id="vext-permission-plugin"></span>
### `permissionPlugin(options?)`

<!-- docs:method name=permissionPlugin locale=en -->

- **Purpose**: Create the permission plugin descriptor registered with Vext.
- **Parameters**: `options` are listed above; at most one database source may be provided, and authentication must run first.
- **State impact**: During Vext setup it creates and initializes core, installs request middleware, route hooks, error mapping, and exposes `app.permission`; during Vext close it closes PermissionCore.
- **Raw return**: Synchronously returns `VextPlugin`, not a setup result and not a `PermissionCore` instance.

<span id="vext-has-permission-context"></span>
### `hasPermissionContext(req)`

<!-- docs:method name=hasPermissionContext locale=en -->

- **Purpose**: Check whether the current request already has a permission context and narrow the TypeScript type.
- **Parameters**: Current Vext `req`.
- **State impact**: Checks the internal owner marker only; it does not lazily resolve the subject.
- **Raw return**: `boolean`; `true` narrows req to `PermissionVextRequest`.

<span id="vext-require-permission-context"></span>
### `requirePermissionContext(req)`

<!-- docs:method name=requirePermissionContext locale=en -->

- **Purpose**: Get the permission API for the current request.
- **Parameters**: Current Vext request that passed through the permission plugin middleware.
- **State impact**: Lazily resolves and freezes the subject for this request only; it does not write authorization data.
- **Raw return**: `Promise<VextRequestPermissionApi>` with `subject`, `can`, `assert`, and `filterResponse`.

<span id="vext-filter-response"></span>
### `req.auth.permission.filterResponse(apiResource, payload, context?)`

<!-- docs:method name=req.auth.permission.filterResponse locale=en -->

- **Purpose**: Project a response payload inside a Vext handler according to the current user's response-field grants.
- **Parameters**: `apiResource` is `api:METHOD:/path`; `payload` is the data about to be returned; `context` is optional.
- **State impact**: Read-only; it first checks whether the current subject can `invoke` the API.
- **Raw return**: `SubjectRuntimeResult<unknown>` with projected data in `data`.

<span id="vext-app-extensions"></span>
### `appExtensions.permission`

<!-- docs:method name=appExtensions.permission locale=en -->

- **Purpose**: Declare `app.permission: PermissionCore` for Vext's type system.
- **Parameters**: No runtime parameters.
- **State impact**: The actual app extension value is installed by plugin setup.
- **Raw return**: This is a type extension definition; application code reads core through `app.permission`.

## Responses and side effects

Plugin setup initializes PermissionCore, installs route guards, binds `req.auth.permission`, exposes `app.permission`, and registers close hooks. Routes protected by `permission: true` check `invoke + api:METHOD:/path` before the handler. If the handler uses `res.json()`, the plugin projects the response according to response-field config and sets `Cache-Control: private, no-store`.

```json
{
  "route": "GET /orders/:id",
  "resource": "api:GET:/orders/:id",
  "guard": "invoke",
  "responseProjection": true
}
```

## Failures and limits

Common errors include `VEXT_MONSQLIZE_REQUIRED`, `VEXT_MONSQLIZE_INCOMPATIBLE`, `VEXT_AUTH_REQUIRED`, `VEXT_APP_EXTENSION_CONFLICT`, `VEXT_AUTH_EXTENSION_CONFLICT`, `VEXT_ROUTE_PERMISSION_INVALID`, and `VEXT_ROUTE_RESTART_REQUIRED`. Route permission requirements are limited to `32`. Route changes after startup require a cold restart. Protected routes with caching enabled refuse startup unless route cache is explicitly disabled.

## Example

```ts
import { permissionPlugin, requirePermissionContext } from 'permission-core/plugins/vext';

export default permissionPlugin({
  monsqlize: msq,
  authPlugin: 'authentication',
  core: { collectionPrefix: 'permission_core' },
});

app.get('/orders/:id', { permission: true }, async (req, res) => {
  const permission = await requirePermissionContext(req);
  const payload = await loadOrder(req.params.id);
  const projected = await permission.filterResponse('api:GET:/orders/:id', payload);
  return res.json(projected.data);
});
```

```json
{ "pluginName": "permission-core", "resource": "api:GET:/orders/:id" }
```

## Related

See [Vext Plugin](/guide/vext-plugin), [Authentication Boundary](/guide/authentication-boundary), [Configure APIs and Response Fields API](/api/api-bindings), and the runnable [Vext example](/examples/vext).
