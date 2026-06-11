import * as path from "node:path";
import { defineConfig } from "@rspress/core";
import { pluginSitemap } from "@rspress/plugin-sitemap";

const DEFAULT_DOCS_BASE = "/permission-core/";
const DEFAULT_DOCS_SITE_URL = "https://vextjs.github.io/permission-core";

function normalizeDocsBase(value?: string) {
    const raw = value?.trim() || DEFAULT_DOCS_BASE;
    if (raw === "/") {
        return "/";
    }

    const trimmed = raw.replace(/^\/+|\/+$/g, "");
    return trimmed ? `/${trimmed}/` : "/";
}

function trimTrailingSlash(value: string) {
    return value.replace(/\/+$/g, "");
}

type Locale = "en" | "zh";

type LocalizedLink = {
    en: string;
    zh: string;
    link: string;
    activeMatch?: string;
};

type LocalizedMenu = {
    en: string;
    zh: string;
    items: LocalizedLink[];
};

type LocalizedNavItem = LocalizedLink | LocalizedMenu;

type SidebarGroup = {
    en: string;
    zh: string;
    items: LocalizedLink[];
};

const docsBase = normalizeDocsBase(process.env.PERMISSION_CORE_DOCS_BASE);
const docsSiteUrl = trimTrailingSlash(
    process.env.PERMISSION_CORE_DOCS_SITE_URL || DEFAULT_DOCS_SITE_URL,
);

const navSource: LocalizedNavItem[] = [
    {
        en: "Guide",
        zh: "指南",
        link: "/guide/introduction",
        activeMatch: "/guide/",
    },
    {
        en: "API Reference",
        zh: "API 参考",
        link: "/api/permission-core",
        activeMatch: "/api/",
    },
    {
        en: "Examples",
        zh: "示例",
        link: "/examples/basic",
        activeMatch: "/examples/",
    },
    {
        en: "v1.0.10",
        zh: "v1.0.10",
        items: [
            {
                en: "GitHub",
                zh: "GitHub 仓库",
                link: "https://github.com/vextjs/permission-core",
            },
            {
                en: "Changelog",
                zh: "更新日志",
                link: "https://github.com/vextjs/permission-core/blob/main/CHANGELOG.md",
            },
        ],
    },
];

const sidebarSource: Record<"guide" | "api" | "examples", SidebarGroup[]> = {
    guide: [
        {
            en: "Start",
            zh: "开始",
            items: [
                { en: "Introduction", zh: "介绍", link: "/guide/introduction" },
                { en: "Quick Start", zh: "快速开始", link: "/guide/quick-start" },
                { en: "FAQ", zh: "常见问题", link: "/guide/faq" },
                { en: "Integration Checklist", zh: "接入检查清单", link: "/guide/integration-checklist" },
                { en: "Reading Order", zh: "接入阅读顺序", link: "/guide/implementation-reading-order" },
            ],
        },
        {
            en: "Core Concepts",
            zh: "核心概念",
            items: [
                { en: "Resource Paths", zh: "资源路径模型", link: "/guide/resource-paths" },
                { en: "Roles and Rules", zh: "角色与规则", link: "/guide/roles-and-rules" },
                { en: "Permission Checks", zh: "权限鉴权", link: "/guide/check-permission" },
                { en: "Row-level Permissions", zh: "行级权限", link: "/guide/row-level" },
                { en: "Field Filtering", zh: "字段过滤", link: "/guide/field-filter" },
                { en: "Permission Cache", zh: "权限缓存", link: "/guide/cache" },
            ],
        },
        {
            en: "Advanced",
            zh: "进阶",
            items: [
                { en: "Framework Integration", zh: "框架接入", link: "/guide/framework-integration" },
                { en: "Management Console", zh: "管理后台接入", link: "/guide/site-preview-release" },
                { en: "Production Deployment", zh: "生产部署与监控", link: "/guide/production-deployment" },
                { en: "Compatibility Matrix", zh: "兼容性矩阵", link: "/guide/compatibility-matrix" },
                { en: "Error Response Mapping", zh: "错误处理与响应映射", link: "/guide/error-response-mapping" },
                { en: "Storage Adapters", zh: "存储适配器", link: "/guide/adapters" },
                { en: "Custom Adapter", zh: "自定义适配器", link: "/guide/custom-adapter" },
                { en: "Migration Guide", zh: "迁移指南", link: "/guide/migration" },
            ],
        },
    ],
    api: [
        {
            en: "API Reference",
            zh: "API 参考",
            items: [
                { en: "PermissionCore", zh: "PermissionCore", link: "/api/permission-core" },
                { en: "PermissionCoreContext", zh: "PermissionCoreContext", link: "/api/context" },
                { en: "PermissionCache", zh: "PermissionCache", link: "/api/permission-cache" },
                { en: "RoleManager", zh: "RoleManager", link: "/api/role-manager" },
                { en: "UserRoleManager", zh: "UserRoleManager", link: "/api/user-roles" },
                { en: "StorageAdapter", zh: "StorageAdapter", link: "/api/storage-adapter" },
                { en: "MemoryAdapter", zh: "MemoryAdapter", link: "/api/memory-adapter" },
                { en: "FileAdapter", zh: "FileAdapter", link: "/api/file-adapter" },
                { en: "MonSQLizeStorageAdapter", zh: "MonSQLizeStorageAdapter", link: "/api/monsqlize-storage-adapter" },
                { en: "matchResource", zh: "matchResource", link: "/api/match-resource" },
                { en: "Error Codes", zh: "错误码", link: "/api/errors" },
            ],
        },
    ],
    examples: [
        {
            en: "Examples",
            zh: "示例",
            items: [
                { en: "Basic Example", zh: "基础示例", link: "/examples/basic" },
                { en: "Express Integration", zh: "Express 接入", link: "/examples/express" },
                { en: "vext Integration", zh: "vext 接入", link: "/examples/vext" },
                { en: "Row-level Permissions", zh: "行级权限", link: "/examples/row-level" },
                { en: "Field Permissions", zh: "字段权限", link: "/examples/field-permission" },
                { en: "Management Backend", zh: "管理后台保存", link: "/examples/management-backend" },
                { en: "MonSQLize Adapter", zh: "MonSQLize 适配器", link: "/examples/monsqlize-adapter" },
            ],
        },
    ],
};

