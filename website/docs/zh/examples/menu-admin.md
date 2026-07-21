# 菜单管理

## 场景

该示例演示后台菜单从配置到运行时的完整路径：先用增量 API 创建配置、菜单、页面、接口、按钮和响应字段，再给角色分配页面、接口、按钮和响应字段，最后以用户身份读取菜单状态并裁剪接口响应。

## 运行

```bash
npm run example:menu-admin
```

规范源码是 `examples/menu-admin.mjs` 中 `docs:menu-admin:start` 到 `docs:menu-admin:end` 的内容。

## 先看结果

运行成功后先看 `roleGrant.generatedSources`、`roleGrant.auditRecorded`、`subjectRuntime.exportEnabled` 和 `subjectRuntime.projectedResponse`。这几个值分别证明角色来源已生成、关键写入有审计记录、用户可以使用导出操作、接口响应已按字段权限裁剪。

## 源码解读

```js
const runtime = await startExampleCore("menu-admin");
const scope = { tenantId: "acme", appId: "admin" };
const scoped = runtime.core.scope(scope);

const savedConfig = await scoped.menus.management.applyChanges("admin", menuChanges, {
  actorId: "admin",
  idempotencyKey: "example-menu-config-incremental-save",
});

await scoped.roles.create({ id: "order-operator", label: "Order operator" });
const selection = {
  configId: "admin",
  views: ["orders-list"],
  responseFields: [{
    apiResource: "api:GET:/api/orders",
    target: "items",
    fields: ["orderNo", "status"],
  }],
  include: { loads: true, actions: true, responseFields: "none" },
};
const grantPreview = await scoped.roles.menuPermissions.preview(
  "order-operator",
  { operation: "grant", selection },
  { actorId: "admin" },
);
const granted = await scoped.roles.menuPermissions.grant("order-operator", selection, {
  ...grantPreview.expected,
  previewToken: grantPreview.previewToken,
  actorId: "admin",
  idempotencyKey: "example-menu-role-grant",
});
await scoped.userRoles.assign("u-menu", "order-operator");

const subjectMenus = runtime.core.forSubject({ userId: "u-menu", scope }).menus;
const tree = await subjectMenus.getViewTree({ configId: "admin" });
const viewState = await subjectMenus.getViewState({ configId: "admin", viewId: "orders-list" });
const actions = await subjectMenus.getActionMap({ configId: "admin", viewId: "orders-list" });
const projected = await subjectMenus.filterResponse("api:GET:/api/orders", rawOrders);
const directGrant = await scoped.roles.menuPermissions.getDirect("order-operator");
```

这段代码省略了 `menuChanges` 和 `rawOrders` 的定义；完整文件中 `menuChanges` 逐项创建了 `admin` 配置、`orders` 菜单、`orders-list` 页面、`api:GET:/api/orders` 加载接口、`export` 操作和响应字段。

### 1. 保存菜单配置

<!-- docs:operation id=menu-model calls=menus.management.applyChanges outputs=config -->

**目的与目标。** `menus.management.applyChanges` 接收 `menuChanges`，内部先预览，确认普通创建操作没有冲突后再写入。本步骤产出 `config`，它表示配置是否保存成功以及内部 manifest 是否发生变化。

**状态、参数与结果。** `configId: "admin"` 是后续授权和运行时读取的主键；`loadApi.add` 的 `resource` 使用 `api:GET:/api/orders`，不需要再写 `action: 'invoke'`；`response.set` 声明订单接口可分配字段。保存返回 `MutationResult<MenuManagementResult>`，`savedConfig.data.config` 是快照，`savedConfig.data.manifestOperations` 是内部同步摘要。

**失败与下一步。** 如果自动提交返回 `MENU_MANAGEMENT_PREVIEW_CONFLICT`，说明这次变更需要管理员显式预览确认；应展示错误里的 `details.operations/conflicts/warnings`，再调用对应的 `preview*()`。普通参数错误或资源格式错误会按原错误码返回。

**API 参考。** 参见[菜单 API](/zh/api/menus)，了解 `menus.management`、`menus.items/views/loadApis/actions/responses` 的签名、响应 envelope 和错误边界。

### 2. 创建工作流使用的角色身份

<!-- docs:operation id=menu-role calls=roles.create outputs=subjectRuntime -->

**目的与目标。** `roles.create` 创建 `order-operator` 角色，作为后续菜单授权的接收者。用户角色绑定发生在授权提交之后，这样示例更清楚地区分“角色存在”和“用户获得权限”。

**状态、参数与结果。** `id` 是稳定角色 ID，`label` 是展示名。创建角色不会给它任何菜单、接口或响应字段权限；这些能力只会在 `menuPermissions.grant` 成功后出现。该步骤最终服务于 `subjectRuntime`，因为用户运行时需要这个角色参与有效权限计算。

**失败与下一步。** 角色已存在时应复用或清理示例数据库；角色缺失时，后续 grant 会失败。不要通过手工 `roles.allow` 补出菜单授权，因为那会丢失菜单来源和字段授权语义。

