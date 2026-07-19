import { useEffect, useState } from "react";
import type { Feature, FrontMatterMeta, NavItem } from "@rspress/core";
import {
    normalizeImagePath,
    useFrontmatter,
    useNav,
    usePage,
    useSite,
} from "@rspress/core/runtime";
import {
    Button,
    LastUpdated as OriginalLastUpdated,
    Link,
    HomeLayout as OriginalHomeLayout,
    Layout as OriginalLayout,
    NavHamburger,
    NavTitle,
    Search,
    SvgWrapper,
    SwitchAppearance,
    type HomeHeroProps,
    type HomeLayoutProps,
    type LayoutProps,
    type NavProps,
    renderHtmlOrText,
} from "@rspress/core/theme-original";
import "@rspress/core/dist/theme/components/HomeHero/index.css";
import "@rspress/core/dist/theme/components/Nav/index.css";

declare const __PERMISSION_CORE_DOCS_CHANNEL__: "stable" | "preview";
declare const __PERMISSION_CORE_DOCS_VERSION__: string;

let searchWasOpen = false;
let searchTrigger: HTMLElement | null = null;

export * from "@rspress/core/theme-original";

function setDrawerAccessibility(
    element: HTMLElement | null,
    hidden: boolean,
    triggerSelector: string,
) {
    if (!element) {
        return;
    }

    if (hidden && element.contains(document.activeElement)) {
        document.querySelector<HTMLElement>(triggerSelector)?.focus();
    }

    if (element.inert !== hidden) {
        element.inert = hidden;
    }

    if (hidden) {
        if (element.getAttribute("aria-hidden") !== "true") {
            element.setAttribute("aria-hidden", "true");
        }
    } else if (element.hasAttribute("aria-hidden")) {
        element.removeAttribute("aria-hidden");
    }
}

function setKeyboardButton(element: HTMLElement | null, label: string) {
    if (!element) {
        return;
    }

    element.setAttribute("role", "button");
    element.setAttribute("tabindex", "0");
    element.setAttribute("aria-label", label);
    if (element.dataset.pcKeyboardButton === "true") {
        return;
    }

    element.dataset.pcKeyboardButton = "true";
    element.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            element.click();
        }
    });
}

function syncInteractiveAccessibility() {
    const isZh = document.documentElement.lang === "zh";
    for (const toggle of document.querySelectorAll<HTMLElement>(
        ".rp-switch-appearance, .rp-nav-screen-appearance",
    )) {
        setKeyboardButton(toggle, isZh ? "切换颜色主题" : "Switch color theme");
    }

    const mobileLanguages = document.querySelector<HTMLElement>(".rp-nav-screen-langs");
    setKeyboardButton(mobileLanguages, isZh ? "选择文档语言" : "Choose documentation language");
    const languageGroup = mobileLanguages?.nextElementSibling as HTMLElement | null;
    if (mobileLanguages && languageGroup) {
        mobileLanguages.setAttribute(
            "aria-expanded",
            String(languageGroup.style.gridTemplateRows === "1fr"),
        );
    }

    const searchInput = document.querySelector<HTMLElement>(
        "#__rspress_modal_container input",
    );
    const searchIsOpen = Boolean(searchInput);
    if (!searchIsOpen && searchWasOpen && searchTrigger?.isConnected) {
        window.requestAnimationFrame(() => searchTrigger?.focus());
    }
    searchWasOpen = searchIsOpen;
}

function rememberSearchTrigger(event: MouseEvent | KeyboardEvent) {
    if (event instanceof MouseEvent) {
        const target = event.target as HTMLElement | null;
        const trigger = target?.closest<HTMLElement>(
            ".rp-search-button, .rp-search-button--mobile",
        );
        if (trigger) searchTrigger = trigger;
        return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        searchTrigger = document.querySelector<HTMLElement>(
            ".rp-search-button:not([hidden]), .rp-search-button--mobile:not([hidden])",
        );
    }
}

function closeOpenOverlayOnEscape(event: KeyboardEvent) {
    if (event.key !== "Escape") return;

    const sidebarOpen = document
        .querySelector(".rp-doc-layout__sidebar")
        ?.classList.contains("rp-doc-layout__sidebar--open");
    const outlineOpen = document
        .querySelector(".rp-doc-layout__outline")
        ?.classList.contains("rp-doc-layout__outline--open");
    if (sidebarOpen || outlineOpen) {
        event.preventDefault();
        document.querySelector<HTMLElement>(".rp-nav")?.dispatchEvent(
            new MouseEvent("mousedown", { bubbles: true }),
        );
        const trigger = document.querySelector<HTMLElement>(
            sidebarOpen ? ".rp-sidebar-menu__left" : ".rp-sidebar-menu__right",
        );
        window.requestAnimationFrame(() => trigger?.focus());
        return;
    }

    const hamburger = document.querySelector<HTMLElement>(
        ".rp-nav-hamburger__sm.rp-nav-hamburger--active",
    );
    if (hamburger) {
        event.preventDefault();
        hamburger.click();
        window.requestAnimationFrame(() => hamburger.focus());
    }
}

