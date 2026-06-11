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
