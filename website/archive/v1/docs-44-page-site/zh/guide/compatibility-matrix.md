# 兼容性矩阵

本页记录当前已验证的运行时和依赖边界。

## 运行时

| 组件 | 版本/声明 | 状态 |
|------|-----------|------|
| Node.js | `>=18` | 支持 |
| TypeScript | `5.9.3` | 已验证 |
| Vitest | `3.2.6` | 已验证 |
| `@vitest/coverage-v8` | `3.2.6` | 已验证 |
| `cache-hub` | `2.2.4` | 已验证 |
| `monsqlize` | `2.0.3` | 已验证 |

## 已验证命令

```bash
npm run typecheck
npm run test:coverage
npm run build
npm run example:all
cd website && npm run build
```

未发布的 `1.1.0` 门禁最低覆盖率为：语句 92%、分支 89.5%、函数 95%、行 92%；`menu`、`scope` 与 `adapters/vext` 另有模块级阈值。

## 存储支持

| 适配器 | 用途 | 说明 |
|--------|------|------|
| `MemoryAdapter` | 测试、演示、本地开发 | 无外部存储 |
| `FileAdapter` | 本地回退 | 不适合多实例共享写入 |
| `MonSQLizeStorageAdapter` | 生产持久化路径 | 使用 `monsqlize@2.0.3`；生产示例将 `msq.getCache()` 传给 PermissionCore |

permission-core 是 Node.js 授权内核，不是浏览器 SDK。
