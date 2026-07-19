# Express Integration

## Scenario

Authorize one Express request with a shared runtime: authentication resolves `userId`, a route guard checks the matched route template, and the service remains responsible for data authorization.

## Runnable source

The repository's HTTP-only source proves the same core route contract:

```bash
npm run example:http
```

Use this guard shape in Express:

```typescript
async function requirePermission(req, res, next) {
  try {
    if (!req.user?.id) return res.status(401).json({ code: 'UNAUTHENTICATED' });
    await pc.assert(req.user.id, 'invoke', `${req.method}:${req.route.path}`);
    next();
  } catch (error) {
    if (error instanceof PermissionCoreError && error.code === 'PERMISSION_DENIED') {
      return res.status(403).json({ code: error.code });
    }
    next(error);
  }
}
```

## Expected result

`npm run example:http` prints `[http-only] ok`, allows `GET:/api/orders`, denies `DELETE:/api/orders`, and closes the runtime. In Express, missing identity becomes `401`, expected denial becomes `403`, and storage/lifecycle errors reach the application error handler.

## Fits and does not fit

Use this for Express-style route guards and stable template resources. It does not replace authentication or Service/DAO collection, row, and field checks. Call `pc.init()` once per application and `pc.close()` during graceful shutdown, not per request.
