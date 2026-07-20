export const guideGroups = [
    { id: "start", order: 1, labels: { en: "Start", zh: "开始" } },
    { id: "tasks", order: 2, labels: { en: "Common Tasks", zh: "常见任务" } },
    { id: "concepts", order: 3, labels: { en: "Core Concepts", zh: "核心概念" } },
    { id: "integration-ops", order: 4, labels: { en: "Integration and Operations", zh: "集成与运维" } },
];

export const docsLocales = ["en", "zh"];

export const docsLocaleContracts = {
    en: {
        pageCount: 36,
        guideGroups: { start: 4, tasks: 6, concepts: 4, "integration-ops": 4 },
        apiCount: 12,
        exampleCount: 5,
    },
    zh: {
        pageCount: 36,
        guideGroups: { start: 4, tasks: 6, concepts: 4, "integration-ops": 4 },
        apiCount: 12,
        exampleCount: 5,
    },
};

const roleSlots = {
    home: ["product-boundary", "primary-task", "release-channel"],
    concept: ["purpose", "model", "boundary", "next-task"],
    tutorial: ["prerequisites", "steps", "expected-result", "recovery", "next-task"],
    "how-to": ["goal", "prerequisites", "steps", "failure-boundary", "next-task"],
    operations: ["preconditions", "checklist", "failure-boundary", "rollback"],
    troubleshooting: ["symptom", "cause", "recovery"],
    reference: ["purpose-import", "signature-index", "behavior-defaults", "errors-limits", "minimal-example", "related"],
    example: ["scenario", "runnable-source", "expected-result", "fits-does-not-fit"],
    compatibility: ["redirect-purpose", "canonical-links"],
};

const roleForbiddenSlots = {
    home: ["maintainer-gate", "full-api-reference"],
    concept: ["maintainer-gate", "full-business-tutorial"],
    tutorial: ["maintainer-gate", "release-checklist"],
    "how-to": ["maintainer-gate", "full-api-reference"],
    operations: ["maintainer-gate", "full-api-reference"],
    troubleshooting: ["maintainer-gate", "full-tutorial"],
    reference: ["maintainer-gate", "full-business-tutorial", "release-checklist"],
    example: ["maintainer-gate", "release-checklist"],
    compatibility: ["maintainer-gate", "new-canonical-content"],
};

function page(id, path, order, section, navGroup, labels, role, sourceOfTruth, options = {}) {
    return {
        id,
        path,
        order,
        section,
        navGroup,
        labels,
        navLabels: options.navLabels ?? labels,
        role,
        audience: options.audience ?? (role === "reference" ? "api-consumer" : "integrator"),
        sourceOfTruth,
        sourceSymbol: options.sourceSymbol ?? null,
        requiredSlots: roleSlots[role],
        forbiddenSlots: roleForbiddenSlots[role],
        contentOwner: options.contentOwner ?? null,
        reuseMode: options.reuseMode ?? "owned-prose",
        locales: options.locales ?? docsLocales,
        primaryNext: options.primaryNext ?? null,
        primaryNextByLocale: options.primaryNextByLocale ?? {},
    };
}

