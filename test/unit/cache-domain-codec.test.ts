import { describe, expect, it } from "vitest";
import {
    buttonMapSnapshotCodec,
    menuTreeSnapshotCodec,
    permissionSnapshotCodec,
    routeStateSnapshotCodec,
} from "../../src/cache/value-codec";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";
import { digestCanonical } from "../../src/internal/canonical";
import type { InternalRoleRuleSource } from "../../src/persistence/documents";
import { loadEffectiveAuthorization, type EffectiveAuthorizationReader } from "../../src/rbac/effective";
import {
    createMenuSourceId,
    createSemanticKey,
    materializeRoleDocument,
    materializeRoleRuleDocument,
    materializeUserRoleSetDocument,
} from "../../src/rbac/materialize";
import type {
    ButtonPermissionState,
    MenuRuntimeApiRisk,
    RoutePermissionState,
    RuleSourceView,
    SubjectRuntimeResult,
    VisibleMenuTreeNode,
} from "../../src/types";

const schemes = new ResourceSchemeRegistry();
const emptyDigest = digestCanonical([]);

function risks(items: readonly MenuRuntimeApiRisk[]) {
    return {
        total: items.length,
        items,
        truncated: false,
        digest: digestCanonical(items),
    } as const;
}

function result<T>(data: T, returned = 0): SubjectRuntimeResult<T> {
    return {
        data,
        detailBudget: {
            limit: 100,
            returned,
            truncated: false,
            digest: emptyDigest,
        },
    };
}

async function permissionFixture() {
    const subject = { userId: "codec-user", scope: { tenantId: "codec-tenant" } } as const;
    const scopeKey = digestCanonical(subject.scope);
    const now = 1_000;
    const semanticKey = createSemanticKey("allow", "read", "db:orders");
    const manualSourceId = `manual:${semanticKey}`;
    const nodeSourceId = createMenuSourceId({
        grantId: "grant-1",
        semanticKey,
        contribution: "node",
        assetId: "orders",
    });
    const apiSourceId = createMenuSourceId({
        grantId: "grant-1",
        semanticKey,
        contribution: "api",
        assetId: "orders",
        apiBindingId: "orders-entry",
    });
    const dataSourceId = createMenuSourceId({
        grantId: "grant-1",
        semanticKey,
        contribution: "data",
        assetId: "orders",
        dataResource: "db:orders",
    });
    const aggregateDigest = digestCanonical(["grant-1"]);
    const role = materializeRoleDocument({
        scopeKey,
        scope: subject.scope,
        roleId: "reader",
        label: "Reader",
        description: "Reads orders",
        status: "enabled",
        parentId: null,
        revision: 1,
        menuGrantCount: 1,
        menuGrantDigest: aggregateDigest,
        menuSourceCount: 3,
        menuSourceDigest: digestCanonical([apiSourceId, dataSourceId, nodeSourceId]),
        createdAt: now,
        updatedAt: now,
    }, subject.scope, scopeKey);
    const sources: InternalRoleRuleSource[] = [
        { kind: "manual", sourceId: manualSourceId },
        {
            kind: "menu",
            sourceId: nodeSourceId,
            grantId: "grant-1",
            grantRevision: 1,
            effect: "allow",
            contribution: "node",
            assetId: "orders",
        },
        {
            kind: "menu",
            sourceId: apiSourceId,
            grantId: "grant-1",
            grantRevision: 1,
            effect: "allow",
            contribution: "api",
            assetId: "orders",
            apiBindingId: "orders-entry",
        },
        {
            kind: "menu",
            sourceId: dataSourceId,
            grantId: "grant-1",
            grantRevision: 1,
            effect: "allow",
            contribution: "data",
            assetId: "orders",
            dataResource: "db:orders",
        },
    ];
    const rule = materializeRoleRuleDocument({
        scopeKey,
        scope: subject.scope,
        roleId: "reader",
        effect: "allow",
        action: "read",
        resource: "db:orders",
        semanticKey,
        sources,
        revision: 1,
        createdAt: now,
        updatedAt: now,
    }, subject.scope, scopeKey, schemes);
    const direct = materializeUserRoleSetDocument({
        scopeKey,
        scope: subject.scope,
        userId: subject.userId,
        roleIds: ["reader"],
        revision: 1,
        createdAt: now,
        updatedAt: now,
    }, subject.scope, scopeKey);
    const sourceViews = new Map<string, RuleSourceView>([
        [manualSourceId, { kind: "manual", sourceId: manualSourceId, state: "active" }],
        [nodeSourceId, {
            kind: "menu",
            sourceId: nodeSourceId,
            grantId: "grant-1",
            grantRevision: 1,
            effect: "allow",
            contribution: "node",
            assetId: "orders",
            state: { integrity: "valid", availability: "active", drift: "current" },
        }],
        [apiSourceId, {
            kind: "menu",
            sourceId: apiSourceId,
            grantId: "grant-1",
            grantRevision: 1,
            effect: "allow",
            contribution: "api",
            assetId: "orders",
            apiBindingId: "orders-entry",
            state: { integrity: "valid", availability: "inactive", drift: "current" },
            stateReason: "binding-disabled",
        }],
        [dataSourceId, {
            kind: "menu",
            sourceId: dataSourceId,
            grantId: "grant-1",
            grantRevision: 1,
            effect: "allow",
            contribution: "data",
            assetId: "orders",
            dataResource: "db:orders",
            state: { integrity: "valid", availability: "active", drift: "refresh-available" },
            stateReason: "contribution-refresh-available",
        }],
    ]);
    const reader: EffectiveAuthorizationReader = {
        async readRoles(roleIds) {
            return new Map(roleIds.includes("reader") ? [["reader", role]] : []);
        },
        async readRulesForRoles(roleIds) {
            return roleIds.includes("reader") ? [rule] : [];
        },
        async resolveRulesForAuthorization(roleIds) {
            return {
                rules: roleIds.includes("reader") ? [rule] : [],
                sourceViews,
            };
        },
    };
    const state = await loadEffectiveAuthorization(reader, direct);
    const codec = permissionSnapshotCodec(subject, scopeKey, schemes);
    return {
        subject,
        state,
        codec,
        snapshot: codec.encode(state) as Record<string, unknown>,
        sourceIds: [apiSourceId, dataSourceId, manualSourceId, nodeSourceId].sort(),
    };
}

