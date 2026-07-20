import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
    docsPages,
    primaryNextForLocale,
} from "../website/docs-manifest.mjs";
import {
    apiMethodContracts,
    diagramContracts,
    diagramFallbackId,
    operationLabels,
    operationPageContracts,
} from "./docs-experience-contracts.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = path.join(projectRoot, "website", "docs");
const zhRoot = path.join(docsRoot, "zh");

const guideTitles = new Map([
    ["index.md", "permission-core"],
    ["guide/introduction.md", "Introduction"],
    ["guide/quick-start.md", "Quick Start"],
    ["guide/core-concepts.md", "Core Terms and Mental Model"],
    ["guide/manage-roles-and-users.md", "Manage Roles and User Assignments"],
    ["guide/troubleshooting.md", "Troubleshooting"],
    ["guide/check-permission.md", "Check Permissions"],
    ["guide/data-permissions.md", "Data Permissions"],
    ["guide/menu-management.md", "Manage Menus"],
    ["guide/api-bindings.md", "Bind APIs"],
    ["guide/role-menu-authorization.md", "Authorize Role Menus"],
    ["guide/permission-lifecycle.md", "Permission Lifecycle"],
    ["guide/resources-and-rules.md", "Resources and Rules"],
    ["guide/role-inheritance.md", "Role Inheritance"],
    ["guide/multi-tenant.md", "Multi-Tenant Model"],
    ["guide/cache.md", "Cache"],
    ["guide/vext-plugin.md", "Vext Plugin"],
    ["guide/authentication-boundary.md", "Authentication Boundary"],
    ["guide/production-operations.md", "Production Operations"],
]);

const apiTitles = new Map([
    ["api/core-and-contexts.md", "Core and Contexts"],
    ["api/roles.md", "Roles"],
    ["api/user-roles.md", "User Roles"],
    ["api/menus.md", "Menus"],
    ["api/api-bindings.md", "API Bindings"],
    ["api/role-menu-permissions.md", "Role Menu Permissions"],
    ["api/authorized-collection.md", "Authorized Collection"],
    ["api/audit-and-health.md", "Audit and Health"],
    ["api/errors.md", "Errors"],
    ["api/resource-schemes.md", "Resource Schemes"],
    ["api/match-resource.md", "Match Resource"],
    ["api/vext-plugin.md", "Vext Plugin API"],
]);

const exampleTitles = new Map([
    ["examples/basic.md", "Basic RBAC"],
    ["examples/multi-tenant.md", "Multi-Tenant"],
    ["examples/data-guard.md", "Data Guard"],
    ["examples/menu-admin.md", "Menu Administration"],
    ["examples/vext.md", "Vext Integration"],
]);

const headingTranslations = new Map([
    ["按需接入，不必一次学完", "Use Only the Layer You Need"],
    ["先认识四个入口", "Know the Four Entry Points"],
    ["推荐路径", "Recommended Path"],
    ["项目入口", "Project Entry Points"],
    ["模块负责什么", "What This Module Owns"],
    ["宿主负责什么", "What the Host Owns"],
    ["四层能力怎样选择", "Choosing the Four Capability Layers"],
    ["对象怎样协作", "How the Objects Work Together"],
    ["运行模型", "Runtime Model"],
    ["支持边界", "Support Boundary"],
    ["选择下一项任务", "Choose the Next Task"],
    ["先记住一条主线", "Remember the Main Line"],
    ["几个常用词", "Common Terms"],
    ["租户、用户与角色的关系", "Tenant, User, and Role Relationships"],
    ["direct 和 effective 怎么选", "Choosing Direct or Effective Reads"],
    ["下一步怎么读", "What to Read Next"],
    ["1. 安装并准备 MongoDB", "1. Install and Prepare MongoDB"],
    ["2. 连接并初始化", "2. Connect and Initialize"],
    ["3. 创建角色并绑定用户", "3. Create the Role and Bind the User"],
    ["4. 验证允许与默认拒绝", "4. Verify Allow and Default Deny"],
    ["5. 关闭并继续下一项任务", "5. Close and Continue"],
    ["先记住四个方法", "Remember Four Methods First"],
    ["1. 创建角色", "1. Create a Role"],
    ["2. 给角色加一条权限", "2. Add One Permission to the Role"],
    ["3. 给用户绑定角色", "3. Bind the Role to a User"],
    ["4. 读取最终结果", "4. Read the Final State"],
    ["常见问题", "Common Questions"],
    ["assign 和 set 到底有什么区别？", "What is the difference between assign and set?"],
    ["为什么读取 direct 后再 set？", "Why read direct before set?"],
    ["更新或删除角色去哪看？", "Where do updates and removals live?"],
    ["失败时先看什么", "What to Check When It Fails"],
    ["最小诊断顺序", "Minimal Diagnostic Order"],
    ["安装与初始化", "Installation and Initialization"],
    ["初始化", "Initialization"],
    ["Scope、身份与决策", "Scope, Identity, and Decisions"],
    ["数据、菜单与并发", "Data, Menus, and Concurrency"],
    ["缓存与 Vext 恢复", "Cache and Vext Recovery"],
    ["布尔检查与强制执行", "Boolean Checks and Enforcement"],
    ["解释一次决策", "Explain One Decision"],
    ["读取角色及其规则", "Read Roles and Rules"],
    ["读取并替换用户角色", "Read and Replace User Roles"],
    ["读取用户权限快照", "Read a User Permission Snapshot"],
    ["`filter` 与 `where` 职责不同", "`filter` and `where` Have Different Jobs"],
    ["多个策略条件", "Multiple Policy Conditions"],
    ["Mongo 风格调用方查询", "Mongo-Style Caller Queries"],
    ["字段权限", "Field Permissions"],
    ["受保护的读写操作", "Protected Read and Write Operations"],
    ["事务与所有权边界", "Transaction and Ownership Boundary"],
    ["节点类型", "Node Types"],
    ["创建并读取节点", "Create and Read Nodes"],
    ["更新元数据与结构", "Update Metadata and Structure"],
    ["安全移除", "Safe Removal"],
    ["导入和导出 manifest", "Import and Export a Manifest"],
    ["绑定结构", "Binding Structure"],
    ["一个按钮对应多个接口", "One Button Can Own Multiple APIs"],
    ["读取与更新绑定", "Read and Update Bindings"],
    ["运行时可用性", "Runtime Availability"],
    ["对象怎样连在一起", "How the Objects Connect"],
    ["构造选择", "Build a Selection"],
    ["执行前预览", "Preview Before Execution"],
    ["授予、拒绝、撤销或替换", "Grant, Deny, Revoke, or Replace"],
    ["绑定用户并读取授权", "Bind Users and Read Authorization"],
    ["投影用户界面", "Project the User Interface"],
    ["处理资源变化", "Handle Asset Changes"],
    ["端到端流程", "End-to-End Flow"],
    ["管理写入路径", "Management Write Path"],
    ["请求决策路径", "Request Decision Path"],
    ["缓存与审计顺序", "Cache and Audit Order"],
    ["失败与关闭", "Failures and Shutdown"],
    ["内置资源方案", "Built-in Resource Schemes"],
    ["Action", "Action"],
    ["Allow、deny 与默认拒绝", "Allow, Deny, and Default Deny"],
    ["条件规则", "Conditional Rules"],
    ["自定义方案", "Custom Schemes"],
    ["创建父角色与子角色", "Create Parent and Child Roles"],
    ["读取自身与有效状态", "Read Own and Effective State"],
    ["冲突处理", "Conflict Handling"],
    ["安全修改父角色或状态", "Safely Change Parent or Status"],
    ["父级变化、移除与缓存", "Parent Changes, Removal, and Cache"],
    ["用户界面模型", "Admin UI Model"],
    ["关系模型", "Relationship Model"],
    ["相同标识、隔离状态", "Same Identifiers, Isolated State"],
    ["构造可信 subject", "Construct a Trusted Subject"],
    ["在业务数据中强制 scope", "Enforce Scope in Business Data"],
    ["持久化、缓存与审计隔离", "Persistence, Cache, and Audit Isolation"],
    ["运维检查", "Operational Checks"],
    ["前置条件", "Preconditions"],
    ["配置", "Configuration"],
    ["一致性与所有权", "Consistency and Ownership"],
    ["故障处置", "Incident Handling"],
    ["多实例检查清单", "Multi-Instance Checklist"],
    ["回滚", "Rollback"],
    ["回滚与关闭", "Rollback and Shutdown"],
    ["目标与前置条件", "Goals and Preconditions"],
    ["注册插件", "Register the Plugin"],
    ["提供可信认证", "Provide Trusted Authentication"],
    ["声明路由权限", "Declare Route Permissions"],
    ["失败与关闭边界", "Failure and Shutdown Boundary"],
    ["职责模型", "Responsibility Model"],
    ["Vext 接受的形态", "Accepted Vext Shapes"],
    ["自定义主体解析", "Custom Subject Resolution"],
    ["受保护与公开路由", "Protected and Public Routes"],
    ["失败边界与下一步", "Failure Boundary and Next Step"],
    ["就绪检查清单", "Readiness Checklist"],
    ["变更与审计控制", "Change and Audit Control"],
    ["容量与一致性", "Capacity and Consistency"],
    ["场景", "Scenario"],
    ["运行", "Run"],
    ["先看结果", "First Check the Result"],
    ["源码解读", "Source walkthrough"],
    ["预期输出", "Expected output"],
    ["生产边界", "Production boundary"],
    ["相关内容", "Related"],
]);