export const docsPages = [
    page("home", "index.md", 1, "home", null, { en: "Home", zh: "首页" }, "home", ["package.json", "src/index.ts"], { sourceSymbol: "exports", contentOwner: "public-api", reuseMode: "cross-link", primaryNext: "guide/quick-start.md" }),
    page("introduction", "guide/introduction.md", 2, "guide", "start", { en: "Introduction", zh: "简介" }, "concept", ["src/index.ts", "src/types/foundation.ts"], { sourceSymbol: "PermissionCoreOptions", contentOwner: "product-boundary", primaryNext: "guide/quick-start.md" }),
    page("quick-start", "guide/quick-start.md", 3, "guide", "start", { en: "Quick Start", zh: "快速开始" }, "tutorial", ["website/docs/zh/guide/quick-start.md", "src/types/rbac.ts"], { sourceSymbol: "docs:first-success:start", contentOwner: "first-success", reuseMode: "generated-snippet", primaryNext: "guide/manage-roles-and-users.md" }),
    page("core-concepts", "guide/core-concepts.md", 3.5, "guide", "start", { en: "Core Terms and Mental Model", zh: "核心术语与心智模型" }, "concept", ["src/types/foundation.ts", "src/types/rbac.ts"], { sourceSymbol: "PermissionSubject", contentOwner: "core-concepts", navLabels: { en: "Core Concepts", zh: "核心概念" }, primaryNext: "guide/manage-roles-and-users.md" }),
    page("troubleshooting", "guide/troubleshooting.md", 4, "guide", "start", { en: "Troubleshooting", zh: "故障排查" }, "troubleshooting", ["src/core/errors.ts", "src/types/errors.ts"], { sourceSymbol: "PermissionCoreError", contentOwner: "failure-recovery", primaryNext: "guide/production-operations.md" }),
    page("manage-roles-and-users", "guide/manage-roles-and-users.md", 4.5, "guide", "tasks", { en: "Manage Roles and User Assignments", zh: "管理角色与用户授权" }, "how-to", ["src/types/rbac.ts", "src/rbac/public-context.ts"], { sourceSymbol: "RoleManager", contentOwner: "role-user-workflow", navLabels: { en: "Roles and Users", zh: "角色与用户" }, primaryNext: "guide/check-permission.md" }),
    page("check-permission", "guide/check-permission.md", 5, "guide", "tasks", { en: "Check Permissions", zh: "检查权限" }, "how-to", ["src/core/permission-core.ts", "src/types/rbac.ts"], { sourceSymbol: "SubjectPermissionContext", contentOwner: "permission-checks", primaryNext: "guide/data-permissions.md" }),
    page("data-permissions", "guide/data-permissions.md", 6, "guide", "tasks", { en: "Data Permissions", zh: "数据权限" }, "how-to", ["src/data/authorized-collection.ts", "src/types/data.ts"], { sourceSymbol: "AuthorizedCollection", contentOwner: "data-guard", reuseMode: "generated-response", primaryNext: "guide/menu-management.md" }),
    page("menu-management", "guide/menu-management.md", 7, "guide", "tasks", { en: "Manage Menus", zh: "管理菜单" }, "how-to", ["src/menu/config-service.ts", "src/types/menu.ts"], { sourceSymbol: "MenuConfigManager", contentOwner: "menu-workflow", reuseMode: "generated-response", primaryNext: "guide/api-bindings.md" }),
    page("api-bindings", "guide/api-bindings.md", 8, "guide", "tasks", { en: "Configure APIs and Response Fields", zh: "配置接口与响应字段" }, "how-to", ["src/menu/config-compiler.ts", "src/types/menu.ts"], { sourceSymbol: "ApiResource", contentOwner: "api-binding-workflow", reuseMode: "generated-response", navLabels: { en: "Bind APIs", zh: "绑定接口" }, primaryNext: "guide/role-menu-authorization.md" }),
    page("role-menu-authorization", "guide/role-menu-authorization.md", 9, "guide", "tasks", { en: "Authorize Role Menus", zh: "角色菜单授权" }, "how-to", ["src/menu/role-menu-mutations.ts", "src/types/menu.ts"], { sourceSymbol: "RoleMenuPermissionManager", contentOwner: "role-menu-workflow", reuseMode: "generated-response", primaryNext: "guide/permission-lifecycle.md" }),
    page("permission-lifecycle", "guide/permission-lifecycle.md", 10, "guide", "concepts", { en: "Permission Lifecycle", zh: "权限生命周期" }, "concept", ["src/core/permission-core.ts", "src/rbac/mutation-executor.ts"], { sourceSymbol: "PermissionCore", contentOwner: "lifecycle-model", primaryNext: "guide/resources-and-rules.md" }),
    page("resources-and-rules", "guide/resources-and-rules.md", 11, "guide", "concepts", { en: "Resources and Rules", zh: "资源与规则" }, "concept", ["src/check/resource-schemes.ts", "src/types/rbac.ts"], { sourceSymbol: "PermissionRuleInput", contentOwner: "resource-model", primaryNext: "guide/role-inheritance.md" }),
    page("role-inheritance", "guide/role-inheritance.md", 12, "guide", "concepts", { en: "Role Inheritance", zh: "角色继承" }, "concept", ["src/rbac/effective.ts", "src/types/rbac.ts"], { sourceSymbol: "EffectiveRoleRules", contentOwner: "inheritance-model", reuseMode: "generated-response", primaryNext: "guide/multi-tenant.md" }),
    page("multi-tenant", "guide/multi-tenant.md", 13, "guide", "concepts", { en: "Multi-Tenant Model", zh: "多租户模型" }, "concept", ["src/scope/scope.ts", "examples/multi-tenant.mjs"], { sourceSymbol: "normalizeScope", contentOwner: "tenant-model", reuseMode: "generated-response", primaryNext: "guide/cache.md" }),
    page("cache", "guide/cache.md", 14, "guide", "integration-ops", { en: "Cache", zh: "缓存" }, "operations", ["src/cache/semantic-cache.ts", "src/types/foundation.ts"], { sourceSymbol: "PermissionSemanticCacheOptions", contentOwner: "cache-operations", primaryNext: "guide/vext-plugin.md" }),
    page("vext-plugin", "guide/vext-plugin.md", 15, "guide", "integration-ops", { en: "Vext Plugin", zh: "Vext 插件" }, "how-to", ["src/plugins/vext/plugin.ts", "examples/vext/index.mjs"], { sourceSymbol: "permissionPlugin", contentOwner: "vext-integration", reuseMode: "cross-link", primaryNext: "guide/authentication-boundary.md" }),
    page("authentication-boundary", "guide/authentication-boundary.md", 16, "guide", "integration-ops", { en: "Authentication Boundary", zh: "认证边界" }, "concept", ["src/plugins/vext/request.ts", "src/plugins/vext/types.ts"], { sourceSymbol: "requirePermissionContext", contentOwner: "auth-boundary", primaryNext: "guide/production-operations.md" }),
    page("production-operations", "guide/production-operations.md", 17, "guide", "integration-ops", { en: "Production Operations", zh: "生产运维" }, "operations", ["src/core/permission-core.ts", "src/types/management.ts"], { sourceSymbol: "health", contentOwner: "production-runbook", primaryNext: "guide/troubleshooting.md" }),
    page("core-and-contexts", "api/core-and-contexts.md", 18, "api", "api", { en: "Core and Contexts", zh: "核心与上下文" }, "reference", ["src/core/permission-core.ts", "src/rbac/public-context.ts"], { sourceSymbol: "PermissionCore", contentOwner: "core-api", primaryNext: "api/roles.md" }),
    page("roles-api", "api/roles.md", 19, "api", "api", { en: "Roles", zh: "角色 API" }, "reference", ["src/types/rbac.ts", "src/rbac/public-context.ts"], { sourceSymbol: "RoleManager", contentOwner: "roles-api", primaryNext: "api/user-roles.md" }),
    page("user-roles-api", "api/user-roles.md", 20, "api", "api", { en: "User Roles", zh: "用户角色 API" }, "reference", ["src/types/rbac.ts", "src/rbac/public-context.ts"], { sourceSymbol: "UserRoleManager", contentOwner: "user-roles-api", primaryNext: "api/menus.md" }),
    page("menus-api", "api/menus.md", 21, "api", "api", { en: "Menus API", zh: "菜单 API" }, "reference", ["src/types/menu.ts", "src/rbac/public-context.ts"], { sourceSymbol: "MenuConfigManager", contentOwner: "menus-api", primaryNext: "api/api-bindings.md" }),
    page("api-bindings-api", "api/api-bindings.md", 22, "api", "api", { en: "Configure APIs and Response Fields API", zh: "配置接口与响应字段 API" }, "reference", ["src/types/menu.ts", "src/menu/config-compiler.ts"], { sourceSymbol: "ApiResource", contentOwner: "api-bindings-api", primaryNext: "api/role-menu-permissions.md" }),
    page("role-menu-permissions-api", "api/role-menu-permissions.md", 23, "api", "api", { en: "Role Menu Permissions API", zh: "角色菜单权限 API" }, "reference", ["src/types/menu.ts", "src/menu/role-menu-mutations.ts"], { sourceSymbol: "RoleMenuPermissionManager", contentOwner: "role-menu-api", primaryNext: "api/authorized-collection.md" }),
    page("authorized-collection-api", "api/authorized-collection.md", 24, "api", "api", { en: "Authorized Collection", zh: "授权集合 API" }, "reference", ["src/types/data.ts", "src/data/authorized-collection.ts"], { sourceSymbol: "AuthorizedCollection", contentOwner: "data-api", primaryNext: "api/audit-and-health.md" }),
    page("audit-and-health-api", "api/audit-and-health.md", 25, "api", "api", { en: "Audit and Health", zh: "审计与健康 API" }, "reference", ["src/core/permission-core.ts", "src/types/management.ts"], { sourceSymbol: "PermissionCoreHealth", contentOwner: "operations-api", primaryNext: "api/errors.md" }),
    page("errors-api", "api/errors.md", 26, "api", "api", { en: "Errors", zh: "错误 API" }, "reference", ["src/core/errors.ts", "src/types/errors.ts"], { sourceSymbol: "PermissionCoreErrorCode", contentOwner: "errors-api", reuseMode: "generated-response", primaryNext: "api/resource-schemes.md" }),
    page("resource-schemes-api", "api/resource-schemes.md", 27, "api", "api", { en: "Resource Schemes", zh: "资源方案 API" }, "reference", ["src/types/foundation.ts", "src/check/resource-schemes.ts"], { sourceSymbol: "ResourceSchemeDefinition", contentOwner: "resource-api", primaryNext: "api/match-resource.md" }),
    page("match-resource-api", "api/match-resource.md", 28, "api", "api", { en: "Match Resource", zh: "资源匹配 API" }, "reference", ["src/match.ts", "src/check/wildcard.ts"], { sourceSymbol: "matchResource", contentOwner: "match-api", primaryNext: "api/vext-plugin.md" }),
    page("vext-plugin-api", "api/vext-plugin.md", 29, "api", "api", { en: "Vext Plugin API", zh: "Vext 插件 API" }, "reference", ["src/plugins/vext/index.ts", "src/plugins/vext/types.ts"], { sourceSymbol: "permissionPlugin", contentOwner: "vext-api", primaryNext: "examples/vext.md" }),
    page("basic-example", "examples/basic.md", 30, "examples", "examples", { en: "Basic RBAC", zh: "基础 RBAC" }, "example", ["examples/basic.mjs"], { sourceSymbol: "docs:basic", contentOwner: "basic-example", reuseMode: "generated-snippet", primaryNext: "examples/multi-tenant.md" }),
    page("multi-tenant-example", "examples/multi-tenant.md", 31, "examples", "examples", { en: "Multi-Tenant", zh: "多租户" }, "example", ["examples/multi-tenant.mjs"], { sourceSymbol: "docs:multi-tenant", contentOwner: "multi-tenant-example", reuseMode: "generated-response", primaryNext: "examples/data-guard.md" }),
    page("data-guard-example", "examples/data-guard.md", 32, "examples", "examples", { en: "Data Guard", zh: "数据保护" }, "example", ["examples/data-guard.mjs"], { sourceSymbol: "docs:data-guard", contentOwner: "data-guard-example", reuseMode: "generated-response", primaryNext: "examples/menu-admin.md" }),
    page("menu-admin-example", "examples/menu-admin.md", 33, "examples", "examples", { en: "Menu Administration", zh: "菜单管理" }, "example", ["examples/menu-admin.mjs"], { sourceSymbol: "docs:menu-admin", contentOwner: "menu-admin-example", reuseMode: "generated-response", primaryNext: "examples/vext.md" }),
    page("vext-example", "examples/vext.md", 34, "examples", "examples", { en: "Vext Integration", zh: "Vext 集成" }, "example", ["examples/vext/index.mjs", "examples/vext/app/src/routes/index.mjs"], { sourceSymbol: "docs:vext", contentOwner: "vext-example", reuseMode: "generated-response", primaryNext: "guide/troubleshooting.md" }),
];

