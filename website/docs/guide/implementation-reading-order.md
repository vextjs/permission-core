# 接入阅读顺序

当你已经准备把 permission-core 接进项目里，但还不确定应该先读哪几页、先落哪一层时，可以按这页给出的顺序进入。

这页不是替代首页和介绍页里的“首次接入主路径”。更合适的用法是：你先按 [快速开始](/guide/quick-start) → [常见问题](/guide/faq) → [资源路径模型](/guide/resource-paths) → [角色与规则](/guide/roles-and-rules) → [权限鉴权](/guide/check-permission) → [接入检查清单](/guide/integration-checklist) 读完一遍，再回到这页开始真正落接入代码。


## 这页适合什么时候看

如果你已经满足下面这些条件，就可以开始看这页：

- 你已经知道自己要走哪条接入路径
- 你已经看过 [常见问题](/guide/faq)
- 你已经能看懂 [接入检查清单](/guide/integration-checklist)
- 你准备真正开始写接入代码，而不只是继续读概念

## 一、开始接入前，先别急着写业务代码

最容易犯的错误，是一上来就先写中间件、先写接口守卫、甚至先写数据库适配器。

更稳妥的顺序通常是：

1. 先确认接入路径
2. 再确认资源模型
3. 再确认角色和规则怎么组织
4. 再确认运行时调用方式
5. 最后才开始写接入代码

原因很简单：

如果前面四步没站稳，后面的实现很容易“代码能写出来，但方向不对”。

## 二、实现阶段补充顺序

### 第 1 步：先把入口路径确认清楚

先读：

1. [快速开始](/guide/quick-start)
2. [常见问题](/guide/faq)
3. [接入检查清单](/guide/integration-checklist)

这一步的目标不是记住所有细节，而是把三件事明确下来：

- 你走哪条接入路径
- 你现在是否真的需要完整标准栈
- 你的规则和绑定准备放在哪里

### 第 2 步：把资源模型和规则模型读明白

再读：

1. [资源路径模型](/guide/resource-paths)
2. [角色与规则](/guide/roles-and-rules)
3. [权限鉴权](/guide/check-permission)

这一步的目标是确认：

- 资源字符串到底怎么写
- 角色、规则、用户绑定之间怎么分工
- `can/assert/getRowScope/canRow/filterRows/filterFields` 在运行时分别该怎么用

### 第 3 步：根据你的场景选择接入入口

如果你主要做接口权限：

- 先看 [框架接入](/guide/framework-integration)
- 再看 [Express 接入](/examples/express) 或 [vext 接入](/examples/vext)

如果你主要做数据权限：

- 先看 [行级权限](/guide/row-level)
- 再看 [行级权限示例](/examples/row-level)
- 再看 [字段过滤](/guide/field-filter)
- 再看 [字段权限示例](/examples/field-permission)
- 如果要回到运行时主入口，再看 [PermissionCore](/api/permission-core)

如果你要同时做接口权限和数据权限：

- 先看 [PermissionCore](/api/permission-core)
- 再看 [MonSQLize 适配器](/examples/monsqlize-adapter)

### 第 4 步：真正写代码前，再回头看一遍 checklist

在开始写接入代码前，建议最后再回看一次 [接入检查清单](/guide/integration-checklist)。

这一步不是重复，而是确认你没有在下面这些地方写偏：

- 资源字符串格式
- 中间件与 Service 的分层
- `write` 的请求侧语义
- 缓存失效方式

## 三、按接入路径分别怎么进入

### `HTTP-only`

推荐顺序：

1. [快速开始](/guide/quick-start)
2. [资源路径模型](/guide/resource-paths)
3. [框架接入](/guide/framework-integration)
4. [Express 接入](/examples/express) 或 [vext 接入](/examples/vext)
5. [PermissionCore](/api/permission-core)

实现重点：

- 先把 `<METHOD>:<path>` 资源格式固定住，并确认 `path` 指规范化后的命中路由路径
- 先把接口权限中间件跑通
- 不要过早把 `db:` 权限塞进来

### `DB-only`

推荐顺序：

1. [快速开始](/guide/quick-start)
2. [资源路径模型](/guide/resource-paths)
3. [行级权限](/guide/row-level)
4. [行级权限示例](/examples/row-level)
5. [字段过滤](/guide/field-filter)
6. [字段权限示例](/examples/field-permission)
7. [PermissionCore](/api/permission-core)

实现重点：

- 先把 `db:<collection>[:<field>]` 写法固定住
- 先把集合权限、行级范围和字段权限分开理解
- 写入过滤优先明确用 `create` / `update`

### `Full standard stack`

推荐顺序：

1. [快速开始](/guide/quick-start)
2. [常见问题](/guide/faq)
3. [接入检查清单](/guide/integration-checklist)
4. [PermissionCore](/api/permission-core)
5. [MonSQLize 适配器](/examples/monsqlize-adapter)
6. [管理后台接入](/guide/site-preview-release)
7. [管理后台保存示例](/examples/management-backend)

实现重点：

- 不要把“用了 monsqlize”误解成“所有资源都必须一起上”
- 明确接口权限、数据权限、缓存和持久化各自负责什么
- 先保证入口层和业务层分工清楚，再谈统一标准栈

## 四、最容易写偏的几个地方

开始实现时，最容易偏掉的通常是这几类问题：

- 资源字符串把查询串或完整 URL 拼进去
- 把接口权限和数据权限都塞进中间件
- 把 `getResources()` 当成最终鉴权
- 把 `write` 当成普通单一动作
- 没 `init()` 就直接调用运行时 API

如果你在实现阶段发现自己总是在这些点来回绕，通常不是代码问题，而是该回头补读文档了。

## 五、开始接入前最后一跳

如果你准备真正开始动手，建议最后按这个顺序确认一次：

1. [接入检查清单](/guide/integration-checklist)
2. [PermissionCore](/api/permission-core)
3. 你的目标框架或示例页

这样你进入代码实现时，路径、资源、运行时入口和分层边界都会更稳。