const apiHeadingTranslations = new Map([
    ["用途与前置条件", "Purpose and preconditions"],
    ["我想做什么", "What Do You Want to Do?"],
    ["签名", "Signatures"],
    ["构造参数与公共输入", "Constructor Options and Shared Inputs"],
    ["公共响应合同", "Common Response Contracts"],
    ["输入参数", "Input Parameters"],
    ["参数对象", "Parameter Objects"],
    ["参数与返回字段", "Parameters and Returned Fields"],
    ["定义字段与生命周期", "Definition Fields and Lifecycle"],
    ["错误对象详解", "Error Object Details"],
    ["方法与字段详解", "Method and Field Details"],
    ["导出详解", "Export Details"],
    ["先理解三个层次", "Understand the Three Layers First"],
    ["方法详解", "Method Details"],
    ["方法详解：初始化与健康", "Method Details: Initialization and Health"],
    ["方法详解：创建管理与用户上下文", "Method Details: Create Management and Subject Contexts"],
    ["方法详解：执行权限判断", "Method Details: Execute Permission Decisions"],
    ["方法详解：读取与解释", "Method Details: Read and Explain"],
    ["方法详解：关闭", "Method Details: Close"],
    ["方法详解：创建与读取", "Method Details: Create and Read"],
    ["方法详解：高影响角色变更", "Method Details: High-Impact Role Changes"],
    ["方法详解：增量修改手工规则", "Method Details: Incremental Manual Rule Changes"],
    ["方法详解：预览并提交规则影响", "Method Details: Preview and Commit Rule Impact"],
    ["方法详解：读取直接与有效规则", "Method Details: Read Direct and Effective Rules"],
    ["方法详解：创建与读取绑定", "Method Details: Create and Read Bindings"],
    ["方法详解：直接修改展示字段", "Method Details: Directly Update Display Fields"],
    ["方法详解：改变状态", "Method Details: Change Status"],
    ["方法详解：修改结构与安全删除", "Method Details: Change Structure and Remove Safely"],
    ["方法详解：全量替换", "Method Details: Full Replacement"],
    ["方法详解：创建与读取节点", "Method Details: Create and Read Nodes"],
    ["方法详解：修改字段与结构", "Method Details: Change Fields and Structure"],
    ["方法详解：改变状态与安全删除", "Method Details: Change Status and Remove Safely"],
    ["方法详解：修复失效引用", "Method Details: Repair Stale References"],
    ["方法详解：投影用户菜单", "Method Details: Project User Menus"],
    ["方法详解：导入与导出 manifest", "Method Details: Import and Export a Manifest"],
    ["方法详解：预览并提交授权", "Method Details: Preview and Commit Grants"],
    ["方法详解：读取直接与有效授权", "Method Details: Read Direct and Effective Grants"],
    ["方法详解：修复失效来源", "Method Details: Repair Stale Sources"],
    ["响应与副作用", "Responses and side effects"],
    ["失败与限制", "Failures and limits"],
    ["示例", "Example"],
    ["相关内容", "Related"],
    ["规则与变更输入", "Rule and Change Inputs"],
    ["分页查询", "Pagination Queries"],
    ["查询和写入选项", "Query and Write Options"],
    ["`PermissionSubject` 与 `PolicyContext`", "`PermissionSubject` and `PolicyContext`"],
    ["`MutationOptions` 与 revision options", "`MutationOptions` and Revision Options"],
    ["读取与分页响应", "Read and Page Responses"],
    ["写入与 preview 响应", "Write and Preview Responses"],
    ["`validate(resource)` 与 `match(pattern, resource)`", "`validate(resource)` and `match(pattern, resource)`"],
    ["`assign` 与 `set` 怎么选", "How to Choose `assign` and `set`"],
]);

const overviewByPath = {
    "guide/introduction.md": "permission-core is a fine-grained authorization library for Node.js applications that already use MonSQLize 3.1. It keeps RBAC state, menus, API bindings, row filters, field permissions, audit evidence, and runtime checks in one tenant-aware model.",
    "guide/core-concepts.md": "This page explains the words used by the rest of the guide. Read it when `scope`, `subject`, `direct`, `effective`, `default deny`, `revision`, or `preview` still feels blurry.",
    "guide/manage-roles-and-users.md": "This page covers the everyday admin workflow: create a role, add one permission, bind the role to a user, and read direct versus effective authorization state.",
    "guide/troubleshooting.md": "Start from structured error `code` and `details.kind`, then narrow the problem to initialization, subject identity, rule state, data guard, menu state, cache, or Vext route integration.",
    "guide/check-permission.md": "Use a subject context for request-time decisions and a scoped context for management reads. Both facades read the same tenant-scoped authorization state.",
    "guide/data-permissions.md": "The supported data boundary is `AuthorizedCollection`. It combines the caller's Mongo-style `filter`, exact scope fields, persisted policy `where`, and field permissions before touching MongoDB.",
    "guide/menu-management.md": "Menu management stores the backend-owned navigation inventory. A node is not a permission by itself; role-menu authorization decides which roles receive the generated rules.",
    "guide/api-bindings.md": "API bindings connect real backend endpoints to the menu, page, or button that owns them. They describe both the permission required by the endpoint and whether an unavailable endpoint should disable the UI owner.",
    "guide/role-menu-authorization.md": "Role-menu authorization converts an administrator's structural selection into durable, provenance-tracked rules. It does not bind users automatically.",
    "guide/permission-lifecycle.md": "Authorization is a lifecycle: the host owns identity and database connections, administrators commit versioned state, requests evaluate stable snapshots, and shutdown drains permission work before the database closes.",
    "guide/resources-and-rules.md": "A permission rule contains an effect, an action pattern, a resource pattern, and optionally a serialized row condition. Requests are allowed only when an active allow matches and no applicable deny wins.",
    "guide/role-inheritance.md": "Each role has at most one direct parent. Child roles inherit the active parent chain while preserving readable provenance for own rules and menu-generated rules.",
    "guide/multi-tenant.md": "Tenant isolation is part of every authorization identity. Roles, bindings, menus, APIs, revisions, audit state, cache keys, and data operations all live inside a normalized scope.",
    "guide/cache.md": "Permission caching is optional and disabled by default. Enable it only when the host can prove that the MonSQLize cache backend provides ordered `get`, `set`, `del`, and `delPattern` semantics across all instances.",
    "guide/vext-plugin.md": "Use `permission-core/plugins/vext` when Vext should own plugin ordering, request integration, route guards, error mapping, and PermissionCore shutdown. The plugin still consumes the host-owned MonSQLize 3.1 instance.",
    "guide/authentication-boundary.md": "The host authenticates the request first; permission-core answers authorization questions only after it receives a trusted `PermissionSubject`.",
    "guide/production-operations.md": "Production readiness depends on a healthy host MonSQLize 3.1 connection, a compatible schema, bounded authorization state, persisted mutation evidence, and the correct close order.",
};

