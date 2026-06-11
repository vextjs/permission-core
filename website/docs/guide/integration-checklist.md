# Integration Checklist

Use this checklist before calling a permission-core integration ready.

## Runtime

- [ ] `pc.init()` runs during service startup.
- [ ] `pc.close()` runs during graceful shutdown.
- [ ] Anonymous requests are rejected before permission-core APIs.
- [ ] Route resources use matched route templates.
- [ ] Data resources use `db:<collection>[:<field>]`.

## Rules

- [ ] Deny rules are visible in management UI.
- [ ] Rule save paths deduplicate by `type + action + resource + where`.
- [ ] Role inheritance is inspected with `roles.inspect()` when shown in UI.
- [ ] Cache invalidation runs after rule and binding changes.

## Verification

- [ ] `npm run typecheck`
- [ ] `npm run test:coverage`
- [ ] `npm run build`
- [ ] `npm run example:all`
- [ ] `cd website && npm run build`