const isExternalLink = (link: string) => /^https?:\/\//.test(link);

function localizeLink(link: string, locale: Locale) {
    if (locale === "en" || isExternalLink(link)) {
        return link;
    }

    return link === "/" ? "/zh/" : `/zh${link}`;
}

function isMenu(item: LocalizedNavItem): item is LocalizedMenu {
    return "items" in item;
}

function createNav(locale: Locale) {
    return navSource.map((item) => {
        if (isMenu(item)) {
            return {
                text: item[locale],
                items: item.items.map((child) => ({
                    text: child[locale],
                    link: localizeLink(child.link, locale),
                })),
            };
        }

        return {
            text: item[locale],
            link: localizeLink(item.link, locale),
            activeMatch: item.activeMatch ? localizeLink(item.activeMatch, locale) : undefined,
        };
    });
}

function createSidebar(locale: Locale, key: keyof typeof sidebarSource) {
    return sidebarSource[key].map((group) => ({
        text: group[locale],
        items: group.items.map((item) => ({
            text: item[locale],
            link: localizeLink(item.link, locale),
        })),
    }));
}

function createSidebars(locale: Locale) {
    const prefix = locale === "en" ? "" : "/zh";
    return {
        [`${prefix}/guide/`]: createSidebar(locale, "guide"),
        [`${prefix}/api/`]: createSidebar(locale, "api"),
        [`${prefix}/examples/`]: createSidebar(locale, "examples"),
    };
}

const englishNav = createNav("en");
const chineseNav = createNav("zh");
const englishSidebars = createSidebars("en");
const chineseSidebars = createSidebars("zh");

export default defineConfig({
    root: path.join(__dirname, "docs"),
    base: docsBase,
    lang: "en",
    title: "permission-core",
    icon: "/favicon.svg",
    globalStyles: path.join(__dirname, "styles", "payment-permission.css"),
    description:
        "A payment-grade fine-grained authorization core for Node.js route permissions, data scopes, field filtering, role rules, and cache invalidation.",
    outDir: "dist",
    locales: [
        {
            lang: "en",
            label: "English",
            title: "permission-core",
            description:
                "A payment-grade fine-grained authorization core for Node.js services.",
        },
        {
            lang: "zh",
            label: "简体中文",
            title: "permission-core",
            description:
                "面向 Node.js 的细粒度权限核心库，支持接口权限、数据权限、字段过滤与统一角色规则管理。",
        },
    ],
    plugins: [
        pluginSitemap({
            siteUrl: docsSiteUrl,
        }),
    ],
    search: {
        codeBlocks: true,
    },
    themeConfig: {
        localeRedirect: "never",
        nav: englishNav,
        locales: [
            {
                lang: "en",
                label: "English",
                title: "permission-core",
                description:
                    "A payment-grade fine-grained authorization core for Node.js services.",
                nav: englishNav,
                sidebar: englishSidebars,
            },
            {
                lang: "zh",
                label: "简体中文",
                title: "permission-core",
                description:
                    "面向 Node.js 的细粒度权限核心库，支持接口权限、数据权限、字段过滤与统一角色规则管理。",
                nav: chineseNav,
                sidebar: chineseSidebars,
            },
        ],
        sidebar: {
            ...englishSidebars,
            ...chineseSidebars,
        },
        socialLinks: [
            {
                icon: "github",
                mode: "link",
                content: "https://github.com/vextjs/permission-core",
            },
        ],
        footer: {
            message: "Released under the Apache License 2.0.",
        },
        lastUpdated: true,
    },
});
