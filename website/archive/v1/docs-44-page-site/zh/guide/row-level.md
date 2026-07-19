# 行级权限

行级权限限制用户可以读取或操作哪些记录。

## 定义范围规则

```typescript
await pc.roles.allow('merchant-auditor', 'read', 'db:transactions', {
  where: {
    field: 'merchantId',
    op: 'eq',
    valueFrom: 'merchantId',
  },
});
```

`where` DSL 描述允许的行条件，`valueFrom` 从运行时检查传入的 context 取值。

## 获取查询范围

```typescript
const scope = await pc.getRowScope('u-1', 'read', 'db:transactions', {
  merchantId: 'm-100',
});
```

数据层能够转换为 SQL、MongoDB 或其他过滤条件时，在查询前使用该 scope。

## 检查单行

```typescript
const ok = await pc.canRow('u-1', 'read', 'db:transactions', row, {
  merchantId: 'm-100',
});
```

记录已经加载、需要最终单行 guard 时使用 `canRow()` 或 `assertRow()`。

## 过滤多行

```typescript
const visible = await pc.filterRows('u-1', 'read', 'db:transactions', rows, {
  merchantId: 'm-100',
});
```

`filterRows()` 是加载后的安全网。大数据集应优先把 `getRowScope()` 下推到查询，再在运行时复核。
