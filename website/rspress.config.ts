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

const docsBase = normalizeDocsBase(process.env.PERMISSION_CORE_DOCS_BASE);
const docsSiteUrl = trimTrailingSlash(
    process.env.PERMISSION_CORE_DOCS_SITE_URL || DEFAULT_DOCS_SITE_URL,
);

export default defineConfig({
    root: path.join(__dirname, "docs"),
    base: docsBase,
    title: "permission-core",
    icon: "/favicon.svg",
    description:
        "permission-core 是一个面向 Node.js 生态的细粒度权限核心库，支持接口权限、数据权限、字段过滤与统一角色规则管理。",
    outDir: "dist",
    plugins: [
        pluginSitemap({
            siteUrl: docsSiteUrl,
        }),
    ],
    search: {
        codeBlocks: true,
    },
    themeConfig: {
        nav: [
            {
                text: "指南",
                link: "/guide/introduction",
                activeMatch: "/guide/",
            },
            {
                text: "API 参考",
                link: "/api/permission-core",
                activeMatch: "/api/",
            },
            {
                text: "示例",
                link: "/examples/basic",
                activeMatch: "/examples/",
            },
            {
                text: "v0.1.0",
                items: [
                    {
                        text: "GitHub 仓库",
                        link: "https://github.com/vextjs/permission-core",
                    },
                    {
                        text: "更新日志",
                        link: "https://github.com/vextjs/permission-core/blob/main/CHANGELOG.md",
                    },
                ],
            },
        ],
        sidebar: {
            "/guide/": [
                {
                    text: "开始",
                    items: [
                        { text: "介绍", link: "/guide/introduction" },
                        { text: "快速开始", link: "/guide/quick-start" },
                        { text: "常见问题", link: "/guide/faq" },
                        { text: "接入检查清单", link: "/guide/integration-checklist" },
                        { text: "接入阅读顺序", link: "/guide/implementation-reading-order" },
                    ],
                },
                {
                    text: "核心概念",
                    items: [
                        { text: "资源路径模型", link: "/guide/resource-paths" },
                        { text: "角色与规则", link: "/guide/roles-and-rules" },
                        { text: "权限鉴权", link: "/guide/check-permission" },
                        { text: "行级权限", link: "/guide/row-level" },
                        { text: "字段过滤", link: "/guide/field-filter" },
                        { text: "权限缓存", link: "/guide/cache" },
                    ],
                },
                {
                    text: "进阶",
                    items: [
                        { text: "框架接入", link: "/guide/framework-integration" },
                        { text: "管理后台接入", link: "/guide/site-preview-release" },
                        { text: "错误处理与响应映射", link: "/guide/error-response-mapping" },
                        { text: "存储适配器", link: "/guide/adapters" },
                        { text: "自定义适配器", link: "/guide/custom-adapter" },
                        { text: "迁移指南", link: "/guide/migration" },
                    ],
                },
            ],
            "/api/": [
                {
                    text: "API 参考",
                    items: [
                        { text: "PermissionCore", link: "/api/permission-core" },
                        { text: "PermissionCoreContext", link: "/api/context" },
                        { text: "RoleManager", link: "/api/role-manager" },
                        { text: "UserRoleManager", link: "/api/user-roles" },
                        { text: "matchResource", link: "/api/match-resource" },
                        { text: "错误码", link: "/api/errors" },
                    ],
                },
            ],
            "/examples/": [
                {
                    text: "示例",
                    items: [
                        { text: "基础示例", link: "/examples/basic" },
                        { text: "Express 接入", link: "/examples/express" },
                        { text: "vext 接入", link: "/examples/vext" },
                        { text: "行级权限", link: "/examples/row-level" },
                        { text: "字段权限", link: "/examples/field-permission" },
                        { text: "管理后台保存", link: "/examples/management-backend" },
                        { text: "MonSQLize 适配器", link: "/examples/monsqlize-adapter" },
                    ],
                },
            ],
        },
        socialLinks: [
            {
                icon: "github",
                mode: "link",
                content: "https://github.com/vextjs/permission-core",
            },
        ],
        footer: {
            message: "面向 permission-core 使用者的接入与 API 文档。",
        },
        lastUpdated: true,
    },
});