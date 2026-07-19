# Runnable Examples

这里的五个场景都是可执行真相源，文档站只引用这些代码，不维护另一套容易漂移的伪示例。

## 运行

```bash
npm install
npm run example:all
```

也可以单独运行：

```bash
npm run example:basic
npm run example:multi-tenant
npm run example:data-guard
npm run example:menu-admin
npm run example:vext
```

`example:*` 会先构建包，再通过包名自引用加载 `dist`。每个脚本输出一段稳定 JSON，便于人工阅读和自动核对。

根包示例支持 Node.js `>=18.0.0`；`example:vext` 使用 Vext 0.3.26，因此要求 Node.js `>=20.19.0`。

## 场景

| 脚本 | 证明的能力 |
|---|---|
| `basic.mjs` | 角色、规则、`assign`/`set`、`can`/`cannot`、角色与权限读取 |
| `multi-tenant.mjs` | 同一用户和角色 ID 在不同租户内真实隔离 |
| `data-guard.mjs` | Mongo 风格业务 filter、租户条件、规则 where、字段权限合并执行 |
| `menu-admin.mjs` | 菜单/按钮/API 绑定创建、角色菜单授权、用户端可见树与按钮状态 |
| `vext/index.mjs` | Vext 插件路由守卫、401/403/200、路由重载保护与宿主数据库所有权 |

## 夹具边界

`_support/host.mjs` 启动临时 MongoDB 副本集，只用于仓库示例。生产应用应创建并连接自己的 MonSQLize 3.1 实例，把该实例传给 `PermissionCore` 或 Vext 插件，并在 `PermissionCore` 关闭后由宿主关闭数据库。

`archive/v1/` 保存重构前的历史脚本，不属于当前文档或发布验证入口。
