# vext Integration

## Scenario

Run the built-in adapter in a real `vextjs/testing` host and prove tenant-aware route metadata allows one request and denies another.

## Runnable source

The page uses the repository source directly. It creates the host with `createTestApp()`, installs `createVextPermissionPlugin()`, enables `tenantRequired`, and declares route `auth.permissions`:

```js file="<root>/../examples/vext-adapter/index.mjs"

```

```bash
npm run example:vext
```

## Expected result

The example authenticates before permission middleware, returns `200` for the allowed route, returns `403 AUTH_FORBIDDEN` for the denied route, and closes the plugin/core lifecycle it owns.

## Fits and does not fit

Use this for Vext native route `auth.permissions`, `any/all` groups, request `auth.can/assert`, and tenant-required routes. It does not move collection, row, or field authorization into route middleware and does not replace the authentication provider.