const apiPurposeByPath = {
    "api/core-and-contexts.md": "`PermissionCore` owns initialization, health, scope facades, subject facades, runtime decisions, diagnostics, and shutdown. The host still owns authentication and the MonSQLize connection.",
    "api/roles.md": "`scoped.roles` manages roles, hierarchy, manual rules, high-impact previews, replacement flows, and effective rule reads inside one complete scope.",
    "api/user-roles.md": "`scoped.userRoles` stores direct role assignments for host user IDs. It distinguishes incremental assignment from full replacement and can read direct or effective role sets.",
    "api/menus.md": "`scoped.menus` manages backend menu inventory, structural changes, stale-reference repair, subject menu projection, and frontend manifest import/export.",
    "api/api-bindings.md": "`scoped.apiBindings` manages endpoint contracts and their owners. Bindings affect UI availability and backend authorization, but they do not grant roles by themselves.",
    "api/role-menu-permissions.md": "`scoped.roles.menuPermissions` expands menu selections into provenance-tracked role rules and reads direct, inherited, or stale menu grants.",
    "api/authorized-collection.md": "`subject.data.collection()` creates the guarded data facade that combines caller filters, scope fields, policy `where`, field permissions, and MonSQLize operations.",
    "api/audit-and-health.md": "`init()` and `health()` expose the readiness evidence that operators need before accepting permission traffic or diagnosing degraded state.",
    "api/errors.md": "`PermissionCoreError` is the structured failure surface. Callers should branch on `code` and `details.kind`, not on localized message text.",
    "api/resource-schemes.md": "Resource schemes validate and match resource strings. Built-ins cover HTTP, API, database, field, UI, and global patterns; custom schemes are trusted configuration.",
    "api/match-resource.md": "`matchResource` exposes the same resource matcher outside a `PermissionCore` instance for tests, diagnostics, or custom integration checks.",
    "api/vext-plugin.md": "The Vext plugin exports the runtime integration, request context helpers, route manifest conversion, and `app.permission` extension surface.",
};

const apiGroupText = {
    "What Do You Want to Do?": "Use this table as the shortest route from a task to the first method. Methods that can change broad state use a preview/execute pair so the admin UI can show impact before writing.",
    "Signatures": "The signatures below are the public contract. The code block is kept executable-looking so TypeScript users can compare argument order, option requirements, and raw return wrappers quickly.",
    "Constructor Options and Shared Inputs": "These inputs are shared by multiple APIs. They decide the namespace, scope, subject, policy context, revision controls, preview controls, and bounded response shape used throughout the package.",
    "Common Response Contracts": "Management writes return mutation envelopes. Reads return versioned or paged envelopes. Subject runtime calls return booleans, void, or bounded diagnostic results depending on the method.",
    "Input Parameters": "The table explains domain inputs. Shared `MutationOptions`, revision options, preview tokens, pagination, and envelope shapes are documented in the common response contracts.",
    "Parameter Objects": "The table explains object fields that are easy to confuse at call sites. Required fields are validated before the method mutates persistent authorization state.",
    "Parameters and Returned Fields": "Use this section to distinguish host-owned user IDs from permission-core role bindings, direct values, effective values, revisions, and cursor fields.",
    "Definition Fields and Lifecycle": "Custom definitions are trusted configuration, not persisted rule functions. Initialization probes them repeatedly and includes their behavior contract in schema health.",
    "Error Object Details": "Every error carries a stable public code and a discriminated details object. Logs and HTTP mappers should keep these structured fields.",
    "Method and Field Details": "The methods below are the public health and audit surface. They are intentionally small so operators can use them from readiness probes and incident tooling.",
    "Export Details": "These exports are the Vext integration surface. Use them from Vext plugins, route metadata conversion, and request handlers that need authorization context.",
    "Understand the Three Layers First": "Menu nodes, API bindings, and generated role-menu sources are separate records. Keeping them separate makes admin previews auditable and prevents UI state from becoming the only security boundary.",
    "Responses and side effects": "Side effects are scoped and revisioned. Writes record audit evidence and invalidate affected semantic cache keys; reads preserve bounded detail metadata so callers can tell whether diagnostics were complete.",
    "Failures and limits": "Failures close authorization instead of widening it. Important limits are enforced before state is committed, and stale previews or revisions must be refreshed rather than guessed.",
    "Example": "The example keeps one narrow path per page. It shows the raw method family and a compact response shape, while the full runnable scenarios live in the examples section.",
    "Related": "Continue with the linked guide or neighboring API page when you need workflow context rather than only signatures.",
};

