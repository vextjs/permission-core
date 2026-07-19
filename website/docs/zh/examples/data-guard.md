# 数据保护

## 场景

该示例针对真实 MonSQLize collection 组合调用者 Mongo filter、精确租户隔离、角色 `where` 条件、字段 projection、insert/update 所有权检查，以及字段/写入拒绝。

## 运行

```bash
npm run example:data-guard
```

规范源码是 `examples/data-guard.mjs` 中 `docs:data-guard:start` 到 `docs:data-guard:end` 的内容。

## 源码解读

```js
const orders = core.forSubject({
  userId: 'u-data', scope, claims: { merchantId: 'm-1' },
}).data.collection('example_orders', {
  resource: 'db:orders',
  scopeFields: { tenantId: 'tenantId' },
});

const rows = await orders.find(
  { status: 'paid' },
  { projection: ['merchantId', 'publicValue'] },
);
```

调用者 filter 会与 `tenantId`、持久化的 `merchantId = claims.merchantId` 条件及允许字段 projection 做 AND 组合。写入另外证明 pre/post ownership 约束。

## 预期输出

```json
{
  "example": "data-guard",
  "ok": true,
  "composition": ["caller filter", "tenant scope", "role where", "field projection"],
  "matchedRows": [{ "merchantId": "m-1", "publicValue": "visible" }],
  "matchedCount": 1,
  "deniedFieldCode": "FIELD_PERMISSION_DENIED",
  "writeGuard": {
    "inserted": true,
    "updated": true,
    "deniedWriteCode": "PERMISSION_DENIED"
  },
  "persistedRows": 5
}
```

## 生产边界

示例在使用 guard 前写入 raw fixture 数据；生产应用读写应使用 `AuthorizedCollection`。权限保护写入需要与业务事务共享时，传入宿主 transaction。不要持久化任意 JavaScript 行函数；应使用可序列化 `where` 条件和可信 context。

## 相关内容

参见[数据权限](/zh/guide/data-permissions)、[授权集合 API](/zh/api/authorized-collection)和[资源与规则](/zh/guide/resources-and-rules)。
