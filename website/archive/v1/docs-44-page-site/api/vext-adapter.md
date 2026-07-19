# vext Adapter API

The built-in Vext adapter attaches core checks to request auth, consumes native route permission metadata, and can own plugin lifecycle.

## Purpose and import

```typescript
import { createVextPermissionPlugin } from 'permission-core/adapters/vext';
```

Use the plugin for normal Vext applications. Lower-level middleware/provider factories are available for custom host composition.

## Construction and types

`VextPermissionAdapterOptions` requires `core` and accepts `menu`, `defaultScope`, `tenantRequired`, `resolveSubject`, `routeResource`, and `guardRoutePermissions`.

`VextPermissionPluginOptions` can instead supply `core`, `createCore`, or `coreOptions`, plus `init`, `closeOnAppClose`, `ownsCore`, and `ownsMenu`. Route requirements accept permissions and `mode: "any" | "all"`.

## Signature index

| Surface | Signature |
|---|---|
| Plugin | `createVextPermissionPlugin(options?)` |
| Middleware | `createVextPermissionMiddleware(options)`; `createVextPermissionMiddlewareFactory(options)` |
| Provider | `createVextPermissionAuthProvider(options)` |
| Subject/resource | `resolveVextPermissionSubject`; `resolveVextRouteResource`; `getHeader` |
| Manifest | `loadVextRouteManifest`; `normalizeVextRoutes` |

## Behavior and defaults

Plugin `init` and `closeOnAppClose` default to enabled. It owns a core it creates, but does not own an injected menu unless `ownsMenu:true`. `guardRoutePermissions` defaults to enabled; route group mode defaults to `any`.

Resource resolution order is custom resolver, route permission resource, `x-permission-resource`, then normalized method/path. Authentication should run before the adapter. `tenantRequired:true` requires tenant identity.

## Errors and limits

Missing authentication for a protected route becomes `401 AUTH_REQUIRED`; a denied group becomes `403 AUTH_FORBIDDEN`. Missing or ambiguous resources and invalid tenant subjects use core `INVALID_ARGUMENT`.

The adapter consumes Vext route metadata but does not issue tokens. If another guard owns the same metadata, disable one guard deliberately and test the resulting boundary. Connection ownership still belongs to the core/storage configuration.

## Minimal example

```typescript
const plugin = createVextPermissionPlugin({
  core: pc,
  init: false,
  tenantRequired: true,
});

await plugin.setup(app);
```

## Related

See [vext Adapter Guide](/guide/vext-adapter), [vext Example](/examples/vext), and [Error Codes](/api/errors).