const genericGuideText = {
    "Use Only the Layer You Need": "Start with core RBAC and add the optional layers only when the application needs them. Menu/API integration, data permissions, Vext, cache, and operations all share the same tenant, user, role, and rule model.",
    "Know the Four Entry Points": "`PermissionCore`, `scoped`, `subject`, and `AuthorizedCollection` are the main objects you will touch. The first owns lifecycle, the second owns management state, the third owns request-time decisions, and the fourth owns guarded data access.",
    "Recommended Path": "Complete the quick start first, then add role/user administration. After that, choose data permissions or menu management based on the application's actual needs, and finish with lifecycle and production operations before rollout.",
    "Project Entry Points": "Use the repository links for source, changelog, contribution rules, security reporting, and the Apache-2.0 license.",
    "What This Module Owns": "permission-core owns tenant-scoped roles, rules, menu and API authorization state, runtime decisions, bounded diagnostics, and optional semantic cache use. Every management write persists through MonSQLize transactions.",
    "What the Host Owns": "The application still owns login, credentials, sessions, MonSQLize connection lifecycle, business collections, HTTP serialization, and operational policy. permission-core does not turn untrusted request input into a trusted subject.",
    "Choosing the Four Capability Layers": "The layers are incremental. A service can use only RBAC decisions, while an admin system can add menus, API bindings, row/field guards, and Vext integration later.",
    "How the Objects Work Together": "`scope()` and `forSubject()` create facades without querying the database. Reads and writes happen only when the subsequent manager, subject, menu, or data methods are called.",
    "Runtime Model": "The host converts authenticated identity into a `PermissionSubject`. permission-core resolves effective rules in the scope and uses the same state for API decisions, menu projection, button state, and guarded collections.",
    "Support Boundary": "The current supported persistence path is a connected `monsqlize@3.1.0` MongoDB runtime. Authentication remains outside this package, and the optional Vext plugin is imported from `permission-core/plugins/vext`.",
    "Choose the Next Task": "If the terms are new, read the core concepts page; otherwise go to the quick start, role/user management, permission checks, data permissions, or menu management based on your next job.",
    "Remember the Main Line": "The authorization chain is: trusted login identity, subject, roles in the current scope, effective rules, then allow or deny. This is the mental model behind every example.",
    "Common Terms": "Use this section as a glossary. The most important distinction is between direct editable state and effective resolved state.",
    "Tenant, User, and Role Relationships": "A tenant scope selects the authorization data set. Users come from the host. Roles belong to the scope. A user can hold multiple direct roles, and inherited roles are resolved at read time.",
    "Choosing Direct or Effective Reads": "Use direct reads for editable admin forms. Use effective reads for diagnostics and explanations. Do not save effective results back into direct assignment lists.",
    "What to Read Next": "The next page depends on the workflow: role assignment, permission checks, or inheritance.",
    "Minimal Diagnostic Order": "Check health, direct roles, and an explanation before changing state. These reads identify the failing layer without accidentally granting new permissions in diagnostic code.",
    "Installation and Initialization": "Most startup failures come from a missing MonSQLize peer, an incompatible runtime, an unavailable database, or a schema contract mismatch. Treat these as readiness failures.",
    "Scope, Identity, and Decisions": "Subject scope must be complete and trusted. Missing policy context, no matching allow, explicit deny, disabled roles, or unavailable sources all fail closed.",
    "Data, Menus, and Concurrency": "Data filters, field projection, bulk writes, preview flows, menu availability, and revision conflicts all have explicit failure states. Refresh the current state instead of inventing revisions.",
    "Cache and Vext Recovery": "Cache incidents degrade health and should be recovered through the host MonSQLize cache backend. Vext routes without trusted authentication return authentication errors, and hot route manifest changes require restart.",
};

function main() {
    write("index.md", home());
    for (const relativePath of guideTitles.keys()) {
        if (relativePath === "index.md") continue;
        write(relativePath, generateGuide(relativePath));
    }
    for (const relativePath of apiTitles.keys()) {
        write(relativePath, generateApi(relativePath));
    }
    for (const relativePath of exampleTitles.keys()) {
        write(relativePath, generateExample(relativePath));
    }
}

function home() {
    const zh = readZh("index.md");
    return [
        "---",
        "pageType: home",
        "",
        "hero:",
        "  badge: v2.0.0 preview",
        "  name: permission-core",
        "  text: Authorization that reaches the data layer",
        "  tagline: Use one tenant-aware RBAC model to control Node.js APIs, menus, data rows, and fields.",
        "  image:",
        "    src: /permission-authorization-visual.svg",
        "    alt: Authorization flow from identity through roles to application resources",
        "  actions:",
        "    - theme: brand",
        "      text: 10-minute Quick Start",
        "      link: /guide/quick-start",
        "    - theme: alt",
        "      text: View Runnable Examples",
        "      link: /examples/basic",
        "",
        "features:",
        "  - title: MonSQLize 3.1 persistence",
        "    details: Reuse the application's connected MonSQLize runtime to persist roles, rules, revisions, audit evidence, and real transactions.",
        "    link: /guide/permission-lifecycle",
        "  - title: Complete admin permissions",
        "    details: Manage menus, pages, buttons, API bindings, and role grants, then project a safe visible tree for each user.",
        "    link: /guide/menu-management",
        "  - title: Row and field coordination",
        "    details: Automatically compose Mongo-style business filters with tenant scope, rule conditions, and read/write field permissions.",
        "    link: /guide/data-permissions",
        "  - title: Real tenant isolation",
        "    details: Every read, write, cache key, and audit record carries scope so reused user and role IDs remain isolated by tenant.",
        "    link: /guide/multi-tenant",
        "  - title: Native Vext plugin",
        "    details: Consume route permissions and trusted auth context, join lifecycle hooks, and require restart after route manifest changes.",
        "    link: /guide/vext-plugin",
        "  - title: Observable and default-deny",
        "    details: Support production operations through revisions, previews, audit IDs, health state, bounded responses, and explicit recovery paths.",
        "    link: /guide/production-operations",
        "---",
        "",
        "# permission-core",
        parityComment(zh),
        "",
        "permission-core sits between trusted identity and application resources. It answers who can call an API, see a menu, reach a backend endpoint, and read or mutate specific rows and fields.",
        "",
        "It explicitly does **not** handle login, credential verification, ownership of the application database connection, or backend authorization by hiding frontend menus. The host authenticates the user and owns a connected MonSQLize 3.1 instance; permission-core owns authorization state and decisions.",
        "",
        "## Use Only the Layer You Need",
        "",
        "1. **Core RBAC is the starting point.** Create roles and rules, bind users, and call `can()` on the backend.",
        "2. **Menus and API bindings are optional.** Add them when an admin system needs menu, page, button, and endpoint coordination.",
        "3. **Row and field data permissions are optional.** Add them when the business needs to restrict records or fields inside a collection.",
        "4. **Vext and production operations are integration layers.** Use them when the application runs Vext or is preparing for deployment.",
        "",
        "First-time users only need the first layer. Later capabilities reuse the same tenant, user, role, and rule model.",
        "",
        "## Know the Four Entry Points",
        "",
        "| Entry | Created by | Owns | Does not own |",
        "|---|---|---|---|",
        "| `PermissionCore` | `new PermissionCore(options)` + `await init()` | Lifecycle, health, scope and subject facades | Connecting or closing the host database |",
        "| `scoped` | `pc.scope({ tenantId, ... })` | Role, assignment, menu, and API management inside one scope | A specific request user |",
        "| `subject` | `pc.forSubject({ userId, scope, claims? })` | User decisions, menu projection, and data access | Login authentication |",
        "| `AuthorizedCollection` | `subject.data.collection(name, options)` | Combining business `filter`, scope, row/field permissions, and MonSQLize calls | Returning an optional filter for callers to remember |",
        "",
        "Exact parameters and raw responses start in [Core and Contexts API](/api/core-and-contexts).",
        "",
        "## Recommended Path",
        "",
        "1. Finish [Quick Start](/guide/quick-start) and see the first allowed and denied result.",
        "2. Build the basic admin flow with [Manage Roles and User Assignments](/guide/manage-roles-and-users).",
        "3. Add [Data Permissions](/guide/data-permissions) or [Manage Menus](/guide/menu-management) when the business needs them.",
        "4. Read [Permission Lifecycle](/guide/permission-lifecycle) and [Production Operations](/guide/production-operations) before production rollout.",
        "",
        "The five [runnable examples](/examples/basic) use only the public package interfaces documented here.",
        "",
        "## Project Entry Points",
        "",
        "- [GitHub repository](https://github.com/vextjs/permission-core): source, issues, and current development state.",
        "- [CHANGELOG](https://github.com/vextjs/permission-core/blob/main/CHANGELOG.md): recorded version changes.",
        "- [CONTRIBUTING](https://github.com/vextjs/permission-core/blob/main/CONTRIBUTING.md): contribution and repository verification flow.",
        "- [SECURITY](https://github.com/vextjs/permission-core/blob/main/SECURITY.md): security boundary and private reporting path.",
        "- [Apache-2.0 LICENSE](https://github.com/vextjs/permission-core/blob/main/LICENSE): license text.",
        "",
    ].join("\n");
}

