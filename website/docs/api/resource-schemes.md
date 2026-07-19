# Resource Schemes

## Purpose and preconditions

Resource schemes define how rule patterns match concrete resources. Built-ins cover HTTP routes, `api:`, `db:`, `ui:`, and the rule-only global `*`. Add a custom scheme only when those grammars cannot represent a stable application resource domain.

## Signatures

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

`scheme` follows lowercase URI-scheme grammar and cannot be `api`, `db`, `http`, or `ui`. `version` is the behavior version, not a package version. Callbacks are trusted synchronous configuration code and must be deterministic.

## Responses and side effects

Construction snapshots at most `32` definitions. `init()` executes each of `1..16` probes twice, requires concrete-resource validation to pass, and verifies the expected match result. Scheme name/version/probes contribute to the persisted schema contract digest returned in health.

```json
{
  "schema": {
    "expectedSchemeContractDigest": "...",
    "expectedSchemaContractKey": "..."
  }
}
```

Rule patterns are dispatched to `match`; concrete resources are first accepted by `validate`. Patterns and resources must remain within the declared scheme.

## Failures and limits

Invalid definitions or nondeterministic/throwing probes fail initialization with `INVALID_CONFIGURATION`. Unknown/malformed resources fail with `INVALID_RESOURCE`. Names are at most `32` characters, versions `64`, and each pattern/resource `1024` UTF-8 bytes. Changing callback behavior requires changing `version` and deploying the same definition to every instance; otherwise schema contracts can diverge.

## Example

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
```

```json
{ "scheme": "topic", "probeCount": 2, "deterministic": true }
```

## Related

See [Resources and Rules](/guide/resources-and-rules), [Match Resource](/api/match-resource), and [Core and Contexts](/api/core-and-contexts).