function activateFocusedControlWithoutClosedSearch(event: KeyboardEvent) {
    if (
        event.key !== "Enter" ||
        event.isComposing ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
    ) {
        return;
    }

    const target = event.target as HTMLElement | null;
    const searchInput = document.querySelector<HTMLElement>(
        "#__rspress_modal_container input",
    );
    if (searchInput) {
        if (
            target === searchInput &&
            !document.querySelector(".rp-suggest-item--current a[href]")
        ) {
            event.preventDefault();
            event.stopPropagation();
        }
        return;
    }

    const control = target?.closest<HTMLElement>(
        "a[href], button, [role='button']",
    );
    if (
        !control ||
        control.matches(":disabled") ||
        control.getAttribute("aria-disabled") === "true"
    ) {
        return;
    }

    // Rspress 2.0.11 reads an empty search result for document-level Enter
    // presses while search is closed. Preserve normal control activation here.
    event.preventDefault();
    event.stopPropagation();
    control.click();
}

function syncDrawerAccessibility() {
    const sidebar = document.querySelector<HTMLElement>(".rp-doc-layout__sidebar");
    const outline = document.querySelector<HTMLElement>(".rp-doc-layout__outline");
    const navScreen = document.querySelector<HTMLElement>(".rp-nav-screen");
    const sidebarOpen = Boolean(
        sidebar?.classList.contains("rp-doc-layout__sidebar--open"),
    );
    const outlineOpen = Boolean(
        outline?.classList.contains("rp-doc-layout__outline--open"),
    );
    const navOpen = Boolean(navScreen?.classList.contains("rp-nav-screen--open"));
    const sidebarHidden =
        window.matchMedia("(max-width: 768px)").matches &&
        !sidebarOpen;
    const outlineHidden =
        window.matchMedia("(max-width: 1279px)").matches &&
        !outlineOpen;

    if (sidebar) sidebar.id = "pc-doc-sidebar";
    if (outline) outline.id = "pc-doc-outline";
    if (navScreen) navScreen.id = "pc-mobile-navigation";
    setDrawerAccessibility(sidebar, sidebarHidden, ".rp-sidebar-menu__left");
    setDrawerAccessibility(outline, outlineHidden, ".rp-sidebar-menu__right");
    setDrawerAccessibility(navScreen, !navOpen, ".rp-nav-hamburger__sm");

    const sidebarTrigger = document.querySelector<HTMLElement>(
        ".rp-sidebar-menu__left",
    );
    sidebarTrigger?.setAttribute("aria-controls", "pc-doc-sidebar");
    sidebarTrigger?.setAttribute("aria-expanded", String(sidebarOpen));

    const outlineTrigger = document.querySelector<HTMLElement>(
        ".rp-sidebar-menu__right",
    );
    outlineTrigger?.setAttribute("aria-controls", "pc-doc-outline");
    outlineTrigger?.setAttribute("aria-expanded", String(outlineOpen));

    for (const hamburger of document.querySelectorAll<HTMLElement>(
        ".rp-nav-hamburger",
    )) {
        hamburger.setAttribute("aria-controls", "pc-mobile-navigation");
        hamburger.setAttribute("aria-expanded", String(navOpen));
        hamburger.setAttribute(
            "aria-label",
            document.documentElement.lang === "zh"
                ? navOpen
                    ? "关闭主导航"
                    : "打开主导航"
                : navOpen
                  ? "Close main navigation"
                  : "Open main navigation",
        );
    }

    const main = document.querySelector<HTMLElement>("main");
    if (main) {
        main.id = "pc-main-content";
        main.tabIndex = -1;
    }
    syncInteractiveAccessibility();
}

