import { describe, expect, it } from "vitest";
import { PermissionCoreError } from "../../src";
import { digestCanonical } from "../../src/internal/canonical";
import {
    denseMenuArray,
    exactMenuRecord,
    normalizeMenuGrantIntent,
    normalizeMenuPermissionChange,
    normalizeMenuPermissionSelection,
    normalizePersistedMenuGrantSnapshot,
    normalizeSourceRewriteDecision,
} from "../../src/menu";

const semanticKey = digestCanonical({ effect: "allow", action: "read", resource: "api:GET:/orders" });

function expectPermissionError(run: () => unknown, code?: string) {
    let caught: unknown;
    try {
        run();
    } catch (error) {
        caught = error;
    }
    expect(caught).toBeInstanceOf(PermissionCoreError);
    if (code) expect(caught).toMatchObject({ code });
}

function include(apis: "none" | "required" | "all" = "none") {
    return { descendants: false, buttons: false, apis, dataPermissions: false } as const;
}

function selection(nodeIds: string[] = ["orders"]) {
    return {
        nodeIds,
        include: include(),
        apiChoices: { bindingIds: [], permissionsByBinding: {} },
    };
}

describe("menu validator structural guards", () => {
    it("accepts null-prototype records and rejects exotic records without invoking accessors", () => {
        const safe = Object.create(null) as Record<string, unknown>;
        safe.value = 1;
        expect(exactMenuRecord(safe, ["value"], "record")).toEqual({ value: 1 });

        class Exotic {
            value = 1;
        }
        expectPermissionError(() => exactMenuRecord(new Exotic(), ["value"], "record"));
        expectPermissionError(() => exactMenuRecord({ [Symbol("value")]: 1 }, ["value"], "record"));

        let getterCalls = 0;
        const accessor = {};
        Object.defineProperty(accessor, "value", {
            enumerable: true,
            get() {
                getterCalls += 1;
                return 1;
            },
        });
        expectPermissionError(() => exactMenuRecord(accessor, ["value"], "record"));
        expect(getterCalls).toBe(0);

        const hidden = {};
        Object.defineProperty(hidden, "value", { enumerable: false, value: 1 });
        expectPermissionError(() => exactMenuRecord(hidden, ["value"], "record"));
        expectPermissionError(() => exactMenuRecord({ value: undefined }, ["value"], "record"));
    });

    it("requires dense bounded arrays with enumerable data entries", () => {
        expect(denseMenuArray(["a", "b"], "items", 2)).toEqual(["a", "b"]);
        expectPermissionError(() => denseMenuArray({}, "items", 2));
        expectPermissionError(() => denseMenuArray(new Proxy(["a"], {}), "items", 2));
        expectPermissionError(() => denseMenuArray(["a", "b"], "items", 1), "LIMIT_EXCEEDED");

        const tagged = ["a"] as string[] & { extra?: string };
        tagged.extra = "b";
        expectPermissionError(() => denseMenuArray(tagged, "items", 2));

        const hidden = ["a"];
        Object.defineProperty(hidden, "0", { enumerable: false, value: "a" });
        expectPermissionError(() => denseMenuArray(hidden, "items", 2));

        const accessor = ["a"];
        Object.defineProperty(accessor, "0", { enumerable: true, get: () => "a" });
        expectPermissionError(() => denseMenuArray(accessor, "items", 2));
        expectPermissionError(() => denseMenuArray([undefined], "items", 2));
        expectPermissionError(() => denseMenuArray(new Array(1), "items", 2));
    });
});

describe("menu source rewrite validation", () => {
    it("normalizes reject/apply decisions and canonical resolution ordering", () => {
        expect(normalizeSourceRewriteDecision()).toEqual({ mode: "reject" });
        expect(normalizeSourceRewriteDecision({
            mode: "apply",
            resolutions: {
                sourceB: { action: "revoke" },
                sourceA: { action: "replace", replacementSemanticKey: semanticKey },
            },
        })).toEqual({
            mode: "apply",
            resolutions: {
                sourceA: { action: "replace", replacementSemanticKey: semanticKey },
                sourceB: { action: "revoke" },
            },
        });
    });

    it("rejects incomplete, oversized, noncanonical, and malformed decisions", () => {
        expectPermissionError(() => normalizeSourceRewriteDecision({ mode: "apply" } as never));
        expectPermissionError(() => normalizeSourceRewriteDecision({ mode: "reject", resolutions: {} } as never));
        expectPermissionError(() => normalizeSourceRewriteDecision({ mode: "other" } as never));
        expectPermissionError(() => normalizeSourceRewriteDecision({
            mode: "apply",
            resolutions: Object.fromEntries(Array.from({ length: 1_001 }, (_, index) => [
                `source-${index}`,
                { action: "revoke" },
            ])),
        }), "LIMIT_EXCEEDED");
        expectPermissionError(() => normalizeSourceRewriteDecision({
            mode: "apply",
            resolutions: { " source": { action: "revoke" } },
        }));
        expectPermissionError(() => normalizeSourceRewriteDecision({
            mode: "apply",
            resolutions: { source: { action: "replace", replacementSemanticKey: "invalid" } },
        }));
        expectPermissionError(() => normalizeSourceRewriteDecision({
            mode: "apply",
            resolutions: { source: { action: "revoke", replacementSemanticKey: semanticKey } },
        } as never));
    });
});

