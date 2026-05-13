# Runnable Examples

这个目录放的是仓库内可以直接执行的 example，不是只给文档站贴代码片段。

## 运行方式

先在仓库根目录执行：

```bash
npm install
```

然后按需运行：

```bash
npm run example:http
npm run example:db
npm run example:complete
```

一次性跑完全部示例：

```bash
npm run example:all
```

这些脚本会先执行 `npm run build`，再通过包名 `permission-core` 自引用加载刚生成的构建产物。

## 包含什么

- `http-only.mjs`：最小接口权限闭环
- `db-only.mjs`：集合权限 + 行级范围 + 字段过滤
- `complete-flow.mjs`：把接口权限、数据权限、角色继承、缓存和管理 API 串成一段完整流程

## 为什么完整示例仍然使用 MemoryAdapter

完整示例的目标是“开箱即可运行”，所以它默认使用 `MemoryAdapter + MemoryCache` 来把权限流跑通，而不是强依赖外部数据库。

如果你要看官方生产默认路径里的 `cache-hub + monsqlize` 组合，继续看：

- `website/docs/guide/quick-start.md`
- `website/docs/examples/monsqlize-adapter.md`