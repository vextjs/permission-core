# Resources and Rules
<!-- docs:inline-parity `effect` `GET:/orders/:id` `GET:/orders/*` `*:/orders/*` `api:POST:/api/orders/export` `api:POST:/api/orders/*` `db:orders` `db:*` `db:orders:field:profile.name` `profile.*` `*` `ui:page:orders` `ui:page:*` `ui:*` `:id` `invoke` `read` `create` `update` `delete` `write` `manage` `roles.allow(roleId, rule, options?)` `MutationResult<PermissionRuleView>` `action='write'` `allow()` `deny()` `action` `resource` `where` `source` `no-allow` `all` `any` `not` `valueFrom` `can` `where.all` `claims.merchantId` `filter` `PermissionCore` `ResourceSchemeDefinition` `validate` `match` `await pc.init()` `PermissionCoreHealth` `validate/match` `version` -->

A permission rule contains an effect, an action pattern, a resource pattern, and optionally a serialized row condition. Requests are allowed only when an active allow matches and no applicable deny wins.

## Built-in Resource Schemes

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

## Action

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

```ts
await scoped.roles.allow('order-writer', {
  action: 'write',
  resource: 'db:orders',
});
```
## Allow, Deny, and Default Deny

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

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

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

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

Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

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
