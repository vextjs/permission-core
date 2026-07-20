import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "parse5";
import {
    docsPages,
    docsPagesForLocale,
    primaryNextForLocale,
    supportsLocale,
} from "../website/docs-manifest.mjs";
import {
    apiMethodContracts,
    apiMethodEvidenceLabels,
    diagramContracts,
    diagramFallbackId,
    operationLabels,
    operationPageContracts,
} from "./docs-experience-contracts.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseOptions(process.argv.slice(2));
const distRoot = path.resolve(projectRoot, options.root ?? "website/dist");
const channel = options.channel ?? "preview";
const contract = options.contract ?? "full";
const base = normalizeBase(options.base ?? "/permission-core/");
const failures = [];

if (!fs.existsSync(distRoot)) {
    fail(`rendered root does not exist: ${path.relative(projectRoot, distRoot)}`);
} else if (!new Set(["preview", "stable"]).has(channel)) {
    fail(`unsupported channel: ${channel}`);
} else if (!new Set(["full", "channel"]).has(contract)) {
    fail(`unsupported contract: ${contract}`);
} else if (contract === "channel") {
    verifyChannelContract();
} else {
    verifyFullContract();
}

if (failures.length > 0) {
    for (const failure of failures) {
        console.error(`DOCS_RENDERED_CHECK_FAILED ${failure}`);
    }
    process.exitCode = 1;
} else {
    const routeCount = contract === "full"
        ? docsPagesForLocale("en").length + docsPagesForLocale("zh").length
        : listHtmlFiles(distRoot).length - 1;
    console.log(
        `Rendered documentation checks passed: ${routeCount} routes, channel=${channel}, contract=${contract}`,
    );
}

function verifyChannelContract() {
    const routes = listHtmlFiles(distRoot).filter((route) => route !== "404.html");
    if (routes.length === 0 || !routes.includes("index.html")) {
        fail("stable channel must contain a root index and at least one documentation route");
        return;
    }
    verifyChunkRecoveryAsset();

    for (const route of routes) {
        const document = readDocument(route);
        verifyRobots(route, document, channel);
        verifyChunkRecoveryReference(
            findElements(document),
            base,
            (message) => fail(`${route} ${message}`),
        );
        for (const node of findElements(document, "a")) {
            const href = getAttr(node, "href");
            if (href?.startsWith("/permission-core/next/")) {
                fail(`${route} stable channel links to preview: ${href}`);
            }
        }
    }
}

function verifyFullContract() {
    verifyChunkRecoveryAsset();
    const expectedPages = buildExpectedPages();
    const expectedRoutes = new Set(expectedPages.keys());
    const actualRoutes = new Set(
        listHtmlFiles(distRoot).filter((route) => route !== "404.html"),
    );

    for (const route of expectedRoutes) {
        if (!actualRoutes.has(route)) fail(`missing rendered route: ${route}`);
    }
    for (const route of actualRoutes) {
        if (!expectedRoutes.has(route)) fail(`unexpected rendered route: ${route}`);
    }

    const documents = new Map();
    for (const [route, metadata] of expectedPages) {
        if (!actualRoutes.has(route)) continue;
        const document = readDocument(route);
        documents.set(route, {
            ...metadata,
            document,
            elements: findElements(document),
        });
    }

    const idSets = new Map();
    for (const [route, page] of documents) {
        idSets.set(route, collectIds(route, page.elements));
    }

    for (const [route, page] of documents) {
        for (const finding of analyzePage({
            route,
            ...page,
            channel,
            base,
            expectedRoutes,
            idSets,
        })) {
            fail(finding);
        }
    }

    verifyNegativeFixtures(documents, expectedRoutes, idSets);
}

