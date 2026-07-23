import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
    docsPages,
    docsPagesForLocale,
    guideGroups,
    primaryNextForLocale,
    supportsLocale,
    validateDocsManifest,
} from "../website/docs-manifest.mjs";
import {
    apiMethodContracts,
    apiMethodEvidenceLabels,
    diagramContracts,
    diagramFallbackId,
    docsLocales,
    localizedDocsSource,
    operationLabels,
    operationPageContracts,
} from "./docs-experience-contracts.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = path.join(projectRoot, "website", "docs");
const failures = [];
const localeMode = parseLocaleMode(process.argv.slice(2));

const englishPages = listMarkdownFiles(docsRoot)
    .filter((file) => !file.startsWith("zh/"));
const chinesePages = listMarkdownFiles(path.join(docsRoot, "zh"));

verifyManifestContracts();
verifyManifestNegativeFixtures();
verifyDiagramSourceContracts();
verifyDiagramNegativeFixtures();
verifyOperationSourceContracts();
verifyOperationNegativeFixtures();
verifyMermaidPipelineConfig();
comparePageSets();
verifyPagesAreSubstantial();
verifyLanguagePairSizeDrift();
verifyCriticalPages();
verifyCriticalPairStructure();
verifyJsonCodeBlocks();
verifyApiReferenceContracts();
verifyChineseApiIntentNavigation();
verifyApiMethodComprehensionContracts();
verifyApiMethodNegativeFixtures();
verifyExampleRoleContracts();
verifyDisplayedExampleCallContracts();
verifyDisplayedExampleCallNegativeFixtures();
verifyContentOwnership();
verifyDuplicateResponsibilities();
verifyMaintainerBoundary();
verifyRepositoryWorkflowContracts();
verifySourceAnchors();
verifySourceBackedClaims();
verifyExecutableTutorialContracts();
verifyInternalLinks();
verifyLocaleLinkBoundaries();
verifyStaleClaims();
verifyDocumentationExperienceGuardrails();

if (failures.length > 0) {
    for (const failure of failures) {
        console.error(`DOCS_CHECK_FAILED ${failure}`);
    }
    process.exitCode = 1;
} else {
    const routeCount = localeMode === "en"
        ? englishPages.length
        : localeMode === "zh"
            ? chinesePages.length
            : englishPages.length + chinesePages.length;
    console.log(
        `Documentation checks passed: mode=${localeMode}, ${routeCount} page routes, critical contracts, and internal links`,
    );
}

function parseLocaleMode(args) {
    const option = args.find((argument) => argument.startsWith("--locale="));
    const value = option?.slice("--locale=".length) ?? "all";
    if (!["all", "en", "zh"].includes(value)) {
        throw new Error(`Unsupported documentation locale mode: ${value}`);
    }
    return value;
}

function activeLocales() {
    return [
        ...(localeMode === "zh" ? [] : [["EN", "en", docsRoot, docsPagesForLocale("en")]]),
        ...(localeMode === "en" ? [] : [["ZH", "zh", path.join(docsRoot, "zh"), docsPagesForLocale("zh")]]),
    ];
}

function listMarkdownFiles(root) {
    const files = [];
    const visit = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const absolute = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                visit(absolute);
            } else if (entry.isFile() && entry.name.endsWith(".md")) {
                files.push(path.relative(root, absolute).replaceAll("\\", "/"));
            }
        }
    };
    visit(root);
    return files.sort();
}

function verifyManifestContracts() {
    for (const failure of validateDocsManifest()) {
        failures.push("manifest: " + failure);
    }

    const expectedEnglish = docsPagesForLocale("en").map((item) => item.path).sort();
    const expectedChinese = docsPagesForLocale("zh").map((item) => item.path).sort();
    if (JSON.stringify(expectedEnglish) !== JSON.stringify(englishPages)) {
        failures.push("manifest paths do not exactly match the English page set");
    }
    if (JSON.stringify(expectedChinese) !== JSON.stringify(chinesePages)) {
        failures.push("manifest paths do not exactly match the Chinese page set");
    }

    for (const item of docsPages) {
        if (Array.isArray(item.primaryNext)) {
            failures.push("manifest page has more than one primary next task: " + item.id);
        }
        for (const locale of item.locales) {
            const primaryNext = primaryNextForLocale(item, locale);
            if (primaryNext && !docsPagesForLocale(locale).some((candidate) => candidate.path === primaryNext)) {
                failures.push(`manifest primary next task is missing (${locale}): ${item.id} -> ${primaryNext}`);
            }
        }
    }
}

function verifyManifestNegativeFixtures() {
    const cases = [
        {
            name: "duplicate order",
            mutate(pages) {
                pages[1].order = pages[0].order;
            },
            expected: "duplicate page order",
        },
        {
            name: "invalid task group size",
            mutate(pages) {
                pages.find((item) => item.id === "check-permission").navGroup = "concepts";
            },
            expected: "EN tasks group must contain exactly 7 pages",
        },
        {
            name: "missing role slot",
            mutate(pages) {
                pages.find((item) => item.id === "quick-start").requiredSlots = [];
            },
            expected: "missing required slots: quick-start",
        },
        {
            name: "missing concrete source anchors",
            mutate(pages) {
                pages.find((item) => item.id === "quick-start").sourceOfTruth = [];
            },
            expected: "missing concrete source anchors: quick-start",
        },
        {
            name: "invalid primary next",
            mutate(pages) {
                pages.find((item) => item.id === "quick-start").primaryNext = "guide/missing.md";
            },
            expected: "invalid primary next task (en): quick-start",
        },
        {
            name: "unsupported locale",
            mutate(pages) {
                pages.find((item) => item.id === "quick-start").locales = ["fr"];
            },
            expected: "invalid locales: quick-start",
        },
        {
            name: "missing supported label",
            mutate(pages) {
                delete pages.find((item) => item.id === "quick-start").labels.zh;
            },
            expected: "missing localized label (zh): quick-start",
        },
    ];

    for (const negativeCase of cases) {
        const pages = structuredClone(docsPages);
        negativeCase.mutate(pages);
        const result = validateDocsManifest(pages, structuredClone(guideGroups));
        if (!result.includes(negativeCase.expected)) {
            failures.push("manifest negative fixture did not fail: " + negativeCase.name);
        }
    }
}

