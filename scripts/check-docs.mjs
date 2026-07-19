import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
    docsPages,
    guideGroups,
    validateDocsManifest,
} from "../website/docs-manifest.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = path.join(projectRoot, "website", "docs");
const failures = [];

const englishPages = listMarkdownFiles(docsRoot)
    .filter((file) => !file.startsWith("zh/"));
const chinesePages = listMarkdownFiles(path.join(docsRoot, "zh"));

verifyManifestContracts();
verifyManifestNegativeFixtures();
comparePageSets();
verifyPagesAreSubstantial();
verifyLanguagePairSizeDrift();
verifyCriticalPages();
verifyCriticalPairStructure();
verifyJsonCodeBlocks();
verifyApiReferenceContracts();
verifyExampleRoleContracts();
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

if (failures.length > 0) {
    for (const failure of failures) {
        console.error(`DOCS_CHECK_FAILED ${failure}`);
    }
    process.exitCode = 1;
} else {
    console.log(
        `Documentation checks passed: ${englishPages.length} EN/ZH page pairs, critical contracts, and internal links`,
    );
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

    const expected = docsPages.map((item) => item.path).sort();
    if (JSON.stringify(expected) !== JSON.stringify(englishPages)) {
        failures.push("manifest paths do not exactly match the English page set");
    }
    if (JSON.stringify(expected) !== JSON.stringify(chinesePages)) {
        failures.push("manifest paths do not exactly match the Chinese page set");
    }

    for (const item of docsPages) {
        if (Array.isArray(item.primaryNext)) {
            failures.push("manifest page has more than one primary next task: " + item.id);
        }
        if (item.primaryNext && !docsPages.some((candidate) => candidate.path === item.primaryNext)) {
            failures.push("manifest primary next task is missing: " + item.id + " -> " + item.primaryNext);
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
            expected: "Tasks group must contain exactly five pages",
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
            expected: "invalid primary next task: quick-start",
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

function comparePageSets() {
    const english = new Set(englishPages);
    const chinese = new Set(chinesePages);
    for (const page of english) {
        if (!chinese.has(page)) {
            failures.push(`missing Chinese page for ${page}`);
        }
    }
    for (const page of chinese) {
        if (!english.has(page)) {
            failures.push(`missing English page for ${page}`);
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
    for (const page of englishPages) {
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
        "guide/quick-start.md": ["userRoles.assign", "set(userId", "getPermissions", "menuPermissions.grant", "scopeFields", "pc.close"],
        "guide/troubleshooting.md": ["PermissionCore", "VEXT_AUTH_REQUIRED", "SCOPE_FIELD_MAPPING_REQUIRED"],
        "guide/check-permission.md": ["cannot", "explain", "getEffectiveRules", "userRoles.set", "getResources"],
        "guide/data-permissions.md": ["filter", "where", "AuthorizedCollection", "FIELD_PERMISSION_DENIED"],
        "guide/menu-management.md": ["menus.create", "previewMove", "getRemovalImpact", "manifest.export"],
        "guide/api-bindings.md": ["apiBindings.create", "availabilityGroup", "authorization", "subject.assert"],
        "guide/role-menu-authorization.md": ["menuPermissions.preview", "apiChoices", "getAuthorizationTree", "refresh-available"],
        "guide/permission-lifecycle.md": ["flowchart", "revision", "auditId", "PermissionCore.close"],
        "guide/resources-and-rules.md": ["no-allow", "db:orders:field", "ResourceSchemeDefinition", "valueFrom"],
        "guide/role-inheritance.md": ["getOwnRules", "getEffectiveRules", "CIRCULAR_INHERITANCE", "getRemovalImpact"],
        "guide/multi-tenant.md": ["erDiagram", "same-user", "scopeFields", "SCOPE_CONFLICT"],
        "guide/cache.md": ["ordered-bounded-stale", "caller-attested", "invalidationRiskUntil", "pendingCacheOutcomes"],
        "guide/vext-plugin.md": ["permissionPlugin", "resolveMonSQLize", "permission: true", "VEXT_ROUTE_RESTART_REQUIRED"],
        "guide/authentication-boundary.md": ["PermissionSubject", "resolveSubject", "SCOPE_CONFLICT", "permission: false"],
        "guide/production-operations.md": ["health", "idempotencyKey", "PREVIEW_STALE", "CORE_CLOSE_TIMEOUT"],
        "api/core-and-contexts.md": ["PermissionCoreOptions", "ScopedPermissionContext", "SubjectPermissionContext", "close(): Promise<void>"],
        "api/roles.md": ["previewAccessUpdate", "executeRuleChange", "replaceRules", "getEffectiveRules"],
        "api/user-roles.md": ["assign(userId", "set(userId", "getDirect", "getEffective"],
        "api/menus.md": ["previewMove", "previewRemove", "findStaleReferences", "menus.manifest.export"],
        "api/api-bindings.md": ["previewSetStatus", "executeUpdate", "previewReplace", "ApiBinding"],
        "api/role-menu-permissions.md": ["choiceRequirements", "getAuthorizationTree", "previewRepairStale", "generatedSources"],
        "api/authorized-collection.md": ["findPage", "updateMany", "deleteMany", "scopeFields"],
        "api/audit-and-health.md": ["PermissionCoreHealth", "operationId", "auditId", "pendingCacheOutcomes"],
        "api/errors.md": ["PermissionCoreErrorCode", "PERMISSION_DENIED", "VEXT_ROUTE_RESTART_REQUIRED", "reconcile-superseded"],
        "api/resource-schemes.md": ["ResourceSchemeDefinition", "probes", "expectedSchemeContractDigest", "INVALID_CONFIGURATION"],
        "api/match-resource.md": ["permission-core/match", "matchResource", "tooShort", "PermissionCore"],
        "api/vext-plugin.md": ["permissionPlugin", "requirePermissionContext", "toApiBindingInputs", "validateRouteManifest"],
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
        for (const [locale, root] of [["EN", docsRoot], ["ZH", path.join(docsRoot, "zh")]]) {
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
    for (const page of docsPages.map((item) => item.path)) {
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
        if (
            [...englishInline].some((token) => !chineseInline.has(token))
            || [...chineseInline].some((token) => !englishInline.has(token))
        ) {
            failures.push(`${page} inline public identifiers differ between EN and ZH`);
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
        "api/menus.md": ["input: MenuNodeCreateInput", "request: MenuNodeImpactUpdateRequest", "input: MenuManifestInput"],
        "api/api-bindings.md": ["input: ApiBindingCreateInput", "request: ApiBindingImpactUpdateRequest", "input: ApiBindingReplaceInput"],
        "api/role-menu-permissions.md": ["change: MenuPermissionChange", "selection: MenuPermissionSelection", "assignments: readonly MenuPermissionAssignment[]"],
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
        for (const [locale, root] of [
            ["EN", docsRoot],
            ["ZH", path.join(docsRoot, "zh")],
        ]) {
            const content = read(path.join(root, page.path));
            const headings = [...content.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
            if (JSON.stringify(headings) !== JSON.stringify(expectedHeadings[locale])) {
                failures.push(`${locale} ${page.path} does not use the fixed API reference slots`);
            }

            const codeBlocks = count(content, /^```[^\n]*$/gm) / 2;
            if (codeBlocks !== 4 || !content.includes("```json")) {
                failures.push(`${locale} ${page.path} must contain signatures, response, example, and example-output blocks`);
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

    for (const [locale, root] of [["EN", docsRoot], ["ZH", path.join(docsRoot, "zh")]]) {
        const coreApi = read(path.join(root, "api/core-and-contexts.md"));
        for (const marker of ['"evaluations"', '"evaluatedAllows"', '"evaluatedDenies"']) {
            if (!coreApi.includes(marker)) failures.push(`${locale} core response example is missing ${marker}`);
        }
    }

    const errors = read(path.join(docsRoot, "api/errors.md"));
    const errorTypes = read(path.join(projectRoot, "src/types/errors.ts"));
    const errorUnion = errorTypes.slice(
        errorTypes.indexOf("export type PermissionCoreErrorCode"),
        errorTypes.indexOf("export interface LimitExceededDetails"),
    );
    for (const match of errorUnion.matchAll(/"([A-Z][A-Z0-9_]+)"/g)) {
        if (!errors.includes(`\`${match[1]}\``)) failures.push(`api/errors.md is missing public code ${match[1]}`);
    }
}

function verifyExampleRoleContracts() {
    const examplePages = docsPages.filter((page) => page.section === "examples");
    const expectedHeadings = {
        EN: ["Scenario", "Run", "Source walkthrough", "Expected output", "Production boundary", "Related"],
        ZH: ["场景", "运行", "源码解读", "预期输出", "生产边界", "相关内容"],
    };
    const sourceMarkers = {
        "examples/basic.md": ["examples/basic.mjs", "docs:basic:start", "npm run example:basic"],
        "examples/multi-tenant.md": ["examples/multi-tenant.mjs", "docs:multi-tenant:start", "npm run example:multi-tenant"],
        "examples/data-guard.md": ["examples/data-guard.mjs", "docs:data-guard:start", "npm run example:data-guard"],
        "examples/menu-admin.md": ["examples/menu-admin.mjs", "docs:menu-admin:start", "npm run example:menu-admin"],
        "examples/vext.md": ["examples/vext/index.mjs", "docs:vext:start", "npm run example:vext"],
    };

    if (examplePages.length !== 5) {
        failures.push(`example role contract expected five pages, received ${examplePages.length}`);
    }

    for (const page of examplePages) {
        for (const [locale, root] of [
            ["EN", docsRoot],
            ["ZH", path.join(docsRoot, "zh")],
        ]) {
            const content = read(path.join(root, page.path));
            const headings = [...content.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
            if (JSON.stringify(headings) !== JSON.stringify(expectedHeadings[locale])) {
                failures.push(`${locale} ${page.path} does not use the fixed example role slots`);
            }

            const codeBlocks = count(content, /^```[^\n]*$/gm) / 2;
            if (codeBlocks !== 3 || !content.includes("```json")) {
                failures.push(`${locale} ${page.path} must contain run, source, and expected-output blocks`);
            }

            for (const sourceMarker of sourceMarkers[page.path] ?? []) {
                if (!content.includes(sourceMarker)) {
                    failures.push(`${locale} ${page.path} is missing runnable source marker ${sourceMarker}`);
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

    for (const [locale, root] of [["EN", docsRoot], ["ZH", path.join(docsRoot, "zh")]]) {
        const quickStart = read(path.join(root, "guide/quick-start.md"));
        const steps = [...quickStart.matchAll(/^## ([1-7])\. /gm)].map((match) => Number(match[1]));
        if (JSON.stringify(steps) !== JSON.stringify([1, 2, 3, 4, 5, 6, 7])) {
            failures.push(`${locale} Quick Start must contain exactly the ordered seven-step path`);
        }
        for (const marker of ["userRoles.assign", "set(userId", "getOwnRules", "getEffectiveRules", "getPermissions", "scopeFields"]) {
            if (!quickStart.includes(marker)) failures.push(`${locale} Quick Start is missing ${marker}`);
        }
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
    for (const page of docsPages.map((item) => item.path)) {
        for (const [locale, root] of [["EN", docsRoot], ["ZH", path.join(docsRoot, "zh")]]) {
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
            ["EN", path.join(docsRoot, page.path)],
            ["ZH", path.join(docsRoot, "zh", page.path)],
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
            const negativeBoundary = /\b(?:no|not|never|retired|removed|without)\b|没有|不是|不要|已退出|已移除|不再/u.test(line);
            if (!negativeBoundary) {
                failures.push(`legacy public claim ${legacyTerm}: ${path.relative(projectRoot, file).replaceAll("\\", "/")}:${lineIndex + 1}`);
            }
        }
    }
}

function verifySourceBackedClaims() {
    const packageJson = JSON.parse(read(path.join(projectRoot, "package.json")));
    if (packageJson.version !== "2.0.0") failures.push("package version must be 2.0.0");
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
    if (!changelog.includes(`## [${packageJson.version}] - Unreleased`)) {
        failures.push("CHANGELOG unreleased heading does not match package.json version");
    }
    if (!changelog.includes("changelogs/unreleased.md")) {
        failures.push("CHANGELOG unreleased entry does not link to the detailed unreleased changelog");
    }

    const publicTypes = [
        read(path.join(projectRoot, "src/types/foundation.ts")),
        read(path.join(projectRoot, "src/types/rbac.ts")),
        read(path.join(projectRoot, "src/types/menu.ts")),
        read(path.join(projectRoot, "src/types/data.ts")),
    ].join("\n");
    for (const marker of ["PermissionCoreOptions", "RoleManager", "UserRoleManager", "MenuManager", "ApiBindingManager", "RoleMenuPermissionManager", "AuthorizedCollection"]) {
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

    const menuValidation = read(path.join(projectRoot, "src/menu/validation.ts"));
    const pageRequirementsMatch = /if \(type === "page"\) \{\s*requireKeys\(\[([^\]]+)\]/u.exec(menuValidation);
    const pageRequiredFields = [...(pageRequirementsMatch?.[1] ?? "").matchAll(/"([^"]+)"/g)]
        .map((match) => match[1]);
    if (pageRequiredFields.length === 0) {
        failures.push("could not resolve page-node required fields from src/menu/validation.ts");
    }

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
        ["EN", docsRoot, "## Example", ["For authorization decisions", "for database access"]],
        ["ZH", path.join(docsRoot, "zh"), "## 示例", ["若要继续处理授权判定", "若要处理数据库访问"]],
    ]) {
        const quickStart = read(path.join(root, "guide/quick-start.md"));
        const secretLiterals = [...quickStart.matchAll(/tokenSecret\s*:\s*(['"])([^'"\r\n]+)\1/gu)];
        if (secretLiterals.length === 0) {
            failures.push(`${locale} Quick Start must contain a directly executable tokenSecret value`);
        }
        for (const literal of secretLiterals) {
            const byteLength = Buffer.byteLength(literal[2], "utf8");
            if (Number.isSafeInteger(minimumSecretBytes) && byteLength < minimumSecretBytes) {
                failures.push(`${locale} Quick Start tokenSecret is ${byteLength} bytes; runtime requires ${minimumSecretBytes}`);
            }
        }
        for (const source of ["examples/basic.mjs", "examples/menu-admin.mjs", "examples/data-guard.mjs"]) {
            if (!quickStart.includes(source)) {
                failures.push(`${locale} Quick Start does not identify the runnable source for ${source}`);
            }
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
        if (!/type\s*:\s*['"]page['"]/u.test(exampleBlock)) {
            failures.push(`${locale} Menus API example must create a page node`);
        }
        for (const field of pageRequiredFields) {
            if (!new RegExp(`\\b${field}\\s*:`, "u").test(exampleBlock)) {
                failures.push(`${locale} Menus API page example is missing runtime-required field ${field}`);
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
        const explanation = parsedResponses.find((value) => value?.data?.resource === "DELETE:/api/orders");
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