function analyzePage({
    route,
    locale,
    counterpart,
    isHome,
    page,
    document,
    elements,
    channel: expectedChannel,
    base: expectedBase,
    expectedRoutes,
    idSets,
}) {
    const pageFailures = [];
    const add = (message) => pageFailures.push(`${route} ${message}`);
    const html = elements.find((node) => node.tagName === "html");
    if (getAttr(html, "lang") !== locale) {
        add(`has incorrect html lang: ${getAttr(html, "lang") ?? "missing"}, expected ${locale}`);
    }

    const h1s = elements.filter((node) => node.tagName === "h1");
    if (h1s.length !== 1) {
        add(`must contain exactly one H1, received ${h1s.length}`);
    } else {
        const actualH1 = normalizeHeadingText(textContent(h1s[0]));
        const expectedH1 = isHome ? "permission-core" : page.labels[locale];
        if (actualH1 !== expectedH1) {
            add(`has incorrect H1: ${actualH1}, expected ${expectedH1}`);
        }
    }

    const channelMeta = getMetaContent(elements, "permission-core-docs-channel");
    const versionMeta = getMetaContent(elements, "permission-core-docs-version");
    if (channelMeta !== expectedChannel) {
        add(`has incorrect docs channel: ${channelMeta || "missing"}, expected ${expectedChannel}`);
    }
    if (!versionMeta) {
        add("is missing docs version metadata");
    } else if (isHome) {
        const pageText = normalizeText(textContent(document));
        const channelLabel = locale === "zh"
            ? (expectedChannel === "stable" ? "稳定版" : "预览版")
            : (expectedChannel === "stable" ? "Stable" : "Preview");
        if (!pageText.includes(`v${versionMeta} ${channelLabel}`)) {
            add(`home does not expose the generated channel/version label: v${versionMeta} ${channelLabel}`);
        }
    }
    verifyChunkRecoveryReference(elements, expectedBase, add);

    verifyRobots(route, document, expectedChannel, pageFailures);

    const ids = idSets.get(route) ?? new Set();
    for (const node of elements.filter(isInteractiveElement)) {
        if (!accessibleName(node, ids, elements)) {
            add(`interactive element has no accessible name: ${describeNode(node)}`);
        }
    }

    let alternateFound = false;
    for (const link of elements.filter((node) => node.tagName === "a" && getAttr(node, "href"))) {
        const href = getAttr(link, "href");
        const resolved = resolveInternalHref(href, route, expectedBase);
        if (!resolved) continue;

        if (!expectedRoutes.has(resolved.route)) {
            add(`has broken internal route: ${href} -> ${resolved.route}`);
            continue;
        }

        const rel = new Set((getAttr(link, "rel") ?? "").split(/\s+/).filter(Boolean));
        if (rel.has("alternate")) {
            if (resolved.route === counterpart) alternateFound = true;
        } else {
            const targetLocale = resolved.route.startsWith("zh/") ? "zh" : "en";
            if (targetLocale !== locale) {
                add(`crosses locale without rel=alternate: ${href}`);
            }
        }

        if (resolved.fragment) {
            const targetIds = idSets.get(resolved.route) ?? new Set();
            if (!targetIds.has(resolved.fragment)) {
                add(`has broken fragment: ${href}`);
            }
        }
    }

    if (counterpart && !alternateFound) {
        add(`is missing an alternate locale link to ${counterpart}`);
    }

    for (const canonical of elements.filter(
        (node) => node.tagName === "link" && hasRel(node, "canonical"),
    )) {
        const href = getAttr(canonical, "href");
        const resolved = resolveInternalHref(href, route, expectedBase);
        if (resolved && resolved.route !== route) {
            add(`canonical route mismatch: ${href}`);
        }
    }

    verifyRenderedStructure({
        route,
        locale,
        isHome,
        page,
        elements,
        expectedBase,
        add,
    });

    return pageFailures;
}

function verifyRenderedStructure({
    route,
    locale,
    isHome,
    page,
    elements,
    expectedBase,
    add,
}) {
    verifyTopNavigation(route, locale, elements, expectedBase, add);

    const main = elements.find((node) => node.tagName === "main");
    if (!main) {
        add("is missing the main content landmark");
        return;
    }

    const skipControl = elements.filter(
        (node) => node.tagName === "button" && hasClass(node, "pc-skip-link"),
    );
    const expectedSkipText = locale === "zh" ? "跳到主要内容" : "Skip to main content";
    if (
        skipControl.length !== 1 ||
        normalizeText(textContent(skipControl[0])) !== expectedSkipText
    ) {
        add(`must render one localized skip control: ${expectedSkipText}`);
    }

    if (isHome) return;

    const sectionPages = docsPagesForLocale(locale)
        .filter((candidate) => candidate.section === page.section)
        .sort((left, right) => left.order - right.order);
    verifySidebar(route, locale, page, sectionPages, elements, expectedBase, add);
    verifyOutline(elements, add);
    verifyCodeBlocks(page, main, add);
    verifyDiagramRenderingContract(locale, page, main, add);
    verifyOperationRenderingContract(locale, page, main, expectedBase, add);
    verifyApiMethodRenderingContract(locale, page, main, add);
    verifyPrevNext(route, locale, page, sectionPages, elements, expectedBase, add);

    const primaryNext = localizedRenderedRoute(
        docsPages.find((candidate) => candidate.path === primaryNextForLocale(page, locale)),
        locale,
    );
    const linkedRoutes = new Set(
        findElements(main, "a")
            .map((node) => resolveInternalHref(getAttr(node, "href"), route, expectedBase))
            .filter(Boolean)
            .map((target) => target.route),
    );
    if (!linkedRoutes.has(primaryNext)) {
        add(`main content does not link to primaryNext: ${primaryNext}`);
    }
}