export function Layout(props: LayoutProps) {
    const { page } = usePage();

    useEffect(() => {
        let frame = 0;
        const scheduleSync = () => {
            window.cancelAnimationFrame(frame);
            frame = window.requestAnimationFrame(syncDrawerAccessibility);
        };
        const observer = new MutationObserver(scheduleSync);

        observer.observe(document.body, {
            attributes: true,
            attributeFilter: ["class", "style"],
            childList: true,
            subtree: true,
        });
        document.addEventListener("click", rememberSearchTrigger, true);
        document.addEventListener(
            "keydown",
            activateFocusedControlWithoutClosedSearch,
            true,
        );
        document.addEventListener("keydown", rememberSearchTrigger, true);
        document.addEventListener("keydown", closeOpenOverlayOnEscape, true);
        window.addEventListener("resize", scheduleSync);
        scheduleSync();

        return () => {
            observer.disconnect();
            document.removeEventListener("click", rememberSearchTrigger, true);
            document.removeEventListener(
                "keydown",
                activateFocusedControlWithoutClosedSearch,
                true,
            );
            document.removeEventListener("keydown", rememberSearchTrigger, true);
            document.removeEventListener("keydown", closeOpenOverlayOnEscape, true);
            window.removeEventListener("resize", scheduleSync);
            window.cancelAnimationFrame(frame);
        };
    }, []);

    return (
        <>
            <button
                type="button"
                className="pc-skip-link"
                onClick={() => {
                    const main = document.getElementById("pc-main-content");
                    if (!main) return;
                    main.focus();
                    main.scrollIntoView({ block: "start" });
                }}
            >
                {page.lang === "zh" ? "跳到主要内容" : "Skip to main content"}
            </button>
            <OriginalLayout {...props} />
        </>
    );
}

export function LastUpdated() {
    const { page } = usePage();

    return page.lastUpdatedTime ? <OriginalLastUpdated /> : null;
}

export function HomeLayout(props: HomeLayoutProps) {
    return (
        <main id="pc-main-content" className="pc-home-main" tabIndex={-1}>
            <OriginalHomeLayout {...props} />
        </main>
    );
}

function DropdownNavItem({ item }: { item: Extract<NavItem, { items: NavItem[] }> }) {
    const [open, setOpen] = useState(false);
    const label = item.text ?? "Menu";

    return (
        <li
            className="rp-nav-menu__item pc-nav-menu"
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
            onKeyDown={(event) => {
                if (event.key === "Escape") {
                    setOpen(false);
                    event.currentTarget.querySelector<HTMLElement>("button")?.focus();
                }
            }}
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setOpen(false);
                }
            }}
        >
            <button
                type="button"
                className="rp-nav-menu__item__container pc-nav-menu__trigger"
                aria-expanded={open}
                aria-haspopup="menu"
                onClick={() => setOpen(true)}
            >
                {label}
            </button>
            <ul
                className={`rp-hover-group rp-hover-group--center${open ? "" : " rp-hover-group--hidden"}`}
                hidden={!open}
                role="menu"
            >
                {item.items.map((child) => (
                    <li className="rp-hover-group__item" key={"link" in child ? child.link : child.text}>
                        {"link" in child ? (
                            <Link
                                className="rp-hover-group__item__link"
                                href={child.link}
                                role="menuitem"
                                lang={child.lang}
                                hrefLang={child.lang}
                                rel={child.rel}
                            >
                                {child.text}
                            </Link>
                        ) : (
                            <span className="rp-hover-group__item__link">{child.text}</span>
                        )}
                    </li>
                ))}
            </ul>
        </li>
    );
}

function DesktopNavMenu({
    menuItems,
    position,
}: {
    menuItems: NavItem[];
    position: "left" | "right";
}) {
    const positionedItems = menuItems.filter(
        (item) => (item.position ?? "right") === position,
    );
    if (positionedItems.length === 0) {
        return null;
    }

    return (
        <ul className={`rp-nav-menu rp-nav-menu--${position}`}>
            {positionedItems.map((item) =>
                "items" in item ? (
                    <DropdownNavItem item={item} key={item.text} />
                ) : (
                    <li className="rp-nav-menu__item" key={item.link}>
                        <Link className="rp-nav-menu__item__container" href={item.link}>
                            {item.text}
                        </Link>
                    </li>
                ),
            )}
        </ul>
    );
}

