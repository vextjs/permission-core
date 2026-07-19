# 字段权限示例

## 场景

从已授权 report 行中只返回 `title` 与 `summary`，移除 `id`、`ownerId` 和 `rawCost`。

## 可运行源码

仓库 DB-only 流程一起执行集合、行级和字段检查：

```bash
npm run example:db
```

```typescript
const safeFields = await pc.filterFields(
  'u-2',
  'read',
  'db:reports',
  row,
);
```

## 预期结果

命令输出 `[db-only] ok`；`safeFields` 为 `{ title: 'Q2', summary: 'good' }`。源对象保持不变，调用者必须返回过滤后的对象，不能继续返回原值。

## 适用与不适用

适合读序列化边界，写 payload 应明确使用 `create` / `update`。它只过滤顶层属性，不是接口鉴权、行级鉴权、schema validation、嵌套脱敏、加密或数据库 projection。