function verifyTopNavigation(route, locale, elements, expectedBase, add) {
    const nav = elements.find(
        (node) => node.tagName === "header" && hasClass(node, "rp-nav"),
    );
    if (!nav) {
        add("is missing the primary navigation landmark");
        return;
    }

    const navigationPages = {
        guide: docsPages.find((page) => page.id === "introduction"),
        api: docsPages.find((page) => page.id === "core-and-contexts"),
        examples: docsPages.find((page) => page.id === "basic-example"),
    };
    if (Object.values(navigationPages).some((page) => !page)) {
        add("manifest is missing a top-navigation target");
        return;
    }
    const expected = [
        [locale === "zh" ? "指南" : "Guide", localizedRenderedRoute(navigationPages.guide, locale)],
        [locale === "zh" ? "API 参考" : "API Reference", localizedRenderedRoute(navigationPages.api, locale)],
        [locale === "zh" ? "示例" : "Examples", localizedRenderedRoute(navigationPages.examples, locale)],
    ];
    const actual = findElements(nav, "a")
        .filter((node) => hasClass(node, "rp-nav-menu__item__container"))
        .map((node) => {
            const target = resolveInternalHref(getAttr(node, "href"), route, expectedBase);
            return [normalizeText(textContent(node)), target?.route ?? null];
        });
    verifySequence("top navigation", actual, expected, add);
}

function verifySidebar(route, locale, page, sectionPages, elements, expectedBase, add) {
    const sidebar = elements.find(
        (node) => node.tagName === "aside" && hasClass(node, "rp-doc-layout__sidebar"),
    );
    if (!sidebar) {
        add("is missing the section sidebar");
        return;
    }

    const actual = findElements(sidebar, "a")
        .filter((node) => hasClass(node, "rp-sidebar-item"))
        .map((node) => {
            const target = resolveInternalHref(getAttr(node, "href"), route, expectedBase);
            return [normalizeText(textContent(node)), target?.route ?? null];
        });
    const expected = sectionPages.map((candidate) => [
        candidate.navLabels[locale],
        localizedRenderedRoute(candidate, locale),
    ]);
    verifySequence("sidebar", actual, expected, add);

    const active = findElements(sidebar, "a").filter(
        (node) => hasClass(node, "rp-sidebar-item--active"),
    );
    const activeTarget = active.length === 1
        ? resolveInternalHref(getAttr(active[0], "href"), route, expectedBase)?.route
        : null;
    if (active.length !== 1 || activeTarget !== localizedRenderedRoute(page, locale)) {
        add(`sidebar must expose exactly one active route for ${localizedRenderedRoute(page, locale)}`);
    }
}

function verifyOutline(elements, add) {
    const outline = elements.find(
        (node) => node.tagName === "aside" && hasClass(node, "rp-doc-layout__outline"),
    );
    const toc = outline
        ? findElements(outline).find((node) => hasClass(node, "rp-outline__toc"))
        : null;
    if (!outline || !toc) {
        add("is missing the rendered outline");
        return;
    }

    const expected = elements
        .filter(
            (node) =>
                ["h2", "h3", "h4"].includes(node.tagName) &&
                hasClass(node, "rp-toc-include") &&
                getAttr(node, "id"),
        )
        .map((node) => `#${getAttr(node, "id")}`);
    const actual = findElements(toc, "a")
        .map((node) => getAttr(node, "href"))
        .filter((href) => href?.startsWith("#"));
    verifySequence("outline", actual, expected, add);
}

