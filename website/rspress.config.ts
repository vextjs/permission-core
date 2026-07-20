import * as fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import * as path from "node:path";
import { defineConfig } from "@rspress/core";
import { pluginSitemap } from "@rspress/plugin-sitemap";
import { permissionCoreMermaidPlugin } from "./plugins/permission-core-mermaid";
import {
    docsPages,
    docsPagesForLocale,
    guideGroups,
    localizeDocsLink,
    pageLink,
} from "./docs-manifest.mjs";

const DEFAULT_DOCS_BASE = "/permission-core/";
const DEFAULT_DOCS_SITE_URL = "https://vextjs.github.io/permission-core";

// Stable and preview use different bases in one release flow. Rspress 2.0.11
// does not include `base` in its persistent-cache digest.
process.env.RSPRESS_PERSISTENT_CACHE = "false";

type DocsChannel = "stable" | "preview";

function resolveDocsChannel(value?: string): DocsChannel {
    const channel = value?.trim() || "preview";
    if (channel !== "stable" && channel !== "preview") {
        throw new Error(`Unsupported PERMISSION_CORE_DOCS_CHANNEL: ${channel}`);
    }
    return channel;
}

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
const docsChannel = resolveDocsChannel(process.env.PERMISSION_CORE_DOCS_CHANNEL);
const packageVersion = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"),
).version as string;
const docsVersion = process.env.PERMISSION_CORE_DOCS_VERSION?.trim() || packageVersion;
const docsHead: [string, Record<string, string>][] = [
    ["meta", { name: "permission-core-docs-channel", content: docsChannel }],
    ["meta", { name: "permission-core-docs-version", content: docsVersion }],
];

if (docsChannel === "preview") {
    docsHead.push(["meta", { name: "robots", content: "noindex,follow" }]);
}

const docsHtmlRoutePattern = /^\/(?:zh\/)?(?:guide|api|examples)\/.+\.html(?:[?#].*)?$/;

function acceptsHtml(request: IncomingMessage) {
    const accept = request.headers.accept;
    return typeof accept === "string" && accept.includes("text/html");
}

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
        link: "/api/core-and-contexts",
        activeMatch: "/api/",
    },
    {
        en: "Examples",
        zh: "示例",
        link: "/examples/basic",
        activeMatch: "/examples/",
    },
    {
        en: `v${docsVersion} ${docsChannel === "stable" ? "Stable" : "Preview"}`,
        zh: `v${docsVersion} ${docsChannel === "stable" ? "稳定版" : "预览版"}`,
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

const manifestItem = (item: (typeof docsPages)[number]): LocalizedLink => ({
    en: item.navLabels.en,
    zh: item.navLabels.zh,
    link: pageLink(item),
});

const isExternalLink = (link: string) => /^https?:\/\//.test(link);

function localizeLink(link: string, locale: Locale) {
    return isExternalLink(link) ? link : localizeDocsLink(link, locale);
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

function createSidebar(locale: Locale, key: "guide" | "api" | "examples") {
    const localePages = docsPagesForLocale(locale);
    const sidebarSource: Record<"guide" | "api" | "examples", SidebarGroup[]> = {
        guide: guideGroups.map((group) => ({
            en: group.labels.en,
            zh: group.labels.zh,
            items: localePages
                .filter((item) => item.section === "guide" && item.navGroup === group.id)
                .sort((left, right) => left.order - right.order)
                .map(manifestItem),
        })),
        api: [{
            en: "API Reference",
            zh: "API 参考",
            items: localePages
                .filter((item) => item.section === "api")
                .sort((left, right) => left.order - right.order)
                .map(manifestItem),
        }],
        examples: [{
            en: "Examples",
            zh: "示例",
            items: localePages
                .filter((item) => item.section === "examples")
                .sort((left, right) => left.order - right.order)
                .map(manifestItem),
        }],
    };
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
        "Fine-grained authorization for Node.js with MonSQLize-backed RBAC, route, menu, row, and field permissions.",
    builderConfig: {
        dev: {
            lazyCompilation: false,
        },
        html: {
            tags: [{
                tag: "script",
                attrs: { src: "chunk-load-recovery.js" },
                append: false,
            }],
        },
        server: {
            historyApiFallback: {
                disableDotRule: true,
            },
            setup({ action, server }) {
                if (action !== "dev") {
                    return;
                }

                return () => {
                    server.middlewares.use((
                        request: IncomingMessage,
                        _response: ServerResponse,
                        next: () => void,
                    ) => {
                        if (request.url && docsHtmlRoutePattern.test(request.url) && acceptsHtml(request)) {
                            request.url = "/";
                        }
                        next();
                    });
                };
            },
        },
        source: {
            define: {
                __PERMISSION_CORE_DOCS_CHANNEL__: JSON.stringify(docsChannel),
                __PERMISSION_CORE_DOCS_VERSION__: JSON.stringify(docsVersion),
            },
        },
    },
    head: docsHead,
    outDir: "dist",
    locales: [
        {
            lang: "en",
            label: "English",
            title: "permission-core",
            description:
                "Fine-grained authorization for Node.js services backed by MonSQLize 3.1.",
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
        permissionCoreMermaidPlugin({
            componentPath: path.join(__dirname, "theme", "MermaidRenderer.tsx"),
            mermaidConfig: {
                securityLevel: "strict",
                startOnLoad: false,
                flowchart: {
                    htmlLabels: false,
                    useMaxWidth: true,
                },
            },
        }),
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
                    "Fine-grained authorization for Node.js services backed by MonSQLize 3.1.",
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
        footer: {
            message: "Released under the Apache License 2.0.",
        },
        lastUpdated: true,
    },
});