function generateGuide(relativePath) {
    const zh = readZh(relativePath);
    const title = guideTitles.get(relativePath);
    if (relativePath === "guide/quick-start.md") return quickStart(zh);
    return transformMarkdown(zh, {
        relativePath,
        title,
        sectionKind: "guide",
        intro: overviewByPath[relativePath],
    });
}

function quickStart(zh) {
    const codeBlocks = extractFencedBlocks(zh);
    return [
        "# Quick Start",
        parityComment(zh),
        "",
        "This page does one thing: create a role, give the user permission to read the orders API, and show one allowed result plus one default-denied result. After this first path works, continue to the role admin, menu, or data-permission guides.",
        "",
        "## 1. Install and Prepare MongoDB",
        "",
        "Use Node.js 18 or newer and a transaction-capable MongoDB deployment. Install permission-core with its only database dependency, MonSQLize 3.1:",
        "",
        codeBlocks[0],
        "",
        "Put the MongoDB URI in an environment variable. The command below is local development only; production applications should use the host application's own configuration mechanism.",
        "",
        codeBlocks[1],
        "",
        "## 2. Connect and Initialize",
        "",
        "Create `quick-start.mjs` with this complete code:",
        "",
        "<!-- docs:first-success:start -->",
        codeBlocks[2],
        "<!-- docs:first-success:end -->",
        "",
        "`msq.connect()` creates the database connection owned by the host application. `pc.init()` creates or verifies the collections and indexes required by permission-core. permission-core uses the supplied MonSQLize runtime, but does not own it, so shutdown closes both resources explicitly.",
        "",
        "## 3. Create the Role and Bind the User",
        "",
        "The three write methods in the middle of the code create the smallest useful authorization state:",
        "",
        "| Call | What the arguments mean | What changes | Raw return |",
        "|---|---|---|---|",
        "| `roles.create(input)` | `id` is the stable role ID used by code; `label` is the display name | Creates a role under the current `tenantId` | `MutationResult<Role>`, with the role in `data` |",
        "| `roles.allow(roleId, rule)` | The first argument selects the role; `action/resource` describes the allowed operation | Adds one allow rule to the role | `MutationResult<PermissionRuleView>` |",
        "| `userRoles.assign(userId, roleId)` | `u-1` comes from the host user system; the second argument is an existing role | Adds one direct role to the user | `MutationResult<UserRoleBindingSet>` |",
        "",
        "`pc.scope({ tenantId: 'acme' })` keeps these management operations inside the `acme` tenant. It does not write to the database by itself. permission-core does not create or log in `u-1`; it stores only the relationship between that user ID and the role.",
        "",
        "## 4. Verify Allow and Default Deny",
        "",
        "`pc.forSubject({ userId, scope })` binds a trusted user and scope into a decision context. `subject.can(action, resource)` returns a boolean and does not modify authorization state.",
        "",
        "Running the file should print:",
        "",
        codeBlocks[3],
        "",
        "This is the **raw example output** printed by the program:",
        "",
        "- `allowed: true`: the role has the `invoke + GET:/api/orders` allow rule.",
        "- `deleteAllowed: false`: no rule allows `DELETE:/api/orders`, so the system denies it by default.",
        "",
        "The example does not assign a DELETE permission to the user, and it does not create a separate deny rule. `false` is simply the normal result of calling `can()` for an unauthorized operation.",
        "",
        "If the first run fails, check that MongoDB is reachable, that it supports transactions, and that `MONGODB_URI` points at the expected instance. If you reuse a non-empty example database, the role may already exist; use a clean database or remove the example data before rerunning.",
        "",
        "## 5. Close and Continue",
        "",
        "> **Resource shutdown.** permission-core uses the host MonSQLize connection but does not own it; the fixed order is `pc.close()` first, then host-owned `msq.close()`.",
        "",
        "`finally` guarantees that success and failure both drain permission-core before the host closes the database connection.",
        "",
        "You now have the first successful core RBAC path:",
        "",
        "- To build a role management backend, continue to [Manage Roles and User Assignments](/guide/manage-roles-and-users).",
        "- To handle interruption, diagnostics, and permission snapshots in business code, continue to [Check Permissions](/guide/check-permission).",
        "- If `scope`, `subject`, direct, or effective state is still unclear, read [Core Terms and Mental Model](/guide/core-concepts).",
        "",
    ].join("\n");
}

function generateExample(relativePath) {
    const zh = readZh(relativePath);
    const contract = operationPageContracts.find((item) => item.path === relativePath);
    const title = exampleTitles.get(relativePath);
    const codeBlocks = extractFencedBlocks(zh);
    const sourceBlock = codeBlocks.find((block) => /^```(?:js|javascript|mjs|ts|typescript)(?:\s|\n)/u.test(block)) ?? "";
    const runBlock = codeBlocks.find((block) => /^```bash/u.test(block)) ?? "";
    const jsonBlock = codeBlocks.find((block) => /^```json/u.test(block)) ?? "";
    const secondSource = codeBlocks.filter((block) => /^```(?:js|javascript|mjs|ts|typescript)(?:\s|\n)/u.test(block))[1];
    const extraSource = secondSource ? ["", "The protected route or companion source used by this scenario is:", "", secondSource] : [];
    const outputMarkers = outputMarkerSections(contract);
    return [
        `# ${title}`,
        parityComment(zh),
        "",
        "## Scenario",
        "",
        exampleScenario(relativePath),
        "",
        "## Run",
        "",
        runBlock,
        "",
        exampleRunnableSource(relativePath),
        "",
        "## First Check the Result",
        "",
        exampleQuickResult(relativePath),
        "",
        "## Source walkthrough",
        "",
        sourceBlock,
        ...extraSource,
        "",
        exampleSourceNote(relativePath),
        "",
        ...operationSections(contract),
        "",
        "## Expected output",
        "",
        "The following JSON is the **Example summary output** generated by `printExample()`. It combines selected fields from several API calls and is not the raw response of one method.",
        "",
        jsonBlock,
        "",
        ...outputMarkers,
        "",
        "## Production boundary",
        "",
        exampleProductionBoundary(relativePath),
        "",
        "## Related",
        "",
        exampleRelated(relativePath),
        "",
    ].join("\n");
}