function verifyCodeBlocks(page, main, add) {
    const blocks = findElements(main).filter((node) => hasClass(node, "rp-codeblock"));
    const copyButtons = findElements(main, "button").filter(
        (node) => hasClass(node, "rp-code-copy-button"),
    );
    if (copyButtons.length !== blocks.length) {
        add(`code block/copy control mismatch: ${blocks.length}/${copyButtons.length}`);
    }
    if (blocks.some((node) => !(getAttr(node, "class") ?? "").split(/\s+/).some((value) => value.startsWith("language-")))) {
        add("contains a rendered code block without a language class");
    }
    if (page.section === "api" && blocks.length < 4) {
        add(`API reference must render at least four code blocks, received ${blocks.length}`);
    }
    if (page.section === "examples" && blocks.length < 3) {
        add(`example page must render at least three code blocks, received ${blocks.length}`);
    }
}

function verifyDiagramRenderingContract(locale, page, main, add) {
    const rawMermaid = findElements(main).filter(
        (node) => hasClass(node, "language-mermaid"),
    );
    if (rawMermaid.length > 0) {
        add(`contains ${rawMermaid.length} raw Mermaid code block(s)`);
    }

    const contract = diagramContracts.find((candidate) => candidate.path === page.path);
    const fallbacks = findElements(main).filter(
        (node) => hasClass(node, "pc-diagram-text"),
    );
    if (!contract?.locales[locale]) {
        if (fallbacks.length > 0) add("contains a diagram fallback outside the diagram contract");
        return;
    }

    const expectedId = diagramFallbackId(contract, locale);
    const expectedFallbacks = fallbacks.filter(
        (node) =>
            getAttr(node, "id") === expectedId &&
            getAttr(node, "data-diagram-id") === contract.id,
    );
    if (fallbacks.length !== 1 || expectedFallbacks.length !== 1) {
        add(`must render one stable diagram text fallback: ${expectedId}`);
        return;
    }

    const fallbackText = normalizeText(textContent(expectedFallbacks[0]));
    const minimumLength = locale === "zh" ? 60 : 140;
    if ([...fallbackText].length < minimumLength) {
        add(`diagram text fallback is too short (${[...fallbackText].length}/${minimumLength})`);
    }
}

function verifyOperationRenderingContract(locale, page, main, expectedBase, add) {
    for (const finding of collectRenderedOperationFailures(locale, page, main, expectedBase)) {
        add(finding);
    }
}

function verifyApiMethodRenderingContract(locale, page, main, add) {
    for (const finding of collectRenderedApiMethodFailures(locale, page, main)) {
        add(finding);
    }
}

function collectRenderedApiMethodFailures(locale, page, main) {
    const findings = [];
    const contract = apiMethodContracts.find((candidate) => candidate.path === page.path);
    if (!contract || locale !== "zh") return findings;

    const labels = apiMethodEvidenceLabels[locale];
    const actualLabels = findElements(main, "strong")
        .map((node) => normalizeText(textContent(node)))
        .filter((label) => labels.includes(label));
    const expectedLabels = contract.methods.flatMap(() => labels);
    if (JSON.stringify(actualLabels) !== JSON.stringify(expectedLabels)) {
        findings.push(
            `must render ${contract.methods.length} ordered API method evidence groups`,
        );
    }
    return findings;
}

