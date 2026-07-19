import { describe, expect, it } from "vitest";
import { PermissionCoreError } from "../../src";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";
import {
    densePreviewArray,
    exactPreviewRecord,
    normalizeExpectedMenuRevisionVector,
    normalizeExpectedRoleRevisionVector,
    normalizeManualRuleChange,
    normalizeManualRuleList,
    normalizeMenuPreviewExecutionOptions,
    normalizePreviewExecutionOptions,
    normalizePreviewOptions,
} from "../../src/rbac/preview-inputs";

const schemes = new ResourceSchemeRegistry();

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

function roleVector(overrides: Record<string, unknown> = {}) {
    return {
        global: 1,
        rbac: 2,
        entities: [{ kind: "role", id: "reader", revision: 3 }],
        ...overrides,
    };
}

function menuVector(overrides: Record<string, unknown> = {}) {
    return {
        global: 1,
        rbac: 2,
        menu: 3,
        entities: [
            { kind: "menu-node", id: "orders", revision: 4 },
            { kind: "role", id: "reader", revision: 5 },
        ],
        ...overrides,
    };
}

describe("preview record and array guards", () => {
    it("accepts null-prototype data and rejects exotic records without invoking getters", () => {
        const safe = Object.create(null) as Record<string, unknown>;
        safe.actorId = "admin";
        expect(exactPreviewRecord(safe, "options", ["actorId"])).toEqual({ actorId: "admin" });
        expectPermissionError(() => exactPreviewRecord([], "options", []));
        expectPermissionError(() => exactPreviewRecord(new Date(), "options", []));
        expectPermissionError(() => exactPreviewRecord({ extra: true }, "options", []));

        let calls = 0;
        const accessor = {};
        Object.defineProperty(accessor, "actorId", {
            enumerable: true,
            get() {
                calls += 1;
                return "admin";
            },
        });
        expectPermissionError(() => exactPreviewRecord(accessor, "options", ["actorId"]));
        expect(calls).toBe(0);
    });

    it("requires dense bounded preview arrays", () => {
        expect(densePreviewArray(["a"], "items", 1)).toEqual(["a"]);
        expectPermissionError(() => densePreviewArray({}, "items", 1));
        expectPermissionError(() => densePreviewArray(new Proxy(["a"], {}), "items", 1));
        expectPermissionError(() => densePreviewArray(["a", "b"], "items", 1), "LIMIT_EXCEEDED");
        const tagged = ["a"] as string[] & { extra?: string };
        tagged.extra = "b";
        expectPermissionError(() => densePreviewArray(tagged, "items", 2));
        const hidden = ["a"];
        Object.defineProperty(hidden, "0", { enumerable: false, value: "a" });
        expectPermissionError(() => densePreviewArray(hidden, "items", 2));
        expectPermissionError(() => densePreviewArray(new Array(1), "items", 2));
    });
});

describe("preview revision vector validation", () => {
    it("normalizes exact role and menu revision ownership", () => {
        expect(normalizeExpectedRoleRevisionVector(roleVector(), "reader")).toEqual(roleVector());
        expect(normalizeExpectedMenuRevisionVector(menuVector())).toEqual({
            global: 1,
            rbac: 2,
            menu: 3,
            entities: [
                { kind: "menu-node", id: "orders", revision: 4 },
                { kind: "role", id: "reader", revision: 5 },
            ],
        });
    });

    it("rejects incomplete, foreign, duplicate, and negative role vectors", () => {
        const invalid = [
            {},
            roleVector({ entities: [] }),
            roleVector({ entities: [{ kind: "menu-node", id: "reader", revision: 3 }] }),
            roleVector({ entities: [{ kind: "role", id: "writer", revision: 3 }] }),
            roleVector({ global: -1 }),
            roleVector({ rbac: -1 }),
            roleVector({ entities: [{ kind: "role", id: "reader", revision: -1 }] }),
        ];
        for (const value of invalid) expectPermissionError(() => normalizeExpectedRoleRevisionVector(value, "reader"));
    });

    it("rejects incomplete, unsupported, duplicate, and negative menu vectors", () => {
        expectPermissionError(() => normalizeExpectedMenuRevisionVector({}));
        expectPermissionError(() => normalizeExpectedMenuRevisionVector(menuVector({
            entities: [{ kind: "user", id: "user-1", revision: 1 }],
        })));
        expectPermissionError(() => normalizeExpectedMenuRevisionVector(menuVector({
            entities: [
                { kind: "menu-node", id: "orders", revision: 1 },
                { kind: "menu-node", id: "orders", revision: 2 },
            ],
        })));
        expectPermissionError(() => normalizeExpectedMenuRevisionVector(menuVector({ menu: -1 })));
    });
});