function LanguageNav() {
    const { page } = usePage();
    const [open, setOpen] = useState(false);
    const routePath = page.routePath.startsWith("/") ? page.routePath : `/${page.routePath}`;
    const englishPath = routePath.replace(/^\/zh(?=\/|$)/, "") || "/";
    const chinesePath = englishPath === "/" ? "/zh/" : `/zh${englishPath}`;
    const isZh = page.lang === "zh";

    return (
        <li
            className="rp-nav-menu__item pc-nav-menu"
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
            onKeyDown={(event) => {
                if (event.key === "Escape") {
                    setOpen(false);
                    event.currentTarget.querySelector<HTMLElement>("button")?.focus();
                }
            }}
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setOpen(false);
                }
            }}
        >
            <button
                type="button"
                className="rp-nav-menu__item__container pc-nav-menu__trigger"
                aria-expanded={open}
                aria-haspopup="menu"
                aria-label={isZh ? "选择文档语言" : "Choose documentation language"}
                onClick={() => setOpen(true)}
            >
                {isZh ? "简体中文" : "English"}
            </button>
            <ul
                className={`rp-hover-group rp-hover-group--center${open ? "" : " rp-hover-group--hidden"}`}
                hidden={!open}
                role="menu"
            >
                <li className="rp-hover-group__item">
                    {isZh ? (
                        <Link
                            className="rp-hover-group__item__link"
                            href={englishPath}
                            hrefLang="en"
                            lang="en"
                            onClick={() => setOpen(false)}
                            rel="alternate"
                            role="menuitem"
                        >
                            English
                        </Link>
                    ) : (
                        <span
                            className="rp-hover-group__item__link"
                            aria-current="page"
                            role="menuitem"
                        >
                            English
                        </span>
                    )}
                </li>
                <li className="rp-hover-group__item">
                    {isZh ? (
                        <span
                            className="rp-hover-group__item__link"
                            aria-current="page"
                            role="menuitem"
                        >
                            简体中文
                        </span>
                    ) : (
                        <Link
                            className="rp-hover-group__item__link"
                            href={chinesePath}
                            hrefLang="zh"
                            lang="zh"
                            onClick={() => setOpen(false)}
                            rel="alternate"
                            role="menuitem"
                        >
                            简体中文
                        </Link>
                    )}
                </li>
            </ul>
        </li>
    );
}

export function Nav(props: NavProps) {
    const navList = useNav();
    const { site } = useSite();
    const hasAppearanceSwitch = site.themeConfig.darkMode !== false;

    return (
        <header className="rp-nav">
            <div className="rp-nav__left">
                {props.beforeNavTitle}
                {props.navTitle ?? <NavTitle />}
                {props.afterNavTitle}
                <DesktopNavMenu menuItems={navList} position="left" />
            </div>
            <div className="rp-nav__right">
                {props.beforeNavMenu}
                <Search />
                <DesktopNavMenu menuItems={navList} position="right" />
                <div className="rp-nav__others">
                    <div className="rp-nav-menu__divider" />
                    <LanguageNav />
                    {hasAppearanceSwitch ? <SwitchAppearance /> : null}
                </div>
                <NavHamburger />
                {props.afterNavMenu}
            </div>
        </header>
    );
}

const DEFAULT_HERO = {
    badge: "",
    name: "",
    text: "",
    tagline: "",
    actions: [],
    image: undefined,
} satisfies FrontMatterMeta["hero"];

function normalizeSrcsetAndSizes(field: undefined | string | string[]) {
    const result = (Array.isArray(field) ? field : [field]).filter(Boolean).join(", ");
    return result || undefined;
}

