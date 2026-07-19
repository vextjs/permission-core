# Resources and Rules

A permission rule has an `effect`, an action pattern, a resource pattern, and an optional durable row condition. A request is allowed only when an active allow matches and no applicable deny wins.

## Built-in resource schemes

| Kind | Concrete resource | Rule patterns | Use |
|---|---|---|---|
| HTTP route | `GET:/orders/:id` | `GET:/orders/:id`, `GET:/orders/*`, `*:/orders/*` | Framework-neutral matched routes |
| API | `api:POST:/api/orders/export` | `api:POST:/api/orders/*` | Backend APIs owned by menus or buttons |
| Data collection | `db:orders` | `db:orders`, `db:*` | Collection-level data operations |
| Data field | `db:orders:field:profile.name` | exact, `profile.*`, or `*` field pattern | Field reads and writes |
| UI | `ui:page:orders` | `ui:page:*`, `ui:*` | Menus, pages, buttons, and custom UI categories |
| Global | not valid as a concrete request | `*` | Deliberate rule-side global pattern |

HTTP and API resources use normalized route templates without query strings or fragments. A trailing `*` consumes one or more remaining path segments; it is not a substring wildcard. Parameters such as `:id` match one segment.

## Actions

Built-in request actions are `invoke`, `read`, `create`, `update`, `delete`, `write`, `manage`, plus application-defined strings. Rule-side `*` matches every action. Rule-side `write` matches `create` and `update`; it is not a magic alias for read or delete.

```ts
await scoped.roles.allow('order-writer', {
  action: 'write',
  resource: 'db:orders',
});
```

This allows concrete `create` and `update` checks on `db:orders`. Prefer explicit actions in high-risk rules when administrators need to review them separately.

## Allow, deny, and default deny

```ts
await scoped.roles.allow('order-reader', {
  action: 'read',
  resource: 'db:orders',
});
await scoped.roles.deny('order-reader', {
  action: 'read',
  resource: 'db:orders:field:secret',
});
```

Rules from direct roles and inherited roles are combined. Any applicable deny takes precedence over matching allows. If no allow matches, the result is `no-allow`; this is default deny and does not require a stored deny rule.

Duplicate semantic rules share one canonical rule with bounded source provenance. Manual grants and menu-generated grants can contribute the same meaning without losing their origin.

## Conditional rules

`where` stores a serializable row-condition AST. `all`, `any`, and `not` compose leaf comparisons; `valueFrom` reads trusted subject, claims, or explicit context. A condition affects row authorization and can also make a general `can` result unknown when no concrete row/context is available.

```ts
await scoped.roles.allow('merchant-reader', {
  action: 'read',
  resource: 'db:orders',
  where: {
    all: [
      { field: 'merchantId', op: 'eq', valueFrom: 'claims.merchantId' },
      { field: 'archived', op: 'eq', value: false },
    ],
  },
});
```

See [Data Permissions](/guide/data-permissions) for why policy `where` is separate from a caller's Mongo `filter`.

## Custom schemes

Pass up to 32 custom `ResourceSchemeDefinition` entries when constructing `PermissionCore`. Each has a unique scheme, behavior version, deterministic `validate` and `match` callbacks, and 1-16 positive or negative probes. Initialization executes every probe twice and includes the scheme contract in the persisted schema digest.

```ts
const pc = new PermissionCore({
  monsqlize: msq,
  resourceSchemes: [{
    scheme: 'topic',
    version: '1',
    probes: [
      { pattern: 'topic:orders:*', resource: 'topic:orders:created', expected: true },
    ],
    validate: (resource) => /^topic:[a-z]+:[a-z]+$/u.test(resource),
    match: (pattern, resource) => {
      const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
      return pattern.endsWith('*') ? resource.startsWith(prefix) : pattern === resource;
    },
  }],
});
```

Custom callbacks are trusted configuration code, not persisted rule functions. Changing scheme behavior without changing `version` risks a schema contract mismatch; deploy the same definitions to every instance.

For direct matching without a core instance, use the [Match Resource API](/api/match-resource). For all rule-management methods, see [Roles](/api/roles).
