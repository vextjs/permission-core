import { describe, expect, it } from "vitest";
import type {
    InternalApiBindingDocument,
    InternalMenuNodeDocument,
} from "../../src/persistence/documents";
import { PERSISTED_SCHEMA_VERSION } from "../../src/persistence/documents";
import type { ScopeStateView } from "../../src/persistence/scope-state";
import {
    EMPTY_REPLACE_MANIFEST_BYTES,
    MAX_API_BINDING_COUNT,
    MAX_MENU_NODE_COUNT,
    MAX_REPLACE_MANIFEST_BYTES,
} from "../../src/persistence/scope-state";
import { canonicalByteLength } from "../../src/internal/canonical";
import {
    calculateReplaceManifestBytes,
    planMenuAggregate,
} from "../../src/menu/aggregate";
import { createScopeKey, normalizeScope } from "../../src/scope/scope";

const scope = normalizeScope({ tenantId: "tenant-aggregate" });
const scopeKey = createScopeKey(scope);

function state(input: {
    menuNodeCount?: number;
    apiBindingCount?: number;
    itemBytes?: number;
    replaceManifestBytes?: number;
} = {}): ScopeStateView {
    const menuNodeCount = input.menuNodeCount ?? 0;
    const apiBindingCount = input.apiBindingCount ?? 0;
    const itemBytes = input.itemBytes ?? 0;
    return Object.freeze({
        scopeKey,
        scope,
        schemaVersion: PERSISTED_SCHEMA_VERSION,
        schemeContractDigest: "scheme",
        schemaContractKey: "contract",
        revision: 0,
        rbacRevision: 0,
        menuRevision: 0,
        auditRevision: 0,
        menuConfigCount: 0,
        menuConfigBytes: 0,
        menuNodeCount,
        apiBindingCount,
        responseFieldCount: 0,
        responseFieldOwnerCount: 0,
        replaceManifestBytes: input.replaceManifestBytes ?? calculateReplaceManifestBytes({
            menuNodeCount,
            apiBindingCount,
            itemBytes,
        }),
        createdAt: 0,
        updatedAt: 0,
        persisted: true,
    });
}

function node(nodeId: string, manifestItemBytes: number) {
    return { nodeId, manifestItemBytes } as Readonly<InternalMenuNodeDocument>;
}

function binding(bindingId: string, manifestItemBytes: number) {
    return { bindingId, manifestItemBytes } as Readonly<InternalApiBindingDocument>;
}

describe("menu aggregate invariants", () => {
    it("matches canonical replace-manifest framing for mixed inventories", () => {
        const nodes = [{ id: "a", order: 0 }, { id: "b", order: 1 }];
        const apiBindings = [{ id: "get-a", method: "GET", path: "/a" }];
        const itemBytes = [...nodes, ...apiBindings]
            .reduce((total, item) => total + canonicalByteLength(item), 0);

        expect(calculateReplaceManifestBytes({
            menuNodeCount: nodes.length,
            apiBindingCount: apiBindings.length,
            itemBytes,
        })).toBe(canonicalByteLength({ schemaVersion: 2, mode: "replace", nodes, apiBindings }));
    });

    it("accepts exact inventory counts and rejects one-over before writes", () => {
        expect(planMenuAggregate({
            state: state({ menuNodeCount: MAX_MENU_NODE_COUNT - 1, itemBytes: MAX_MENU_NODE_COUNT - 1 }),
            afterNodes: [node("last-node", 1)],
        })).toMatchObject({ menuNodeCount: MAX_MENU_NODE_COUNT });
        expect(() => planMenuAggregate({
            state: state({ menuNodeCount: MAX_MENU_NODE_COUNT, itemBytes: MAX_MENU_NODE_COUNT }),
            afterNodes: [node("one-over-node", 1)],
        })).toThrowError(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));

        expect(planMenuAggregate({
            state: state({ apiBindingCount: MAX_API_BINDING_COUNT - 1, itemBytes: MAX_API_BINDING_COUNT - 1 }),
            afterBindings: [binding("last-binding", 1)],
        })).toMatchObject({ apiBindingCount: MAX_API_BINDING_COUNT });
        expect(() => planMenuAggregate({
            state: state({ apiBindingCount: MAX_API_BINDING_COUNT, itemBytes: MAX_API_BINDING_COUNT }),
            afterBindings: [binding("one-over-binding", 1)],
        })).toThrowError(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));
    });

    it("accepts exactly 12 MiB and rejects one byte over", () => {
        const exactItemBytes = MAX_REPLACE_MANIFEST_BYTES - EMPTY_REPLACE_MANIFEST_BYTES;
        expect(planMenuAggregate({
            state: state(),
            afterNodes: [node("exact", exactItemBytes)],
        })).toMatchObject({ replaceManifestBytes: MAX_REPLACE_MANIFEST_BYTES });
        expect(() => planMenuAggregate({
            state: state(),
            afterNodes: [node("one-over", exactItemBytes + 1)],
        })).toThrowError(expect.objectContaining({
            code: "LIMIT_EXCEEDED",
            details: expect.objectContaining({ limitName: "replaceManifestBytes", current: MAX_REPLACE_MANIFEST_BYTES + 1 }),
        }));
    });

    it.each([
        ["touched node count", () => planMenuAggregate({ state: state(), beforeNodes: [node("missing", 1)] })],
        ["duplicate touched identity", () => planMenuAggregate({
            state: state({ menuNodeCount: 2, itemBytes: 2 }),
            beforeNodes: [node("same", 1), node("same", 1)],
        })],
        ["missing private byte", () => planMenuAggregate({ state: state(), afterNodes: [node("invalid", 0)] })],
        ["declared byte corruption", () => planMenuAggregate({
            state: state({ menuNodeCount: 1, replaceManifestBytes: EMPTY_REPLACE_MANIFEST_BYTES }),
        })],
    ])("fails closed for %s corruption", (_name, operation) => {
        expect(operation).toThrowError(expect.objectContaining({ code: "PERSISTED_STATE_INVALID" }));
    });
});
