# Resources and Rules
<!-- docs:inline-parity `effect` `GET:/orders/:id` `GET:/orders/*` `*:/orders/*` `api:POST:/api/orders/export` `api:POST:/api/orders/*` `db:orders` `db:*` `db:orders:field:profile.name` `profile.*` `*` `ui:page:orders` `ui:page:*` `ui:*` `:id` `invoke` `read` `create` `update` `delete` `write` `manage` `roles.allow(roleId, rule, options?)` `MutationResult<PermissionRuleView>` `action='write'` `allow()` `deny()` `action` `resource` `where` `source` `no-allow` `all` `any` `not` `valueFrom` `can` `where.all` `claims.merchantId` `filter` `PermissionCore` `ResourceSchemeDefinition` `validate` `match` `await pc.init()` `PermissionCoreHealth` `validate/match` `version` -->

A permission rule contains an effect, an action pattern, a resource pattern, and optionally a serialized row condition. Requests are allowed only when an active allow matches and no applicable deny wins.

## Built-in Resource Schemes

This section explains the operation in plain terms, including when to use it, which values must come from trusted server state, and which return fields are safe to read.

## Action

This section explains the operation in plain terms, including when to use it, which values must come from trusted server state, and which return fields are safe to read.

```ts
await scoped.roles.allow('order-writer', {
  action: 'write',
  resource: 'db:orders',
});
```
## Allow, Deny, and Default Deny

This section explains the operation in plain terms, including when to use it, which values must come from trusted server state, and which return fields are safe to read.

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
## Conditional Rules

This section explains the operation in plain terms, including when to use it, which values must come from trusted server state, and which return fields are safe to read.

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
## Custom Schemes

This section explains the operation in plain terms, including when to use it, which values must come from trusted server state, and which return fields are safe to read.

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
Continue with [Role Inheritance](/guide/role-inheritance).