export function pageLink(page) {
    if (page.path === "index.md") {
        return "/";
    }
    return "/" + page.path.replace(/\.md$/, "");
}

export function localizeDocsLink(link, locale) {
    if (locale === "en" || /^https?:\/\//.test(link)) {
        return link;
    }
    return link === "/" ? "/zh/" : "/zh" + link;
}

export function supportsLocale(item, locale) {
    return item.locales.includes(locale);
}

export function docsPagesForLocale(locale, pages = docsPages) {
    return pages.filter((item) => supportsLocale(item, locale));
}

export function primaryNextForLocale(item, locale) {
    return item.primaryNextByLocale?.[locale] ?? item.primaryNext;
}

export function validateDocsManifest(
    pages = docsPages,
    groups = guideGroups,
    localeContracts = docsLocaleContracts,
) {
    const failures = [];
    const duplicateFields = ["id", "path", "order"];
    if (groups.length !== 4) failures.push("manifest must contain exactly four guide groups");

    for (const field of duplicateFields) {
        const values = pages.map((item) => item[field]);
        if (new Set(values).size !== values.length) failures.push("duplicate page " + field);
    }

    const groupIds = new Set(groups.map((group) => group.id));
    for (const item of pages) {
        if (!Array.isArray(item.locales) || item.locales.length === 0) {
            failures.push("missing locales: " + item.id);
        } else if (
            new Set(item.locales).size !== item.locales.length
            || item.locales.some((locale) => !docsLocales.includes(locale))
        ) {
            failures.push("invalid locales: " + item.id);
        }
        for (const locale of item.locales ?? []) {
            if (!item.labels?.[locale]) failures.push(`missing localized label (${locale}): ${item.id}`);
            if (!item.navLabels?.[locale]) failures.push(`missing localized nav label (${locale}): ${item.id}`);
            if (locale === "zh" && item.section === "guide" && item.navLabels?.[locale]?.length > 8) {
                failures.push(`localized nav label too long (${locale}): ${item.id}`);
            }
        }
        if (!item.role || !item.audience) failures.push("missing role metadata: " + item.id);
        if (!Array.isArray(item.sourceOfTruth) || item.sourceOfTruth.length === 0
            || item.sourceOfTruth.some((source) => typeof source !== "string" || source.length === 0)) {
            failures.push("missing concrete source anchors: " + item.id);
        }
        if (typeof item.sourceSymbol !== "string" || item.sourceSymbol.length === 0) failures.push("missing source symbol: " + item.id);
        if (typeof item.contentOwner !== "string" || item.contentOwner.length === 0) failures.push("missing content owner: " + item.id);
        if (typeof item.reuseMode !== "string" || item.reuseMode.length === 0) failures.push("missing reuse mode: " + item.id);
        if (!Array.isArray(item.requiredSlots) || item.requiredSlots.length === 0) failures.push("missing required slots: " + item.id);
        if (!Array.isArray(item.forbiddenSlots) || item.forbiddenSlots.length === 0) failures.push("missing forbidden slots: " + item.id);
        if (item.section === "guide" && item.navGroup !== null && !groupIds.has(item.navGroup)) {
            failures.push("unknown guide group: " + item.id);
        }
    }

    for (const locale of docsLocales) {
        const localePages = docsPagesForLocale(locale, pages);
        const contract = localeContracts[locale];
        if (!contract) {
            failures.push(`missing locale contract: ${locale}`);
            continue;
        }
        if (localePages.length !== contract.pageCount) {
            failures.push(`${locale.toUpperCase()} manifest must contain exactly ${contract.pageCount} pages`);
        }
        for (const [groupId, expectedCount] of Object.entries(contract.guideGroups)) {
            const actualCount = localePages.filter((item) => item.navGroup === groupId).length;
            if (actualCount !== expectedCount) {
                failures.push(`${locale.toUpperCase()} ${groupId} group must contain exactly ${expectedCount} pages`);
            }
        }
        if (localePages.filter((item) => item.section === "api").length !== contract.apiCount) {
            failures.push(`${locale.toUpperCase()} API section must contain ${contract.apiCount} pages`);
        }
        if (localePages.filter((item) => item.section === "examples").length !== contract.exampleCount) {
            failures.push(`${locale.toUpperCase()} Examples section must contain ${contract.exampleCount} pages`);
        }
        if (
            localePages.filter((item) => item.section === "home").length !== 1
            || localePages.find((item) => item.section === "home")?.navGroup !== null
        ) {
            failures.push(`${locale.toUpperCase()} Home must be unique and excluded from the sidebar`);
        }
        for (const item of localePages) {
            const primaryNext = primaryNextForLocale(item, locale);
            if (
                !primaryNext
                || !localePages.some((candidate) => candidate.path === primaryNext)
            ) {
                failures.push(`invalid primary next task (${locale}): ${item.id}`);
            }
        }
    }
    return failures;
}
