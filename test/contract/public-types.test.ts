import type { MonSQLizeInstance } from "monsqlize";
import { describe, expect, it } from "vitest";
import {
    PermissionCore,
    type PermissionCoreErrorDetails,
    type PermissionCoreHealth,
    type PermissionCoreOptions,
    type PermissionSubject,
    type MenuConfigManager,
    type MenuConfigRootManager,
    type RoleMenuPermissionManager,
    type SubjectMenuRuntime,
    type AuthorizedCollection,
    type SubjectDataRuntime,
    type SubjectPermissionContext,
} from "../../src";

describe("B1 public type contract", () => {
    it("keeps the cache union and public surface closed", () => {
        type HasLogin = "login" extends keyof PermissionCore ? true : false;
        type HasStorage = "storage" extends keyof PermissionCoreOptions ? true : false;
        const hasLogin: HasLogin = false;
        const hasStorage: HasStorage = false;
        expect(hasLogin).toBe(false);
        expect(hasStorage).toBe(false);
    });
});

describe("B4 menu public type contract", () => {
    it("exports the complete high-level menu manager method sets from the root", () => {
        const rootKeys = [
            "config", "management", "configs", "items", "views", "loadApis", "actions", "responses",
        ] as const satisfies readonly (keyof MenuConfigRootManager)[];
        const configKeys = [
            "preview", "save", "get", "list", "previewRemove", "remove", "previewChanges", "applyChanges",
        ] as const satisfies readonly (keyof MenuConfigManager)[];
        const roleMenuKeys = [
            "preview", "grant", "revoke", "deny", "set", "getDirect", "listDirect", "getEffective",
            "getAuthorizationTree",
        ] as const satisfies readonly (keyof RoleMenuPermissionManager)[];
        const subjectMenuKeys = ["getViewTree", "getActionMap", "getViewState", "filterResponse"] as const satisfies readonly (keyof SubjectMenuRuntime)[];
        const rootComplete: Exclude<keyof MenuConfigRootManager, typeof rootKeys[number]> extends never ? true : false = true;
        const configComplete: Exclude<keyof MenuConfigManager, typeof configKeys[number]> extends never ? true : false = true;
        const roleMenuComplete: Exclude<keyof RoleMenuPermissionManager, typeof roleMenuKeys[number]> extends never ? true : false = true;
        const subjectMenuComplete: Exclude<keyof SubjectMenuRuntime, typeof subjectMenuKeys[number]> extends never ? true : false = true;

        expect([rootComplete, configComplete, roleMenuComplete, subjectMenuComplete]).toEqual([
            true, true, true, true,
        ]);
    });
});

describe("B5 data public type contract", () => {
    it("exports only the frozen AuthorizedCollection safe subset", () => {
        const collectionKeys = [
            "find", "findOne", "count", "findAndCount", "findPage",
            "insertOne", "updateOne", "updateMany", "deleteOne", "deleteMany",
        ] as const satisfies readonly (keyof AuthorizedCollection<object>)[];
        const complete: Exclude<keyof AuthorizedCollection<object>, typeof collectionKeys[number]> extends never ? true : false = true;
        type HasRaw = "raw" extends keyof AuthorizedCollection<object> ? true : false;
        type HasAggregate = "aggregate" extends keyof AuthorizedCollection<object> ? true : false;
        type HasWatch = "watch" extends keyof AuthorizedCollection<object> ? true : false;
        const hasRaw: HasRaw = false;
        const hasAggregate: HasAggregate = false;
        const hasWatch: HasWatch = false;
        const dataKey: "data" extends keyof SubjectPermissionContext ? true : false = true;

        expect([complete, hasRaw, hasAggregate, hasWatch, dataKey]).toEqual([true, false, false, false, true]);
    });
});

