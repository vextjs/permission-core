# 行级权限示例

## 场景

通过 `valueFrom` 把 report reader 限制到 `ownerId` 等于当前用户的记录：列表查询先取得 scope，记录加载后再复核。

## 可运行源码

仓库 DB-only 示例包含规则、scope、列表、详情和清理闭环：

```bash
npm run example:db
```

核心顺序是：

```typescript
const scope = await pc.getRowScope('u-2', 'read', 'db:reports');
const visibleRows = await pc.filterRows('u-2', 'read', 'db:reports', rows);
await pc.assertRow('u-2', 'read', 'db:reports', visibleRows[0]);
```

## 预期结果

命令输出 `[db-only] ok`。Scope 按 `ownerId` 形成条件，当前用户记录保留，其他用户记录被拒绝，进程最后正常关闭。

## 适用与不适用

大查询前使用 `getRowScope()`，已加载记录使用 `canRow/assertRow/filterRows`。示例不负责把 DSL 翻译成特定 SQL/Mongo query，也不会让字段授权放行原本不可见的行。