function collectRenderedOperationFailures(locale, page, main, expectedBase) {
    const findings = [];
    const contract = operationPageContracts.find((candidate) => candidate.path === page.path);
    if (!contract) return findings;

    const elements = findElements(main);
    const headings = elements.filter((node) => node.tagName === "h3");
    if (headings.length !== contract.operations.length) {
        findings.push(`must render ${contract.operations.length} operation H3 headings, received ${headings.length}`);
    }

    for (const operation of contract.operations) {
        const expectedHeading = operation.headings[locale];
        const matches = headings.filter(
            (node) => normalizeHeadingText(textContent(node)) === expectedHeading,
        );
        if (matches.length !== 1) {
            findings.push(`operation ${operation.id} must render one heading: ${expectedHeading}`);
            continue;
        }

        const start = elements.indexOf(matches[0]) + 1;
        let end = elements.length;
        for (let index = start; index < elements.length; index += 1) {
            if (["h2", "h3"].includes(elements[index].tagName)) {
                end = index;
                break;
            }
        }
        const section = elements.slice(start, end);
        const actualLabels = section
            .filter((node) => node.tagName === "strong")
            .map((node) => normalizeText(textContent(node)))
            .filter((label) => operationLabels[locale].includes(label));
        if (JSON.stringify(actualLabels) !== JSON.stringify(operationLabels[locale])) {
            findings.push(`operation ${operation.id} rendered label order differs from the contract`);
        }

        const codeTokens = new Set(
            section
                .filter((node) => node.tagName === "code")
                .map((node) => normalizeText(textContent(node))),
        );
        for (const call of operation.calls) {
            if (!codeTokens.has(call)) {
                findings.push(`operation ${operation.id} rendered method is missing: ${call}`);
            }
        }

        const linkedRoutes = new Set(
            section
                .filter((node) => node.tagName === "a")
                .map((node) => resolveInternalHref(getAttr(node, "href"), markdownToHtml(page.path), expectedBase))
                .filter(Boolean)
                .map((target) => target.route),
        );
        for (const apiPath of operation.apiPaths) {
            const route = `${locale === "zh" ? "zh/" : ""}${apiPath.replace(/^\//u, "")}.html`;
            if (!linkedRoutes.has(route)) {
                findings.push(`operation ${operation.id} rendered API link is missing: ${route}`);
            }
        }
    }

    const paragraphs = findElements(main, "p");
    for (const output of contract.outputGroups) {
        const label = locale === "zh"
            ? `${output.group} 来源。`
            : `${output.group} provenance.`;
        const matches = paragraphs.filter(
            (node) => normalizeText(textContent(node)).startsWith(label),
        );
        if (matches.length !== 1) {
            findings.push(`output ${output.group} must render one provenance paragraph`);
            continue;
        }
        const codeTokens = new Set(
            findElements(matches[0], "code").map((node) => normalizeText(textContent(node))),
        );
        if (!codeTokens.has(output.group)) {
            findings.push(`output ${output.group} rendered label does not preserve its group token`);
        }
        if (!codeTokens.has(output.producerToken)) {
            findings.push(`output ${output.group} rendered producer is missing: ${output.producerToken}`);
        }
        const minimum = locale === "zh" ? 35 : 70;
        if ([...normalizeText(textContent(matches[0]))].length < minimum) {
            findings.push(`output ${output.group} rendered provenance is too short`);
        }
    }
    return findings;
}

function verifyPrevNext(route, locale, page, sectionPages, elements, expectedBase, add) {
    const index = sectionPages.findIndex((candidate) => candidate.id === page.id);
    const expectedPrev = index > 0 ? sectionPages[index - 1] : null;
    const expectedNext = index < sectionPages.length - 1 ? sectionPages[index + 1] : null;
    const container = elements.find((node) => hasClass(node, "rp-prev-next-page"));
    const links = container ? findElements(container, "a") : [];
    const actualPrev = links.find((node) => hasClass(node, "rp-prev-next-page__prev"));
    const actualNext = links.find((node) => hasClass(node, "rp-prev-next-page__next"));
    verifyDirectionalLink("previous", actualPrev, expectedPrev, locale, route, expectedBase, add);
    verifyDirectionalLink("next", actualNext, expectedNext, locale, route, expectedBase, add);
}

function verifyDirectionalLink(direction, actual, expected, locale, route, expectedBase, add) {
    if (!expected) {
        if (actual) add(`must not render a ${direction} page link at the section boundary`);
        return;
    }
    if (!actual) {
        add(`is missing ${direction} page link to ${localizedRenderedRoute(expected, locale)}`);
        return;
    }
    const actualRoute = resolveInternalHref(getAttr(actual, "href"), route, expectedBase)?.route;
    const title = findElements(actual).find(
        (node) => hasClass(node, "rp-prev-next-page__item__title"),
    );
    if (
        actualRoute !== localizedRenderedRoute(expected, locale) ||
        normalizeText(textContent(title)) !== expected.navLabels[locale]
    ) {
        add(`${direction} page link does not match ${expected.navLabels[locale]} (${localizedRenderedRoute(expected, locale)})`);
    }
}

function verifySequence(name, actual, expected, add) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        add(`${name} sequence mismatch: ${JSON.stringify(actual)} expected ${JSON.stringify(expected)}`);
    }
}

function verifyRobots(route, document, expectedChannel, targetFailures = failures) {
    const robots = findElements(document, "meta")
        .filter((node) => getAttr(node, "name")?.toLowerCase() === "robots")
        .map((node) => getAttr(node, "content")?.toLowerCase() ?? "");
    const hasPreviewDirective = robots.includes("noindex,follow");
    if (expectedChannel === "preview" && !hasPreviewDirective) {
        targetFailures.push(`${route} preview page is missing robots noindex,follow`);
    }
    if (expectedChannel === "stable" && robots.some((value) => value.includes("noindex"))) {
        targetFailures.push(`${route} stable page must not contain a preview noindex directive`);
    }
}

