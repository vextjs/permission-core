# 基础示例

## 场景

在增加框架或数据库前，通过安装后的 `permission-core` 包证明一条允许和一条拒绝鉴权结果。

## 可运行源码

本页与 package-consumer smoke 共用仓库维护的同一文件：

```js file="<root>/../examples/docs-first-success.mjs"

```

在仓库根目录运行隔离消费验证：

```bash
npm run docs:first-success
```

## 预期结果

命令会打包当前项目、把 tarball 安装进临时空 consumer，并精确输出：

```text
[first-success] allowed=true blocked=true
```

## 适用与不适用

它用于第一次验证 package/install/runtime，也适合发布通道 smoke。这里证明的是消费项目真正安装了 tarball、runtime 完成初始化，并且 allow 与 deny 两条路径都产生预期结果，而不是从仓库源码目录偶然导入成功。

它不演示持久化、租户隔离、框架中间件、行级、字段或菜单流程，也不代表生产存储已经配置完成；该结果通过后，再进入对应指南。
