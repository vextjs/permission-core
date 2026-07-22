export const docsLocales = ["en", "zh"];

export const diagramContracts = [
    {
        id: "runtime-model",
        path: "guide/introduction.md",
        kind: "flowchart",
        locales: {
            en: {
                title: "permission-core runtime model",
                description: "An authenticated identity becomes a scoped permission subject whose effective rules drive API, menu, button, and data decisions.",
            },
            zh: {
                title: "permission-core 运行模型",
                description: "已认证身份成为带范围的权限主体，有效规则随后驱动接口、菜单、按钮和数据访问决策。",
            },
        },
    },
    {
        id: "permission-lifecycle",
        path: "guide/permission-lifecycle.md",
        kind: "flowchart",
        locales: {
            en: {
                title: "Permission lifecycle",
                description: "The host initializes storage, administrators commit revisioned permission state, requests evaluate a trusted subject, and shutdown drains permission work before the host database closes.",
            },
            zh: {
                title: "权限生命周期",
                description: "宿主初始化存储，管理员提交带修订的权限状态，请求评估可信主体，关闭时先排空权限操作再关闭宿主数据库。",
            },
        },
    },
    {
        id: "authentication-boundary",
        path: "guide/authentication-boundary.md",
        kind: "flowchart",
        locales: {
            en: {
                title: "Authentication and authorization boundary",
                description: "The host authenticates credentials and supplies trusted identity, scope, and claims before permission-core authorizes a route, menu, or data operation.",
            },
            zh: {
                title: "认证与授权边界",
                description: "宿主先认证凭据并提供可信身份、范围和声明，再由 permission-core 授权路由、菜单或数据操作。",
            },
        },
    },
    {
        id: "tenant-relationship",
        path: "guide/multi-tenant.md",
        kind: "flowchart TD",
        locales: {
            en: {
                title: "Tenant, user, role, menu, and API relationships",
                description: "Each complete scope owns independent roles, user-role sets, rules, menu grants, menu nodes, and API bindings even when identifiers are reused in another tenant.",
            },
            zh: {
                title: "租户、用户、角色、菜单与接口关系",
                description: "每个完整范围独立拥有角色、用户角色集合、规则、菜单授权、菜单节点和接口绑定，即使另一个租户复用了相同标识。",
            },
        },
    },
    {
        id: "role-menu-relationship",
        path: "guide/role-menu-authorization.md",
        kind: "flowchart LR",
        locales: {
            en: {
                title: "Role-menu authorization relationship",
                description: "A saved menu config supplies grantable menus, views, APIs, actions, and response fields; role-menu grants and user-role bindings determine the subject runtime projection.",
            },
            zh: {
                title: "角色菜单授权关系",
                description: "已保存的菜单配置提供可授权的菜单、页面、接口、操作和响应字段，角色菜单授权与用户角色绑定共同决定用户运行时投影。",
            },
        },
    },
    {
        id: "menu-config-lifecycle",
        path: "guide/menu-management.md",
        kind: "flowchart LR",
        locales: {
            en: {
                title: "Menu config to API protection flow",
                description: "The admin side creates a menu config, menus, and views, then configures page load APIs, action APIs or UI permissions, and response fields. Role grants assign those capabilities, and backend guards protect APIs and response fields.",
            },
            zh: {
                title: "菜单配置到接口保护流程",
                description: "管理端先创建菜单配置、菜单和页面，再配置页面加载接口、按钮接口或 UI 权限、接口响应字段；随后给角色授权这些能力，并在后端保护接口和响应字段。",
            },
        },
    },
];

export const verifiedOperationGuidePaths = [
    "guide/quick-start.md",
    "guide/check-permission.md",
    "guide/data-permissions.md",
    "guide/menu-management.md",
    "guide/api-bindings.md",
    "guide/role-menu-authorization.md",
    "guide/role-inheritance.md",
    "guide/multi-tenant.md",
    "guide/vext-plugin.md",
];

export const operationLabels = {
    en: [
        "Purpose and target.",
        "State, arguments, and result.",
        "Failure and next step.",
        "API reference.",
    ],
    zh: [
        "目的与目标。",
        "状态、参数与结果。",
        "失败与下一步。",
        "API 参考。",
    ],
};

