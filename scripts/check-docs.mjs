import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = path.join(projectRoot, "website", "docs");
const failures = [];

const englishPages = listMarkdownFiles(docsRoot)
    .filter((file) => !file.startsWith("zh/"));
const chinesePages = listMarkdownFiles(path.join(docsRoot, "zh"));

comparePageSets();
verifyPagesAreSubstantial();
verifyLanguagePairSizeDrift();
verifyCriticalPages();
verifyCriticalPairStructure();
verifySourceBackedClaims();
verifyInternalLinks();
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
        const english = read(path.join(docsRoot, page)).length;
        const chinese = read(path.join(docsRoot, "zh", page)).length;
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
        "guide/menu-permissions.md": [
            "roles.create",
            "users.assign",
            "importFrontendManifest",
            "MonSQLizeMenuStorageAdapter",
            "validate",
            "sourceRoleIds",
            "ROLE_NOT_FOUND",
            "close()",
        ],
        "guide/multi-tenant.md": [
            "roles.create",
            "users.assign",
            "tenant-a",
            "tenant-b",
            "MonSQLizeStorageAdapter",
            "false",
            "INVALID_ARGUMENT",
            "close()",
        ],
        "guide/vext-adapter.md": [
            "createVextPermissionPlugin",
            "tenantRequired",
            "routeResource",
            "ownsCore",
            "guardRoutePermissions",
            "AUTH_FORBIDDEN",
            "0.3.26",
            "auth",
        ],
        "api/menu.md": [
            "createMenuPermission",
            "MenuPermissionManager",
            "importFrontendManifest",
            "getAuthorizationTree",
            "getVisibleMenuTree",
            "MemoryMenuStorageAdapter",
            "FileMenuStorageAdapter",
            "MonSQLizeMenuStorageAdapter",
            "resourceSchemes.register",
            "sourceRoleIds",
        ],
        "api/scoped-permissions.md": [
            "PermissionScope",
            "PermissionSubject",
            "canSubject",
            "assertSubject",
            "forSubject",
            "invalidateSubject",
            "invalidateScope",
            "LegacyScopedStorageAdapter",
        ],
        "api/vext-adapter.md": [
            "createVextPermissionPlugin",
            "createVextPermissionMiddleware",
            "createVextPermissionAuthProvider",
            "resolveVextPermissionSubject",
            "resolveVextRouteResource",
            "loadVextRouteManifest",
            "normalizeVextRoutes",
            "AUTH_REQUIRED",
            "AUTH_FORBIDDEN",
        ],
        "api/permission-core.md": [
            "defaultScope",
            "resourceSchemes",
            "canSubject",
            "assertSubject",
            "invalidateSubject",
            "invalidateScope",
            "PERMISSION_DENIED",
            "NOT_INITIALIZED",
        ],
        "api/role-manager.md": [
            "create(id",
            "update(id",
            "delete(id",
            "getEffectiveRules",
            "inspect",
            "CIRCULAR_INHERITANCE",
            "sourceRoleIds",
        ],
        "api/context.md": [
            "forSubject",
            "getRowScope",
            "filterRows",
            "filterFields",
            "PERMISSION_DENIED",
        ],
        "api/storage-adapter.md": [
            "getUsersByRole",
            "setUserRoles",
            "setRules",
            "ScopedStorageAdapter",
            "MenuPermissionStorageAdapter",
        ],
        "api/file-adapter.md": [
            "path",
            "STORAGE_ERROR",
            /atomic|原子/,
            "FileMenuStorageAdapter",
        ],
        "api/memory-adapter.md": [
            "MemoryAdapter",
            "MemoryMenuStorageAdapter",
            "scoped",
            "close()",
        ],
        "api/monsqlize-storage-adapter.md": [
            "namespace",
            "ownsConnection",
            "scopeKey",
            "STORAGE_ERROR",
            "MonSQLizeMenuStorageAdapter",
        ],
        "api/errors.md": [
            "NOT_INITIALIZED",
            "PERMISSION_DENIED",
            "ROLE_NOT_FOUND",
            "CIRCULAR_INHERITANCE",
            "INVALID_RESOURCE_PATH",
            "INVALID_ACTION",
            "INVALID_ARGUMENT",
            "STORAGE_ERROR",
        ],
        "api/match-resource.md": ["scheme", "GET:/api/*", "db:*", "can()", "assert()"],
        "examples/basic.md": ["roles.create", /users\.(?:setUserRoles|assign)/, "assert", "close()"],
        "examples/express.md": ["pc.init", "pc.close", "PERMISSION_DENIED", "next(error)"],
        "examples/row-level.md": ["getRowScope", "assertRow", "filterRows", "valueFrom"],
        "examples/field-permission.md": ["users.assign", "filterFields", "update", /top-level|顶层/],
        "examples/monsqlize-adapter.md": [
            "ownsConnection",
            "MonSQLizeMenuStorageAdapter",
            "pc.close",
            /backup|备份/,
        ],
        "examples/management-backend.md": [
            "roles.inspect",
            "getAuthorizationTree",
            "saveRoleAuthorization",
            "sourceRoleIds",
            "revision",
        ],
        "guide/production-deployment.md": [
            "MonSQLizeStorageAdapter",
            "MonSQLizeMenuStorageAdapter",
            "ownsConnection",
            "menu.close()",
            "validate()",
            "revision",
            "audit",
            /backup|备份/,
        ],
        "guide/adapters.md": [
            "MemoryAdapter",
            "FileAdapter",
            "MonSQLizeStorageAdapter",
            "MemoryMenuStorageAdapter",
            "FileMenuStorageAdapter",
            "MonSQLizeMenuStorageAdapter",
            "ownsConnection",
            /compensation|补偿/,
        ],
        "examples/vext.md": [
            "createTestApp",
            "createVextPermissionPlugin",
            "tenantRequired",
            "permissions",
            "200",
            "403 AUTH_FORBIDDEN",
        ],
        "guide/introduction.md": ["menu-permissions", "multi-tenant", "vext-adapter"],
        "guide/implementation-reading-order.md": [
            "menu-permissions",
            "multi-tenant",
            "vext-adapter",
            "test:docs",
        ],
        "guide/integration-checklist.md": [
            "strictApiBindings",
            "tenantId",
            "guardRoutePermissions",
            "test:docs",
            "test:package",
        ],
        "guide/faq.md": [
            "MonSQLizeMenuStorageAdapter",
            "tenantRequired",
            "guardRoutePermissions",
            "test:docs",
        ],
    };

    for (const [page, markers] of Object.entries(contracts)) {
        for (const [locale, root] of [
            ["EN", docsRoot],
            ["ZH", path.join(docsRoot, "zh")],
        ]) {
            const content = read(path.join(root, page));
            for (const marker of markers) {
                const present = typeof marker === "string" ? content.includes(marker) : marker.test(content);
                if (!present) {
                    failures.push(`${locale} ${page} is missing critical marker: ${String(marker)}`);
                }
            }
        }
    }
}

