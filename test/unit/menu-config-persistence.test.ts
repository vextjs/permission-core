import { describe, expect, it } from "vitest";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";
import { createScopeKey } from "../../src/scope/scope";
import type { MenuConfigInput, PermissionScope } from "../../src/types";
import {
    aggregateCompiledMenuConfigs,
    compileMenuConfigSnapshot,
    normalizeMenuConfigInput,
} from "../../src/menu";
import {
    materializeMenuConfigDocument,
    nonNegativeInteger,
    positiveInteger,
} from "../../src/menu/config-persistence";

const scope = { tenantId: "acme" } satisfies PermissionScope;
const scopeKey = createScopeKey(scope);
const schemes = new ResourceSchemeRegistry();

function input(): MenuConfigInput {
    return {
        configId: "admin",
        title: "Admin",
        menus: [{
            id: "orders",
            title: "Orders",
            views: [{
                id: "orders-list",
                type: "page",
                title: "Orders",
                path: "/orders",
                component: "OrdersPage",
                load: [{
                    resource: "api:GET:/api/orders",
                    response: [
                        { field: "orderNo", title: "Order number" },
                        { field: "status", title: "Status" },
                    ],
                }],
                actions: [{
                    id: "export",
                    title: "Export",
                    resource: "api:POST:/api/orders/export",
                }],
            }],
        }],
    };
}

function rawDocument() {
    const snapshot = normalizeMenuConfigInput(input(), {
        revision: 3,
        createdAt: 100,
        updatedAt: 120,
    });
    const compiled = compileMenuConfigSnapshot(snapshot, schemes);
    const aggregate = aggregateCompiledMenuConfigs([compiled], schemes);
    return {
        _id: "raw-admin-config",
        scopeKey,
        scope,
        configId: compiled.configId,
        title: compiled.title,
        config: snapshot,
        configDigest: compiled.configDigest,
        aggregateDigest: aggregate.aggregateDigest,
        configRevision: snapshot.revision,
        menuCount: compiled.metrics.menuCount,
        viewCount: compiled.metrics.viewCount,
        actionCount: compiled.metrics.actionCount,
        apiCount: compiled.metrics.apiCount,
        responseFieldCount: compiled.metrics.responseFieldCount,
        responseFieldOwnerCount: compiled.metrics.responseFieldOwnerCount,
        configBytes: compiled.metrics.configBytes,
        compiledMenuNodeCount: compiled.nodes.length,
        compiledApiBindingCount: aggregate.metrics.apiBindingCount,
        compiledManifestBytes: aggregate.metrics.compiledManifestBytes,
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.updatedAt,
    };
}

function mutableRawDocument() {
    return structuredClone(rawDocument());
}

function expectPersistedInvalid(callback: () => unknown) {
    expect(callback).toThrowError(expect.objectContaining({
        code: "PERSISTED_STATE_INVALID",
        details: expect.objectContaining({ kind: "persisted-state-invalid" }),
    }));
}

describe("menu config persistence materialization", () => {
    it("materializes a canonical persisted menu config document", () => {
        const document = materializeMenuConfigDocument(rawDocument(), scope, scopeKey, schemes);

        expect(document).toMatchObject({
            scopeKey,
            configId: "admin",
            title: "Admin",
            menuCount: 1,
            viewCount: 1,
            actionCount: 1,
            apiCount: 2,
            responseFieldCount: 2,
        });
        expect(Object.isFrozen(document)).toBe(true);
        expect(Object.isFrozen(document.config)).toBe(true);
    });

    it("rejects non-canonical numeric helpers before persisted state is trusted", () => {
        expectPersistedInvalid(() => positiveInteger(0, "configRevision"));
        expectPersistedInvalid(() => positiveInteger(Number.NaN, "configRevision"));
        expectPersistedInvalid(() => nonNegativeInteger(-1, "createdAt"));
        expectPersistedInvalid(() => nonNegativeInteger(1.5, "createdAt"));
    });

    it("rejects malformed persisted menu config documents fail-closed", () => {
        const cases: Array<readonly [string, unknown]> = [
            ["plain document", null],
            ["unexpected field", { ...mutableRawDocument(), unexpected: true }],
            ["missing defined property", (() => {
                const value = mutableRawDocument();
                Object.defineProperty(value, "title", { value: undefined, enumerable: true });
                return value;
            })()],
            ["scope key mismatch", { ...mutableRawDocument(), scopeKey: createScopeKey({ tenantId: "other" }) }],
            ["scope mismatch", { ...mutableRawDocument(), scope: { tenantId: "other" } }],
            ["negative createdAt", { ...mutableRawDocument(), createdAt: -1 }],
            ["updated before created", { ...mutableRawDocument(), createdAt: 200, updatedAt: 100 }],
            ["non-positive revision", { ...mutableRawDocument(), configRevision: 0 }],
            ["snapshot config id mismatch", {
                ...mutableRawDocument(),
                config: { ...mutableRawDocument().config, configId: "other" },
            }],
            ["non-canonical snapshot", {
                ...mutableRawDocument(),
                config: { ...mutableRawDocument().config, title: "Changed" },
            }],
            ["metric mismatch", { ...mutableRawDocument(), menuCount: 2 }],
            ["digest mismatch", { ...mutableRawDocument(), configDigest: "bad-digest" }],
            ["empty aggregate digest", { ...mutableRawDocument(), aggregateDigest: "" }],
            ["negative compiled byte count", { ...mutableRawDocument(), compiledManifestBytes: -1 }],
        ];

        for (const [, value] of cases) {
            expectPersistedInvalid(() => materializeMenuConfigDocument(value, scope, scopeKey, schemes));
        }
    });
});
