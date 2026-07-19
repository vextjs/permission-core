# Vext Plugin API

## Purpose and preconditions

`permission-core/plugins/vext` is the optional Vext 0.3.26 integration subpath. Its host must run Node.js `>=20.19.0`, provide a host-owned MonSQLize 3.1 instance, and install an authentication plugin that supplies trusted request state before permission evaluation. The root and `match` entries keep their Node.js `>=18.0.0` contract.

## Signatures

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

`monsqlize` and `resolveMonSQLize` are mutually exclusive; otherwise the plugin discovers `app.monsqlize`. `authPlugin` defaults to `authentication`. `RouteOptions.permission` accepts `false`, `true`, one requirement, or an `any`/`all` requirement group.

## Responses and side effects

Plugin setup initializes a core, installs middleware/hooks, exposes `app.permission`, validates and commits the initial route manifest, enforces matched routes, maps domain errors, and closes the core with Vext. `requirePermissionContext()` lazily creates a request-owned API with `subject`, `can`, and `assert`. `toApiBindingInputs()` converts protected manifest entries into deterministic `purpose: 'entry'` binding inputs without writing them.

```json
{
  "manifest": { "schemaVersion": 1, "digest": "...", "routes": 12 },
  "apiBindingCandidates": 9,
  "appExtension": "permission"
}
```

## Failures and limits

The plugin may raise `VEXT_MONSQLIZE_REQUIRED`, `VEXT_MONSQLIZE_INCOMPATIBLE`, `VEXT_AUTH_REQUIRED`, `VEXT_APP_EXTENSION_CONFLICT`, `VEXT_AUTH_EXTENSION_CONFLICT`, `VEXT_ROUTE_PERMISSION_INVALID`, or `VEXT_ROUTE_RESTART_REQUIRED`. Limits include `20000` routes, `8 MiB` manifest, `32` requirements per route, and `32` cached policy contexts per request. Route changes after initial commit require a cold restart.

## Example

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

`validateRouteManifest` is a startup validation/observation hook. Persisting or reconciling binding candidates is a host-owned administrative decision, not an automatic plugin write.

## Related

See [Vext Plugin](/guide/vext-plugin), [Authentication Boundary](/guide/authentication-boundary), [API Bindings](/api/api-bindings), and the [Basic RBAC example](/examples/basic).
