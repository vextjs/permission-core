import { randomUUID } from "node:crypto";
import type { CacheLike } from "monsqlize";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PermissionCore } from "../../src";
import type { MenuManifestInput, PermissionScope, ScopedPermissionContext } from "../../src/types";
import { startRealMongo, type RealMongoContext } from "./helpers/real-mongo";

const TEST_TIMEOUT = 120_000;
const TTL_MS = 1_000;
const PREFIX = `pc_c1_${randomUUID().replaceAll("-", "")}`;

function nextScope(label: string): PermissionScope {
    return { tenantId: `c1-${label}-${randomUUID()}` };
}

function createCore(context: RealMongoContext, collectionPrefix = PREFIX) {
    return new PermissionCore({
        monsqlize: context.monsqlize,
        collectionPrefix,
        tokenSecret: "permission-core-semantic-cache-integration-secret",
        cache: {
            enabled: true,
            consistency: "ordered-bounded-stale",
            ttlMs: TTL_MS,
        },
    });
}

async function importManifest(
    scoped: ScopedPermissionContext,
    input: MenuManifestInput,
) {
    const preview = await scoped.menus.manifest.preview(input, { actorId: "admin" });
    if (!preview.executable) throw new Error("Expected an executable menu manifest preview.");
    return scoped.menus.manifest.import(input, {
        ...preview.expected,
        previewToken: preview.previewToken,
        actorId: "admin",
        idempotencyKey: `manifest-${randomUUID()}`,
    });
}