describe("menu permission selection and change validation", () => {
    it("normalizes every supported change operation", () => {
        expect(normalizeMenuPermissionSelection(selection())).toMatchObject({ nodeIds: ["orders"] });
        expect(normalizeMenuPermissionChange({ operation: "grant", selection: selection() })).toMatchObject({ operation: "grant" });
        expect(normalizeMenuPermissionChange({ operation: "deny", selection: selection() })).toMatchObject({ operation: "deny" });
        expect(normalizeMenuPermissionChange({ operation: "revoke", grantIds: ["g2", "g1", "g1"] })).toEqual({
            operation: "revoke",
            grantIds: ["g1", "g2"],
        });
        expect(normalizeMenuPermissionChange({
            operation: "set",
            assignments: [
                { effect: "allow", selection: selection(["orders"]) },
                { effect: "deny", selection: selection(["orders.delete"]) },
            ],
        })).toMatchObject({ operation: "set" });
    });

    it("rejects incomplete selections and invalid include/choice contracts", () => {
        expectPermissionError(() => normalizeMenuPermissionSelection({ nodeIds: [], include: include(), apiChoices: {} }));
        expectPermissionError(() => normalizeMenuPermissionSelection(selection([])));
        expectPermissionError(() => normalizeMenuPermissionSelection({
            ...selection(),
            include: { descendants: false, buttons: false, apis: "sometimes", dataPermissions: false },
        }));
        expectPermissionError(() => normalizeMenuPermissionSelection({
            ...selection(),
            include: { descendants: "no", buttons: false, apis: "none", dataPermissions: false },
        }));
        expectPermissionError(() => normalizeMenuPermissionSelection({
            ...selection(),
            apiChoices: { bindingIds: [], permissionsByBinding: { binding: ["invalid"] } },
        }));
        expectPermissionError(() => normalizeMenuPermissionSelection({
            ...selection(),
            apiChoices: { bindingIds: [], permissionsByBinding: { " binding": [semanticKey] } },
        }));
        expectPermissionError(() => normalizeMenuPermissionSelection({
            ...selection(),
            apiChoices: {
                bindingIds: [],
                permissionsByBinding: Object.fromEntries(Array.from({ length: 1_001 }, (_, index) => [
                    `binding-${index}`,
                    [],
                ])),
            },
        }), "LIMIT_EXCEEDED");

        const bindingIds = Array.from({ length: 1_000 }, (_, index) => `binding-${index}`);
        expectPermissionError(() => normalizeMenuPermissionSelection({
            ...selection(),
            apiChoices: { bindingIds, permissionsByBinding: { "binding-0": [semanticKey] } },
        }), "LIMIT_EXCEEDED");
    });

    it("rejects operation-specific field drift and aggregate anchor overflow", () => {
        expectPermissionError(() => normalizeMenuPermissionChange({ operation: "grant", selection: selection(), grantIds: [] }));
        expectPermissionError(() => normalizeMenuPermissionChange({ operation: "revoke", grantIds: [], selection: selection() }));
        expectPermissionError(() => normalizeMenuPermissionChange({ operation: "set", assignments: [], selection: selection() }));
        expectPermissionError(() => normalizeMenuPermissionChange({ operation: "set", assignments: [{ effect: "audit", selection: selection() }] }));
        expectPermissionError(() => normalizeMenuPermissionChange({ operation: "other" }));

        const first = Array.from({ length: 501 }, (_, index) => `first-${index}`);
        const second = Array.from({ length: 501 }, (_, index) => `second-${index}`);
        expectPermissionError(() => normalizeMenuPermissionChange({
            operation: "set",
            assignments: [
                { effect: "allow", selection: selection(first) },
                { effect: "deny", selection: selection(second) },
            ],
        }), "LIMIT_EXCEEDED");
    });

    it("validates persisted grant intent and snapshot completeness", () => {
        expectPermissionError(() => normalizeMenuGrantIntent({ anchorId: "orders", include: include() }));
        expectPermissionError(() => normalizePersistedMenuGrantSnapshot({}));

        const valid = {
            contributionContractDigest: semanticKey,
            contributionDigest: semanticKey,
            contributingAssetCount: 0,
            contributingBindingCount: 0,
            contributingAssetIds: [],
            contributingBindingIds: [],
        };
        expect(normalizePersistedMenuGrantSnapshot(valid)).toEqual(valid);
        expectPermissionError(() => normalizePersistedMenuGrantSnapshot({ ...valid, contributionDigest: "invalid" }));
        expectPermissionError(() => normalizePersistedMenuGrantSnapshot({ ...valid, contributingAssetCount: -1 }));
    });
});