describe("semantic cache domain codecs", () => {
    it("round-trips a complete permission snapshot without raw scope or user identity", async () => {
        const fixture = await permissionFixture();
        const decoded = await fixture.codec.decode(structuredClone(fixture.snapshot));
        expect(decoded).toMatchObject({
            direct: { userId: fixture.subject.userId, roleIds: ["reader"], persisted: true },
            usage: { effectiveRoles: 1, semanticRules: 1, sourceRefs: 4 },
        });
        expect([...decoded.sourceViews.keys()]).toEqual(fixture.sourceIds);
        const serialized = JSON.stringify(fixture.snapshot);
        expect(serialized).not.toContain(fixture.subject.userId);
        expect(serialized).not.toContain(fixture.subject.scope.tenantId);
        expect(Object.isFrozen(decoded)).toBe(true);
    });

    it("rejects duplicate, unreachable, mismatched, and invalid-source permission snapshots", async () => {
        const fixture = await permissionFixture();
        const original = structuredClone(fixture.snapshot) as {
            direct: Record<string, unknown>;
            roles: Record<string, unknown>[];
            rules: Record<string, unknown>[];
            sourceViews: [string, Record<string, unknown>][];
        };
        await expect(fixture.codec.decode({ ...original, roles: [original.roles[0], original.roles[0]] }))
            .rejects.toThrow(/duplicate role/u);
        await expect(fixture.codec.decode({ ...original, rules: [original.rules[0], original.rules[0]] }))
            .rejects.toThrow(/duplicate role rule/u);
        await expect(fixture.codec.decode({
            ...original,
            roles: [...original.roles, { ...original.roles[0], roleId: "orphan" }],
        })).rejects.toThrow(/unreachable/u);
        await expect(fixture.codec.decode({
            ...original,
            sourceViews: [["other-source", original.sourceViews[0]![1]], ...original.sourceViews.slice(1)],
        })).rejects.toThrow(/mismatched/u);
        const dataEntry = original.sourceViews.find(([, source]) => source.contribution === "data")!;
        await expect(fixture.codec.decode({
            ...original,
            sourceViews: original.sourceViews.map((entry) => entry === dataEntry
                ? [entry[0], { ...entry[1], dataResource: "unknown:orders" }]
                : entry),
        })).rejects.toThrow(/unknown resource scheme/u);
        await expect(fixture.codec.decode({
            ...original,
            direct: { ...original.direct, createdAt: undefined },
        })).rejects.toThrow();
    });

    it("round-trips visible tree nodes with bounded API risks and public-only fields", async () => {
        const deniedRisk = { bindingId: "orders-entry", required: true, allowed: false } as const;
        const nodes: VisibleMenuTreeNode[] = [{
            id: "root",
            parentId: null,
            type: "directory",
            title: "Root",
            icon: "folder",
            order: 0,
            i18nKey: "menu.root",
            meta: { layout: "main" },
            permission: { action: "read", resource: "ui:directory:root" },
            visible: true,
            enabled: true,
            reason: "allowed",
            apiRisks: risks([]),
            children: [{
                id: "orders",
                parentId: "root",
                type: "page",
                title: "Orders",
                path: "/orders",
                name: "orders",
                component: "OrdersPage",
                order: 0,
                permission: { action: "read", resource: "ui:page:orders" },
                visible: true,
                enabled: false,
                reason: "api-unavailable",
                apiRisks: risks([deniedRisk]),
                children: [],
            }],
        }];
        const decoded = await menuTreeSnapshotCodec(schemes).decode(result(nodes, 1));
        expect(decoded).toEqual(result(nodes, 1));
        expect(Object.isFrozen(decoded.data[0]!.children[0])).toBe(true);
    });

    it("rejects malformed tree structure, accessors, sparse arrays, and invalid detail budgets", async () => {
        const codec = menuTreeSnapshotCodec(schemes);
        const base: VisibleMenuTreeNode = {
            id: "root",
            parentId: null,
            type: "directory",
            title: "Root",
            order: 0,
            visible: true,
            enabled: true,
            reason: "allowed",
            apiRisks: risks([]),
            children: [],
        };
        expect(() => codec.decode(result([{ ...base, visible: false }] as never))).toThrow(/visible/u);
        expect(() => codec.decode(result([{ ...base, enabled: false }] as never))).toThrow(/enabled/u);
        expect(() => codec.decode(result([{
            ...base,
            children: [{ ...base, id: "child", parentId: "wrong" }],
        }]))).toThrow(/parentId/u);
        expect(() => codec.decode(result([{ ...base, children: [{ ...base, parentId: "root" }] }]))).toThrow(/duplicated/u);
        const sparse = new Array(1);
        expect(() => codec.decode(result(sparse as never))).toThrow(/sparse/u);
        let accessorCalls = 0;
        const accessor = { ...base } as Record<string, unknown>;
        Object.defineProperty(accessor, "title", {
            enumerable: true,
            get() {
                accessorCalls += 1;
                return "Root";
            },
        });
        expect(() => codec.decode(result([accessor] as never))).toThrow(/data property/u);
        expect(accessorCalls).toBe(0);
        expect(() => codec.decode({
            data: [],
            detailBudget: { limit: 99, returned: 0, truncated: false, digest: emptyDigest },
        })).toThrow(/limit/u);
    });

    it("round-trips all button states and rejects unsafe maps and inconsistent states", async () => {
        const deniedRisk = { bindingId: "button-api", required: true, allowed: false } as const;
        const state = (reason: ButtonPermissionState["reason"]): ButtonPermissionState => ({
            visible: reason === "allowed" || reason === "api-unavailable",
            enabled: reason === "allowed",
            reason,
            action: "invoke",
            resource: `ui:button:${reason}`,
            apiRisks: risks(reason === "api-unavailable" ? [deniedRisk] : []),
        });
        const buttons = {
            allowed: state("allowed"),
            unavailable: state("api-unavailable"),
            hidden: state("hidden"),
            disabled: state("disabled"),
            denied: state("permission-denied"),
        };
        const codec = buttonMapSnapshotCodec(schemes);
        expect(codec.decode(result(buttons, 1))).toEqual(result(buttons, 1));
        expect(() => codec.decode(result({ "bad code": state("allowed") }))).toThrow(/safe button code/u);
        expect(() => codec.decode(result({ allowed: { ...state("allowed"), enabled: false } }))).toThrow(/does not match/u);
        const polluted = Object.create(null) as Record<string, ButtonPermissionState>;
        Object.defineProperty(polluted, "constructor", { enumerable: true, value: state("allowed") });
        expect(() => codec.decode(result(polluted))).toThrow(/invalid key/u);
    });

    it("round-trips allowed, denied, unavailable, disabled, and missing route states", async () => {
        const codec = routeStateSnapshotCodec(schemes);
        const matched = (reason: RoutePermissionState["reason"]): RoutePermissionState => ({
            allowed: reason === "allowed",
            reason,
            nodeId: "orders",
            action: "read",
            resource: "ui:page:orders",
            matchedPath: "/orders",
            apiRisks: risks(reason === "api-unavailable"
                ? [{ bindingId: "orders-entry", required: true, allowed: false }]
                : []),
            navigationReachable: reason === "allowed",
            navigationReason: reason === "allowed" ? "reachable" : "self-unavailable",
        });
        const states: RoutePermissionState[] = [
            matched("allowed"),
            matched("permission-denied"),
            matched("api-unavailable"),
            matched("disabled"),
            {
                allowed: false,
                reason: "not-found",
                apiRisks: risks([]),
                navigationReachable: false,
                navigationReason: "not-found",
            },
        ];
        for (const state of states) {
            expect(codec.decode(result(state))).toEqual(result(state));
        }
        expect(() => codec.decode(result({ ...matched("allowed"), allowed: false }))).toThrow(/allowed/u);
        expect(() => codec.decode(result({ ...matched("permission-denied"), navigationReason: "denied-ancestor" })))
            .toThrow(/self-unavailable/u);
        expect(() => codec.decode(result({
            ...states[4],
            nodeId: "orders",
        }))).toThrow(/not-found/u);
        expect(() => codec.decode(result({
            ...matched("allowed"),
            matchedPath: "/orders?tab=all",
        }))).toThrow(/canonical/u);
    });

    it("rejects hostile records, malformed dense arrays, invalid text, and negative ordering", () => {
        const codec = menuTreeSnapshotCodec(schemes);
        const base: VisibleMenuTreeNode = {
            id: "root",
            parentId: null,
            type: "directory",
            title: "Root",
            order: 0,
            visible: true,
            enabled: true,
            reason: "allowed",
            apiRisks: risks([]),
            children: [],
        };
        expect(() => codec.decode(null)).toThrow(/plain object/u);
        expect(() => codec.decode(new Proxy({}, {}))).toThrow(/Proxy/u);
        expect(() => codec.decode(Object.create({ inherited: true }))).toThrow(/plain object/u);
        expect(() => codec.decode(result([{ ...base, title: "\ud800" }]))).toThrow(/well-formed string/u);
        expect(() => codec.decode(result([{ ...base, order: -1 }]))).toThrow(/non-negative/u);

        const extra = [{ ...base }] as Array<VisibleMenuTreeNode> & { extra?: boolean };
        extra.extra = true;
        expect(() => codec.decode(result(extra))).toThrow(/non-index property/u);
        const hidden = [{ ...base }];
        Object.defineProperty(hidden, "0", { value: hidden[0], enumerable: false });
        expect(() => codec.decode(result(hidden))).toThrow(/data property/u);
    });

    it("validates virtual bindings and every menu source-state relationship", async () => {
        const fixture = await permissionFixture();
        const original = structuredClone(fixture.snapshot) as {
            direct: Record<string, unknown>;
            roles: Record<string, unknown>[];
            rules: Record<string, unknown>[];
            sourceViews: [string, Record<string, unknown>][];
        };
        const virtual = { direct: { roleIds: [], revision: 0, persisted: false }, roles: [], rules: [], sourceViews: [] };
        await expect(fixture.codec.decode(virtual)).resolves.toMatchObject({ direct: { persisted: false, roleIds: [] } });
        await expect(fixture.codec.decode({
            ...virtual,
            direct: { ...virtual.direct, createdAt: 1, updatedAt: 1 },
        })).rejects.toThrow(/virtual role bindings/u);
        await expect(fixture.codec.decode({
            ...virtual,
            direct: { ...virtual.direct, revision: 1 },
        })).rejects.toThrow(/revision zero and no roles/u);
        const missingTimestamp = structuredClone(original);
        delete missingTimestamp.direct.createdAt;
        await expect(fixture.codec.decode(missingTimestamp)).rejects.toThrow(/require timestamps/u);

        const menuIndex = original.sourceViews.findIndex(([, source]) => source.contribution === "node");
        const mutateSource = (change: Readonly<Record<string, unknown>>) => ({
            ...original,
            sourceViews: original.sourceViews.map((entry, index) => index === menuIndex
                ? [entry[0], { ...entry[1], ...change }]
                : entry),
        });
        for (const change of [
            { state: { integrity: "broken", availability: "active", drift: "current" } },
            { state: { integrity: "valid", availability: "missing", drift: "current" } },
            { state: { integrity: "valid", availability: "active", drift: "stale" } },
            { contribution: "unknown" },
            { stateReason: "unknown-reason" },
            { apiBindingId: "orders-entry" },
            { dataResource: "db:orders" },
        ]) {
            await expect(fixture.codec.decode(mutateSource(change))).rejects.toThrow();
        }
        await expect(fixture.codec.decode({ ...original, sourceViews: [...original.sourceViews].reverse() }))
            .rejects.toThrow(/canonical effective authorization order/u);
    });

    it("rejects inconsistent API-risk digests, tree paths, and route navigation states", () => {
        const treeCodec = menuTreeSnapshotCodec(schemes);
        const node: VisibleMenuTreeNode = {
            id: "orders",
            parentId: null,
            type: "page",
            title: "Orders",
            path: "/orders",
            order: 0,
            visible: true,
            enabled: true,
            reason: "allowed",
            apiRisks: risks([]),
            children: [],
        };
        expect(() => treeCodec.decode(result([{ ...node, path: "/orders?tab=all" }]))).toThrow(/canonical/u);
        expect(() => treeCodec.decode(result([{
            ...node,
            apiRisks: { ...risks([]), digest: digestCanonical(["wrong"]) },
        }]))).toThrow(/complete items/u);

        const routeCodec = routeStateSnapshotCodec(schemes);
        const missing: RoutePermissionState = {
            allowed: false,
            reason: "not-found",
            apiRisks: risks([]),
            navigationReachable: false,
            navigationReason: "not-found",
        };
        expect(() => routeCodec.decode(result({ ...missing, navigationReason: "unknown" } as never)))
            .toThrow(/navigationReason/u);
        expect(() => routeCodec.decode(result({ ...missing, navigationReachable: true } as never)))
            .toThrow(/navigationReachable/u);
        expect(() => routeCodec.decode(result({ ...missing, navigationReason: "reachable", navigationReachable: true } as never)))
            .toThrow(/not-found route state/u);
    });
});