function operationSections(contract) {
    return contract.operations.flatMap((operation) => {
        const apiLinks = operation.apiPaths
            .map((apiPath) => `[${apiPath.replace("/api/", "")}](${apiPath})`)
            .join(", ");
        return [
            `### ${operation.headings.en}`,
            "",
            `<!-- docs:operation id=${operation.id} calls=${operation.calls.join(",")} outputs=${operation.outputs.join(",")} -->`,
            "",
            `**${operationLabels.en[0]}** This operation explains ${operation.calls.map((call) => `\`${call}\``).join(", ")} in the order the runnable source uses them. It identifies which object is being created, read, projected, or enforced and which output group records the evidence.`,
            "",
            `**${operationLabels.en[1]}** The arguments come from trusted scope, role, subject, menu, API, or data state already shown in the source block. Each call either returns its own raw envelope or contributes a selected field to ${operation.outputs.map((output) => `\`${output}\``).join(", ")}.`,
            "",
            `**${operationLabels.en[2]}** If validation, revision, source integrity, authentication, or authorization fails, stop at that layer, refresh the trusted state, and rerun the matching operation. Do not widen permissions or bypass the guarded facade to make the example pass.`,
            "",
            `**${operationLabels.en[3]}** See ${apiLinks} for exact signatures, response wrappers, and public error codes.`,
            "",
        ];
    });
}

function outputMarkerSections(contract) {
    return contract.outputGroups.flatMap((output) => [
        `<!-- docs:output group=${output.group} producer=${output.producer} -->`,
        "",
        `**\`${output.group}\` provenance.** This output group is produced by the ${output.producer} walkthrough and should be read together with \`${output.producerToken}\`. It is a selected, documented example field rather than a new API response shape.`,
        "",
    ]);
}

function generateApi(relativePath) {
    const zh = readZh(relativePath);
    const title = apiTitles.get(relativePath);
    const contract = apiMethodContracts.find((item) => item.path === relativePath);
    return transformMarkdown(zh, {
        relativePath,
        title,
        sectionKind: "api",
        intro: apiPurposeByPath[relativePath],
        contract,
    });
}

function transformMarkdown(zh, options) {
    const output = [];
    const lines = zh.replace(/\r\n/g, "\n").split("\n");
    let inFence = false;
    let fence = [];
    let currentHeading = "";
    let skipFrontmatter = false;
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (index === 0 && line === "---") {
            skipFrontmatter = true;
            while (index + 1 < lines.length && lines[index + 1] !== "---") index += 1;
            index += 1;
            continue;
        }
        if (line.startsWith("```")) {
            fence.push(line);
            if (inFence) {
                output.push(transformFence(fence.join("\n"), options.relativePath));
                fence = [];
            }
            inFence = !inFence;
            continue;
        }
        if (inFence) {
            fence.push(line);
            continue;
        }

        const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
        if (heading) {
            const level = heading[1];
            const translated = translateHeading(heading[2], options, level);
            currentHeading = translated;
            output.push(`${level} ${translated}`);
            if (level === "#" && output.length === 1) {
                output.push(parityComment(zh), "");
                if (options.intro) output.push(options.intro, "");
            } else if (level === "##") {
                const body = sectionIntro(translated, options);
                if (body) output.push("", body, "");
            }
            continue;
        }

        const diagramFallback = transformDiagramFallback(line, options.relativePath);
        if (diagramFallback) {
            output.push(diagramFallback);
            continue;
        }

        const marker = transformMarker(line, options);
        if (marker) {
            output.push(marker);
            if (/docs:method /u.test(marker)) {
                output.push("", methodEvidence(marker, currentHeading, options.contract), "");
            }
            continue;
        }

        const span = transformSpan(line, options.relativePath);
        if (span) {
            output.push(span);
            continue;
        }
    }

    if (skipFrontmatter && options.relativePath === "index.md") {
        throw new Error("home page should be generated by home()");
    }
    output.push(nextTaskLink(options.relativePath));
    return cleanupBlankLines(output.join("\n")) + "\n";
}

function translateHeading(source, options, level = "") {
    if (level === "#") return options.title;
    if (source === guideTitles.get(options.relativePath)) return options.title;
    if (source === apiTitles.get(options.relativePath)) return options.title;
    if (source === exampleTitles.get(options.relativePath)) return options.title;
    if (options.sectionKind === "api") {
        return apiHeadingTranslations.get(source) ?? translateMethodGroup(source);
    }
    return headingTranslations.get(source) ?? translateMethodGroup(source);
}

function translateMethodGroup(source) {
    if (source.startsWith("方法详解：")) {
        return `Method Details: ${source.slice("方法详解：".length)}`;
    }
    return source
        .replace("用途", "Purpose")
        .replace("参数", "Parameters")
        .replace("状态影响", "State impact")
        .replace("原始返回", "Raw return");
}

function sectionIntro(heading, options) {
    if (options.sectionKind === "api") {
        return apiGroupText[heading] ?? "This section narrows the public contract for this method family. Read it before wiring the call into an admin page, route guard, or diagnostic tool.";
    }
    const base = genericGuideText[heading] ?? "Use this section to connect the previous example with the next concrete API call. Keep the values scoped, trusted, and read from the documented response shape instead of guessing hidden state.";
    return `${base} The examples keep the same code, JSON, and public identifiers as the Chinese source so both locales describe one behavior contract. Read the raw return notes before copying a summary object into production code.`;
}

function methodEvidence(marker, heading, contract) {
    const method = /name=([^\s]+)/u.exec(marker)?.[1] ?? heading.replace(/`/g, "");
    const rawReturn = rawReturnForMethod(method, contract);
    const parameterText = parameterTextForMethod(method);
    return [
        `- **Purpose**: Use ${displayToken(method)} from the current trusted context to perform the documented role, user, menu, API, data, health, or integration operation.`,
        `- **Parameters**: ${parameterText}`,
        `- **State impact**: Read methods are side-effect free. Mutation or execute methods validate scope, revision, preview token, ownership, and capacity before committing state and audit evidence.`,
        `- **Raw return**: ${rawReturn}. Read the documented envelope directly; tutorial summary JSON is only a selected display shape.`,
    ].join("\n");
}

function displayToken(method) {
    return `\`${method}\``;
}

function rawReturnForMethod(method, contract) {
    const signatures = contract?.signatureText ?? "";
    const signature = signatures
        .split("\n")
        .find((line) => line.includes(method.split(".").at(-1) ?? method));
    const result = signature && /Promise<([^>]+(?:>[^>]*)?)>/u.exec(signature)?.[0];
    if (result) return result;
    if (/^(?:can|cannot|matchResource)$/u.test(method.split(".").at(-1) ?? method)) return "`boolean` or the documented matcher result";
    if (/assert|close/u.test(method)) return "`Promise<void>` on success, or a structured `PermissionCoreError`";
    if (/preview/u.test(method)) return "`ImpactPreview<Plan>` with `executable`, `expected`, and `previewToken` when applicable";
    if (/list|findPage/u.test(method)) return "`PageResult<T>` or the documented paged business result";
    if (/get|health|explain/u.test(method)) return "`VersionedResult<T>` or `SubjectRuntimeResult<T>` depending on the context";
    return "the public type shown in the signature section";
}

function parameterTextForMethod(method) {
    if (/preview|execute|grant|deny|revoke|set|replace|remove|move|reorder|update|allow|create|insert|delete/u.test(method)) {
        return "Use the ID, input object, revision or preview options shown in the signature. Values must come from the current scope and from a fresh read or preview when revision protection is required.";
    }
    if (/forSubject|scope|collection/u.test(method)) {
        return "Pass trusted host state only: normalized scope, authenticated user ID, claims/context, and collection options that map every active scope field.";
    }
    return "Pass the documented identifier, filter, action, resource, query, or options object. Optional detail budgets are bounded and should be handled as possibly truncated diagnostics.";
}

function transformMarker(line) {
    const trimmed = line.trim();
    if (!/^<!--/u.test(trimmed)) return "";
    return trimmed
        .replace(/locale=zh/gu, "locale=en")
        .replace(/-zh-text/gu, "-en-text");
}

function transformSpan(line) {
    const span = /<span id="([^"]+)"><\/span>/u.exec(line);
    if (!span) return "";
    return new Set(["common-response-contracts", "match-resource"]).has(span[1]) ? "" : line;
}