describe("preview options and rule change validation", () => {
    it("normalizes preview metadata and both execution envelopes", () => {
        expect(normalizePreviewOptions({ actorId: "admin", reason: "review", requestId: "req-1" })).toEqual({
            actorId: "admin",
            reason: "review",
            requestId: "req-1",
        });
        expect(normalizePreviewExecutionOptions({
            actorId: "admin",
            idempotencyKey: "preview-1",
            expectedRevisions: roleVector() as never,
            previewToken: "token",
            acknowledgeCapacityRisk: true,
        }, "reader")).toMatchObject({ actorId: "admin", previewToken: "token", acknowledgeCapacityRisk: true });
        expect(normalizeMenuPreviewExecutionOptions({
            actorId: "admin",
            expectedRevisions: menuVector() as never,
            previewToken: "token",
        })).toMatchObject({ actorId: "admin", previewToken: "token" });
    });

    it("rejects missing, empty, oversized, and nonliteral execution fields", () => {
        expectPermissionError(() => normalizePreviewExecutionOptions({} as never, "reader"));
        expectPermissionError(() => normalizePreviewExecutionOptions({
            expectedRevisions: roleVector() as never,
            previewToken: "",
        }, "reader"));
        expectPermissionError(() => normalizePreviewExecutionOptions({
            expectedRevisions: roleVector() as never,
            previewToken: "x".repeat(16 * 1024 + 1),
        }, "reader"));
        expectPermissionError(() => normalizePreviewExecutionOptions({
            expectedRevisions: roleVector() as never,
            previewToken: "token",
            acknowledgeCapacityRisk: false,
        } as never, "reader"));
        expectPermissionError(() => normalizeMenuPreviewExecutionOptions({} as never));
        expectPermissionError(() => normalizeMenuPreviewExecutionOptions({
            expectedRevisions: menuVector() as never,
            previewToken: "token",
            acknowledgeCapacityRisk: false,
        } as never));
    });

    it("normalizes allow/deny/revoke changes and deduplicates manual rule lists", () => {
        const rule = { action: "read", resource: "db:orders" } as const;
        expect(normalizeManualRuleChange({ operation: "allow", rule }, schemes)).toMatchObject({ operation: "allow" });
        expect(normalizeManualRuleChange({ operation: "deny", rule }, schemes)).toMatchObject({ operation: "deny" });
        expect(normalizeManualRuleChange({
            operation: "revoke",
            selector: { effect: "allow", ...rule },
        }, schemes)).toMatchObject({ operation: "revoke" });
        expect(normalizeManualRuleList([
            { effect: "allow", ...rule },
            { effect: "allow", ...rule },
            { effect: "deny", ...rule },
        ], schemes)).toHaveLength(2);
    });

    it("rejects operation field drift and wraps per-rule validation paths", () => {
        expectPermissionError(() => normalizeManualRuleChange({ operation: "allow" } as never, schemes));
        expectPermissionError(() => normalizeManualRuleChange({
            operation: "allow",
            rule: { action: "read", resource: "db:orders" },
            selector: { effect: "allow", action: "read", resource: "db:orders" },
        } as never, schemes));
        expectPermissionError(() => normalizeManualRuleChange({ operation: "revoke" } as never, schemes));
        expectPermissionError(() => normalizeManualRuleChange({ operation: "other" } as never, schemes));
        expectPermissionError(() => normalizeManualRuleList([
            { effect: "allow", action: "read", resource: "unknown:orders" },
        ], schemes));
    });
});