export function HomeHero({ beforeHeroActions, afterHeroActions, image }: HomeHeroProps) {
    const { frontmatter } = useFrontmatter();
    const { page } = usePage();
    const hero = frontmatter?.hero || DEFAULT_HERO;
    const isZh = page.lang === "zh";
    const channelBadge = isZh
        ? `v${__PERMISSION_CORE_DOCS_VERSION__} ${__PERMISSION_CORE_DOCS_CHANNEL__ === "stable" ? "稳定版" : "预览版 · 稳定文档位于站点根目录"}`
        : `v${__PERMISSION_CORE_DOCS_VERSION__} ${__PERMISSION_CORE_DOCS_CHANNEL__ === "stable" ? "Stable" : "Preview · stable documentation at site root"}`;
    const actions = __PERMISSION_CORE_DOCS_CHANNEL__ === "stable"
        ? hero.actions?.filter(
            (action) => action.link !== "https://vextjs.github.io/permission-core/",
        )
        : hero.actions;
    const hasImage = hero.image !== undefined || image !== undefined;
    const multiHeroText = hero.text
        ? hero.text.toString().split(/\n/g).filter((text) => text !== "")
        : [];
    const imageSrc = typeof hero.image?.src === "string"
        ? { light: hero.image.src, dark: hero.image.src }
        : hero.image?.src || { light: "", dark: "" };

    return (
        <div className={`rp-home-hero${hasImage ? "" : " rp-home-hero--no-image"}`}>
            <div className="rp-home-hero__container">
                <div className="rp-home-hero__badge">{channelBadge}</div>
                <div className="rp-home-hero__content">
                    <h1 className="rp-home-hero__title">
                        <span
                            className="rp-home-hero__title-brand"
                            {...renderHtmlOrText(hero.name)}
                        />
                    </h1>
                    {multiHeroText.map((heroText) => (
                        <div
                            key={heroText}
                            className="rp-home-hero__subtitle"
                            {...renderHtmlOrText(heroText)}
                        />
                    ))}
                </div>
                <p className="rp-home-hero__tagline" {...renderHtmlOrText(hero.tagline)} />
                {beforeHeroActions}
                <div className="rp-home-hero__actions">
                    {actions?.map((action) => (
                        <Button
                            type="a"
                            key={action.link}
                            href={action.link}
                            theme={action.theme}
                            className="rp-home-hero__action"
                            {...renderHtmlOrText(action.text)}
                        />
                    ))}
                </div>
                {afterHeroActions}
            </div>
            {image ? (
                <div className="rp-home-hero__image">{image}</div>
            ) : hero.image ? (
                <div className="rp-home-hero__image">
                    <img
                        src={normalizeImagePath(imageSrc.light)}
                        alt={hero.image.alt}
                        srcSet={normalizeSrcsetAndSizes(hero.image.srcset)}
                        sizes={normalizeSrcsetAndSizes(hero.image.sizes)}
                        width={375}
                        height={375}
                        className="rp-home-hero__image-img rp-home-hero__image-img--light"
                    />
                    <img
                        src={normalizeImagePath(imageSrc.dark)}
                        alt={hero.image.alt}
                        srcSet={normalizeSrcsetAndSizes(hero.image.srcset)}
                        sizes={normalizeSrcsetAndSizes(hero.image.sizes)}
                        width={375}
                        height={375}
                        className="rp-home-hero__image-img rp-home-hero__image-img--dark"
                    />
                </div>
            ) : null}
        </div>
    );
}

function getFeatureGridClass(span?: number) {
    return [2, 3, 4, 6].includes(span ?? 4)
        ? `rp-home-feature__item--span-${span ?? 4}`
        : "";
}

export function HomeFeature({ features: suppliedFeatures }: { features?: Feature[] }) {
    const { frontmatter } = useFrontmatter();
    const features = suppliedFeatures ?? frontmatter?.features;

    return (
        <div className="rp-home-feature">
            {features?.map((feature) => {
                const card = (
                    <article
                        className={`rp-home-feature__card ${feature.link ? "rp-home-feature__card--clickable" : ""}`}
                    >
                        <div className="rp-home-feature__title-wrapper">
                            {feature.icon ? (
                                <div className="rp-home-feature__icon">
                                    <SvgWrapper icon={feature.icon} />
                                </div>
                            ) : null}
                            <h2 className="rp-home-feature__title">{feature.title}</h2>
                        </div>
                        <p
                            className="rp-home-feature__detail"
                            {...renderHtmlOrText(feature.details)}
                        />
                    </article>
                );

                return (
                    <div
                        className={`rp-home-feature__item ${getFeatureGridClass(feature.span)}`}
                        key={feature.title}
                    >
                        <div className="rp-home-feature__item-wrapper">
                            {feature.link ? (
                                <Link className="pc-home-feature__link" href={feature.link}>
                                    {card}
                                </Link>
                            ) : (
                                card
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

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
            tagline: "面向多租户 Node.js 服务与管理后台的细粒度授权内核。",
            columns: [
                {
                    title: "文档",
                    items: [
                        { text: "介绍", href: local("/guide/introduction") },
                        { text: "快速开始", href: local("/guide/quick-start") },
                        { text: "API 参考", href: local("/api/core-and-contexts") },
                    ],
                },
                {
                    title: "能力",
                    items: [
                        { text: "接口权限", href: local("/guide/check-permission") },
                        { text: "菜单与按钮", href: local("/guide/menu-management") },
                        { text: "数据权限", href: local("/guide/data-permissions") },
                        { text: "多租户模型", href: local("/guide/multi-tenant") },
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
            "Fine-grained authorization for multi-tenant Node.js services and administration systems.",
        columns: [
            {
                title: "Docs",
                items: [
                    { text: "Introduction", href: local("/guide/introduction") },
                    { text: "Quick Start", href: local("/guide/quick-start") },
                    { text: "API Reference", href: local("/api/core-and-contexts") },
                ],
            },
            {
                title: "Capabilities",
                items: [
                    { text: "Route checks", href: local("/guide/check-permission") },
                    { text: "Menus and buttons", href: local("/guide/menu-management") },
                    { text: "Data permissions", href: local("/guide/data-permissions") },
                    { text: "Multi-tenant model", href: local("/guide/multi-tenant") },
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