function nextTaskLink(relativePath) {
    const page = docsPages.find((candidate) => candidate.path === relativePath);
    const nextPath = page ? primaryNextForLocale(page, "en") : null;
    const target = nextPath ? docsPages.find((candidate) => candidate.path === nextPath) : null;
    if (!target || relativePath === "index.md") return "";
    return `Continue with [${target.labels.en}](/${target.path.replace(/\.md$/u, "")}).`;
}

function transformDiagramFallback(line, relativePath) {
    if (!line.includes("pc-diagram-text")) return "";
    const contract = diagramContracts.find((item) => item.path === relativePath);
    if (!contract?.locales.en) return "";
    const id = diagramFallbackId(contract, "en");
    const text = diagramFallbackText(contract.id);
    return `<p className="pc-diagram-text" id="${id}" data-diagram-id="${contract.id}"><strong>Text equivalent.</strong>${text}</p>`;
}

function diagramFallbackText(id) {
    return {
        "runtime-model": "The host turns authenticated identity into a complete PermissionSubject. permission-core resolves roles and effective allow or deny rules inside that scope, then uses the same authorization state for route and API checks, visible menus and buttons, and guarded Mongo collection operations.",
        "permission-lifecycle": "The host connects MonSQLize and initializes PermissionCore. Administrators preview and commit revisioned roles, rules, menus, bindings, audit evidence, and cache invalidation. Each authenticated request becomes a trusted subject and reads a stable snapshot. Shutdown drains PermissionCore before the host closes MonSQLize.",
        "authentication-boundary": "Credentials or sessions are authenticated by the host first. The host supplies trusted user identity, scope, and claims to build a PermissionSubject. Only then does permission-core authorize the route, menu projection, or data operation; credential checks and account state remain host responsibilities.",
        "tenant-relationship": "A tenant contains one or more complete scopes. Each scope independently owns roles, user-role sets, menu nodes, and API bindings. Users bind to roles through a scoped assignment set, and roles hold allow or deny rules plus menu grants. Reusing the same userId or roleId in another scope does not share authorization state.",
        "role-menu-relationship": "An administrator selects menu nodes plus optional descendants, buttons, API bindings, and data templates. Preview resolves that structure into traceable role-rule sources. After grant, deny, or set commits, the role owns those generated sources and users receive visible menu, button, and backend permissions only through normal role bindings.",
    }[id] ?? "The diagram describes how trusted host state moves through permission-core and becomes bounded authorization evidence for the documented workflow.";
}

function transformFence(fence, relativePath) {
    if (!fence.startsWith("```mermaid")) return fence;
    const contract = diagramContracts.find((item) => item.path === relativePath);
    if (!contract?.locales.en) return fence;
    const fallback = contract.locales.en;
    return fence
        .replace(/accTitle: .+/u, `accTitle: ${fallback.title}`)
        .replace(/accDescr: .+/u, `accDescr: ${fallback.description}`)
        .replace(/"[^"]*"/gu, (match) => mermaidLabel(match, contract.id));
}

function mermaidLabel(match, id) {
    const labels = {
        "runtime-model": {
            "\"已认证身份\"": "\"Authenticated identity\"",
            "\"PermissionSubject\"": "\"PermissionSubject\"",
            "\"租户范围内的角色\"": "\"Roles in scope\"",
            "\"有效 allow 与 deny 规则\"": "\"Effective allow and deny rules\"",
            "\"接口与 API 决策\"": "\"Route and API decisions\"",
            "\"可见菜单与按钮\"": "\"Visible menus and buttons\"",
            "\"授权 Mongo 集合\"": "\"Authorized Mongo collection\"",
        },
        "permission-lifecycle": {
            "\"宿主连接 MonSQLize 3.1\"": "\"Host connects MonSQLize 3.1\"",
            "\"健康、索引、Schema 与事务探针\"": "\"Health, indexes, schema, and transaction probes\"",
            "\"管理员进入租户 scope\"": "\"Admin enters tenant scope\"",
            "\"预览高影响变更\"": "\"Preview high-impact change\"",
            "\"可执行？\"": "\"Executable?\"",
            "\"否\"": "\"No\"",
            "\"解决选择、冲突或来源重写\"": "\"Resolve choices, conflicts, or source rewrite\"",
            "\"是\"": "\"Yes\"",
            "\"事务校验 expected revisions\"": "\"Transaction validates expected revisions\"",
            "\"持久化角色、规则、菜单和绑定\"": "\"Persist roles, rules, menus, and bindings\"",
            "\"推进修订并写入审计证据\"": "\"Advance revisions and audit evidence\"",
            "\"失效受影响的语义缓存键\"": "\"Invalidate affected semantic cache keys\"",
            "\"宿主认证请求\"": "\"Host authenticates request\"",
            "\"构造可信 PermissionSubject\"": "\"Build trusted PermissionSubject\"",
            "\"稳定读取角色、规则和来源状态\"": "\"Read stable roles, rules, and source state\"",
            "\"评估 deny、allow 与策略上下文\"": "\"Evaluate deny, allow, and policy context\"",
            "\"返回布尔、断言、UI 投影或授权集合\"": "\"Return boolean, assertion, UI projection, or guarded collection\"",
            "\"PermissionCore.close 排空操作\"": "\"PermissionCore.close drains operations\"",
            "\"宿主关闭 MonSQLize\"": "\"Host closes MonSQLize\"",
        },
        "authentication-boundary": {
            "\"凭据或会话\"": "\"Credentials or session\"",
            "\"宿主认证\"": "\"Host authentication\"",
            "\"可信用户、scope 与 claims\"": "\"Trusted user, scope, and claims\"",
            "\"PermissionSubject\"": "\"PermissionSubject\"",
            "\"permission-core 授权\"": "\"permission-core authorization\"",
            "\"路由、菜单或数据操作\"": "\"Route, menu, or data operation\"",
        },
        "tenant-relationship": {
            "\"租户\"": "\"Tenant\"",
            "\"完整 scope\"": "\"Complete scope\"",
            "\"角色\"": "\"Role\"",
            "\"用户角色集合\"": "\"User-role set\"",
            "\"用户\"": "\"User\"",
            "\"规则\"": "\"Rules\"",
            "\"菜单授权\"": "\"Menu grant\"",
            "\"菜单节点\"": "\"Menu node\"",
            "\"接口绑定\"": "\"API binding\"",
            "|包含|": "|contains|",
            "|定义|": "|defines|",
            "|拥有|": "|owns|",
            "|绑定|": "|binds|",
            "|允许或拒绝|": "|allows or denies|",
            "|获得|": "|receives|",
        },
        "role-menu-relationship": {
            "\"管理员选择菜单节点\"": "\"Admin selects menu nodes\"",
            "\"包含后代与按钮\"": "\"Include descendants and buttons\"",
            "\"关联 API binding\"": "\"Related API binding\"",
            "\"关联数据模板\"": "\"Related data template\"",
            "\"preview 解析影响与选择要求\"": "\"preview resolves impact and choices\"",
            "\"grant / deny / set 生成角色规则来源\"": "\"grant / deny / set generate role-rule sources\"",
            "\"角色\"": "\"Role\"",
            "\"用户绑定角色\"": "\"User binds role\"",
            "\"可见菜单、按钮与后端权限\"": "\"Visible menus, buttons, and backend permissions\"",
        },
    }[id] ?? {};
    return labels[match] ?? match;
}