**API 参考。** 参见[角色 API](/zh/api/roles)和[用户角色 API](/zh/api/user-roles)，了解角色创建、用户绑定和响应结构。

### 3. 预览并提交角色菜单授权

<!-- docs:operation id=menu-grant calls=menuPermissions.preview,menuPermissions.grant,menuPermissions.getDirect outputs=roleGrant -->

**目的与目标。** `menuPermissions.preview` 把 `selection` 展开为页面、加载接口、按钮操作和响应字段；`menuPermissions.grant` 按预览提交 allow 授权；`menuPermissions.getDirect` 读取保存后的 grant 和字段来源。本步骤产出 `roleGrant`。

**状态、参数与结果。** `selection.configId` 指向 `admin` 配置，`views` 选择 `orders-list`，`include.loads/actions` 自动包含页面加载接口和导出操作，`responseFields` 通过 `target: "items"` 只给 `api:GET:/api/orders` 的列表行分配 `orderNo/status`。授权返回 `generatedSources`、`generatedResponseFields` 和 `grantIds`，直接读取返回 `responseFields.total`。

**失败与下一步。** 如果选择了不存在的 view、action 或字段，preview 会拒绝。revision 或 token 过期时 grant 会失败。正确做法是刷新配置和角色状态，重新 preview，再提交新的 token。

**API 参考。** 参见[角色菜单权限 API](/zh/api/role-menu-permissions)，了解 `MenuBusinessPermissionSelection`、`responseFields`、`selectedResponseFields` 和 `generatedSources`。

### 4. 投影用户菜单运行时与响应

<!-- docs:operation id=menu-subject calls=forSubject,getViewTree,getViewState,getActionMap,filterResponse outputs=subjectRuntime -->

**目的与目标。** `forSubject` 绑定当前用户和 scope；`getViewTree` 返回用户可见菜单；`getViewState` 判断页面能否进入；`getActionMap` 判断按钮是否可用；`filterResponse` 按响应字段授权裁剪接口返回。本步骤产出 `subjectRuntime`。

**状态、参数与结果。** `userRoles.assign` 把 `order-operator` 交给 `u-menu` 后，subject runtime 才能看到刚才的授权。`filterResponse("api:GET:/api/orders", rawOrders)` 会先检查接口调用权限，再把 `items` 中的 `internalCost` 和未授权字段移除，同时保留 `total`。

**失败与下一步。** 如果用户没绑定角色、配置 ID 错误、页面未授权或接口权限缺失，运行时会 fail closed。不要只靠前端隐藏菜单，业务接口仍需要 `subject.assert` 或 Vext 插件守卫。

**API 参考。** 参见[核心与上下文 API](/zh/api/core-and-contexts)、[菜单 API](/zh/api/menus)和[角色菜单权限 API](/zh/api/role-menu-permissions)。

## 预期输出

以下 JSON 是 `printExample()` 从多个 API 响应中提取字段后的**示例汇总输出**，不是任何一个 API 的原始响应。

```json
{
  "example": "menu-admin",
  "ok": true,
  "config": {
    "id": "admin",
    "menuCount": 1,
    "manifestChanged": true
  },
  "roleGrant": {
    "generatedSources": 5,
    "generatedResponseFields": 2,
    "grantCount": 1,
    "responseFieldCount": 2,
    "auditRecorded": true
  },
  "subjectRuntime": {
    "viewTreeIds": ["orders", "orders-list"],
    "viewAllowed": true,
    "exportEnabled": true,
    "projectedResponse": {
      "total": 1,
      "items": [{ "orderNo": "O-1001", "status": "paid" }]
    }
  }
}
```

<!-- docs:output group=config producer=menu-model -->

**`config` 来源。** `menus.management.applyChanges` 返回保存后的配置快照和内部同步摘要。示例只打印 `configId`、菜单数量和是否发生内部变更，原始响应仍保留完整 revision、auditId 和 cache 结果。

<!-- docs:output group=roleGrant producer=menu-grant -->

**`roleGrant` 来源。** `menuPermissions.grant` 提供 `generatedSources`、`generatedResponseFields` 和 audit 证据；`menuPermissions.getDirect` 提供 grant 数量和响应字段数量。它们证明角色拿到的是菜单来源授权，而不是手工拼出来的规则。

<!-- docs:output group=subjectRuntime producer=menu-subject -->

**`subjectRuntime` 来源。** `filterResponse` 产出 `projectedResponse`，`getViewTree`、`getViewState` 和 `getActionMap` 产出可见菜单、页面状态和按钮状态。这个汇总是用户运行时视角，不是后台配置库存。

## 生产边界

该示例是后端管理流程，不是前端菜单过滤。生产环境中，保存菜单配置、分配角色菜单授权、绑定用户角色和访问业务接口都应是受保护的后端操作。接口响应字段裁剪应发生在返回前，不能只在浏览器里隐藏字段。

## 相关内容

参见[管理菜单](/zh/guide/menu-management)、[配置接口与响应字段](/zh/guide/api-bindings)和[角色菜单授权](/zh/guide/role-menu-authorization)。
