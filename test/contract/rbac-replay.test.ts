import { describe, expect, it } from "vitest";
import { PermissionCoreError } from "../../src";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";
import { compareUtf8, digestCanonical } from "../../src/internal/canonical";
import {
    createMenuSourceId,
    createSemanticKey,
    decodePermissionRuleReplay,
    decodeRoleReplay,
    decodeRuleRevokeReplay,
    decodeUserRoleBindingReplay,
    MAX_RULE_SOURCES,
} from "../../src/rbac";

const resourceSchemes = new ResourceSchemeRegistry();

function expectPersistedFailure(operation: () => unknown) {
    expect(operation).toThrowError(PermissionCoreError);
    try {
        operation();
    } catch (error) {
        expect(error).toMatchObject({ code: "PERSISTED_STATE_INVALID" });
    }
}

function ruleReplay() {
    const semanticKey = createSemanticKey("allow", "read", "db:orders");
    const source = {
        kind: "manual" as const,
        sourceId: `manual:${semanticKey}`,
        state: "active" as const,
    };
    return {
        effect: "allow" as const,
        action: "read",
        resource: "db:orders",
        semanticKey,
        sources: {
            total: 1,
            items: [source],
            truncated: false,
            digest: digestCanonical([source]),
        },
    };
}

function menuSource(
    semanticKey: string,
    assetId: string,
) {
    const grantId = "grant-orders";
    return {
        kind: "menu" as const,
        grantId,
        grantRevision: 1,
        sourceId: createMenuSourceId({
            grantId,
            semanticKey,
            contribution: "node",
            assetId,
        }),
        effect: "allow" as const,
        contribution: "node" as const,
        assetId,
        state: {
            integrity: "valid" as const,
            availability: "active" as const,
            drift: "current" as const,
        },
    };
}

describe("RBAC replay invariants", () => {
    it("rejects self-parent role evidence", () => {
        expectPersistedFailure(() => decodeRoleReplay({
            id: "operator",
            label: "Operator",
            status: "enabled",
            parentId: "operator",
            revision: 1,
            createdAt: 1,
            updatedAt: 1,
        }));
    });

    it("requires virtual user-role evidence to be empty", () => {
        expectPersistedFailure(() => decodeUserRoleBindingReplay({
            userId: "u-1",
            roleIds: ["operator"],
            revision: 0,
            persisted: false,
        }));
    });

    it("maps malformed rule policy fields to persisted-state failures", () => {
        expectPersistedFailure(() => decodePermissionRuleReplay({
            ...ruleReplay(),
            action: "READ",
        }, resourceSchemes));
    });

    it("rejects duplicate and over-budget replay source evidence", () => {
        const valid = ruleReplay();
        const duplicateItems = [valid.sources.items[0], valid.sources.items[0]];
        expectPersistedFailure(() => decodePermissionRuleReplay({
            ...valid,
            sources: {
                total: duplicateItems.length,
                items: duplicateItems,
                truncated: false,
                digest: digestCanonical(duplicateItems),
            },
        }, resourceSchemes));

        const overBudgetItems = Array.from(
            { length: MAX_RULE_SOURCES + 1 },
            () => valid.sources.items[0],
        );
        expectPersistedFailure(() => decodePermissionRuleReplay({
            ...valid,
            sources: {
                total: overBudgetItems.length,
                items: overBudgetItems,
                truncated: false,
                digest: digestCanonical(overBudgetItems),
            },
        }, resourceSchemes));
    });

    it("accepts canonical menu source evidence and rejects a forged source identity", () => {
        const valid = ruleReplay();
        const items = [...valid.sources.items, menuSource(valid.semanticKey, "orders")]
            .sort((left, right) => compareUtf8(left.sourceId, right.sourceId));
        const replay = {
            ...valid,
            sources: {
                total: items.length,
                items,
                truncated: false,
                digest: digestCanonical(items),
            },
        };
        expect(decodePermissionRuleReplay(replay, resourceSchemes)).toEqual(replay);
        expectPersistedFailure(() => decodePermissionRuleReplay({
            ...replay,
            sources: {
                ...replay.sources,
                items: replay.sources.items.map((source) => source.kind === "menu"
                    ? { ...source, sourceId: "source_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }
                    : source),
            },
        }, resourceSchemes));
    });

    it("replays a canonical truncated source envelope", () => {
        const valid = ruleReplay();
        const complete = Array.from(
            { length: 101 },
            (_, index) => menuSource(valid.semanticKey, `asset-${index.toString().padStart(3, "0")}`),
        ).sort((left, right) => compareUtf8(left.sourceId, right.sourceId));
        const replay = {
            ...valid,
            sources: {
                total: complete.length,
                items: complete.slice(0, 100),
                truncated: true,
                digest: digestCanonical(complete),
            },
        };
        expect(decodePermissionRuleReplay(replay, resourceSchemes)).toEqual(replay);
    });

    it("accepts the revoke aggregate boundary and rejects one over", () => {
        const digest = digestCanonical([]);
        expect(decodeRuleRevokeReplay({
            removed: 1,
            remainingCount: 2048,
            remainingDigest: digest,
        })).toEqual({ removed: 1, remainingCount: 2048, remainingDigest: digest });
        expectPersistedFailure(() => decodeRuleRevokeReplay({
            removed: 1,
            remainingCount: 2049,
            remainingDigest: digest,
        }));
    });
});
