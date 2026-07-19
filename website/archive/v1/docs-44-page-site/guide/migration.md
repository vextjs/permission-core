# Migration Guide

Use this page when moving from scattered permission checks to permission-core.

## Suggested migration path

1. Inventory route permissions and data permissions separately.
2. Convert route guards to `<METHOD>:<path>` resources.
3. Convert data checks to `db:<collection>[:<field>]` resources.
4. Start with one role group and one integration path.
5. Add management APIs only after the runtime path is clear.
6. Add cache invalidation to every rule or binding change.

## Avoid during migration

- Do not encode real record IDs into route resources.
- Do not move authentication responsibilities into permission-core.
- Do not use `getResources()` as the final server-side authorization result.
- Do not introduce broad wildcards for payment or ledger mutation without review.

## Version upgrade checks

When upgrading an existing permission-core integration:

1. Read the changelog and confirm whether `action + resource`, request-side `write`, or exported subpaths changed.
2. Run the current quick start and maintained examples against the packed artifact, not only source imports.
3. Revalidate custom storage adapters, cache ownership, custom resource schemes, and framework route mapping.
4. If menu or scoped APIs are enabled, migrate core and menu stores together and prove tenant partitions remain exact.
5. Roll out compatible readers before writing a new persisted shape; invalidate permission caches after data changes.
6. Keep rollback copies of core roles/rules/bindings plus menu nodes/API bindings/revisions/audits.

Review [Compatibility Matrix](/guide/compatibility-matrix), [Production Deployment](/guide/production-deployment), and the API page for every public subpath your application imports.