if (false) {
    const monsqlize = null as unknown as MonSQLizeInstance;
    const minimal: PermissionCoreOptions = { monsqlize };
    const disabled: PermissionCoreOptions = { monsqlize, cache: { enabled: false } };
    const enabled: PermissionCoreOptions = {
        monsqlize,
        cache: { enabled: true, consistency: "ordered-bounded-stale" },
    };
    const health = null as unknown as PermissionCoreHealth;
    const subject: PermissionSubject = {
        userId: "u-1",
        scope: { tenantId: "tenant-a" },
    };
    const scopedWithDefaults = new PermissionCore(minimal).scope(
        { tenantId: "tenant-a", appId: "admin" },
        { actorId: "admin", requestId: "req-admin-page" },
    );
    const detail: PermissionCoreErrorDetails = { kind: "validation", reason: "example" };
    const data = null as unknown as SubjectDataRuntime;
    const menuManagement = null as unknown as MenuConfigRootManager["management"];
    const menuManagementChanges = [{ operation: "menu.create", input: { id: "orders", title: "Orders" } }] as const;
    const orders = data.collection<
        { _id: string; tenantId: string; amount: number },
        { amount: number }
    >("orders", { resource: "db:orders", scopeFields: { tenantId: "tenantId" } });
    void orders.insertOne({ amount: 10 });
    void scopedWithDefaults.withDefaults({ actorId: "ops" }).roles.create({ id: "operator", label: "Operator" });
    void scopedWithDefaults.menus.management.applyChanges("admin", menuManagementChanges);
    void scopedWithDefaults.menus.items.create("admin", { id: "orders", title: "Orders" });
    void scopedWithDefaults.menus.views.create("admin", "orders", {
        id: "orders-list",
        type: "page",
        title: "Orders list",
        path: "/orders",
        component: "OrdersList",
    });
    void menuManagement.applyChanges("admin", menuManagementChanges, { actorId: "admin", idempotencyKey: "auto" });
    void menuManagement.applyChanges("admin", menuManagementChanges, {
        actorId: "admin",
        expectedRevisions: { global: 0, menu: 0, entities: [] },
        previewToken: "preview-token",
    });
    void [minimal, disabled, enabled, health, subject, scopedWithDefaults, detail, data, orders, menuManagement];

    // @ts-expect-error Empty cache objects are not a third configuration state.
    new PermissionCore({ monsqlize, cache: {} });
    // @ts-expect-error Enabled cache requires the consistency attestation.
    new PermissionCore({ monsqlize, cache: { enabled: true } });
    // @ts-expect-error Disabled cache cannot carry a TTL.
    new PermissionCore({ monsqlize, cache: { enabled: false, ttlMs: 1000 } });
    // @ts-expect-error StorageAdapter is not part of the public constructor.
    new PermissionCore({ monsqlize, storage: {} });
    // @ts-expect-error Authentication state cannot inject roles into the trusted subject.
    const invalidSubject: PermissionSubject = { userId: "u-1", scope: { tenantId: "t" }, roles: ["admin"] };
    // @ts-expect-error Error details must use a declared discriminator.
    const invalidDetails: PermissionCoreErrorDetails = { arbitrary: true };
    // @ts-expect-error The create shape is distinct from the read document shape.
    void orders.insertOne({ _id: "caller", tenantId: "tenant", amount: 10 });
    // @ts-expect-error Collection creation does not accept a second policy context.
    void data.collection("orders", { resource: "db:orders", scopeFields: { tenantId: "tenantId" } }, {});
    // @ts-expect-error Raw Mongo handles are not part of the protected surface.
    void orders.raw();
    // @ts-expect-error Preview tokens must be paired with expectedRevisions.
    void menuManagement.applyChanges("admin", menuManagementChanges, { actorId: "admin", previewToken: "preview-token" });
    // @ts-expect-error Menu management execution no longer accepts the old scalar expectedRevision option.
    void menuManagement.applyChanges("admin", menuManagementChanges, { actorId: "admin", expectedRevision: 1 });
    // @ts-expect-error Old bottom-level menu manager is no longer exported from the package root.
    type RemovedMenuManager = import("../../src").MenuManager;
    // @ts-expect-error Old manifest manager is no longer exported from the package root.
    type RemovedMenuManifestManager = import("../../src").MenuManifestManager;
    // @ts-expect-error Old API binding manager is no longer exported from the package root.
    type RemovedApiBindingManager = import("../../src").ApiBindingManager;
    void [invalidSubject, invalidDetails];
}
