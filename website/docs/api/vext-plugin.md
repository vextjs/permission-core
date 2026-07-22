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
req.auth.permission.data?.collection<TDocument extends object, TCreate extends object = Omit<TDocument, '_id'>>(name: string): AuthorizedCollection<TDocument, TCreate>
req.monsqlize?.collection<TDocument extends object, TCreate extends object = Omit<TDocument, '_id'>>(name: string): AuthorizedCollection<TDocument, TCreate>
req.auth.permission.filterResponse(apiResource: ApiResource, payload: unknown, context?: PolicyContext): Promise<SubjectRuntimeResult<unknown>>
appExtensions.permission: PermissionCore

interface PermissionVextPluginOptions {
  monsqlize?: MonSQLizeInstance;
  resolveMonSQLize?: (app) => MonSQLizeInstance | Promise<MonSQLizeInstance>;
  databasePlugin?: string;
  authPlugin?: string;
  core?: Omit<PermissionCoreOptions, 'monsqlize'>;
  subject?: {
    resolve: (req: VextRequest) => PermissionSubject | Promise<PermissionSubject>;
  };
  data?: {
    exposeAs?: false | 'monsqlize';
    scopeFields: { tenantId: string; appId?: string; moduleId?: string; namespace?: string };
    collections?: Readonly<Record<string, {
      resource?: string;
      scopeFields?: { tenantId: string; appId?: string; moduleId?: string; namespace?: string };
    }>>;
  };
  /** @deprecated Use subject.resolve(req). */
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
| `subject.resolve(req)` | Strict default resolver | Converts the current Vext request into `PermissionSubject`; use it when the host auth shape is not one of the defaults. |
| `resolveSubject(auth, req)` | Deprecated | Legacy subject resolver; mutually exclusive with `subject.resolve(req)`. |
| `data.scopeFields` | Required when `data` is enabled | Maps subject scope into business document fields; `tenantId` is required and paths must not overlap. |
| `data.collections` | Optional | Configures logical resources or per-collection scope mappings for physical collection names; up to `128` overrides. |
| `data.exposeAs` | Optional | Use `'monsqlize'` to expose `req.monsqlize`; use `false` or omit it to access only through `req.auth.permission.data`. |

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
- **Raw return**: `Promise<VextRequestPermissionApi>` with `subject`, `can`, `assert`, optional `data`, and `filterResponse`.

<span id="vext-request-data-collection"></span>
### `req.auth.permission.data.collection(name)`

<!-- docs:method name=req.auth.permission.data.collection locale=en -->

- **Purpose**: Create a guarded collection facade inside the current Vext request for authorized reads, writes, counts, or pagination.
- **Parameters**: `name` is the host MonSQLize collection name; resource and scope fields come from `data.collections[name]` or the default `db:${name}` plus `data.scopeFields`.
- **State impact**: Creating the facade does not access the database; every `find/insert/update/delete` call re-checks the current request owner, subject, scope, row rules, and field permissions.
- **Raw return**: `AuthorizedCollection<TDocument, TCreate>`; it is not a full MonSQLize collection and does not expose `raw()`.

When `data.exposeAs: 'monsqlize'` is configured, `req.monsqlize.collection(name)` is the same request data facade as a friendly alias. Do not cache it across requests.

`req.monsqlize` is optional in the public type because the alias only exists when `data.exposeAs: 'monsqlize'` is configured. In TypeScript handlers, call `requirePermissionContext(req)` when you want a narrowed permission object and use `req.monsqlize ?? permission.data` to support both the friendly alias and the canonical data entry.

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

Plugin setup initializes PermissionCore, installs route guards, binds `req.auth.permission`, optionally binds `req.monsqlize`, exposes `app.permission`, and registers close hooks. Routes protected by `permission: true` check `invoke + api:METHOD:/path` before the handler. If the handler uses `res.json()`, the plugin projects the response according to response-field config and sets `Cache-Control: private, no-store`.

```json
{
  "route": "GET /orders/:id",
  "resource": "api:GET:/orders/:id",
  "guard": "invoke",
  "requestDataFacade": "req.auth.permission.data",
  "responseProjection": true
}
```

## Failures and limits

Common errors include `VEXT_MONSQLIZE_REQUIRED`, `VEXT_MONSQLIZE_INCOMPATIBLE`, `VEXT_AUTH_REQUIRED`, `VEXT_APP_EXTENSION_CONFLICT`, `VEXT_AUTH_EXTENSION_CONFLICT`, `VEXT_ROUTE_PERMISSION_INVALID`, and `VEXT_ROUTE_RESTART_REQUIRED`. Missing `data.scopeFields.tenantId`, invalid `data.exposeAs`, too many collection overrides, or an occupied `req.monsqlize` alias fail closed during startup. Route permission requirements are limited to `32`. Route changes after startup require a cold restart. Protected routes with caching enabled refuse startup unless route cache is explicitly disabled.

## Example

```ts
import { permissionPlugin, requirePermissionContext } from 'permission-core/plugins/vext';

export default permissionPlugin({
  monsqlize: msq,
  authPlugin: 'authentication',
  core: { collectionPrefix: 'permission_core' },
  data: {
    exposeAs: 'monsqlize',
    scopeFields: { tenantId: 'tenantId' },
    collections: {
      orders: { resource: 'db:orders' },
    },
  },
});

app.get('/orders', { permission: true }, async (req, res) => {
  const permission = await requirePermissionContext(req);
  const data = req.monsqlize ?? permission.data;

  if (!data) {
    throw new Error('Vext permission data facade is not enabled');
  }

  const items = await data.collection('orders').find(
    { status: 'paid' },
    { projection: ['orderNo', 'status', 'amount'], limit: 20 },
  );
  return res.json({ items, total: items.length });
});
```

```json
{ "pluginName": "permission-core", "resource": "api:GET:/orders", "dataResource": "db:orders" }
```

## Related

See [Vext Plugin](/guide/vext-plugin), [Authentication Boundary](/guide/authentication-boundary), [Authorized Collection API](/api/authorized-collection), [Configure APIs and Response Fields API](/api/api-bindings), and the runnable [Vext example](/examples/vext).