export const operationPageContracts = [
    {
        id: "basic",
        path: "examples/basic.md",
        operations: [
            {
                id: "basic-role-state",
                headings: { en: "1. Create the role state", zh: "1. 创建角色状态" },
                calls: ["roles.create", "roles.allow"],
                outputs: ["role", "reads.ownRules"],
                apiPaths: ["/api/roles"],
            },
            {
                id: "basic-assignment",
                headings: { en: "2. Add a role, then replace the direct-role set", zh: "2. 追加角色，再替换完整直接角色集合" },
                calls: ["userRoles.assign", "userRoles.getDirect", "userRoles.set"],
                outputs: ["userRoles.afterAssign", "userRoles.beforeSet", "userRoles.afterSet"],
                apiPaths: ["/api/user-roles"],
            },
            {
                id: "basic-decision",
                headings: { en: "3. Evaluate the concrete operation", zh: "3. 判定具体操作" },
                calls: ["forSubject", "can", "cannot", "explain"],
                outputs: ["permissionChecks"],
                apiPaths: ["/api/core-and-contexts"],
            },
            {
                id: "basic-effective-reads",
                headings: { en: "4. Read effective authorization state", zh: "4. 读取有效授权状态" },
                calls: ["roles.get", "roles.getOwnRules", "roles.getEffectiveRules", "roles.getChain", "userRoles.getEffective", "getPermissions", "getResources"],
                outputs: ["role", "userRoles.effective", "reads"],
                apiPaths: ["/api/roles", "/api/user-roles", "/api/core-and-contexts"],
            },
        ],
        outputGroups: [
            { group: "role", producer: "basic-role-state", producerToken: "roles.get" },
            { group: "userRoles", producer: "basic-assignment", producerToken: "assign" },
            { group: "permissionChecks", producer: "basic-decision", producerToken: "explain" },
            { group: "reads", producer: "basic-effective-reads", producerToken: "getPermissions" },
        ],
    },
    {
        id: "multi-tenant",
        path: "examples/multi-tenant.md",
        operations: [
            {
                id: "tenant-state-a",
                headings: { en: "1. Build tenant A authorization state", zh: "1. 构建租户 A 的授权状态" },
                calls: ["scope", "roles.create", "roles.allow", "userRoles.assign"],
                outputs: ["tenantA"],
                apiPaths: ["/api/core-and-contexts", "/api/roles", "/api/user-roles"],
            },
            {
                id: "tenant-state-b",
                headings: { en: "2. Build tenant B authorization state", zh: "2. 构建租户 B 的授权状态" },
                calls: ["scope", "roles.create", "roles.allow", "userRoles.assign"],
                outputs: ["tenantB"],
                apiPaths: ["/api/core-and-contexts", "/api/roles", "/api/user-roles"],
            },
            {
                id: "tenant-decisions",
                headings: { en: "3. Compare own-scope and cross-scope decisions", zh: "3. 对比本 scope 与跨 scope 判定" },
                calls: ["forSubject", "userRoles.getDirect", "can"],
                outputs: ["identity", "tenantA", "tenantB"],
                apiPaths: ["/api/core-and-contexts", "/api/user-roles"],
            },
        ],
        outputGroups: [
            { group: "identity", producer: "tenant-decisions", producerToken: "can" },
            { group: "tenantA", producer: "tenant-state-a", producerToken: "getDirect" },
            { group: "tenantB", producer: "tenant-state-b", producerToken: "can" },
        ],
    },
    {
        id: "data-guard",
        path: "examples/data-guard.md",
        operations: [
            {
                id: "data-policy",
                headings: { en: "1. Define row, field, and write policy", zh: "1. 定义行、字段与写入策略" },
                calls: ["roles.create", "roles.allow", "roles.deny", "userRoles.assign"],
                outputs: ["composition"],
                apiPaths: ["/api/roles"],
            },
            {
                id: "data-collection",
                headings: { en: "2. Create the authorized collection", zh: "2. 创建授权集合" },
                calls: ["forSubject", "data.collection"],
                outputs: ["matchedRows", "matchedCount", "deniedFieldCode", "writeGuard", "persistedRows"],
                apiPaths: ["/api/authorized-collection"],
            },
            {
                id: "data-read",
                headings: { en: "3. Read with composed constraints", zh: "3. 使用组合约束读取" },
                calls: ["find"],
                outputs: ["matchedRows", "matchedCount", "deniedFieldCode"],
                apiPaths: ["/api/authorized-collection"],
            },
            {
                id: "data-write",
                headings: { en: "4. Enforce ownership before and after writes", zh: "4. 在写入前后强制所有权" },
                calls: ["insertOne", "updateOne"],
                outputs: ["writeGuard", "persistedRows"],
                apiPaths: ["/api/authorized-collection"],
            },
        ],
        outputGroups: [
            { group: "composition", producer: "data-policy", producerToken: "roles.allow" },
            { group: "matchedRows", producer: "data-read", producerToken: "find" },
            { group: "matchedCount", producer: "data-read", producerToken: "find" },
            { group: "deniedFieldCode", producer: "data-read", producerToken: "find" },
            { group: "writeGuard", producer: "data-write", producerToken: "insertOne" },
            { group: "persistedRows", producer: "data-write", producerToken: "insertOne" },
        ],
    },
    {
        id: "menu-admin",
        path: "examples/menu-admin.md",
        operations: [
            {
                id: "menu-model",
                headings: { en: "1. Save the menu config", zh: "1. 保存菜单配置" },
                calls: ["menus.management.applyChanges"],
                outputs: ["config"],
                apiPaths: ["/api/menus"],
            },
            {
                id: "menu-role",
                headings: { en: "2. Create the role identity used by the workflow", zh: "2. 创建工作流使用的角色身份" },
                calls: ["roles.create"],
                outputs: ["subjectRuntime"],
                apiPaths: ["/api/roles", "/api/user-roles"],
            },
            {
                id: "menu-grant",
                headings: { en: "3. Preview and commit the role-menu grant", zh: "3. 预览并提交角色菜单授权" },
                calls: ["menuPermissions.preview", "menuPermissions.grant", "menuPermissions.getDirect"],
                outputs: ["roleGrant"],
                apiPaths: ["/api/role-menu-permissions"],
            },
            {
                id: "menu-subject",
                headings: { en: "4. Project the user's menu runtime and response", zh: "4. 投影用户菜单运行时与响应" },
                calls: ["forSubject", "getViewTree", "getViewState", "getActionMap", "filterResponse"],
                outputs: ["subjectRuntime"],
                apiPaths: ["/api/core-and-contexts", "/api/menus", "/api/role-menu-permissions"],
            },
        ],
        outputGroups: [
            { group: "config", producer: "menu-model", producerToken: "menus.management.applyChanges" },
            { group: "roleGrant", producer: "menu-grant", producerToken: "menuPermissions.grant" },
            { group: "subjectRuntime", producer: "menu-subject", producerToken: "filterResponse" },
        ],
    },
    {
        id: "vext",
        path: "examples/vext.md",
        operations: [
            {
                id: "vext-bootstrap",
                headings: { en: "1. Bootstrap the Vext test host and plugin", zh: "1. 启动 Vext 测试宿主与插件" },
                calls: ["createTestApp", "permissionPlugin.setup", "server:beforeListen"],
                outputs: ["responses.public"],
                apiPaths: ["/api/vext-plugin"],
            },
            {
                id: "vext-policy",
                headings: { en: "2. Seed the route permission policy", zh: "2. 准备路由权限策略" },
                calls: ["scope", "roles.create", "roles.allow", "userRoles.assign"],
                outputs: ["responses.permissionDenied", "responses.permissionAllowed"],
                apiPaths: ["/api/roles", "/api/user-roles", "/api/vext-plugin"],
            },
            {
                id: "vext-requests",
                headings: { en: "3. Exercise public, authentication, and permission outcomes", zh: "3. 覆盖公开、认证与权限结果" },
                calls: ["request.get"],
                outputs: ["responses", "allowedBody"],
                apiPaths: ["/api/vext-plugin"],
            },
            {
                id: "vext-reload",
                headings: { en: "4. Reject hot route reload", zh: "4. 拒绝热路由重载" },
                calls: ["routes:ready", "request.get"],
                outputs: ["responses.routeReloadRequiresRestart"],
                apiPaths: ["/api/vext-plugin"],
            },
            {
                id: "vext-close",
                headings: { en: "5. Close only plugin-owned state", zh: "5. 只关闭插件拥有的状态" },
                calls: ["testApp.close", "monsqlize.health"],
                outputs: ["lifecycle"],
                apiPaths: ["/api/vext-plugin", "/api/core-and-contexts"],
            },
        ],
        outputGroups: [
            { group: "responses", producer: "vext-requests", producerToken: "request.get" },
            { group: "allowedBody", producer: "vext-requests", producerToken: "request.get" },
            { group: "lifecycle", producer: "vext-close", producerToken: "testApp.close" },
        ],
    },
];

