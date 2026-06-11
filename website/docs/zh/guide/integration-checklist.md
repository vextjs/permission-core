# 接入检查清单

这页适合在真正开始接入 permission-core 之前使用。

如果你已经知道大概的概念，但准备开始落地代码，这页可以帮你快速确认：哪些事已经决定了，哪些事还没决定，哪些地方最容易一开始就写偏。

## 一、先决定接入路径

在开始写代码前，先确认你属于哪一类场景：

- 只做接口权限：选 `HTTP-only`
- 只做数据权限和字段过滤：选 `DB-only`
- 接口权限和数据权限都要做：选 `Full standard stack`

如果这里还不确定，先回看 [快速开始](/zh/guide/quick-start) 和 [常见问题](/zh/guide/faq)。

## 二、接入前检查

### 1. 你已经确认要管哪一类权限

- [ ] 已确认当前只做接口权限、只做数据权限，还是两者都做
- [ ] 已确认是否需要字段过滤
- [ ] 已确认现在是否真的需要直接上完整标准栈

### 2. 你已经确认数据放在哪里

- [ ] 已确认当前先用 `MemoryAdapter`、`FileAdapter` 还是 `MonSQLizeStorageAdapter`
- [ ] 已确认“是否使用 `monsqlize`”和“是否启用 `db:` 资源”是两回事
- [ ] 如果准备上生产，已确认缓存仍然走 `cache-hub`
- [ ] 如果准备上生产，已确认当前运行时与依赖版本满足 [兼容性矩阵](/zh/guide/compatibility-matrix)

### 3. 你已经确认运行时入口怎么写

- [ ] 已确认所有公共 API 都会在 `await pc.init()` 之后调用
- [ ] 已确认应用关闭时会调用 `await pc.close()`
- [ ] 已确认未登录请求不会把 `null` 或 `undefined` 直接传给 `PermissionCore`

## 三、接口权限接入检查

如果你要做接口权限，至少确认下面这些点：

- [ ] 已确认接口资源格式统一使用 `<METHOD>:<path>`，其中 `path` 指规范化后的命中路由路径；框架支持模板路由时优先使用模板
- [ ] 已确认不会把查询串、完整 URL 拼进资源字符串
- [ ] 已确认接口通配符只在末段 `*` 语义下使用，不会误以为中间位置的 `*` 也被支持
- [ ] 已确认接口入口主要使用 `assert()` 或 `can()`
- [ ] 已确认 `getResources()` 只作为前端参考列表，不替代最终鉴权

如果这一块还不稳，建议直接对照 [框架接入](/zh/guide/framework-integration) 和 [Express 接入](/zh/examples/express)。

## 四、数据权限接入检查

如果你要做数据权限，至少确认下面这些点：

- [ ] 已确认数据资源格式统一使用 `db:<collection>[:<field>]`
- [ ] 已确认字段过滤只处理顶层字段
- [ ] 已确认数据权限判断放在 Service / DAO 层，而不是全塞进中间件
- [ ] 已确认 `filterFields()` 前后分别要在业务层怎么组织查询、过滤和返回

如果这一块还不稳，建议直接对照 [字段过滤](/zh/guide/field-filter) 和 [字段权限示例](/zh/examples/field-permission)。

## 五、规则与角色检查

- [ ] 已确认角色负责承载规则，用户只绑定角色
- [ ] 已确认首版只按单继承设计角色关系
- [ ] 已确认 `allow` 和 `deny` 的职责边界
- [ ] 已确认不会把所有差异都堆给一个超大 `admin` 角色再靠零散 deny 修补

如果这里容易混淆，先回看 [角色与规则](/zh/guide/roles-and-rules) 和 [RoleManager](/zh/api/role-manager)。

## 六、运行时语义检查

- [ ] 已确认 `can()` 用于返回 true / false
- [ ] 已确认 `assert()` 用于直接阻断
- [ ] 已确认 `cannot()` 只是 `!can(...)` 的包装
- [ ] 已确认请求侧 `write` 的语义是 `create && update`
- [ ] 已确认写入过滤通常更适合明确传 `create` 或 `update`

如果这里还有疑问，先回看 [权限鉴权](/zh/guide/check-permission) 和 [PermissionCore](/zh/api/permission-core)。

## 七、缓存与失效检查

- [ ] 已确认缓存的是用户最终规则集合，而不是单次 `can()` 的结果
- [ ] 已确认规则变化会触发 `invalidateAll()`
- [ ] 已确认用户角色绑定变化会触发 `invalidate(userId)`
- [ ] 已确认不会把“缓存命中”误解成“权限语义变了”

如果这里还不清楚，建议继续看 [权限缓存](/zh/guide/cache)。

## 八、生产治理检查

- [ ] 已确认漏洞提交流程和安全边界，知道哪些问题属于 [SECURITY.md](https://github.com/vextjs/permission-core/blob/main/SECURITY.md) 中声明的范围
- [ ] 已确认上线后要监控哪些指标，例如权限拒绝率、缓存命中率、存储异常次数
- [ ] 已确认规则变更、角色变更和用户绑定变更都有日志或审计线索

如果你已经准备上线，继续看 [生产部署与监控](/zh/guide/production-deployment)。

## 九、开始写代码前最后再看一眼

如果下面四条你都能明确回答，通常就可以开始真正接入了：

- [ ] 我选的是哪条接入路径
- [ ] 我的规则和绑定数据放在哪里
- [ ] 我的接口权限放在哪一层判断
- [ ] 我的数据权限和字段过滤放在哪一层判断

## 还不知道下一步先做什么？

你可以按这个顺序继续：

1. 先看 [快速开始](/zh/guide/quick-start)
2. 再看 [常见问题](/zh/guide/faq)
3. 然后按需要进入 [框架接入](/zh/guide/framework-integration) 或 [PermissionCore](/zh/api/permission-core)
4. 真正写接入代码前，再回来看这份清单