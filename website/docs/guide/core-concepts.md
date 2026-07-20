# Core Terms and Mental Model
<!-- docs:inline-parity `userId` `tenantId` `pc.scope({ tenantId: 'acme' })` `scope` `pc.forSubject({ userId: 'u-1', scope })` `scoped.roles.create(...)` `{ action: 'invoke', resource: 'api:GET:/api/orders' }` `userRoles.getDirect()` `userRoles.getEffective()` `roles.getEffectiveRules()` `can()` `false` `expectedRevision` `previewAccessUpdate()` `order-reader` `scope()` `forSubject()` `roles.*` `userRoles.*` `subject.can()` `roles.getOwnRules()` -->

This page explains the words used by the rest of the guide. Read it when `scope`, `subject`, `direct`, `effective`, `default deny`, `revision`, or `preview` still feels blurry.

## Remember the Main Line

The authorization chain is: trusted login identity, subject, roles in the current scope, effective rules, then allow or deny. This is the mental model behind every example. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

```text
可信登录身份 -> subject（当前用户） -> 当前 scope 内的角色 -> 有效规则 -> 允许或拒绝
```
## Common Terms

Use this section as a glossary. The most important distinction is between direct editable state and effective resolved state. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

## Tenant, User, and Role Relationships

A tenant scope selects the authorization data set. Users come from the host. Roles belong to the scope. A user can hold multiple direct roles, and inherited roles are resolved at read time. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

```ts
const scope = { tenantId: 'acme' };
const scoped = pc.scope(scope); // 管理 acme 租户的权限数据
const subject = pc.forSubject({ userId: 'u-1', scope }); // 判断 u-1 的权限
```
## Choosing Direct or Effective Reads

Use direct reads for editable admin forms. Use effective reads for diagnostics and explanations. Do not save effective results back into direct assignment lists. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

## What to Read Next

The next page depends on the workflow: role assignment, permission checks, or inheritance. The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.

Continue with [Manage Roles and User Assignments](/guide/manage-roles-and-users).
