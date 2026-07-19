# 管理后台保存示例

## 场景

提供一个角色授权编辑器：加载可解释的角色/menu 状态，保存一次带审计的授权变更，再刷新精确 tenant snapshot。

## 可运行源码

运行仓库 menu 流程，验证 manifest、显隐、后端断言与生命周期：

```bash
npm run example:menu
```

后端保存是一个完整操作：

```typescript
const audit = await menu.saveRoleAuthorization(scope, roleId, {
  allow: input.allow,
  deny: input.deny,
  revoke: input.revoke,
  actorId: request.user.id,
  reason: input.reason,
});
```

## 预期结果

可运行命令打印可见菜单与按钮 map，后端 API 断言成功。保存命令返回含 revision/diff 的 audit entry；UI 随后重载 `roles.inspect()`、`getAuthorizationTree()`、其中的 `sourceRoleIds` 与 subject snapshot。

## 适用与不适用

适合由一个后端 owner 完成校验、revision 检查与审计保存。不适合浏览器直接调用大量 adapter write 或远程 `allow()`。后端必须拒绝过期 revision/局部输入，rule、audit 或 compensation 未完整成功时不能显示成功。