function verifyChunkRecoveryAsset() {
    const assetPath = path.join(distRoot, "chunk-load-recovery.js");
    if (!fs.existsSync(assetPath) || fs.statSync(assetPath).size === 0) {
        fail("rendered site is missing chunk-load-recovery.js");
    }
}

function verifyChunkRecoveryReference(elements, expectedBase, add) {
    const expectedSource = `${expectedBase}chunk-load-recovery.js`;
    const matches = elements.filter(
        (node) => node.tagName === "script" && getAttr(node, "src") === expectedSource,
    );
    if (matches.length !== 1) {
        add(`must load one chunk recovery guard: ${expectedSource}`);
    }
}

function verifyNegativeFixtures(documents, expectedRoutes, idSets) {
    const home = documents.get("index.html");
    if (!home) return;
    const source = fs.readFileSync(path.join(distRoot, "index.html"), "utf-8");
    const fixtures = [
        {
            name: "missing H1",
            html: source.replace(/<h1\b/, "<div").replace(/<\/h1>/, "</div>"),
            expected: "must contain exactly one H1",
        },
        {
            name: "unnamed link",
            html: injectBeforeBody(source, `<a href="${base}"><svg></svg></a>`),
            expected: "interactive element has no accessible name",
        },
        {
            name: "duplicate id",
            html: injectBeforeBody(source, '<div id="__rspress_root"></div>'),
            expected: "duplicate id: __rspress_root",
        },
        {
            name: "broken route",
            html: injectBeforeBody(source, `<a href="${base}missing-route">Missing</a>`),
            expected: "has broken internal route",
        },
        {
            name: "wrong locale",
            html: source.replace('<html lang="en">', '<html lang="zh">'),
            expected: "has incorrect html lang",
        },
        {
            name: "missing preview robots",
            html: source.replace("noindex,follow", "index,follow"),
            expected: "preview page is missing robots noindex,follow",
            channel: "preview",
        },
    ];

    for (const fixture of fixtures) {
        const document = parse(fixture.html);
        const elements = findElements(document);
        const fixtureIdSets = new Map(idSets);
        const fixtureFailures = [];
        const fixtureIds = collectIds("fixture", elements, fixtureFailures);
        fixtureIdSets.set("index.html", fixtureIds);
        fixtureFailures.push(...analyzePage({
            route: "index.html",
            locale: "en",
            counterpart: "zh/index.html",
            isHome: true,
            document,
            elements,
            channel: fixture.channel ?? channel,
            base,
            expectedRoutes,
            idSets: fixtureIdSets,
        }));
        if (!fixtureFailures.some((finding) => finding.includes(fixture.expected))) {
            fail(`negative fixture did not fail as expected: ${fixture.name}`);
        }
    }

    verifyRenderedDiagramNegativeFixtures();
    verifyRenderedOperationNegativeFixtures();
    verifyRenderedApiMethodNegativeFixtures();
}

function verifyRenderedDiagramNegativeFixtures() {
    const contract = diagramContracts[0];
    const page = docsPages.find((candidate) => candidate.path === contract.path);
    const route = markdownToHtml(contract.path);
    const source = fs.readFileSync(path.join(distRoot, route), "utf-8");
    const fallbackId = diagramFallbackId(contract, "en");
    const fallbackPattern = new RegExp(
        `<p[^>]*\\bid="${fallbackId}"[^>]*>[\\s\\S]*?<\\/p>`,
        "u",
    );
    const fixtures = [
        {
            name: "missing rendered diagram fallback",
            html: source.replace(fallbackPattern, ""),
            expected: "must render one stable diagram text fallback",
        },
        {
            name: "raw rendered Mermaid block",
            html: source.replace(
                "</main>",
                '<div class="rp-codeblock language-mermaid"><code>flowchart LR</code></div></main>',
            ),
            expected: "raw Mermaid code block",
        },
    ];

    for (const fixture of fixtures) {
        const document = parse(fixture.html);
        const main = findElements(document).find((node) => node.tagName === "main");
        const fixtureFailures = [];
        if (!main) {
            fail(`rendered diagram fixture is missing main: ${fixture.name}`);
            continue;
        }
        verifyDiagramRenderingContract("en", page, main, (finding) => fixtureFailures.push(finding));
        if (!fixtureFailures.some((finding) => finding.includes(fixture.expected))) {
            fail(`negative fixture did not fail as expected: ${fixture.name}`);
        }
    }
}

