import type { HealthView } from "monsqlize";
import { describe, expect, it, vi } from "vitest";
import { PermissionCore } from "../../src";
import { createMonSQLizeStub } from "./helpers/monsqlize-stub";

describe("PermissionCore lifecycle foundation", () => {
    it("reports new state without probing external resources", async () => {
        const stub = createMonSQLizeStub();
        const core = new PermissionCore({ monsqlize: stub.instance });

        const health = await core.health();
        expect(health).toMatchObject({
            status: "down",
            lifecycle: "new",
            initialized: false,
            database: { status: "unknown" },
            cache: { permissionLayer: "bypassed" },
        });
        expect(Object.isFrozen(health)).toBe(true);
        expect(stub.spies.health).not.toHaveBeenCalled();
    });

    it("initializes eight private collection handles and bypasses cache by default", async () => {
        const stub = createMonSQLizeStub();
        const core = new PermissionCore({ monsqlize: stub.instance });

        const health = await core.init();
        expect(health.status).toBe("up");
        expect(health.lifecycle).toBe("ready");
        expect(health.coreNamespaceHash).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        expect(health.schema.expectedSchemeContractDigest).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        expect(health.schema.expectedSchemaContractKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
        expect(stub.spies.collection.mock.calls.map(([name]) => name)).toEqual([
            "permission_core_roles",
            "permission_core_role_rules",
            "permission_core_user_role_sets",
            "permission_core_role_menu_grants",
            "permission_core_menu_nodes",
            "permission_core_api_bindings",
            "permission_core_scope_state",
            "permission_core_audit_entries",
        ]);
        expect(stub.spies.getDefaults).toHaveBeenCalledTimes(1);
        expect(stub.spies.db).toHaveBeenCalledTimes(2);
        expect(stub.database.admin).toHaveBeenCalledTimes(2);
        expect(stub.admin.serverStatus).toHaveBeenCalledTimes(1);
        expect(stub.spies.withTransaction).toHaveBeenCalledTimes(1);
        for (const handle of stub.collections.values()) {
            expect(handle.createIndexes).toHaveBeenCalledTimes(1);
            expect(handle.listIndexes).toHaveBeenCalledTimes(1);
        }
        expect(stub.spies.getCache).not.toHaveBeenCalled();
        expect(stub.spies.connect).not.toHaveBeenCalled();
    });

    it("shares a concurrent init and supports retry after database recovery", async () => {
        const stub = createMonSQLizeStub();
        let resolveHealth!: (value: HealthView) => void;
        stub.spies.health.mockImplementationOnce(() => new Promise((resolve) => {
            resolveHealth = resolve;
        }));
        const core = new PermissionCore({ monsqlize: stub.instance });

        const first = core.init();
        const second = core.init();
        resolveHealth({ status: "down", connected: false });
        await expect(first).rejects.toMatchObject({ code: "DATABASE_UNAVAILABLE" });
        await expect(second).rejects.toMatchObject({ code: "DATABASE_UNAVAILABLE" });
        expect(stub.spies.health).toHaveBeenCalledTimes(1);

        stub.spies.health.mockResolvedValueOnce({ status: "up", connected: true });
        const recovered = await core.init();
        expect(recovered.lifecycle).toBe("ready");
        expect(recovered.lastInitError).toBeUndefined();
        expect(stub.spies.health).toHaveBeenCalledTimes(2);
    });

    it("only resolves the host cache after explicit opt-in", async () => {
        const stub = createMonSQLizeStub();
        const core = new PermissionCore({
            monsqlize: stub.instance,
            cache: { enabled: true, consistency: "ordered-bounded-stale" },
        });

        expect(stub.spies.getCache).not.toHaveBeenCalled();
        const health = await core.init();
        expect(stub.spies.getCache).toHaveBeenCalledTimes(1);
        expect(health.cache).toMatchObject({
            permissionLayer: "enabled",
            consistencyAssurance: "caller-attested",
            backendState: "opaque",
        });
    });

    it.each([undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
        "rejects an invalid MonSQLize findMaxLimit capability (%s)",
        async (findMaxLimit) => {
            const stub = createMonSQLizeStub();
            stub.spies.getDefaults.mockReturnValueOnce({ findMaxLimit });

            await expect(new PermissionCore({ monsqlize: stub.instance }).init()).rejects.toMatchObject({
                code: "MONSQLIZE_CONTRACT_UNSUPPORTED",
                details: {
                    kind: "validation",
                    field: "monsqlize.getDefaults().findMaxLimit",
                },
            });
            expect(stub.spies.collection).not.toHaveBeenCalled();
        },
    );

    it("maps malformed host capabilities to the stable contract error", async () => {
        const adminFailure = createMonSQLizeStub();
        adminFailure.database.admin.mockImplementationOnce(() => {
            throw new Error("host failure");
        });
        await expect(new PermissionCore({ monsqlize: adminFailure.instance }).init()).rejects.toMatchObject({
            code: "MONSQLIZE_CONTRACT_UNSUPPORTED",
            details: { kind: "validation", field: "monsqlize.db().admin" },
        });

        const namespaceFailure = createMonSQLizeStub();
        const roleCollection = namespaceFailure.spies.collection("permission_core_roles") as Record<string, unknown>;
        roleCollection.getNamespace = () => {
            throw new Error("host failure");
        };
        namespaceFailure.spies.collection.mockClear();
        await expect(new PermissionCore({ monsqlize: namespaceFailure.instance }).init()).rejects.toMatchObject({
            code: "MONSQLIZE_CONTRACT_UNSUPPORTED",
            details: { kind: "validation", field: "monsqlize.collection.getNamespace" },
        });

        const cacheFailure = createMonSQLizeStub();
        (cacheFailure.cache as unknown as { delPattern?: unknown }).delPattern = undefined;
        await expect(new PermissionCore({
            monsqlize: cacheFailure.instance,
            cache: { enabled: true, consistency: "ordered-bounded-stale" },
        }).init()).rejects.toMatchObject({
            code: "MONSQLIZE_CONTRACT_UNSUPPORTED",
            details: { kind: "validation", field: "monsqlize.getCache().delPattern" },
        });
    });

    it("closes only its own lifecycle and freezes health without new I/O", async () => {
        const stub = createMonSQLizeStub();
        const core = new PermissionCore({ monsqlize: stub.instance });
        await core.init();
        const probesBeforeClose = stub.spies.health.mock.calls.length;

        await Promise.all([core.close(), core.close()]);
        const health = await core.health();
        expect(health).toMatchObject({ lifecycle: "closed", initialized: false, status: "down" });
        expect(stub.spies.health).toHaveBeenCalledTimes(probesBeforeClose);
        expect(stub.spies.close).not.toHaveBeenCalled();
        await expect(core.init()).rejects.toMatchObject({ code: "CORE_CLOSED", retryable: false });
    });

    it("keeps closing after a finite drain timeout and permits close retry", async () => {
        vi.useFakeTimers();
        try {
            const stub = createMonSQLizeStub();
            let resolveHealth!: (value: HealthView) => void;
            stub.spies.health.mockImplementationOnce(() => new Promise((resolve) => {
                resolveHealth = resolve;
            }));
            const core = new PermissionCore({
                monsqlize: stub.instance,
                closeDrainTimeoutMs: 1_000,
            });

            const initialization = core.init();
            const closing = core.close();
            const timeoutAssertion = expect(closing).rejects.toMatchObject({
                code: "CORE_CLOSE_TIMEOUT",
                retryable: true,
                details: {
                    kind: "close-timeout",
                    timeoutMs: 1_000,
                    activeOperationLeases: 0,
                    activeBorrowedTransactions: 0,
                },
            });
            await vi.advanceTimersByTimeAsync(1_000);
            await timeoutAssertion;

            const probeCount = stub.spies.health.mock.calls.length;
            expect(await core.health()).toMatchObject({ lifecycle: "closing", status: "down" });
            expect(stub.spies.health).toHaveBeenCalledTimes(probeCount);

            resolveHealth({ status: "up", connected: true });
            expect(await initialization).toMatchObject({ lifecycle: "closing", initialized: false });
            await core.close();
            expect(await core.health()).toMatchObject({ lifecycle: "closed", initialized: false });
            expect(stub.spies.close).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it("drains an active public operation lease without closing the host", async () => {
        const stub = createMonSQLizeStub();
        const core = new PermissionCore({
            monsqlize: stub.instance,
            closeDrainTimeoutMs: 1_000,
        });
        await core.init();
        const scopeState = stub.collections.get("permission_core_scope_state")!;
        const findOne = scopeState.findOne as ReturnType<typeof vi.fn>;
        let release!: (value: null) => void;
        findOne.mockImplementationOnce(() => new Promise<null>((resolve) => {
            release = resolve;
        }));

        vi.useFakeTimers();
        try {
            const lookup = core.scope({ tenantId: "lease-tenant" }).roles.get("missing-role");
            await Promise.resolve();
            expect(findOne).toHaveBeenCalled();

            const closing = core.close();
            const timeoutAssertion = expect(closing).rejects.toMatchObject({
                code: "CORE_CLOSE_TIMEOUT",
                retryable: true,
                details: {
                    kind: "close-timeout",
                    timeoutMs: 1_000,
                    activeOperationLeases: 1,
                    activeBorrowedTransactions: 0,
                },
            });
            await vi.advanceTimersByTimeAsync(1_000);
            await timeoutAssertion;
            expect(await core.health()).toMatchObject({ lifecycle: "closing", status: "down" });

            release(null);
            await expect(lookup).rejects.toMatchObject({ code: "ROLE_NOT_FOUND" });
            await core.close();
            expect(await core.health()).toMatchObject({ lifecycle: "closed" });
            expect(stub.spies.close).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});