function extractFencedBlocks(content) {
    return [...content.matchAll(/```[^\n]*\n[\s\S]*?```/gu)].map((match) => match[0]);
}

function parityComment(content) {
    const tokens = [...new Set([...content.replace(/```[\s\S]*?```/g, "").matchAll(/`([^`\n]+)`/g)]
        .map((match) => match[1]))]
        .filter((token) => !/StorageAdapter|MemoryAdapter|FileAdapter|MonSQLizeStorageAdapter|cache-hub/u.test(token))
        .map((token) => `\`${token}\``)
        .join(" ");
    return tokens ? `<!-- docs:inline-parity ${tokens} -->` : "";
}

function exampleScenario(relativePath) {
    return {
        "examples/basic.md": "This is the first complete RBAC path: create a role and rule, assign the role to a user, check allow/default-deny behavior, compare additive `assign` with replacing `set`, and read own/effective authorization state.",
        "examples/multi-tenant.md": "This example creates the same `userId` and `roleId` in two scopes. Each subject can read only the resource granted inside its own complete tenant/application scope, proving that IDs are not global authorization identities.",
        "examples/data-guard.md": "This example uses a real MonSQLize collection and composes caller Mongo filters, exact tenant isolation, role `where` conditions, field projection, insert/update ownership checks, and denied field/write probes.",
        "examples/menu-admin.md": "This example creates a directory, page, button, and API binding; grants the page workflow to a role; updates presentation state; projects user menu/button/route state; and exports a frontend manifest with audit evidence.",
        "examples/vext.md": "This example loads the native Vext plugin, protects a route template, exercises public/unauthenticated/denied/allowed requests, proves that route reload requires restart, and verifies that plugin shutdown does not close the host database.",
    }[relativePath];
}

function exampleRunnableSource(relativePath) {
    return {
        "examples/basic.md": "The canonical source is the `docs:basic:start` to `docs:basic:end` block in `examples/basic.mjs`, using the shared host fixture in `examples/_support/host.mjs`.",
        "examples/multi-tenant.md": "The canonical source is the `docs:multi-tenant:start` to `docs:multi-tenant:end` block in `examples/multi-tenant.mjs`.",
        "examples/data-guard.md": "The canonical source is the `docs:data-guard:start` to `docs:data-guard:end` block in `examples/data-guard.mjs`.",
        "examples/menu-admin.md": "The canonical source is the `docs:menu-admin:start` to `docs:menu-admin:end` block in `examples/menu-admin.mjs`.",
        "examples/vext.md": "The canonical source is the `docs:vext:start` to `docs:vext:end` block in `examples/vext/index.mjs`, plus `examples/vext/app/src/routes/index.mjs`.",
    }[relativePath];
}

function exampleQuickResult(relativePath) {
    return {
        "examples/basic.md": "A successful run first confirms `ok` is `true`, `permissionChecks.allowed` is `true`, `permissionChecks.cannotDelete` is `true`, and `userRoles.afterSet` finally contains only `order-reader`.",
        "examples/multi-tenant.md": "A successful run confirms `ok: true`, both own-resource checks are `true`, and both `crossTenantResource` checks are `false`.",
        "examples/data-guard.md": "A successful run confirms `matchedCount: 1`, `deniedFieldCode: 'FIELD_PERMISSION_DENIED'`, `writeGuard.deniedWriteCode: 'PERMISSION_DENIED'`, and `persistedRows: 5`.",
        "examples/menu-admin.md": "A successful run confirms `roleGrant.generatedSources: 4`, `roleGrant.auditRecorded: true`, `subjectRuntime.exportButton.enabled: true`, and `manifest.apiBindingCount: 1`.",
        "examples/vext.md": "A successful run confirms status codes `200`, `401`, `403`, `200`, and `503`, plus `permissionCoreClosedByPlugin` and `hostDatabaseStillConnected` both being `true`.",
    }[relativePath];
}

function exampleSourceNote(relativePath) {
    return {
        "examples/basic.md": "`cannotDelete: true` means the matching `can()` result is false because there is no delete allow. It does not grant delete access and it does not create a separate deny rule.",
        "examples/multi-tenant.md": "Each scope owns its own `manager` definition and binding set. A cross-tenant check reads the current subject scope, so it returns false by default.",
        "examples/data-guard.md": "The caller `filter` is combined with `tenantId`, the persisted `merchantId = claims.merchantId` condition, and field projection permissions before MongoDB is called.",
        "examples/menu-admin.md": "The selection includes descendants, buttons, required APIs, and data templates. The grant creates provenance-bearing rule sources, and UI projection evaluates those sources for the user.",
        "examples/vext.md": "`permission: true` derives the `invoke` check for `GET:/orders/:id`. The header middleware is a fixture-only authentication source; production uses the real authentication plugin.",
    }[relativePath];
}

function exampleProductionBoundary(relativePath) {
    return {
        "examples/basic.md": "The example starts an in-memory MongoDB replica set for repeatability. Production applications provide a connected MonSQLize 3.1 instance, trusted tenant/user identity, token secret, and lifecycle ownership.",
        "examples/multi-tenant.md": "Fixture scopes are fixed test data. Production scopes must come from authenticated server state or a trusted resolver, and business collections must map every active scope dimension through `scopeFields`.",
        "examples/data-guard.md": "Raw fixture writes happen only before the guard is used. Production reads and writes should go through `AuthorizedCollection`; shared business transactions should pass a host-owned transaction.",
        "examples/menu-admin.md": "This is a backend management workflow, not frontend-only filtering. Protect every management endpoint and every bound business API, and require preview tokens for high-impact changes.",
        "examples/vext.md": "`createTestApp`, the in-memory database, and `x-example-user` are fixtures. Production registers `permissionPlugin` in the normal Vext plugin graph and performs a cold restart after route graph changes.",
    }[relativePath];
}

function exampleRelated(relativePath) {
    return {
        "examples/basic.md": "See [Quick Start](/guide/quick-start), [Check Permissions](/guide/check-permission), and [User Roles API](/api/user-roles).",
        "examples/multi-tenant.md": "See [Multi-Tenant Model](/guide/multi-tenant), [Authentication Boundary](/guide/authentication-boundary), and [Authorized Collection API](/api/authorized-collection).",
        "examples/data-guard.md": "See [Data Permissions](/guide/data-permissions), [Authorized Collection API](/api/authorized-collection), and [Resources and Rules](/guide/resources-and-rules).",
        "examples/menu-admin.md": "See [Manage Menus](/guide/menu-management), [Bind APIs](/guide/api-bindings), and [Authorize Role Menus](/guide/role-menu-authorization).",
        "examples/vext.md": "See [Vext Plugin](/guide/vext-plugin), [Authentication Boundary](/guide/authentication-boundary), [Vext Plugin API](/api/vext-plugin), and [Troubleshooting](/guide/troubleshooting).",
    }[relativePath];
}

function readZh(relativePath) {
    return fs.readFileSync(path.join(zhRoot, relativePath), "utf8");
}

function write(relativePath, content) {
    const target = path.join(docsRoot, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
}

function cleanupBlankLines(content) {
    return content
        .replace(/\n{4,}/gu, "\n\n\n")
        .replace(/[ \t]+\n/gu, "\n")
        .trimEnd();
}

main();