function verifyRenderedOperationNegativeFixtures() {
    const contract = operationPageContracts[0];
    const page = docsPages.find((candidate) => candidate.path === contract.path);
    const route = markdownToHtml(contract.path);
    const source = fs.readFileSync(path.join(distRoot, route), "utf-8");
    const roleParagraphPattern = /<p><strong><code>role<\/code> provenance\.<\/strong>[\s\S]*?<\/p>/u;
    const fixtures = [
        {
            name: "missing rendered operation heading",
            html: source.replace("1. Create the role state", "1. Removed role state"),
            expected: "must render one heading",
        },
        {
            name: "missing rendered operation label",
            html: source.replace("Purpose and target.", "Purpose removed."),
            expected: "rendered label order differs",
        },
        {
            name: "missing rendered operation API link",
            html: source.replace(
                `href="${base}api/roles.html"`,
                `href="${base}guide/introduction.html"`,
            ),
            expected: "rendered API link is missing",
        },
        {
            name: "missing rendered output producer",
            html: source.replace(roleParagraphPattern, (paragraph) =>
                paragraph.replace("<code>roles.get</code>", "<code>role read</code>")),
            expected: "rendered producer is missing",
        },
    ];

    for (const fixture of fixtures) {
        const document = parse(fixture.html);
        const main = findElements(document).find((node) => node.tagName === "main");
        if (!main) {
            fail(`rendered operation fixture is missing main: ${fixture.name}`);
            continue;
        }
        const fixtureFailures = collectRenderedOperationFailures("en", page, main, base);
        if (!fixtureFailures.some((finding) => finding.includes(fixture.expected))) {
            fail(`operation negative fixture did not fail as expected: ${fixture.name}`);
        }
    }
}

function verifyRenderedApiMethodNegativeFixtures() {
    const contract = apiMethodContracts[0];
    const page = docsPages.find((candidate) => candidate.path === contract.path);
    const route = `zh/${markdownToHtml(contract.path)}`;
    const source = fs.readFileSync(path.join(distRoot, route), "utf-8");
    const fixture = source.replace("<strong>参数</strong>", "<strong>参数已移除</strong>");
    const document = parse(fixture);
    const main = findElements(document).find((node) => node.tagName === "main");
    if (!main) {
        fail("rendered API method fixture is missing main");
        return;
    }

    const fixtureFailures = collectRenderedApiMethodFailures("zh", page, main);
    if (!fixtureFailures.some((finding) => finding.includes("ordered API method evidence groups"))) {
        fail("API method negative fixture did not fail: missing rendered parameter evidence");
    }
}

function buildExpectedPages() {
    const pages = new Map();
    for (const page of docsPages) {
        const englishRoute = markdownToHtml(page.path);
        const chineseRoute = `zh/${englishRoute}`;
        if (supportsLocale(page, "en")) {
            pages.set(englishRoute, {
                locale: "en",
                counterpart: supportsLocale(page, "zh") ? chineseRoute : null,
                isHome: page.path === "index.md",
                page,
            });
        }
        if (supportsLocale(page, "zh")) {
            pages.set(chineseRoute, {
                locale: "zh",
                counterpart: supportsLocale(page, "en") ? englishRoute : null,
                isHome: page.path === "index.md",
                page,
            });
        }
    }
    return pages;
}

function collectIds(route, elements, targetFailures = failures) {
    const ids = new Set();
    for (const node of elements) {
        const id = getAttr(node, "id");
        if (!id) continue;
        if (ids.has(id)) targetFailures.push(`${route} duplicate id: ${id}`);
        ids.add(id);
    }
    return ids;
}

function isInteractiveElement(node) {
    if (hasAttr(node, "disabled") || getAttr(node, "aria-disabled") === "true") return false;
    if (node.tagName === "a") return Boolean(getAttr(node, "href"));
    if (node.tagName === "input") return getAttr(node, "type") !== "hidden";
    if (["button", "select", "textarea", "summary"].includes(node.tagName)) return true;
    return ["button", "link"].includes(getAttr(node, "role"));
}