export const apiMethodContracts = [
    {
        path: "api/core-and-contexts.md",
        methods: [
            "PermissionCore", "init", "health", "scope", "forSubject", "can", "cannot", "assert",
            "getPermissions", "getResources", "explain", "close",
        ],
    },
    {
        path: "api/roles.md",
        methods: [
            "roles.create", "roles.get", "roles.list", "roles.update", "roles.previewAccessUpdate",
            "roles.executeAccessUpdate", "roles.getRemovalImpact", "roles.remove", "roles.allow",
            "roles.deny", "roles.revoke", "roles.previewRuleChange", "roles.executeRuleChange",
            "roles.previewReplaceRules", "roles.replaceRules", "roles.getOwnRules", "roles.listOwnRules",
            "roles.getEffectiveRules", "roles.getChain",
        ],
    },
    {
        path: "api/user-roles.md",
        methods: [
            "userRoles.assign", "userRoles.revoke", "userRoles.set", "userRoles.clear",
            "userRoles.getDirect", "userRoles.getEffective", "userRoles.listUsersByRole",
        ],
    },
    {
        path: "api/menus.md",
        methods: [
            "menus.config.preview", "menus.config.save", "menus.config.get", "menus.config.list",
            "menus.config.previewRemove", "menus.config.remove",
            "menus.config.previewChanges", "menus.config.applyChanges",
            "subject.menus.getViewTree", "subject.menus.getActionMap",
            "subject.menus.getViewState", "subject.menus.filterResponse",
        ],
    },
    {
        path: "api/api-bindings.md",
        methods: [
            "MenuConfigInput.load", "MenuConfigInput.actions", "MenuConfigInput.response",
        ],
    },
    {
        path: "api/role-menu-permissions.md",
        methods: [
            "roles.menuPermissions.preview", "roles.menuPermissions.grant", "roles.menuPermissions.deny",
            "roles.menuPermissions.revoke", "roles.menuPermissions.set", "roles.menuPermissions.getDirect",
            "roles.menuPermissions.listDirect", "roles.menuPermissions.getEffective",
            "roles.menuPermissions.getAuthorizationTree",
        ],
    },
    {
        path: "api/authorized-collection.md",
        methods: [
            "subject.data.collection", "authorizedCollection.find", "authorizedCollection.findOne",
            "authorizedCollection.count", "authorizedCollection.findAndCount", "authorizedCollection.findPage",
            "authorizedCollection.insertOne", "authorizedCollection.updateOne", "authorizedCollection.updateMany",
            "authorizedCollection.deleteOne", "authorizedCollection.deleteMany",
        ],
    },
    {
        path: "api/audit-and-health.md",
        methods: ["init", "health"],
    },
    {
        path: "api/errors.md",
        methods: ["PermissionCoreError"],
    },
    {
        path: "api/resource-schemes.md",
        methods: ["PermissionCore.resourceSchemes", "ResourceSchemeDefinition.callbacks"],
    },
    {
        path: "api/match-resource.md",
        methods: ["matchResource"],
    },
    {
        path: "api/vext-plugin.md",
        methods: [
            "permissionPlugin", "hasPermissionContext", "requirePermissionContext",
            "req.auth.permission.filterResponse", "appExtensions.permission",
        ],
    },
];

export const apiMethodEvidenceLabels = {
    zh: ["用途", "参数", "状态影响", "原始返回"],
    en: ["Purpose", "Parameters", "State impact", "Raw return"],
};

export function localizedDocsSource(path, locale) {
    return locale === "zh" ? `zh/${path}` : path;
}

export function diagramFallbackId(contract, locale) {
    return `pc-diagram-${contract.id}-${locale}-text`;
}
