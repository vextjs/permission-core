# vext Adapter API

Import from `permission-core/adapters/vext`. The subpath has no runtime import of `vextjs`; Vext is an optional peer used by host applications.

## Plugin

```ts
createVextPermissionPlugin(options?: VextPermissionPluginOptions): VextPlugin
```

| Option | Type | Default / behavior |
|---|---|---|
| `core` | `PermissionCore` | External core; plugin does not own it by default |
| `createCore` | `() => PermissionCore \| Promise<PermissionCore>` | Factory used when `core` is absent |
| `coreOptions` | `PermissionCoreOptions` | Used by the default internal core factory |
| `menu` | `MenuPermissionManagerLike` | Exposed as `app.permissionMenu` |
| `init` | `boolean` | `true`; initialize the selected core |
| `ownsCore` | `boolean` | Defaults to true only for an internally created core |
| `ownsMenu` | `boolean` | `false`; when true, initialize and close menu |
| `closeOnAppClose` | `boolean` | `true`; registers close only for owned resources |
| `tenantRequired` | `boolean` | `false`; when true, request must carry an explicit tenant |
| `defaultScope` | `PermissionScope` | Fallback only when allowed by `tenantRequired` |
| `guardRoutePermissions` | `boolean` | `true`; evaluate route `auth.permissions` before handler |
| `resolveSubject` | callback | Replace default request identity/scope resolution |
| `routeResource` | callback | Explicit custom route-resource mapper |

The plugin exposes `permissionCore`, optionally `permissionMenu`, attaches `req.auth.can/assert`, and registers lifecycle hooks according to ownership.

## Middleware and provider

```ts
createVextPermissionMiddleware(options): VextPermissionMiddleware
createVextPermissionMiddlewareFactory(options): () => VextPermissionMiddleware
createVextPermissionAuthProvider(options): {
  can(req, action, resource?, context?): Promise<boolean>;
  assert(req, action, resource?, context?): Promise<void>;
}
```

Authentication must populate `req.auth.isAuthenticated`, `userId` or `subject`, roles/scopes, and claims before this middleware. The route guard evaluates permission arrays with `mode: "any" | "all"`. Denial uses Vext `app.throw` and returns `401 AUTH_REQUIRED` or `403 AUTH_FORBIDDEN`.

Set `guardRoutePermissions:false` only when another proven guard consumes the same route metadata.

## Subject and resource helpers

```ts
resolveVextPermissionSubject(options, req, context?): Promise<PermissionSubject>
resolveVextRouteResource(options, req, action, context?): Promise<string | undefined>
```

Identity or scope sources that provide different non-empty values fail with `INVALID_ARGUMENT`. Case-insensitive duplicate headers and string-array headers are compared rather than accepted by precedence.

Resource resolution is: explicit call resource, custom mapper, matching route auth metadata, docs extension, generated method + matched route path. Multiple route resources for one action fail closed.

## Route manifest

```ts
loadVextRouteManifest(filePath): Promise<VextRouteManifestPayload>
normalizeVextRoutes(payload): ApiManifest
```

Each visible route becomes one or more `ApiBinding` records. Permission objects preserve action and string resource. Multiple permissions receive deterministic IDs plus `permissionGroup/permissionMode`; function resources fall back to the generated route resource because functions cannot be serialized in JSON.

`VextRouteManifestPayload.routes[]` supports method, path, operationId, docsSummary, tags, hidden, and `auth` or `options.auth`. A source manifest that omits auth cannot prove that a route is protected.

## Structural host types

The adapter exports `VextPermissionRequest`, `VextPermissionAuthContext`, `VextPermissionRequirement`, `VextRouteAuthRequirement`, middleware types, adapter options, and plugin options. These types intentionally describe the adapter boundary so the runtime bundle stays independent of the optional peer.

## Errors

| Error | Meaning |
|---|---|
| `AUTH_REQUIRED` | Route requires an authenticated request |
| `AUTH_FORBIDDEN` | Permission group evaluated to false |
| `INVALID_ARGUMENT` | Missing identity/tenant, conflicting sources, ambiguous route resources |
| `PERMISSION_DENIED` | Direct `req.auth.assert` or core assertion failed |
| `NOT_INITIALIZED` | Supplied core was not initialized when `init:false` was used incorrectly |

See the [vext adapter guide](/guide/vext-adapter) for middleware order, real-host setup, version caveats, and recovery steps.
