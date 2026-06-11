import { usePage, useSite } from "@rspress/core/runtime";

export * from "@rspress/core/theme-original";

type FooterColumn = {
    title: string;
    items: Array<
        | {
              text: string;
              href: string;
              external?: boolean;
          }
        | {
              text: string;
              label: true;
          }
    >;
};

const external = (text: string, href: string) => ({
    text,
    href,
    external: true,
});

function withBase(base: string, path: string) {
    const normalizedBase = base.endsWith("/") ? base : `${base}/`;
    return `${normalizedBase}${path.replace(/^\/+/, "")}`;
}

function createFooterData(lang: string): {
    tagline: string;
    columns: FooterColumn[];
} {
    const isZh = lang === "zh";
    const prefix = isZh ? "/zh" : "";
    const local = (path: string) => `${prefix}${path}`;

    if (isZh) {
        return {
            tagline: "面向支付、交易和管理后台的细粒度权限控制内核。",
            columns: [
                {
                    title: "文档",
                    items: [
                        { text: "介绍", href: local("/guide/introduction") },
                        { text: "快速开始", href: local("/guide/quick-start") },
                        { text: "API 参考", href: local("/api/permission-core") },
                    ],
                },
                {
                    title: "能力",
                    items: [
                        { text: "接口权限", href: local("/guide/check-permission") },
                        { text: "行级权限", href: local("/guide/row-level") },
                        { text: "字段过滤", href: local("/guide/field-filter") },
                    ],
                },
                {
                    title: "生态",
                    items: [
                        external("vext", "https://vextjs.github.io/vext/"),
                        external("MonSQLize", "https://vextjs.github.io/monSQLize/"),
                        external("flex-rate-limit", "https://vextjs.github.io/flex-rate-limit/"),
                    ],
                },
                {
                    title: "项目",
                    items: [
                        external(
                            "更新日志",
                            "https://github.com/vextjs/permission-core/blob/main/CHANGELOG.md",
                        ),
                        external("GitHub", "https://github.com/vextjs/permission-core"),
                        { text: "Apache-2.0", label: true },
                    ],
                },
            ],
        };
    }

    return {
        tagline:
            "Fine-grained authorization primitives for payment, transaction, and operations systems.",
        columns: [
            {
                title: "Docs",
                items: [
                    { text: "Introduction", href: local("/guide/introduction") },
                    { text: "Quick Start", href: local("/guide/quick-start") },
                    { text: "API Reference", href: local("/api/permission-core") },
                ],
            },
            {
                title: "Capabilities",
                items: [
                    { text: "Route checks", href: local("/guide/check-permission") },
                    { text: "Row scopes", href: local("/guide/row-level") },
                    { text: "Field filtering", href: local("/guide/field-filter") },
                ],
            },
            {
                title: "Ecosystem",
                items: [
                    external("vext", "https://vextjs.github.io/vext/"),
                    external("MonSQLize", "https://vextjs.github.io/monSQLize/"),
                    external("flex-rate-limit", "https://vextjs.github.io/flex-rate-limit/"),
                ],
            },
            {
                title: "Project",
                items: [
                    external(
                        "Changelog",
                        "https://github.com/vextjs/permission-core/blob/main/CHANGELOG.md",
                    ),
                    external("GitHub", "https://github.com/vextjs/permission-core"),
                    { text: "Apache-2.0", label: true },
                ],
            },
        ],
    };
}

export function HomeFooter() {
    const { page } = usePage();
    const { site } = useSite();
    const footer = createFooterData(page.lang);

    return (
        <footer className="pc-footer">
            <div className="pc-footer__inner">
                <div className="pc-footer__brand">
                    <strong>permission-core</strong>
                    <span>{footer.tagline}</span>
                </div>
                <div className="pc-footer__grid">
                    {footer.columns.map((column) => (
                        <div className="pc-footer__column" key={column.title}>
                            <h2>{column.title}</h2>
                            {column.items.map((item) =>
                                "label" in item ? (
                                    <span key={item.text}>{item.text}</span>
                                ) : (
                                    <a
                                        key={item.text}
                                        href={
                                            item.external
                                                ? item.href
                                                : withBase(site.base, item.href)
                                        }
                                        target={item.external ? "_blank" : undefined}
                                        rel={item.external ? "noreferrer" : undefined}
                                    >
                                        {item.text}
                                    </a>
                                ),
                            )}
                        </div>
                    ))}
                </div>
            </div>
        </footer>
    );
}