function verifyCriticalPairStructure() {
    const pairedRoles = [
        "guide/menu-permissions.md",
        "guide/multi-tenant.md",
        "guide/vext-adapter.md",
        "api/menu.md",
        "api/scoped-permissions.md",
        "api/vext-adapter.md",
        "examples/vext.md",
    ];

    for (const page of pairedRoles) {
        const english = read(path.join(docsRoot, page));
        const chinese = read(path.join(docsRoot, "zh", page));
        const englishHeadings = count(english, /^#{1,3} /gm);
        const chineseHeadings = count(chinese, /^#{1,3} /gm);
        const englishFences = count(english, /^```/gm);
        const chineseFences = count(chinese, /^```/gm);
        if (englishHeadings !== chineseHeadings) {
            failures.push(`${page} heading structure differs: EN ${englishHeadings}, ZH ${chineseHeadings}`);
        }
        if (englishFences !== chineseFences) {
            failures.push(`${page} code-fence structure differs: EN ${englishFences}, ZH ${chineseFences}`);
        }
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
    ];
    for (const file of files) {
        const content = read(file);
        for (const [pattern, label] of stalePatterns) {
            pattern.lastIndex = 0;
            if (pattern.test(content)) {
                failures.push(`${label}: ${path.relative(projectRoot, file).replaceAll("\\", "/")}`);
            }
        }
    }
}

function verifySourceBackedClaims() {
    const fileAdapterSource = read(path.join(projectRoot, "src", "storage", "file-adapter.ts"));
    const hasAtomicCommit = /fs\.writeFile\(temporaryPath/.test(fileAdapterSource)
        && /fs\.rename\(temporaryPath,\s*this\.filePath\)/.test(fileAdapterSource);
    if (!hasAtomicCommit) {
        failures.push("FileAdapter atomic replacement docs are not backed by the write implementation");
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
