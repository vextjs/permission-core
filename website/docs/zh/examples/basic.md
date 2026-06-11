# 基础示例

这个示例展示最小 `HTTP-only` 路径，适合第一次跑通 permission-core。

```typescript
import { MemoryAdapter, PermissionCore } from 'permission-core';

const pc = new PermissionCore({ storage: new MemoryAdapter() });
await pc.init();

await pc.roles.create('viewer', { label: '只读用户' });
await pc.roles.allow('viewer', 'invoke', 'GET:/api/articles');
await pc.users.assign('user-001', 'viewer');

await pc.assert('user-001', 'invoke', 'GET:/api/articles');
```

## 这个示例实际跑通了什么

虽然代码很短，但它已经把 `HTTP-only` 最基本的一次跑通流程串起来了：

1. 初始化运行时
2. 创建角色
3. 给角色配置接口规则
4. 给用户绑定角色
5. 在运行时做接口权限断言

也就是说，这不是“玩具片段”，而是一段可以直接帮助你理解接入顺序的最小示例。

这个示例刻意不引入：

- `db:` 资源
- 字段过滤
- 生产存储

目的就是先跑通最简单的接入方式。

## 如果你想把它再往前走一步

通常下一步会是下面两种方向之一：

### 方向一：继续留在 `HTTP-only`

补：

- 多个接口规则
- `getResources()`
- 中间件接入

### 方向二：升级到数据权限

补：

- `db:<collection>[:<field>]` 资源
- `filterFields()`
- Service / DAO 层的集合权限判断

## 对照阅读建议

看完这个示例后，最适合继续读的是：

- [快速开始](/zh/guide/quick-start)
- [Express 接入](/zh/examples/express)
- [资源路径模型](/zh/guide/resource-paths)