function accessibleName(node, ids, elements) {
    const ariaLabel = normalizeText(getAttr(node, "aria-label") ?? "");
    if (ariaLabel) return ariaLabel;

    const labelledBy = (getAttr(node, "aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
    const labelledText = labelledBy
        .filter((id) => ids.has(id))
        .map((id) => elements.find((candidate) => getAttr(candidate, "id") === id))
        .map((candidate) => normalizeText(textContent(candidate)))
        .filter(Boolean)
        .join(" ");
    if (labelledText) return labelledText;

    const title = normalizeText(getAttr(node, "title") ?? "");
    if (title) return title;

    const visibleText = normalizeText(textContent(node));
    if (visibleText) return visibleText;

    const imageAlt = findElements(node, "img")
        .map((image) => normalizeText(getAttr(image, "alt") ?? ""))
        .find(Boolean);
    if (imageAlt) return imageAlt;

    if (node.tagName === "input") {
        const type = getAttr(node, "type") ?? "text";
        if (["button", "submit", "reset"].includes(type)) {
            return normalizeText(getAttr(node, "value") ?? "");
        }
        return normalizeText(getAttr(node, "alt") ?? "");
    }
    return "";
}

function resolveInternalHref(href, currentRoute, expectedBase) {
    if (!href || /^(?:https?:|mailto:|tel:|javascript:)/i.test(href)) return null;
    const [rawPath, rawFragment = ""] = href.split("#", 2);
    let route;
    if (!rawPath) {
        route = currentRoute;
    } else if (rawPath.startsWith("/")) {
        if (!rawPath.startsWith(expectedBase)) return { route: `outside-base:${rawPath}`, fragment: "" };
        route = rawPath.slice(expectedBase.length);
    } else {
        route = path.posix.join(path.posix.dirname(currentRoute), rawPath);
    }

    route = route.split("?", 1)[0];
    if (!route || route.endsWith("/")) route += "index.html";
    if (!path.posix.extname(route)) route += ".html";
    return {
        route: path.posix.normalize(route),
        fragment: safeDecode(rawFragment),
    };
}

function readDocument(route) {
    return parse(fs.readFileSync(path.join(distRoot, ...route.split("/")), "utf-8"));
}

function findElements(node, tagName) {
    const result = [];
    const visit = (current) => {
        if (current.tagName && (!tagName || current.tagName === tagName)) result.push(current);
        for (const child of current.childNodes ?? []) visit(child);
    };
    visit(node);
    return result;
}

function textContent(node) {
    if (!node) return "";
    if (node.nodeName === "#text") return node.value ?? "";
    return (node.childNodes ?? []).map(textContent).join(" ");
}

function getAttr(node, name) {
    return node?.attrs?.find((attribute) => attribute.name === name)?.value;
}

function getMetaContent(elements, name) {
    return getAttr(
        elements.find(
            (node) => node.tagName === "meta" && getAttr(node, "name") === name,
        ),
        "content",
    );
}

function hasAttr(node, name) {
    return Boolean(node?.attrs?.some((attribute) => attribute.name === name));
}

function hasRel(node, value) {
    return (getAttr(node, "rel") ?? "").split(/\s+/).includes(value);
}

function hasClass(node, value) {
    return (getAttr(node, "class") ?? "").split(/\s+/).includes(value);
}

function describeNode(node) {
    const href = getAttr(node, "href");
    const className = getAttr(node, "class");
    return `<${node.tagName}${href ? ` href="${href}"` : ""}${className ? ` class="${className}"` : ""}>`;
}

function listHtmlFiles(root) {
    const files = [];
    const visit = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(absolute);
            else if (entry.isFile() && entry.name.endsWith(".html")) {
                files.push(path.relative(root, absolute).replaceAll("\\", "/"));
            }
        }
    };
    visit(root);
    return files.sort();
}

function markdownToHtml(source) {
    return source === "index.md" ? "index.html" : source.replace(/\.md$/, ".html");
}

function localizedRenderedRoute(page, locale) {
    const route = markdownToHtml(page.path);
    return locale === "zh" ? `zh/${route}` : route;
}

function normalizeBase(value) {
    const withLeading = value.startsWith("/") ? value : `/${value}`;
    return withLeading.endsWith("/") ? withLeading : `${withLeading}/`;
}

function normalizeText(value) {
    return value.replace(/\s+/g, " ").trim();
}

function normalizeHeadingText(value) {
    return normalizeText(value).replace(/^#\s*/, "");
}

function injectBeforeBody(source, html) {
    return source.replace("</body>", `${html}</body>`);
}

function safeDecode(value) {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function parseOptions(args) {
    return Object.fromEntries(
        args.map((argument) => {
            const [key, ...value] = argument.replace(/^--/, "").split("=");
            return [key, value.join("=")];
        }),
    );
}

function fail(message) {
    failures.push(message);
}