describe("semantic permission cache on real MonSQLize 3.1", () => {
    let context: RealMongoContext;
    let cache: CacheLike;
    let coreA: PermissionCore;
    let coreB: PermissionCore;
    let scopeStateReads = 0;
    let restoreCollectionProbe: (() => void) | undefined;

    beforeAll(async () => {
        context = await startRealMongo({ findMaxLimit: 97 });
        cache = context.monsqlize.getCache();
        const host = context.monsqlize as unknown as {
            collection(name: string, ...args: unknown[]): unknown;
        };
        const originalCollection = host.collection.bind(host);
        const instrumented = new WeakSet<object>();
        const restoreReaders: Array<() => void> = [];
        const collectionProbe = vi.spyOn(host, "collection").mockImplementation((name, ...args) => {
            const handle = originalCollection(name, ...args) as object & {
                raw?: () => unknown;
            };
            const native = (typeof handle.raw === "function" ? handle.raw() : handle) as object & {
                findOne?: (...input: unknown[]) => unknown;
            };
            if (name === `${PREFIX}_scope_state` && !instrumented.has(native) && typeof native.findOne === "function") {
                instrumented.add(native);
                const originalFindOne = native.findOne.bind(native);
                native.findOne = (...input) => {
                    scopeStateReads += 1;
                    return originalFindOne(...input);
                };
                restoreReaders.push(() => {
                    native.findOne = originalFindOne;
                });
            }
            return handle;
        });
        restoreCollectionProbe = () => {
            for (const restore of restoreReaders) restore();
            collectionProbe.mockRestore();
        };
        coreA = createCore(context);
        coreB = createCore(context);
        await coreA.init();
        await coreB.init();
    }, TEST_TIMEOUT);

    afterAll(async () => {
        await coreA?.close();
        await coreB?.close();
        restoreCollectionProbe?.();
        await context?.close();
    }, TEST_TIMEOUT);

    it("shares a permission fill across cores with zero scope-state reads and invalidates a revoked user", async () => {
        const targetScope = nextScope("shared-revoke");
        const subject = { userId: `user-${randomUUID()}`, scope: targetScope };
        const scoped = coreA.scope(targetScope);
        await scoped.roles.create({ id: "reader", label: "Reader" });
        await scoped.roles.allow("reader", { action: "read", resource: "db:orders" });
        await scoped.userRoles.assign(subject.userId, "reader");

        const set = vi.spyOn(cache, "set");
        try {
            scopeStateReads = 0;
            await expect(coreA.can(subject, "read", "db:orders")).resolves.toBe(true);
            expect(scopeStateReads).toBeGreaterThan(0);
            const permissionSet = set.mock.calls.find(([key]) => String(key).endsWith(":permissions"));
            expect(permissionSet).toBeDefined();
            expect(String(permissionSet![0])).not.toContain(subject.userId);
            expect(String(permissionSet![0])).not.toContain(targetScope.tenantId);
            const serialized = JSON.stringify(permissionSet![1]);
            expect(serialized).not.toContain(subject.userId);
            expect(serialized).not.toContain(targetScope.tenantId);

            scopeStateReads = 0;
            await expect(coreB.can(subject, "read", "db:orders")).resolves.toBe(true);
            expect(scopeStateReads).toBe(0);

            const revoked = await scoped.userRoles.revoke(subject.userId, "reader");
            expect(revoked).toMatchObject({ changed: true, cache: { status: "completed" } });
            scopeStateReads = 0;
            await expect(coreB.can(subject, "read", "db:orders")).resolves.toBe(false);
            expect(scopeStateReads).toBeGreaterThan(0);
        } finally {
            set.mockRestore();
        }
    }, TEST_TIMEOUT);

    it("removes an old permission fill that races after a committed revocation", async () => {
        const targetScope = nextScope("fill-after-revoke");
        const subject = { userId: `user-${randomUUID()}`, scope: targetScope };
        const scoped = coreA.scope(targetScope);
        await scoped.roles.create({ id: "reader", label: "Reader" });
        await scoped.roles.allow("reader", { action: "read", resource: "db:orders" });
        await scoped.userRoles.assign(subject.userId, "reader");

        const originalSet = cache.set.bind(cache);
        let raced = false;
        let revokeStatus: string | undefined;
        const set = vi.spyOn(cache, "set").mockImplementation(async (key, value, ttlMs) => {
            if (!raced && String(key).endsWith(":permissions")) {
                raced = true;
                const revoked = await scoped.userRoles.revoke(subject.userId, "reader");
                revokeStatus = revoked.cache.status;
            }
            return originalSet(key, value, ttlMs);
        });
        try {
            await expect(coreB.can(subject, "read", "db:orders")).resolves.toBe(true);
        } finally {
            set.mockRestore();
        }
        expect(raced).toBe(true);
        expect(revokeStatus).toBe("completed");
        await expect(coreB.can(subject, "read", "db:orders")).resolves.toBe(false);
    }, TEST_TIMEOUT);

    it("removes an old menu-tree fill that races after a committed menu update", async () => {
        const targetScope = nextScope("menu-fill-after-update");
        const subject = { userId: `user-${randomUUID()}`, scope: targetScope };
        const scoped = coreA.scope(targetScope);
        await importManifest(scoped, {
            schemaVersion: 2,
            mode: "replace",
            nodes: [
                { id: "root", type: "directory", title: "Root", order: 0 },
                {
                    id: "orders",
                    parentId: "root",
                    type: "page",
                    title: "Orders",
                    path: "/orders",
                    name: "orders",
                    component: "OrdersPage",
                    permission: { action: "read", resource: "ui:page:orders" },
                    order: 0,
                },
            ],
            apiBindings: [],
        });
        await scoped.roles.create({ id: "reader", label: "Reader" });
        await scoped.roles.allow("reader", { action: "read", resource: "ui:page:orders" });
        await scoped.userRoles.assign(subject.userId, "reader");
        const currentMenu = await scoped.menus.get("orders");

        const originalSet = cache.set.bind(cache);
        let raced = false;
        let updateStatus: string | undefined;
        const set = vi.spyOn(cache, "set").mockImplementation(async (key, value, ttlMs) => {
            if (!raced && String(key).includes(":menu-tree:")) {
                raced = true;
                const updated = await scoped.menus.update("orders", { title: "Orders v2" }, {
                    expectedRevision: currentMenu.data.revision,
                });
                updateStatus = updated.cache.status;
            }
            return originalSet(key, value, ttlMs);
        });
        try {
            await expect(coreB.forSubject(subject).menus.getVisibleTree()).resolves.toMatchObject({
                data: [expect.objectContaining({ children: [expect.objectContaining({ title: "Orders" })] })],
            });
        } finally {
            set.mockRestore();
        }
        expect(raced).toBe(true);
        expect(updateStatus).toBe("completed");
        await expect(coreB.forSubject(subject).menus.getVisibleTree()).resolves.toMatchObject({
            data: [expect.objectContaining({ children: [expect.objectContaining({ title: "Orders v2" })] })],
        });
    }, TEST_TIMEOUT);

    it("invalidates inherited permissions when a role parent changes", async () => {
        const targetScope = nextScope("parent");
        const subject = { userId: `user-${randomUUID()}`, scope: targetScope };
        const scoped = coreA.scope(targetScope);
        await scoped.roles.create({ id: "parent", label: "Parent" });
        await scoped.roles.allow("parent", { action: "read", resource: "db:orders" });
        await scoped.roles.create({ id: "child", label: "Child", parentId: "parent" });
        await scoped.userRoles.assign(subject.userId, "child");
        await expect(coreA.can(subject, "read", "db:orders")).resolves.toBe(true);
        await expect(coreB.can(subject, "read", "db:orders")).resolves.toBe(true);

        const preview = await scoped.roles.previewAccessUpdate("child", { parentId: null }, { actorId: "admin" });
        if (!preview.executable) throw new Error("Expected an executable parent update preview.");
        const changed = await scoped.roles.executeAccessUpdate("child", { parentId: null }, {
            ...preview.expected,
            previewToken: preview.previewToken,
            actorId: "admin",
        });
        expect(changed).toMatchObject({ changed: true, cache: { status: "completed" } });
        await expect(coreB.can(subject, "read", "db:orders")).resolves.toBe(false);
    }, TEST_TIMEOUT);

    it("invalidates every user view family plus menu and API projections", async () => {
        const targetScope = nextScope("menu-api");
        const subject = { userId: `user-${randomUUID()}`, scope: targetScope };
        const scoped = coreA.scope(targetScope);
        await importManifest(scoped, {
            schemaVersion: 2,
            mode: "replace",
            nodes: [
                { id: "root", type: "directory", title: "Root", order: 0 },
                {
                    id: "orders",
                    parentId: "root",
                    type: "page",
                    title: "Orders",
                    path: "/orders",
                    name: "orders",
                    component: "OrdersPage",
                    permission: { action: "read", resource: "ui:page:orders" },
                    order: 0,
                },
                {
                    id: "orders-export",
                    parentId: "orders",
                    type: "button",
                    title: "Export",
                    code: "orders.export",
                    permission: { action: "invoke", resource: "ui:button:orders.export" },
                    order: 0,
                },
            ],
            apiBindings: [{
                id: "orders-entry",
                method: "GET",
                path: "/api/orders",
                purpose: "entry",
                authorization: {
                    mode: "all",
                    permissions: [{ action: "invoke", resource: "api:GET:/api/orders" }],
                },
                owners: [{ type: "page", id: "orders", required: true }],
                canonicalOwner: { type: "page", id: "orders" },
            }],
        });
        await scoped.roles.create({ id: "operator", label: "Operator" });
        for (const rule of [
            { action: "read" as const, resource: "ui:page:orders" },
            { action: "invoke" as const, resource: "ui:button:orders.export" },
            { action: "invoke" as const, resource: "api:GET:/api/orders" },
        ]) {
            await scoped.roles.allow("operator", rule);
        }
        await scoped.userRoles.assign(subject.userId, "operator");

        const before = coreB.forSubject(subject);
        await expect(before.menus.getVisibleTree()).resolves.toMatchObject({
            data: [expect.objectContaining({ children: [expect.objectContaining({ id: "orders", title: "Orders" })] })],
        });
        await expect(before.menus.getButtonMap("orders")).resolves.toMatchObject({
            data: { "orders.export": { enabled: true, reason: "allowed" } },
        });
        await expect(before.menus.getRouteState("/orders")).resolves.toMatchObject({
            data: { allowed: true, reason: "allowed" },
        });

        const revoked = await scoped.userRoles.revoke(subject.userId, "operator");
        expect(revoked.cache.status).toBe("completed");
        const withoutRole = coreB.forSubject(subject);
        await expect(withoutRole.menus.getButtonMap("orders")).resolves.toMatchObject({
            data: { "orders.export": { enabled: false, reason: "permission-denied" } },
        });
        await expect(withoutRole.menus.getRouteState("/orders")).resolves.toMatchObject({
            data: { allowed: false, reason: "permission-denied" },
        });

        await scoped.userRoles.assign(subject.userId, "operator");
        const currentMenu = await scoped.menus.get("orders");
        const renamed = await scoped.menus.update("orders", { title: "Orders v2" }, {
            expectedRevision: currentMenu.data.revision,
        });
        expect(renamed.cache.status).toBe("completed");
        await expect(coreB.forSubject(subject).menus.getVisibleTree()).resolves.toMatchObject({
            data: [expect.objectContaining({ children: [expect.objectContaining({ id: "orders", title: "Orders v2" })] })],
        });

        await expect(coreB.forSubject(subject).menus.getRouteState("/orders")).resolves.toMatchObject({
            data: { allowed: true, reason: "allowed" },
        });
        const preview = await scoped.apiBindings.previewSetStatus("orders-entry", "disabled", { actorId: "admin" });
        if (!preview.executable) throw new Error("Expected an executable API status preview.");
        const disabled = await scoped.apiBindings.setStatus("orders-entry", "disabled", {
            ...preview.expected,
            previewToken: preview.previewToken,
            actorId: "admin",
        });
        expect(disabled.cache.status).toBe("completed");
        await expect(coreB.forSubject(subject).menus.getRouteState("/orders")).resolves.toMatchObject({
            data: { allowed: false, reason: "api-unavailable" },
        });
    }, TEST_TIMEOUT);

    it("reports a committed degraded mutation and bounds stale authorization by TTL after delete failure", async () => {
        const targetScope = nextScope("delete-fault");
        const subject = { userId: `user-${randomUUID()}`, scope: targetScope };
        const scoped = coreA.scope(targetScope);
        await scoped.roles.create({ id: "reader", label: "Reader" });
        await scoped.roles.allow("reader", { action: "read", resource: "db:orders" });
        await scoped.userRoles.assign(subject.userId, "reader");
        await expect(coreB.can(subject, "read", "db:orders")).resolves.toBe(true);

        const del = vi.spyOn(cache, "del").mockRejectedValue(new Error("delete failed"));
        const delPattern = vi.spyOn(cache, "delPattern").mockRejectedValue(new Error("delete failed"));
        let revoked;
        try {
            revoked = await scoped.userRoles.revoke(subject.userId, "reader");
        } finally {
            del.mockRestore();
            delPattern.mockRestore();
        }
        expect(revoked).toMatchObject({
            committed: true,
            changed: true,
            cache: { status: "degraded" },
        });
        await expect(coreB.can(subject, "read", "db:orders")).resolves.toBe(true);
        await expect(coreA.health()).resolves.toMatchObject({
            status: "degraded",
            cache: { invalidationIncidentActive: true, invalidationFailures: expect.any(Number) },
        });

        await new Promise((resolve) => setTimeout(resolve, TTL_MS + 100));
        await expect(coreB.can(subject, "read", "db:orders")).resolves.toBe(false);
    }, TEST_TIMEOUT);

    it("isolates a different collection namespace and leaves the shared cache usable after one core closes", async () => {
        const targetScope = nextScope("isolation-close");
        const subject = { userId: `user-${randomUUID()}`, scope: targetScope };
        const scoped = coreA.scope(targetScope);
        await scoped.roles.create({ id: "reader", label: "Reader" });
        await scoped.roles.allow("reader", { action: "read", resource: "db:orders" });
        await scoped.userRoles.assign(subject.userId, "reader");
        await expect(coreB.can(subject, "read", "db:orders")).resolves.toBe(true);

        const isolated = createCore(context, `${PREFIX}_iso`);
        await isolated.init();
        try {
            await expect(isolated.can(subject, "read", "db:orders")).resolves.toBe(false);
        } finally {
            await isolated.close();
        }

        const disposable = createCore(context);
        await disposable.init();
        await disposable.close();
        await expect(coreB.can(subject, "read", "db:orders")).resolves.toBe(true);
    }, TEST_TIMEOUT);
});
