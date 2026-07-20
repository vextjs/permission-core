# Resource Schemes
<!-- docs:inline-parity `api:` `db:` `ui:` `*` `scheme` `api` `db` `http` `ui` `version` `scheme:` `probes` `1..16` `{ pattern, resource, expected }` `init()` `validate(resource)` `match(pattern, resource)` `new PermissionCore({ resourceSchemes })` `PermissionCore` `validate` `match` `32` `INVALID_CONFIGURATION` `INVALID_RESOURCE` `64` `1024` `topicScheme` `health` `pc.init()` `PermissionCoreHealth` `health.schema.expectedSchemeContractDigest` `health.namespace.schemeContractDigest` `topic:orders:*` `can/assert` `topic:orders:created` `permission-core/match` -->

Resource schemes validate and match resource strings. Built-ins cover HTTP, API, database, field, UI, and global patterns; custom schemes are trusted configuration.

## Purpose and preconditions

This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.

## Signatures

The signatures below are the public contract. The code block is kept executable-looking so TypeScript users can compare argument order, option requirements, and raw return wrappers quickly.

```ts
interface ResourceSchemeDefinition {
  scheme: string;
  version: string;
  probes: readonly {
    pattern: string;
    resource: string;
    expected: boolean;
  }[];
  validate(resource: string): boolean;
  match(pattern: string, resource: string): boolean;
}

new PermissionCore({
  monsqlize,
  resourceSchemes?: ResourceSchemeDefinition[],
});
```
## Definition Fields and Lifecycle

Custom definitions are trusted configuration, not persisted rule functions. Initialization probes them repeatedly and includes their behavior contract in schema health.

<!-- docs:params owner=ResourceSchemeDefinition locale=en -->
<span id="resource-schemes-configure"></span>
### `new PermissionCore({ resourceSchemes })`
<!-- docs:method name=PermissionCore.resourceSchemes locale=en -->

- **Purpose**: Use `PermissionCore.resourceSchemes` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

<span id="resource-schemes-validate"></span>
### `validate(resource)` and `match(pattern, resource)`
<!-- docs:method name=ResourceSchemeDefinition.callbacks locale=en -->

- **Purpose**: Use `ResourceSchemeDefinition.callbacks` from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.
- **Parameters**: Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.
- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.
- **Raw return**: the public type shown in the signature section. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.

## Responses and side effects

Side effects are scoped and revisioned. Writes record audit evidence and invalidate affected semantic cache keys; reads preserve bounded detail metadata so callers can tell whether diagnostics were complete.

```json
{
  "schema": {
    "expectedSchemeContractDigest": "...",
    "expectedSchemaContractKey": "..."
  }
}
```
## Failures and limits

Failures close authorization instead of widening it. Important limits are enforced before state is committed, and stale previews or revisions must be refreshed rather than guessed.

## Example

The example keeps one narrow path per page. It shows the raw method family and a compact response shape, while the full runnable scenarios live in the examples section.

```ts
const topicScheme = {
  scheme: 'topic',
  version: '1',
  probes: [
    { pattern: 'topic:orders:*', resource: 'topic:orders:created', expected: true },
    { pattern: 'topic:orders:*', resource: 'topic:users:created', expected: false },
  ],
  validate: (resource: string) => /^topic:[a-z]+:[a-z]+$/u.test(resource),
  match: (pattern: string, resource: string) => {
    const prefix = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern;
    return pattern.endsWith('*') ? resource.startsWith(prefix) : pattern === resource;
  },
};

const pc = new PermissionCore({
  monsqlize,
  resourceSchemes: [topicScheme],
});
const health = await pc.init();
```
```json
{ "scheme": "topic", "probeCount": 2, "deterministic": true }
```
## Related

Continue with the linked guide or neighboring API page when you need workflow context rather than only signatures.

Continue with [Match Resource](/api/match-resource).