function verifyDiagramSourceContracts() {
    const expectedSources = new Set();
    let diagramCount = 0;

    for (const contract of diagramContracts) {
        for (const locale of Object.keys(contract.locales)) {
            const source = localizedDocsSource(contract.path, locale);
            expectedSources.add(source);
            const content = read(path.join(docsRoot, source));
            for (const finding of collectDiagramSourceFailures(content, contract, locale)) {
                failures.push(`${source} ${finding}`);
            }
            diagramCount += count(content, /^```mermaid$/gmu);
        }
    }

    for (const page of [
        ...englishPages,
        ...chinesePages.map((source) => `zh/${source}`),
    ]) {
        const mermaidCount = count(read(path.join(docsRoot, page)), /^```mermaid$/gmu);
        if (mermaidCount > 0 && !expectedSources.has(page)) {
            failures.push(`unexpected Mermaid source outside the diagram contract: ${page}`);
        }
    }

    const expectedCount = diagramContracts.reduce(
        (total, contract) => total + Object.keys(contract.locales).length,
        0,
    );
    if (diagramCount !== expectedCount) {
        failures.push(`diagram inventory expected ${expectedCount} Mermaid blocks, received ${diagramCount}`);
    }
}

function verifyChineseApiIntentNavigation() {
    const contracts = {
        "api/core-and-contexts.md": ["初始化与健康", "创建管理上下文", "执行权限判断", "读取与解释", "安全关闭"],
        "api/roles.md": ["创建或读取角色", "修改状态或父角色", "增量修改规则", "替换完整规则", "读取最终规则"],
        "api/menus.md": ["预览菜单配置", "保存菜单配置", "读取配置", "删除配置", "批量变更", "投影用户菜单"],
        "api/api-bindings.md": ["声明加载接口", "声明操作接口", "声明响应字段", "运行时校验", "常见错误"],
        "api/role-menu-permissions.md": ["预览并提交授权", "读取直接授权", "分页读取授权", "读取有效授权", "生成授权树"],
    };
    for (const [page, intents] of Object.entries(contracts)) {
        const content = read(path.join(docsRoot, "zh", page));
        if (!content.includes("## 我想做什么")) {
            failures.push(`ZH ${page} is missing the intent navigation matrix`);
        }
        for (const intent of intents) {
            if (!content.includes(intent)) failures.push(`ZH ${page} is missing API intent: ${intent}`);
        }
        if (!/^## 方法详解：/mu.test(content)) {
            failures.push(`ZH ${page} is missing intent-grouped method sections`);
        }
    }
}

function collectDiagramSourceFailures(content, contract, locale) {
    const findings = [];
    const blocks = [...content.matchAll(/```mermaid\r?\n([\s\S]*?)```/gu)];
    if (blocks.length !== 1) {
        findings.push(`must contain exactly one Mermaid block, received ${blocks.length}`);
        return findings;
    }

    const source = blocks[0][1];
    const expected = contract.locales[locale];
    if (!source.trimStart().startsWith(contract.kind)) {
        findings.push(`diagram kind must be ${contract.kind}`);
    }
    if (!source.includes(`accTitle: ${expected.title}`)) {
        findings.push("is missing its localized accTitle");
    }
    if (!source.includes(`accDescr: ${expected.description}`)) {
        findings.push("is missing its localized accDescr");
    }

    const fallbackId = diagramFallbackId(contract, locale);
    const fallbackPattern = new RegExp(
        `<p\\s+className="pc-diagram-text"\\s+id="${escapeRegExp(fallbackId)}"\\s+data-diagram-id="${escapeRegExp(contract.id)}">([\\s\\S]*?)<\\/p>`,
        "u",
    );
    const fallback = fallbackPattern.exec(content);
    if (!fallback) {
        findings.push("is missing its stable visible diagram text fallback");
    } else {
        const visibleText = fallback[1]
            .replace(/<[^>]+>/gu, " ")
            .replace(/[`*_]/gu, "")
            .replace(/\s+/gu, " ")
            .trim();
        const minimumLength = locale === "zh" ? 60 : 140;
        if ([...visibleText].length < minimumLength) {
            findings.push(`diagram text fallback is too short (${[...visibleText].length}/${minimumLength})`);
        }
    }
    return findings;
}

function verifyDiagramNegativeFixtures() {
    const contract = diagramContracts[0];
    const locale = "en";
    const metadata = contract.locales[locale];
    const fallbackId = diagramFallbackId(contract, locale);
    const fallback = `<p className="pc-diagram-text" id="${fallbackId}" data-diagram-id="${contract.id}"><strong>Text equivalent.</strong> The authenticated host identity becomes a scoped permission subject, effective rules are resolved, and the same authorization state drives API, menu, button, and protected data decisions for the request.</p>`;
    const valid = `# Fixture\n\n\`\`\`mermaid\n${contract.kind} LR\n  accTitle: ${metadata.title}\n  accDescr: ${metadata.description}\n  A --> B\n\`\`\`\n\n${fallback}`;
    const cases = [
        {
            name: "missing diagram title",
            content: valid.replace(`  accTitle: ${metadata.title}\n`, ""),
            expected: "missing its localized accTitle",
        },
        {
            name: "missing diagram description",
            content: valid.replace(`  accDescr: ${metadata.description}\n`, ""),
            expected: "missing its localized accDescr",
        },
        {
            name: "missing visible fallback",
            content: valid.replace(fallback, ""),
            expected: "missing its stable visible diagram text fallback",
        },
        {
            name: "fallback too short",
            content: valid.replace(fallback, `<p className="pc-diagram-text" id="${fallbackId}" data-diagram-id="${contract.id}">Short.</p>`),
            expected: "diagram text fallback is too short",
        },
    ];

    if (collectDiagramSourceFailures(valid, contract, locale).length > 0) {
        failures.push("valid diagram source fixture did not pass");
    }
    for (const fixture of cases) {
        const fixtureFailures = collectDiagramSourceFailures(fixture.content, contract, locale);
        if (!fixtureFailures.some((finding) => finding.includes(fixture.expected))) {
            failures.push(`diagram negative fixture did not fail: ${fixture.name}`);
        }
    }
}

function verifyOperationSourceContracts() {
    const expectedPaths = operationPageContracts.map((contract) => contract.path).sort();
    const examplePaths = docsPages
        .filter((page) => page.section === "examples")
        .map((page) => page.path)
        .sort();
    if (JSON.stringify(expectedPaths) !== JSON.stringify(examplePaths)) {
        failures.push("operation contracts must cover exactly the five example pages");
    }

    let operationCount = 0;
    let outputCount = 0;
    for (const contract of operationPageContracts) {
        for (const locale of docsLocales) {
            const source = localizedDocsSource(contract.path, locale);
            const content = read(path.join(docsRoot, source));
            for (const finding of collectOperationSourceFailures(content, contract, locale)) {
                failures.push(`${source} ${finding}`);
            }
            operationCount += count(content, /<!-- docs:operation /gu);
            outputCount += count(content, /<!-- docs:output /gu);
        }
    }

    const expectedOperationCount = operationPageContracts
        .reduce((total, contract) => total + contract.operations.length, 0) * docsLocales.length;
    const expectedOutputCount = operationPageContracts
        .reduce((total, contract) => total + contract.outputGroups.length, 0) * docsLocales.length;
    if (operationCount !== expectedOperationCount) {
        failures.push(`operation inventory expected ${expectedOperationCount} localized groups, received ${operationCount}`);
    }
    if (outputCount !== expectedOutputCount) {
        failures.push(`output provenance inventory expected ${expectedOutputCount} localized groups, received ${outputCount}`);
    }

    const contractedPaths = new Set(expectedPaths);
    for (const page of [
        ...englishPages,
        ...chinesePages.map((source) => `zh/${source}`),
    ]) {
        const canonical = page.replace(/^zh\//u, "");
        const content = read(path.join(docsRoot, page));
        if (!contractedPaths.has(canonical) && /<!-- docs:(?:operation|output) /u.test(content)) {
            failures.push(`operation marker exists outside its page contract: ${page}`);
        }
    }
}

function localizedOperationCalls(operation, locale) {
    return operation.callsByLocale?.[locale] ?? operation.calls;
}

function localizedProducerToken(output, locale) {
    return output.producerTokenByLocale?.[locale] ?? output.producerToken;
}

function collectOperationSourceFailures(content, contract, locale) {
    const findings = [];
    const expectedOperationMarkers = [];
    const expectedOutputMarkers = [];

    for (const operation of contract.operations) {
        const calls = localizedOperationCalls(operation, locale);
        const marker = `<!-- docs:operation id=${operation.id} calls=${calls.join(",")} outputs=${operation.outputs.join(",")} -->`;
        expectedOperationMarkers.push(marker);
        if (count(content, new RegExp(escapeRegExp(marker), "gu")) !== 1) {
            findings.push(`operation ${operation.id} is missing its exact contract marker`);
        }

        const section = extractMarkdownSection(content, 3, operation.headings[locale]);
        if (!section) {
            findings.push(`operation ${operation.id} is missing heading: ${operation.headings[locale]}`);
            continue;
        }
        if (!section.includes(marker)) {
            findings.push(`operation ${operation.id} marker is outside its visible section`);
        }

        const visible = section.replace(/<!--[\s\S]*?-->/gu, "");
        for (const label of operationLabels[locale]) {
            const token = `**${label}**`;
            if (count(visible, new RegExp(escapeRegExp(token), "gu")) !== 1) {
                findings.push(`operation ${operation.id} is missing visible label: ${label}`);
                continue;
            }
            const labelStart = visible.indexOf(token) + token.length;
            const laterLabels = operationLabels[locale]
                .map((candidate) => visible.indexOf(`**${candidate}**`, labelStart))
                .filter((index) => index >= 0);
            const labelEnd = laterLabels.length > 0 ? Math.min(...laterLabels) : visible.length;
            const explanation = stripMarkdown(visible.slice(labelStart, labelEnd));
            const isApiReference = label === operationLabels[locale][3];
            const minimum = isApiReference
                ? (locale === "zh" ? 10 : 20)
                : (locale === "zh" ? 20 : 45);
            if ([...explanation].length < minimum) {
                findings.push(`operation ${operation.id} ${label} explanation is too short`);
            }
        }

        for (const call of calls) {
            if (!visible.includes(`\`${call}\``)) {
                findings.push(`operation ${operation.id} method is not visible: ${call}`);
            }
        }
        for (const apiPath of operation.apiPaths) {
            const target = locale === "zh" ? `/zh${apiPath}` : apiPath;
            if (!section.includes(`](${target})`)) {
                findings.push(`operation ${operation.id} is missing API link: ${target}`);
            }
        }
    }

    const actualOperationMarkers = [...content.matchAll(/<!-- docs:operation [^>]+ -->/gu)]
        .map((match) => match[0]);
    if (JSON.stringify(actualOperationMarkers) !== JSON.stringify(expectedOperationMarkers)) {
        findings.push("operation marker order or inventory differs from the contract");
    }

    for (const output of contract.outputGroups) {
        const marker = `<!-- docs:output group=${output.group} producer=${output.producer} -->`;
        expectedOutputMarkers.push(marker);
        if (count(content, new RegExp(escapeRegExp(marker), "gu")) !== 1) {
            findings.push(`output ${output.group} is missing its exact output marker`);
            continue;
        }
        if (!contract.operations.some((operation) => operation.id === output.producer)) {
            findings.push(`output ${output.group} references unknown producer ${output.producer}`);
        }

        const markerStart = content.indexOf(marker) + marker.length;
        const relativeEnd = content.slice(markerStart).search(/\n(?:<!-- docs:output|## )/u);
        const markerEnd = relativeEnd === -1 ? content.length : markerStart + relativeEnd;
        const visible = content.slice(markerStart, markerEnd).replace(/<!--[\s\S]*?-->/gu, "");
        const label = locale === "zh"
            ? `**\`${output.group}\` 来源。**`
            : `**\`${output.group}\` provenance.**`;
        if (!visible.includes(label)) {
            findings.push(`output ${output.group} is missing its visible provenance label`);
        }
        const producerToken = localizedProducerToken(output, locale);
        if (!visible.includes(`\`${producerToken}\``)) {
            findings.push(`output ${output.group} does not name producer token ${producerToken}`);
        }
        const explanation = stripMarkdown(visible);
        const minimum = locale === "zh" ? 35 : 70;
        if ([...explanation].length < minimum) {
            findings.push(`output ${output.group} provenance explanation is too short`);
        }
    }

    const actualOutputMarkers = [...content.matchAll(/<!-- docs:output [^>]+ -->/gu)]
        .map((match) => match[0]);
    if (JSON.stringify(actualOutputMarkers) !== JSON.stringify(expectedOutputMarkers)) {
        findings.push("output marker order or inventory differs from the contract");
    }
    return findings;
}

function verifyOperationNegativeFixtures() {
    const contract = operationPageContracts[0];
    const locale = "en";
    const valid = read(path.join(docsRoot, contract.path));
    if (collectOperationSourceFailures(valid, contract, locale).length > 0) {
        failures.push("valid operation source fixture did not pass");
        return;
    }

    const roleOutputMarker = "<!-- docs:output group=role producer=basic-role-state -->";
    const cases = [
        {
            name: "missing operation label",
            content: valid.replace("**Purpose and target.**", "**Purpose removed.**"),
            expected: "missing visible label: Purpose and target.",
        },
        {
            name: "broad operation explanation",
            content: valid.replace(
                /\*\*Purpose and target\.\*\*[\s\S]*?(?=\r?\n\r?\n\*\*State, arguments, and result\.\*\*)/u,
                "**Purpose and target.** Works.",
            ),
            expected: "Purpose and target. explanation is too short",
        },
        {
            name: "method hidden in marker only",
            content: valid.replace("`roles.create` creates", "`role write` creates"),
            expected: "method is not visible: roles.create",
        },
        {
            name: "missing operation API link",
            content: valid.replace("](/api/roles)", "](#roles)"),
            expected: "missing API link: /api/roles",
        },
        {
            name: "disconnected output producer",
            content: valid.replace(
                roleOutputMarker,
                "<!-- docs:output group=role producer=basic-assignment -->",
            ),
            expected: "output role is missing its exact output marker",
        },
    ];

    for (const fixture of cases) {
        const fixtureFailures = collectOperationSourceFailures(fixture.content, contract, locale);
        if (!fixtureFailures.some((finding) => finding.includes(fixture.expected))) {
            failures.push(`operation negative fixture did not fail: ${fixture.name}`);
        }
    }
}

function extractMarkdownSection(content, level, heading) {
    const startToken = `${"#".repeat(level)} ${heading}`;
    const start = content.indexOf(startToken);
    if (start < 0) return null;
    const bodyStart = start + startToken.length;
    const relativeEnd = content.slice(bodyStart).search(new RegExp(`\\n#{1,${level}} `, "u"));
    const end = relativeEnd === -1 ? content.length : bodyStart + relativeEnd;
    return content.slice(start, end);
}

function stripMarkdown(value) {
    return value
        .replace(/<!--[\s\S]*?-->/gu, " ")
        .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
        .replace(/[`*_#]/gu, "")
        .replace(/\s+/gu, " ")
        .trim();
}

function verifyMermaidPipelineConfig() {
    const websitePackage = JSON.parse(read(path.join(projectRoot, "website", "package.json")));
    if (websitePackage.dependencies?.["rspress-plugin-devkit"] !== "1.0.0") {
        failures.push("website must pin rspress-plugin-devkit to 1.0.0");
    }
    if (websitePackage.dependencies?.["rspress-plugin-mermaid"] !== undefined) {
        failures.push("website must use the serialized local Mermaid renderer instead of the racy upstream renderer");
    }
    if (websitePackage.dependencies?.mermaid !== "10.9.6") {
        failures.push("website must pin mermaid to 10.9.6");
    }
    if (websitePackage.overrides?.mermaid?.uuid !== "11.1.1") {
        failures.push("website must pin Mermaid's uuid dependency to the fixed 11.1.1 release");
    }
    if (websitePackage.scripts?.prebuild !== "node ./scripts/check-mermaid.mjs") {
        failures.push("website build must run the Mermaid parser through prebuild");
    }

    const config = read(path.join(projectRoot, "website", "rspress.config.ts"));
    for (const marker of [
        "permissionCoreMermaidPlugin",
        'securityLevel: "strict"',
        "startOnLoad: false",
        "htmlLabels: false",
        "useMaxWidth: true",
    ]) {
        if (!config.includes(marker)) failures.push(`Rspress Mermaid config is missing: ${marker}`);
    }

    const theme = read(path.join(projectRoot, "website", "theme", "index.tsx"));
    for (const marker of ["syncMermaidAccessibility", "pc-mermaid", "aria-describedby"]) {
        if (!theme.includes(marker)) failures.push(`website theme is missing Mermaid synchronization marker: ${marker}`);
    }

    const renderer = read(path.join(projectRoot, "website", "theme", "MermaidRenderer.tsx"));
    for (const marker of ["renderQueue", "enqueueRender", "nextRenderId", "data-mermaid-state"]) {
        if (!renderer.includes(marker)) failures.push(`website Mermaid renderer is missing serialization marker: ${marker}`);
    }

    const styles = read(path.join(projectRoot, "website", "styles", "payment-permission.css"));
    for (const marker of [".pc-mermaid", ".pc-diagram-text", "overflow-x: auto"]) {
        if (!styles.includes(marker)) failures.push(`website styles are missing Mermaid marker: ${marker}`);
    }
}

function comparePageSets() {
    const english = new Set(englishPages);
    const chinese = new Set(chinesePages);
    for (const page of docsPages) {
        if (supportsLocale(page, "en") && supportsLocale(page, "zh") && !chinese.has(page.path)) {
            failures.push(`missing Chinese page for ${page.path}`);
        }
        if (supportsLocale(page, "en") && supportsLocale(page, "zh") && !english.has(page.path)) {
            failures.push(`missing English page for ${page.path}`);
        }
    }
}

function verifyPagesAreSubstantial() {
    for (const [locale, root, pages] of [
        ["EN", docsRoot, englishPages],
        ["ZH", path.join(docsRoot, "zh"), chinesePages],
    ]) {
        for (const page of pages) {
            const content = read(path.join(root, page));
            if (content.trim().length < 100) {
                failures.push(`${locale} page is empty or placeholder-like: ${page}`);
            }
            const h1Count = count(content, /^# /gm);
            if (h1Count !== 1) {
                failures.push(`${locale} page must contain exactly one H1: ${page} (${h1Count})`);
            }
        }
    }
}

function verifyLanguagePairSizeDrift() {
    if (localeMode !== "all") return;
    for (const page of docsPages.filter((item) => supportsLocale(item, "en") && supportsLocale(item, "zh")).map((item) => item.path)) {
        const english = Buffer.byteLength(read(path.join(docsRoot, page)), "utf8");
        const chinese = Buffer.byteLength(read(path.join(docsRoot, "zh", page)), "utf8");
        const ratio = Math.min(english, chinese) / Math.max(english, chinese);
        if (ratio < 0.5) {
            failures.push(
                `${page} has high EN/ZH size drift (${english}/${chinese}); review page-role parity`,
            );
        }
    }
}

function verifyCriticalPages() {
    const contracts = {
        "index.md": ["permission-core", "MonSQLize 3.1", "Vext"],
        "guide/introduction.md": ["MonSQLize 3.1", "PermissionSubject", "scope"],
        "guide/quick-start.md": ["roles.create", "roles.allow", "userRoles.assign", "subject.can", "deleteAllowed", "pc.close"],
        "guide/core-concepts.md": ["scope", "subject", "direct", "effective", "default deny", "revision", "preview"],
        "guide/troubleshooting.md": ["PermissionCore", "VEXT_AUTH_REQUIRED", "SCOPE_FIELD_MAPPING_REQUIRED"],
        "guide/manage-roles-and-users.md": ["roles.create", "userRoles.assign", "userRoles.set", "getEffectiveRules", "previewAccessUpdate", "getRemovalImpact"],
        "guide/check-permission.md": ["cannot", "explain", "getEffectiveRules", "userRoles.set", "getResources"],
        "guide/data-permissions.md": ["filter", "where", "AuthorizedCollection", "FIELD_PERMISSION_DENIED"],
        "guide/menu-management.md": ["menus.configs.get", "menus.management.applyChanges", "filterResponse", "getViewTree"],
        "guide/menu-config-as-code.md": ["MenuConfigInput", "menus.config.preview", "menus.config.save", "menus.config.previewChanges", "menus.config.applyChanges"],
        "guide/api-bindings.md": ["load.resource", "actions[].resource", "response", "subject.assert"],
        "guide/role-menu-authorization.md": ["menuPermissions.preview", "responseFields", "getAuthorizationTree", "filterResponse"],
        "guide/permission-lifecycle.md": ["flowchart", "revision", "auditId", "PermissionCore.close"],
        "guide/resources-and-rules.md": ["no-allow", "db:orders:field", "ResourceSchemeDefinition", "valueFrom"],
        "guide/role-inheritance.md": ["getOwnRules", "getEffectiveRules", "CIRCULAR_INHERITANCE", "getRemovalImpact"],
        "guide/multi-tenant.md": ["flowchart TD", "same-user", "scopeFields", "SCOPE_CONFLICT"],
        "guide/cache.md": ["ordered-bounded-stale", "caller-attested", "invalidationRiskUntil", "pendingCacheOutcomes"],
        "guide/vext-plugin.md": ["permissionPlugin", "resolveMonSQLize", "permission: true", "VEXT_ROUTE_RESTART_REQUIRED"],
        "guide/authentication-boundary.md": ["PermissionSubject", "resolveSubject", "SCOPE_CONFLICT", "permission: false"],
        "guide/production-operations.md": ["health", "idempotencyKey", "PREVIEW_STALE", "CORE_CLOSE_TIMEOUT"],
        "api/core-and-contexts.md": ["PermissionCoreOptions", "ScopedPermissionContext", "SubjectPermissionContext", "close(): Promise<void>"],
        "api/roles.md": ["previewAccessUpdate", "executeRuleChange", "replaceRules", "getEffectiveRules"],
        "api/user-roles.md": ["assign(userId", "set(userId", "getDirect", "getEffective"],
        "api/menus.md": ["menus.config.preview", "menus.config.save", "menus.config.previewChanges", "subject.menus.filterResponse"],
        "api/api-bindings.md": ["MenuConfigInput.load", "MenuConfigInput.actions", "MenuConfigInput.response", "ApiResource"],
        "api/role-menu-permissions.md": ["selectedResponseFields", "getAuthorizationTree", "responseFields", "generatedSources"],
        "api/authorized-collection.md": ["findPage", "updateMany", "deleteMany", "scopeFields"],
        "api/audit-and-health.md": ["PermissionCoreHealth", "operationId", "auditId", "pendingCacheOutcomes"],
        "api/errors.md": ["PermissionCoreErrorCode", "PERMISSION_DENIED", "VEXT_ROUTE_RESTART_REQUIRED", "reconcile-superseded"],
        "api/resource-schemes.md": ["ResourceSchemeDefinition", "probes", "expectedSchemeContractDigest", "INVALID_CONFIGURATION"],
        "api/match-resource.md": ["permission-core/match", "matchResource", "tooShort", "PermissionCore"],
        "api/vext-plugin.md": ["permissionPlugin", "requirePermissionContext", "filterResponse", "api:GET:/orders/:id"],
        "examples/basic.md": ["examples/basic.mjs", "docs:basic:start", "cannotDelete", "deleteReason"],
        "examples/multi-tenant.md": ["examples/multi-tenant.mjs", "docs:multi-tenant:start", "crossTenantResource"],
        "examples/data-guard.md": ["examples/data-guard.mjs", "docs:data-guard:start", "FIELD_PERMISSION_DENIED", "persistedRows"],
        "examples/menu-admin.md": ["examples/menu-admin.mjs", "docs:menu-admin:start", "generatedSources", "auditRecorded"],
        "examples/vext.md": ["examples/vext/index.mjs", "docs:vext:start", "routeReloadRequiresRestart", "hostDatabaseStillConnected"],
    };

    if (Object.keys(contracts).length !== docsPages.length) {
        failures.push(`critical page contract expected ${docsPages.length} entries, received ${Object.keys(contracts).length}`);
    }
    for (const [page, markers] of Object.entries(contracts)) {
        const manifestPage = docsPages.find((item) => item.path === page);
        for (const [locale, localeCode, root] of activeLocales()) {
            if (!manifestPage || !supportsLocale(manifestPage, localeCode)) continue;
            const content = read(path.join(root, page)).toLowerCase();
            for (const marker of markers) {
                if (!content.includes(marker.toLowerCase())) {
                    failures.push(`${locale} ${page} is missing critical marker: ${marker}`);
                }
            }
        }
    }
}

function verifyCriticalPairStructure() {
    if (localeMode !== "all") return;
    for (const page of docsPages.filter((item) => supportsLocale(item, "en") && supportsLocale(item, "zh")).map((item) => item.path)) {
        const english = read(path.join(docsRoot, page));
        const chinese = read(path.join(docsRoot, "zh", page));
        const headingSignature = (content) => [...content.matchAll(/^(#{1,6}) /gm)]
            .map((match) => match[1].length)
            .join(",");
        const englishHeadings = headingSignature(english);
        const chineseHeadings = headingSignature(chinese);
        const englishFences = count(english, /^```/gm);
        const chineseFences = count(chinese, /^```/gm);
        if (englishHeadings !== chineseHeadings) {
            failures.push(`${page} heading-level structure differs: EN ${englishHeadings}, ZH ${chineseHeadings}`);
        }
        if (englishFences !== chineseFences) {
            failures.push(`${page} code-fence structure differs: EN ${englishFences}, ZH ${chineseFences}`);
        }

        const fencedBlocks = (content) => [...content.matchAll(/```([^\n]*)\n([\s\S]*?)```/g)]
            .map((match) => ({ language: match[1].trim(), body: match[2] }));
        const englishBlocks = fencedBlocks(english);
        const chineseBlocks = fencedBlocks(chinese);
        const normalizeExecutableBlock = (body) => body
            .replace(/\r\n/g, "\n")
            .split("\n")
            .filter((line) => !/^\s*\/\//u.test(line))
            .map((line) => line.trimEnd())
            .join("\n")
            .trim();
        for (let blockIndex = 0; blockIndex < englishBlocks.length; blockIndex += 1) {
            const englishBlock = englishBlocks[blockIndex];
            const chineseBlock = chineseBlocks[blockIndex];
            if (!chineseBlock || englishBlock.language !== chineseBlock.language) continue;
            if (!/^(?:bash|js|json|ts)$/u.test(englishBlock.language)) continue;
            if (normalizeExecutableBlock(englishBlock.body) !== normalizeExecutableBlock(chineseBlock.body)) {
                failures.push(`${page} executable block ${blockIndex + 1} differs between EN and ZH`);
            }
        }

        const inlineCode = (content) => new Set(
            [...content.replace(/```[\s\S]*?```/g, "").matchAll(/`([^`\n]+)`/g)]
                .map((match) => match[1]),
        );
        const englishInline = inlineCode(english);
        const chineseInline = inlineCode(chinese);
        const missingEnglishTokens = [...chineseInline].filter((token) => !englishInline.has(token));
        if (missingEnglishTokens.length > 0) {
            failures.push(`${page} is missing EN inline public identifiers from ZH: ${missingEnglishTokens.slice(0, 5).join(", ")}`);
        }
    }
}

function verifyJsonCodeBlocks() {
    for (const [locale, root, pages] of [
        ["EN", docsRoot, englishPages],
        ["ZH", path.join(docsRoot, "zh"), chinesePages],
    ]) {
        for (const page of pages) {
            const content = read(path.join(root, page));
            for (const [index, match] of [...content.matchAll(/```json\r?\n([\s\S]*?)```/g)].entries()) {
                try {
                    JSON.parse(match[1]);
                } catch (error) {
                    failures.push(`${locale} ${page} JSON block ${index + 1} is invalid: ${error.message}`);
                }
            }
        }
    }
}

function verifyApiReferenceContracts() {
    const apiPages = docsPages.filter((page) => page.section === "api");
    const signatureMarkers = {
        "api/core-and-contexts.md": ["subject: PermissionSubject", "action: PermissionAction", "context?: PolicyContext"],
        "api/roles.md": ["input: RoleCreateInput", "options: RequiredRevisionVectorOptions & PreviewExecutionOptions", "rules: readonly ManualRuleInput[]"],
        "api/user-roles.md": ["roleIds: readonly string[]", "options: RequiredRevisionOptions", "query?: CursorQuery"],
        "api/menus.md": ["config: MenuConfigInput", "options: MenuConfigSaveOptions", "changes: NonEmptyMenuConfigChangeArray"],
        "api/api-bindings.md": ["load.resource: ApiResource", "actions[].resource: ApiResource | UiResource", "response?: ResponseProjectionConfigInput"],
        "api/role-menu-permissions.md": ["change: MenuBusinessPermissionChange", "selection: MenuBusinessPermissionSelection", "assignments: readonly MenuBusinessPermissionAssignment[]"],
        "api/authorized-collection.md": ["options: AuthorizedCollectionOptions", "filter?: SafeMongoFilter", "options: AuthorizedBulkWriteOptions"],
    };
    const expectedHeadings = {
        EN: [
            "Purpose and preconditions",
            "Signatures",
            "Responses and side effects",
            "Failures and limits",
            "Example",
            "Related",
        ],
        ZH: [
            "用途与前置条件",
            "签名",
            "响应与副作用",
            "失败与限制",
            "示例",
            "相关内容",
        ],
    };

    if (apiPages.length !== 12) {
        failures.push(`API reference contract expected 12 pages, received ${apiPages.length}`);
    }

    for (const page of apiPages) {
        for (const [locale, , root] of activeLocales()) {
            const content = read(path.join(root, page.path));
            const headings = [...content.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
            let previousIndex = -1;
            for (const heading of expectedHeadings[locale]) {
                const index = headings.indexOf(heading);
                if (index < 0 || index <= previousIndex) {
                    failures.push(`${locale} ${page.path} is missing or reorders API reference slot: ${heading}`);
                }
                previousIndex = index;
            }

            const codeBlocks = count(content, /^```[^\n]*$/gm) / 2;
            if (codeBlocks < 4 || !content.includes("```json")) {
                failures.push(`${locale} ${page.path} must contain at least signatures, response, example, and example-output blocks`);
            }

            if (/^## .*(?:Tutorial|教程|Deployment|部署|Reading Order|阅读顺序|Release Checklist|发布清单)/gmi.test(content)) {
                failures.push(`${locale} ${page.path} contains a non-reference API section`);
            }

            for (const marker of signatureMarkers[page.path] ?? []) {
                if (!content.includes(marker)) {
                    failures.push(`${locale} ${page.path} is missing public signature type: ${marker}`);
                }
            }
        }
    }

    for (const [locale, , root] of activeLocales()) {
        const coreApi = read(path.join(root, "api/core-and-contexts.md"));
        for (const marker of ['"evaluations"', '"evaluatedAllows"', '"evaluatedDenies"']) {
            if (!coreApi.includes(marker)) failures.push(`${locale} core response example is missing ${marker}`);
        }
    }

    const errorTypes = read(path.join(projectRoot, "src/types/errors.ts"));
    const errorUnion = errorTypes.slice(
        errorTypes.indexOf("export type PermissionCoreErrorCode"),
        errorTypes.indexOf("export interface LimitExceededDetails"),
    );
    for (const [locale, , root] of activeLocales()) {
        const errors = read(path.join(root, "api/errors.md"));
        for (const match of errorUnion.matchAll(/"([A-Z][A-Z0-9_]+)"/g)) {
            if (!errors.includes(`\`${match[1]}\``)) failures.push(`${locale} api/errors.md is missing public code ${match[1]}`);
        }
    }
}

function verifyApiMethodComprehensionContracts() {
    const expectedPaths = docsPages
        .filter((page) => page.section === "api")
        .map((page) => page.path)
        .sort();
    const contractPaths = apiMethodContracts.map((contract) => contract.path).sort();
    if (JSON.stringify(contractPaths) !== JSON.stringify(expectedPaths)) {
        failures.push("API method comprehension contracts do not exactly cover the API page set");
    }

    for (const contract of apiMethodContracts) {
        for (const [localeLabel, locale, root] of activeLocales()) {
            const content = read(path.join(root, contract.path));
            for (const finding of collectApiMethodComprehensionFailures(
                content,
                contract,
                locale,
            )) {
                failures.push(`${localeLabel} ${contract.path} ${finding}`);
            }
        }
    }
}

function collectApiMethodComprehensionFailures(content, contract, locale) {
    const findings = [];
    const expectedMarkers = contract.methods.map(
        (method) => `<!-- docs:method name=${method} locale=${locale} -->`,
    );
    const actualMarkers = [
        ...content.matchAll(/<!--\s*docs:method name=([^\s]+) locale=(en|zh)\s*-->/gu),
    ].map((match) => match[0]);
    if (JSON.stringify(actualMarkers) !== JSON.stringify(expectedMarkers)) {
        findings.push("method marker order or inventory differs from the contract");
    }
    if (!/<!--\s*docs:params owner=[^\s]+ locale=(?:en|zh)\s*-->/u.test(content)) {
        findings.push("is missing a visible parameter-contract owner marker");
    }

    for (const [index, method] of contract.methods.entries()) {
        const marker = expectedMarkers[index];
        const markerMatches = [...content.matchAll(new RegExp(escapeRegExp(marker), "gu"))];
        if (markerMatches.length !== 1) {
            findings.push(`method ${method} must have exactly one method marker`);
            continue;
        }

        const markerIndex = markerMatches[0].index;
        const precedingHeadings = [
            ...content.slice(0, markerIndex).matchAll(/^###\s+(.+)$/gmu),
        ];
        const heading = precedingHeadings.at(-1);
        if (!heading) {
            findings.push(`method ${method} is not owned by an H3 section`);
            continue;
        }

        const sectionStart = heading.index;
        const remaining = content.slice(markerIndex + marker.length);
        const nextHeading = remaining.search(/\n#{1,3}\s+/u);
        const sectionEnd = nextHeading < 0
            ? content.length
            : markerIndex + marker.length + nextHeading;
        const section = content.slice(sectionStart, sectionEnd);
        const headingText = stripMarkdown(heading[1]);
        const visibleSegments = method === "ResourceSchemeDefinition.callbacks"
            ? ["validate", "match"]
            : method.split(".").filter((segment) => segment.length >= 3);
        if (!visibleSegments.some((segment) => headingText.includes(segment))) {
            findings.push(`method ${method} is present only in a hidden marker`);
        }

        for (const label of apiMethodEvidenceLabels[locale]) {
            const evidence = new RegExp(
                `\\*\\*${escapeRegExp(label)}\\*\\*[：:]\\s*([^\\r\\n]+)`,
                "u",
            ).exec(section)?.[1];
            if (!evidence) {
                findings.push(`method ${method} is missing visible evidence: ${label}`);
                continue;
            }
            const minimumLength = locale === "zh" ? 2 : 5;
            if ([...stripMarkdown(evidence)].length < minimumLength) {
                findings.push(`method ${method} ${label} explanation is too short`);
            }
        }
    }

    return findings;
}

function verifyApiMethodNegativeFixtures() {
    const contract = apiMethodContracts[0];
    const locale = "zh";
    const valid = read(path.join(docsRoot, "zh", contract.path));
    if (collectApiMethodComprehensionFailures(valid, contract, locale).length > 0) {
        failures.push("valid Chinese API method comprehension fixture did not pass");
        return;
    }

    const firstMarker = `<!-- docs:method name=${contract.methods[0]} locale=${locale} -->`;
    const cases = [
        {
            name: "missing API method parameter evidence",
            content: valid.replace("**参数**", "**参数已移除**"),
            expected: "is missing visible evidence: 参数",
        },
        {
            name: "method hidden in marker only",
            content: valid.replace("### `new PermissionCore(options)`", "### `new authorization core(options)`"),
            expected: "is present only in a hidden marker",
        },
        {
            name: "missing API method marker",
            content: valid.replace(firstMarker, ""),
            expected: "method marker order or inventory differs",
        },
    ];

    for (const fixture of cases) {
        const fixtureFailures = collectApiMethodComprehensionFailures(
            fixture.content,
            contract,
            locale,
        );
        if (!fixtureFailures.some((finding) => finding.includes(fixture.expected))) {
            failures.push(`API method negative fixture did not fail: ${fixture.name}`);
        }
    }
}

function verifyExampleRoleContracts() {
    const examplePages = docsPages.filter((page) => page.section === "examples");
    const expectedHeadings = {
        EN: ["Scenario", "Run", "First Check the Result", "Source walkthrough", "Expected output", "Production boundary", "Related"],
        ZH: ["场景", "运行", "先看结果", "源码解读", "预期输出", "生产边界", "相关内容"],
    };
    const sourceMarkers = {
        "examples/basic.md": ["examples/basic.mjs", "docs:basic:start", "npm run example:basic"],
        "examples/multi-tenant.md": ["examples/multi-tenant.mjs", "docs:multi-tenant:start", "npm run example:multi-tenant"],
        "examples/data-guard.md": ["examples/data-guard.mjs", "docs:data-guard:start", "npm run example:data-guard"],
        "examples/menu-admin.md": ["examples/menu-admin.mjs", "docs:menu-admin:start", "npm run example:menu-admin"],
        "examples/vext.md": ["examples/vext/index.mjs", "docs:vext:start", "npm run example:vext"],
    };
    const successMarkers = {
        "examples/basic.md": ["permissionChecks.allowed", "permissionChecks.cannotDelete", "userRoles.afterSet"],
        "examples/multi-tenant.md": ["ownResource", "crossTenantResource"],
        "examples/data-guard.md": ["matchedCount", "deniedFieldCode", "persistedRows"],
        "examples/menu-admin.md": ["roleGrant.generatedSources", "subjectRuntime.exportEnabled", "subjectRuntime.projectedResponse"],
        "examples/vext.md": ["401", "403", "503", "hostDatabaseStillConnected"],
    };

    if (examplePages.length !== 5) {
        failures.push(`example role contract expected five pages, received ${examplePages.length}`);
    }

    for (const page of examplePages) {
        for (const [locale, , root] of activeLocales()) {
            const content = read(path.join(root, page.path));
            const headings = [...content.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
            if (JSON.stringify(headings) !== JSON.stringify(expectedHeadings[locale])) {
                failures.push(`${locale} ${page.path} does not use the fixed example role slots`);
            }

            const codeBlocks = count(content, /^```[^\n]*$/gm) / 2;
            if (codeBlocks < 3 || !content.includes("```json")) {
                failures.push(`${locale} ${page.path} must contain at least run, source, and expected-output blocks`);
            }

            for (const sourceMarker of sourceMarkers[page.path] ?? []) {
                if (!content.includes(sourceMarker)) {
                    failures.push(`${locale} ${page.path} is missing runnable source marker ${sourceMarker}`);
                }
            }
            if (locale === "ZH") {
                const quickResult = extractMarkdownSection(content, 2, "先看结果");
                for (const marker of successMarkers[page.path] ?? []) {
                    if (!quickResult.includes(marker)) {
                        failures.push(`${locale} ${page.path} quick-result layer is missing ${marker}`);
                    }
                }
            }
        }
    }

    const packageJson = JSON.parse(read(path.join(projectRoot, "package.json")));
    const expectedScripts = ["basic", "multi-tenant", "data-guard", "menu-admin", "vext"];
    for (const name of expectedScripts) {
        if (typeof packageJson.scripts?.[`example:${name}`] !== "string") {
            failures.push(`package.json is missing example:${name}`);
        }
    }
}

function verifyDisplayedExampleCallContracts() {
    for (const contract of operationPageContracts) {
        for (const [localeLabel, locale, root] of activeLocales()) {
            const content = read(path.join(root, contract.path));
            for (const finding of collectDisplayedExampleCallFailures(
                content,
                contract,
                locale,
            )) {
                failures.push(`${localeLabel} ${contract.path} ${finding}`);
            }
        }
    }
}

function collectDisplayedExampleCallFailures(content, contract, locale) {
    const findings = [];
    const displayedCode = [
        ...content.matchAll(/```(?:js|javascript|mjs|ts|typescript)\r?\n([\s\S]*?)```/gu),
    ].map((match) => match[1]).join("\n");
    if (!displayedCode.trim()) {
        findings.push("does not contain a displayed JavaScript/TypeScript source block");
        return findings;
    }

    for (const operation of contract.operations) {
        for (const call of localizedOperationCalls(operation, locale)) {
            if (!displayedExampleContainsCall(displayedCode, call)) {
                findings.push(`operation ${operation.id} displayed source is missing call: ${call}`);
            }
        }
    }

    const summaryLabel = locale === "zh" ? "示例汇总输出" : "Example summary output";
    if (!content.includes(summaryLabel)) {
        findings.push(`is missing the generated-output provenance label: ${summaryLabel}`);
    }
    return findings;
}

function displayedExampleContainsCall(displayedCode, call) {
    if (call === "permissionPlugin.setup") {
        return /permissionPlugin\s*\(/u.test(displayedCode) && /\)\s*\.setup\s*\(/u.test(displayedCode);
    }
    return displayedCode.includes(call);
}

function verifyDisplayedExampleCallNegativeFixtures() {
    const contract = operationPageContracts[0];
    const locale = "zh";
    const valid = read(path.join(docsRoot, "zh", contract.path));
    if (collectDisplayedExampleCallFailures(valid, contract, locale).length > 0) {
        failures.push("valid Chinese displayed example-call fixture did not pass");
        return;
    }

    const cases = [
        {
            name: "call remains in prose but is removed from displayed source",
            content: valid.replaceAll("roles.create", "roles_create_removed"),
            expected: "displayed source is missing call: roles.create",
        },
        {
            name: "example output provenance removed",
            content: valid.replace("示例汇总输出", "输出"),
            expected: "is missing the generated-output provenance label",
        },
    ];

    for (const fixture of cases) {
        const fixtureFailures = collectDisplayedExampleCallFailures(
            fixture.content,
            contract,
            locale,
        );
        if (!fixtureFailures.some((finding) => finding.includes(fixture.expected))) {
            failures.push(`displayed example negative fixture did not fail: ${fixture.name}`);
        }
    }
}

function verifyContentOwnership() {
    const owners = docsPages.map((page) => page.contentOwner);
    if (new Set(owners).size !== owners.length) failures.push("manifest content owners must be unique");

    const roleSections = new Map([
        ["reference", "api"],
        ["example", "examples"],
    ]);
    for (const page of docsPages) {
        const expectedSection = roleSections.get(page.role);
        if (expectedSection && page.section !== expectedSection) {
            failures.push(`${page.id} role ${page.role} is outside ${expectedSection}`);
        }
    }

    for (const [locale, root] of [["EN", docsRoot]]) {
        const quickStart = read(path.join(root, "guide/quick-start.md"));
        const steps = [...quickStart.matchAll(/^## ([1-5])\. /gm)].map((match) => Number(match[1]));
        if (JSON.stringify(steps) !== JSON.stringify([1, 2, 3, 4, 5])) {
            failures.push(`${locale} Quick Start must contain exactly the ordered five-step path`);
        }
        for (const marker of ["docs:first-success:start", "roles.create", "roles.allow", "userRoles.assign", "subject.can", "deleteAllowed", "pc.close", "msq.close"]) {
            if (!quickStart.includes(marker)) failures.push(`${locale} Quick Start is missing ${marker}`);
        }
        for (const forbidden of ["subject.cannot", "userRoles.set", "menuPermissions", "apiBindings", "scopeFields", "previewToken", "stale"]) {
            if (quickStart.includes(forbidden)) failures.push(`${locale} Quick Start contains advanced-path marker: ${forbidden}`);
        }
    }

    const chineseQuickStart = read(path.join(docsRoot, "zh", "guide/quick-start.md"));
    const chineseSteps = [...chineseQuickStart.matchAll(/^## ([1-5])\. /gm)].map((match) => Number(match[1]));
    if (JSON.stringify(chineseSteps) !== JSON.stringify([1, 2, 3, 4, 5])) {
        failures.push("ZH Quick Start must contain exactly the ordered five-step path");
    }
    for (const marker of ["docs:first-success:start", "roles.create", "roles.allow", "userRoles.assign", "subject.can", "deleteAllowed", "pc.close", "msq.close"]) {
        if (!chineseQuickStart.includes(marker)) failures.push(`ZH Quick Start is missing ${marker}`);
    }
    for (const forbidden of ["subject.cannot", "userRoles.set", "menuPermissions", "apiBindings", "scopeFields", "previewToken", "stale"]) {
        if (chineseQuickStart.includes(forbidden)) failures.push(`ZH Quick Start contains advanced-path marker: ${forbidden}`);
    }
}

function verifyDuplicateResponsibilities() {
    for (const [locale, root, pages] of [
        ["EN", docsRoot, englishPages],
        ["ZH", path.join(docsRoot, "zh"), chinesePages],
    ]) {
        const fingerprints = new Map();
        const tokenSets = new Map();
        for (const page of pages) {
            const content = read(path.join(root, page))
                .replace(/^---[\s\S]*?^---$/m, "")
                .replace(/```[\s\S]*?```/g, "")
                .replace(/^#.*$/gm, "")
                .replace(/\[[^\]]+\]\([^)]+\)/g, " ")
                .toLowerCase();
            const fingerprint = content.replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 240);
            if (fingerprint.length >= 120 && fingerprints.has(fingerprint)) {
                failures.push(`${locale} duplicate opening responsibility: ${fingerprints.get(fingerprint)} and ${page}`);
            }
            fingerprints.set(fingerprint, page);
            const tokens = new Set(content.match(/[\p{L}\p{N}_:-]{3,}/gu) ?? []);
            tokenSets.set(page, tokens);
        }

        for (let leftIndex = 0; leftIndex < pages.length; leftIndex += 1) {
            for (let rightIndex = leftIndex + 1; rightIndex < pages.length; rightIndex += 1) {
                const left = tokenSets.get(pages[leftIndex]);
                const right = tokenSets.get(pages[rightIndex]);
                if (left.size < 40 || right.size < 40) continue;
                const intersection = [...left].filter((token) => right.has(token)).length;
                const union = new Set([...left, ...right]).size;
                if (intersection / union >= 0.72) {
                    failures.push(`${locale} pages have suspiciously duplicate responsibility: ${pages[leftIndex]} and ${pages[rightIndex]}`);
                }
            }
        }
    }
}

function verifyMaintainerBoundary() {
    const maintainerCommands = [
        "npm run test:docs",
        "npm run test:package",
        "npm run test:coverage",
        "npm run example:all",
        "npm run build",
    ];
    const commandAllowances = new Map([
        ["guide/quick-start.md", new Set(["npm run build"])],
    ]);
    for (const [locale, , root, localePages] of activeLocales()) {
        for (const page of localePages.map((item) => item.path)) {
            const content = read(path.join(root, page));
            for (const command of maintainerCommands) {
                if (commandAllowances.get(page)?.has(command)) continue;
                if (content.includes(command)) failures.push(locale + " user page contains maintainer command " + command + ": " + page);
            }
        }
    }

    const contributing = read(path.join(projectRoot, "CONTRIBUTING.md"));
    for (const marker of [
        "npm ci",
        "npm run typecheck",
        "npm run test:complexity",
        "npm run test:coverage",
        "npm run test:docs",
        "npm run example:all",
        "npm run test:package",
        "npm --prefix website run build",
        "npm publish",
        "npm view permission-core@",
        "npm deprecate permission-core@",
        "npm dist-tag add permission-core@",
    ]) {
        if (!contributing.includes(marker)) failures.push("CONTRIBUTING is missing maintainer marker: " + marker);
    }
}

function verifyRepositoryWorkflowContracts() {
    const ci = read(path.join(projectRoot, ".github/workflows/ci.yml"));
    for (const [label, pattern] of [
        ["pull_request main trigger", /pull_request:\s*\r?\n\s+branches:\s*\[\s*main\s*\]/u],
        ["push main trigger", /push:\s*\r?\n\s+branches:\s*\[\s*main\s*\]/u],
    ]) {
        if (!pattern.test(ci)) failures.push(`CI workflow is missing ${label}`);
    }
    for (const marker of [
        "permissions:",
        "contents: read",
        "actions/checkout@v6",
        "actions/setup-node@v6",
        "node-version: '20.19'",
        "npm ci",
        "npm --prefix website ci",
        "npm run prepublishOnly",
        'id: preview',
        'PERMISSION_CORE_DOCS_VERSION: ${{ steps.preview.outputs.version }}',
        "npm --prefix website run build",
        "npm run test:docs:rendered",
    ]) {
        if (!ci.includes(marker)) failures.push(`CI workflow is missing release marker: ${marker}`);
    }
    if (/pull_request_target\s*:/u.test(ci)) {
        failures.push("CI workflow must not use pull_request_target for untrusted package execution");
    }
    if (/PERMISSION_CORE_DOCS_VERSION:\s*['"]?\d+\.\d+\.\d+/u.test(ci)) {
        failures.push("CI workflow must derive the preview version instead of hard-coding it");
    }

    const publish = read(path.join(projectRoot, ".github/workflows/publish.yml"));
    for (const marker of [
        'tags:',
        'Verify tag matches package.json version',
        'npm publish --provenance --access public',
        'NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}',
        'id-token: write',
    ]) {
        if (!publish.includes(marker)) failures.push(`Publish workflow is missing release marker: ${marker}`);
    }

    const pages = read(path.join(projectRoot, ".github/workflows/pages.yml"));
    for (const marker of [
        "npm view permission-core version",
        'ref: v${{ steps.stable.outputs.version }}',
        "PERMISSION_CORE_DOCS_CHANNEL: stable",
        "PERMISSION_CORE_DOCS_CHANNEL: preview",
        "npm run docs:assemble",
    ]) {
        if (!pages.includes(marker)) failures.push(`Pages workflow is missing channel marker: ${marker}`);
    }
}

function verifyInternalLinks() {
    for (const page of [
        ...englishPages.map((file) => path.join(docsRoot, file)),
        ...chinesePages.map((file) => path.join(docsRoot, "zh", file)),
    ]) {
        const content = read(page).replace(/```[\s\S]*?```/g, "");
        const links = content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g);
        for (const match of links) {
            const target = match[1].trim().replace(/^<|>$/g, "");
            if (!target || /^(?:https?:|mailto:|#)/.test(target)) {
                continue;
            }
            if (!resolveInternalTarget(page, target)) {
                failures.push(
                    `${path.relative(projectRoot, page).replaceAll("\\", "/")} has broken link: ${target}`,
                );
            }
        }
    }
}

function verifySourceAnchors() {
    for (const page of docsPages) {
        let sourceText = "";
        for (const source of page.sourceOfTruth) {
            const sourcePath = path.join(projectRoot, source);
            if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
                failures.push(`manifest source anchor is not a file: ${page.id} -> ${source}`);
            } else {
                sourceText += `\n${read(sourcePath)}`;
            }
        }
        if (!sourceText.includes(page.sourceSymbol)) {
            failures.push(`manifest source symbol is not present in its anchors: ${page.id} -> ${page.sourceSymbol}`);
        }
    }
}

function verifyLocaleLinkBoundaries() {
    for (const page of docsPages) {
        for (const [locale, file] of [
            ...(supportsLocale(page, "en") ? [["EN", path.join(docsRoot, page.path)]] : []),
            ...(supportsLocale(page, "zh") ? [["ZH", path.join(docsRoot, "zh", page.path)]] : []),
        ]) {
            const content = read(file).replace(/```[\s\S]*?```/g, "");
            for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
                const target = match[1].trim().replace(/^<|>$/g, "");
                if (locale === "EN" && /^\/zh(?:\/|$)/.test(target)) {
                    failures.push(`EN ${page.path} crosses into the ZH locale: ${target}`);
                }
                if (locale === "ZH" && /^\/(?!zh(?:\/|$)|assets\/|permission-core\/)/.test(target)) {
                    failures.push(`ZH ${page.path} crosses into the EN locale: ${target}`);
                }
            }
        }
    }
}

function resolveInternalTarget(page, rawTarget) {
    const target = decodeURIComponent(rawTarget.split(/[?#]/, 1)[0]);
    const hasExtension = path.extname(target) !== "";
    const base = target.startsWith("/")
        ? path.join(docsRoot, target.slice(1))
        : path.resolve(path.dirname(page), target);
    const candidates = hasExtension
        ? [base, path.join(docsRoot, "public", target.replace(/^\/(?:zh\/)?/, ""))]
        : [`${base}.md`, path.join(base, "index.md")];
    return candidates.some((candidate) => fs.existsSync(candidate));
}

function verifyStaleClaims() {
    const files = [
        path.join(projectRoot, "README.md"),
        path.join(projectRoot, "changelogs", "unreleased.md"),
        ...englishPages.map((file) => path.join(docsRoot, file)),
        ...chinesePages.map((file) => path.join(docsRoot, "zh", file)),
    ];
    const stalePatterns = [
        [/66 tests|test count to 66|66 个测试/gi, "stale test-count claim"],
        [/scrolling into the center content pane|中间(?:正文|文档)[^\n]*独立滚动/gi, "obsolete center-pane scrolling claim"],
        [/100% (?:statement|branch|function|line|coverage)|100% 覆盖率/gi, "unverified 100% coverage claim"],
        [/current version[^\n]*1\.0\.10|当前版本[^\n]*1\.0\.10/gi, "stale current-version claim"],
        [/permission-core\/adapters\/vext/gi, "retired Vext path must not appear in current public documentation"],
        [/new\s+(?:MemoryAdapter|FileAdapter|MonSQLizeStorageAdapter)\b/gi, "retired storage adapter construction"],
    ];
    for (const file of files) {
        const content = read(file);
        for (const [pattern, label] of stalePatterns) {
            pattern.lastIndex = 0;
            if (pattern.test(content)) {
                failures.push(`${label}: ${path.relative(projectRoot, file).replaceAll("\\", "/")}`);
            }
        }

        for (const [lineIndex, line] of content.split(/\r?\n/).entries()) {
            const legacyTerm = /permission-core\/adapters\/vext|cache-hub|\b(?:MemoryAdapter|FileAdapter|MonSQLizeStorageAdapter|StorageAdapter)\b/u.exec(line)?.[0];
            if (!legacyTerm) continue;
            const negativeBoundary = /\b(?:no|not|never|retired|removed|without)\b|没有|不是|不要|已退出|已移除|不再|不(?:直接|依赖|配置|创建|使用|支持|需要)/u.test(line);
            if (!negativeBoundary) {
                failures.push(`legacy public claim ${legacyTerm}: ${path.relative(projectRoot, file).replaceAll("\\", "/")}:${lineIndex + 1}`);
            }
        }
    }
}

function verifyDocumentationExperienceGuardrails() {
    const genericEnglishPurpose = "perform the documented role, user, menu, API, data, health, or integration operation";
    for (const page of docsPages.filter((item) => item.section === "api" && supportsLocale(item, "en"))) {
        const content = read(path.join(docsRoot, page.path));
        if (content.includes(genericEnglishPurpose)) {
            failures.push(`EN ${page.path} contains generic API purpose copy instead of method-specific intent`);
        }
    }

    for (const [locale, root] of [
        ["EN", docsRoot],
        ["ZH", path.join(docsRoot, "zh")],
    ]) {
        const checkPermission = read(path.join(root, "guide/check-permission.md"));
        for (const marker of [
            "subject.can(action, resource, context?)",
            "subject.cannot(action, resource, context?)",
            "subject.assert(action, resource, context?)",
            "subject.getPermissions(options?)",
            "subject.getResources(action?, options?)",
        ]) {
            if (checkPermission.includes(marker)) {
                failures.push(`${locale} Check Permissions exposes unsupported subject facade signature: ${marker}`);
            }
        }
        if (/detailBudget\s*[:?=]/u.test(stripMarkdownCommentsAndCode(checkPermission))) {
            failures.push(`${locale} Check Permissions describes detailBudget as an input option`);
        }

        const vextGuide = read(path.join(root, "guide/vext-plugin.md"));
        if (vextGuide.includes("resource: 'api:GET:/orders'") || /[`“”]\/orders[`“”]/u.test(stripMarkdownCommentsAndCode(vextGuide))) {
            failures.push(`${locale} Vext guide mixes /orders with /api/orders in the main route examples`);
        }

        const authBoundary = stripMarkdownCommentsAndCode(read(path.join(root, "guide/authentication-boundary.md")));
        const historicalHeading = locale === "EN" ? "## Historical Option" : "## 历史选项";
        const historicalIndex = authBoundary.indexOf(historicalHeading);
        const resolveSubjectIndex = authBoundary.indexOf("resolveSubject");
        if (resolveSubjectIndex >= 0 && (historicalIndex < 0 || resolveSubjectIndex < historicalIndex)) {
            failures.push(`${locale} Authentication Boundary mentions resolveSubject before its historical-options section`);
        }
        if (authBoundary.includes("This section explains the operation in plain terms")) {
            failures.push(`${locale} Authentication Boundary still contains generated template filler text`);
        }

        const menuManagement = stripMarkdownCommentsAndCode(read(path.join(root, "guide/menu-management.md")));
        const treeReadHeading = locale === "EN"
            ? "## Open the management page: read the full tree first"
            : "## 打开管理页：先读取完整菜单树";
        const menuMainPath = menuManagement.slice(0, Math.max(0, menuManagement.indexOf(treeReadHeading)));
        for (const marker of ["apiBindings", "owner relationship", "owner 关系", "v2"]) {
            if (menuMainPath.includes(marker)) {
                failures.push(`${locale} Menu Management main path exposes historical/internal storage marker: ${marker}`);
            }
        }

        const roleMenu = read(path.join(root, "guide/role-menu-authorization.md"));
        const previewSection = roleMenu.slice(roleMenu.indexOf(locale === "EN" ? "## Preview, Then Commit" : "## 预览再提交"));
        if (!previewSection.includes("{ operation: 'set', assignments }") || !previewSection.includes("menuPermissions.set(")) {
            failures.push(`${locale} Role Menu Authorization main example must use set(assignments) for full-tree saves`);
        }
    }
}

function stripMarkdownCommentsAndCode(content) {
    return content
        .replace(/<!--[\s\S]*?-->/gu, "")
        .replace(/```[\s\S]*?```/gu, "");
}

function verifySourceBackedClaims() {
    const packageJson = JSON.parse(read(path.join(projectRoot, "package.json")));
    if (packageJson.version !== "3.0.0") failures.push("package version must be 3.0.0");
    if (packageJson.peerDependencies?.monsqlize !== "3.1.0") failures.push("MonSQLize peer must be exactly 3.1.0");
    if (packageJson.peerDependencies?.vextjs !== "0.3.26" || packageJson.peerDependenciesMeta?.vextjs?.optional !== true) {
        failures.push("Vext peer must be optional and exactly 0.3.26");
    }
    const exportKeys = Object.keys(packageJson.exports ?? {}).sort();
    const expectedExports = [".", "./match", "./plugins/vext"].sort();
    if (JSON.stringify(exportKeys) !== JSON.stringify(expectedExports)) {
        failures.push(`public exports drifted: ${exportKeys.join(", ")}`);
    }

    const changelog = read(path.join(projectRoot, "CHANGELOG.md"));
    const currentHeading = new RegExp(
        `## \\[${escapeRegExp(packageJson.version)}\\] - (?:Unreleased|\\d{4}-\\d{2}-\\d{2})`,
        "u",
    );
    if (!currentHeading.test(changelog)) {
        failures.push("CHANGELOG current version heading does not match package.json version");
    }
    const releasedChangelogPath = `changelogs/v${packageJson.version}.md`;
    const linksCurrentRelease = changelog.includes(releasedChangelogPath);
    const linksUnreleased = changelog.includes("changelogs/unreleased.md");
    if (!linksCurrentRelease && !linksUnreleased) {
        failures.push("CHANGELOG current entry does not link to its detailed changelog");
    }
    if (linksCurrentRelease && !fs.existsSync(path.join(projectRoot, releasedChangelogPath))) {
        failures.push(`CHANGELOG detailed release file is missing: ${releasedChangelogPath}`);
    }

    const publicTypes = [
        read(path.join(projectRoot, "src/types/foundation.ts")),
        read(path.join(projectRoot, "src/types/rbac.ts")),
        read(path.join(projectRoot, "src/types/menu.ts")),
        read(path.join(projectRoot, "src/types/data.ts")),
    ].join("\n");
    for (const marker of ["PermissionCoreOptions", "RoleManager", "UserRoleManager", "MenuConfigManager", "RoleMenuPermissionManager", "SubjectMenuRuntime", "AuthorizedCollection"]) {
        if (!publicTypes.includes(`interface ${marker}`)) failures.push(`public type source is missing ${marker}`);
    }
}

function verifyExecutableTutorialContracts() {
    const configSource = read(path.join(projectRoot, "src/core/config.ts"));
    const secretLimitMatch = /bytes\.byteLength < (\d+)/u.exec(configSource);
    const minimumSecretBytes = Number(secretLimitMatch?.[1]);
    if (!Number.isSafeInteger(minimumSecretBytes)) {
        failures.push("could not resolve the tokenSecret byte minimum from src/core/config.ts");
    }

    const menuConfigExampleMarkers = [
        "menus.config.save",
        "configId",
        "menus",
        "views",
        "type: 'page'",
        "path",
        "component",
        "load",
        "resource: 'api:GET:/api/orders'",
        "response",
    ];

    let vextEngine;
    try {
        const vextPackage = JSON.parse(read(path.join(projectRoot, "node_modules/vextjs/package.json")));
        vextEngine = vextPackage.engines?.node;
    } catch {
        failures.push("could not resolve the Vext peer engine from node_modules/vextjs/package.json");
    }
    if (typeof vextEngine !== "string" || !vextEngine) {
        failures.push("Vext peer package does not declare a Node.js engine");
    } else {
        for (const relativePath of [
             "README.md",
            "CONTRIBUTING.md",
            "examples/README.md",
            "website/docs/guide/vext-plugin.md",
            "website/docs/zh/guide/vext-plugin.md",
            "website/docs/api/vext-plugin.md",
            "website/docs/zh/api/vext-plugin.md",
        ]) {
            if (!read(path.join(projectRoot, relativePath)).includes(vextEngine)) {
                failures.push(`${relativePath} is missing the Vext Node.js engine ${vextEngine}`);
            }
        }
    }

    for (const [locale, root, exampleHeading, taskRoutingMarkers] of [
        ["EN", docsRoot, "## Example", ["/guide/manage-roles-and-users", "/guide/check-permission", "/guide/core-concepts"]],
        ["ZH", path.join(docsRoot, "zh"), "## 示例", ["/zh/guide/manage-roles-and-users", "/zh/guide/check-permission", "/zh/guide/core-concepts"]],
    ]) {
        const quickStart = read(path.join(root, "guide/quick-start.md"));
        if (!quickStart.includes("process.env.MONGODB_URI")) {
            failures.push(`${locale} Quick Start must accept the host MongoDB URI from MONGODB_URI`);
        }
        for (const marker of ["docs:first-success:start", "roles.create", "roles.allow", "userRoles.assign", "subject.can", "deleteAllowed", "pc.close", "msq.close"]) {
            if (!quickStart.includes(marker)) failures.push(`${locale} Quick Start is missing ${marker}`);
        }
        for (const marker of taskRoutingMarkers) {
            if (!quickStart.includes(marker)) {
                failures.push(`${locale} Quick Start must distinguish task routing by user goal: ${marker}`);
            }
        }

        const menusApi = read(path.join(root, "api/menus.md"));
        const exampleStart = menusApi.indexOf(exampleHeading);
        const exampleBlock = exampleStart < 0
            ? ""
            : /```ts\r?\n([\s\S]*?)```/u.exec(menusApi.slice(exampleStart))?.[1] ?? "";
        for (const marker of menuConfigExampleMarkers) {
            if (!exampleBlock.includes(marker)) {
                failures.push(`${locale} Menus API example is missing MenuConfigInput marker ${marker}`);
            }
        }

        const menuGuide = read(path.join(root, "guide/menu-management.md"));
        const createdNodeIds = new Set(
            [...menuGuide.matchAll(/scoped\.menus\.create\(\{[\s\S]*?\bid\s*:\s*['"]([^'"]+)['"]/gu)]
                .map((match) => match[1]),
        );
        for (const match of menuGuide.matchAll(/previewMove\(\{[\s\S]*?\bparentId\s*:\s*(null|['"]([^'"]+)['"])/gu)) {
            const parentId = match[2];
            if (parentId && !createdNodeIds.has(parentId)) {
                failures.push(`${locale} Menu Management moves a node under undeclared parent ${parentId}`);
            }
        }

        const checkPermission = read(path.join(root, "guide/check-permission.md"));
        const parsedResponses = [...checkPermission.matchAll(/```json\r?\n([\s\S]*?)```/g)]
            .flatMap((match) => {
                try {
                    return [JSON.parse(match[1])];
                } catch {
                    return [];
                }
            });
        const explanation = parsedResponses.find((value) => value?.data?.resource === "api:DELETE:/api/orders");
        if (!explanation?.detailBudget) {
            failures.push(`${locale} Check Permissions explanation response is missing detailBudget`);
        }
        const snapshot = parsedResponses.find((value) => value?.permissions && value?.invokeResources);
        if (!snapshot?.permissions?.data?.directRoleIds || !snapshot?.permissions?.detailBudget) {
            failures.push(`${locale} Check Permissions getPermissions response is incomplete`);
        }
        if (!Array.isArray(snapshot?.invokeResources?.data) || !snapshot?.invokeResources?.detailBudget) {
            failures.push(`${locale} Check Permissions getResources response is incomplete`);
        }
    }

}

function read(file) {
    if (!fs.existsSync(file)) {
        failures.push(`required documentation file is missing: ${path.relative(projectRoot, file)}`);
        return "";
    }
    return fs.readFileSync(file, "utf-8");
}

function count(content, pattern) {
    return [...content.matchAll(pattern)].length;
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
