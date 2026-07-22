import { describe, expect, it, vi } from "vitest";
import type {
    AuthorizedCollection,
    AuthorizedCollectionOptions,
    PermissionCoreErrorCode,
    PermissionCoreErrorDetails,
    PermissionSubject,
    SubjectPermissionContext,
} from "../../src";
import { PermissionCore } from "../../src/core/permission-core";
import { PermissionCoreError } from "../../src/core/errors";
import {
    mapVextPermissionError,
    throwVextPermissionError,
    vextPermissionHttpStatus,
} from "../../src/plugins/vext/errors";
import {
    createPermissionRequestMiddleware,
    hasPermissionContext,
    requirePermissionContext,
} from "../../src/plugins/vext/request";
import type { ResolvedPermissionVextDataOptions } from "../../src/plugins/vext/options";
import type { VextRequest } from "vextjs";

class TestHttpError extends Error {
    readonly name = "HttpError";
    constructor(
        readonly status: number,
        message: string,
        readonly code?: string | number,
    ) {
        super(message);
    }
}

function fakeApp() {
    return {
        throw(options: { status: number; message: string; code?: string | number }) {
            throw new TestHttpError(options.status, options.message, options.code);
        },
    };
}

function request(auth?: unknown) {
    return {
        app: fakeApp(),
        ...(auth === undefined ? {} : { auth }),
    } as unknown as VextRequest;
}

function fakeAuthorizedCollection(): AuthorizedCollection<Record<string, unknown>> {
    return {
        find: vi.fn(async () => [{ orderNo: "O-1", status: "paid" }]),
        findOne: vi.fn(async () => ({ orderNo: "O-1" })),
        count: vi.fn(async () => 1),
        findAndCount: vi.fn(async () => ({ data: [{ orderNo: "O-1" }], total: 1 })),
        findPage: vi.fn(async () => ({
            items: [{ orderNo: "O-1" }],
            pageInfo: { hasNext: false, hasPrev: false, startCursor: null, endCursor: null },
        })),
        insertOne: vi.fn(async () => ({ acknowledged: true as const, insertedId: "id-1" })),
        updateOne: vi.fn(async () => ({ acknowledged: true as const, matchedCount: 1, modifiedCount: 1 })),
        updateMany: vi.fn(async () => ({ acknowledged: true as const, matchedCount: 1, modifiedCount: 1 })),
        deleteOne: vi.fn(async () => ({ acknowledged: true as const, deletedCount: 1 })),
        deleteMany: vi.fn(async () => ({ acknowledged: true as const, deletedCount: 1 })),
    };
}

function fakeCore(can: (action: string, resource: string) => boolean | Promise<boolean> = () => true) {
    const calls: Array<{ subject: PermissionSubject; context: unknown }> = [];
    const dataCalls: Array<{ name: string; options: AuthorizedCollectionOptions }> = [];
    const collections: AuthorizedCollection<Record<string, unknown>>[] = [];
    const core = {
        forSubject(subject: PermissionSubject, context?: unknown): SubjectPermissionContext {
            calls.push({ subject, context });
            return {
                can: async (action, resource) => can(action, resource),
                cannot: async (action, resource) => !(await can(action, resource)),
                assert: async (action, resource) => {
                    if (!(await can(action, resource))) {
                        throw new PermissionCoreError("PERMISSION_DENIED", "denied");
                    }
                },
                data: {
                    collection(name, options) {
                        dataCalls.push({ name, options });
                        const collection = fakeAuthorizedCollection();
                        collections.push(collection);
                        return collection;
                    },
                },
            } as SubjectPermissionContext;
        },
    } as unknown as PermissionCore;
    return { core, calls, dataCalls, collections };
}

async function runMiddleware(
    req: VextRequest,
    core: PermissionCore,
    operation: () => Promise<void> | void,
    resolver?: Parameters<typeof createPermissionRequestMiddleware>[1],
    dataOptions?: ResolvedPermissionVextDataOptions,
) {
    const middleware = createPermissionRequestMiddleware(core, resolver, dataOptions);
    await middleware(req, {} as never, async () => {
        await operation();
    });
}

function dataOptions(
    input?: Partial<ResolvedPermissionVextDataOptions>,
): ResolvedPermissionVextDataOptions {
    return Object.freeze({
        scopeFields: Object.freeze({ tenantId: "tenantId" }),
        collections: Object.freeze({}),
        ...input,
    });
}

describe("Vext lazy permission request context", () => {
    it("does not read or validate auth on a public request that never calls the helper", async () => {
        let getterCalls = 0;
        const req = request();
        Object.defineProperty(req, "auth", {
            enumerable: true,
            get() {
                getterCalls += 1;
                throw new Error("must not execute");
            },
        });
        const { core, calls } = fakeCore();

        await runMiddleware(req, core, () => undefined);

        expect(getterCalls).toBe(0);
        expect(calls).toHaveLength(0);
        expect(hasPermissionContext(req)).toBe(false);
    });

    it("supports both exact default auth shapes and freezes the installed API", async () => {
        const inputs = [
            {
                isAuthenticated: true,
                permissionSubject: { userId: "u-1", scope: { tenantId: "t-1" } },
                provider: "test",
            },
            {
                isAuthenticated: true,
                userId: "u-1",
                scope: { tenantId: "t-1" },
                claims: { merchantId: "m-1" },
                provider: "test",
                optionalProviderState: undefined,
            },
        ];

        for (const auth of inputs) {
            Object.defineProperty(auth, Symbol.for("authentication.internal"), {
                value: true,
                enumerable: false,
            });
            const req = request(auth);
            const { core, calls } = fakeCore();
            await runMiddleware(req, core, async () => {
                const permission = await requirePermissionContext(req);
                expect(permission.subject.userId).toBe("u-1");
                expect(permission.subject.scope.tenantId).toBe("t-1");
                expect(Object.isFrozen(permission)).toBe(true);
                expect(hasPermissionContext(req)).toBe(true);
                expect((req as never as { auth: { permission: unknown } }).auth.permission).toBe(permission);
            });
            expect(calls).toHaveLength(1);
        }
    });

    it("installs a protected data facade and optional req.monsqlize alias", async () => {
        const req = request({ isAuthenticated: true, userId: "u-1", scope: { tenantId: "t-1" } });
        const { core, dataCalls, collections } = fakeCore();
        await runMiddleware(req, core, async () => {
            const permission = await requirePermissionContext(req);
            expect(permission.data).toBeDefined();
            expect(Object.isFrozen(permission.data)).toBe(true);
            expect((req as never as { monsqlize: unknown }).monsqlize).toBe(permission.data);

            const orders = permission.data!.collection("orders");
            expect(Object.isFrozen(orders)).toBe(true);
            await expect(orders.find({ status: "paid" })).resolves.toEqual([{ orderNo: "O-1", status: "paid" }]);
            expect(dataCalls).toEqual([{
                name: "orders",
                options: { resource: "db:orders", scopeFields: { tenantId: "tenantId" } },
            }]);
            expect(collections[0]?.find).toHaveBeenCalledWith({ status: "paid" }, undefined);
        }, undefined, dataOptions({ exposeAs: "monsqlize" }));
    });

    it("keeps req.monsqlize optional while exposing canonical permission.data", async () => {
        const req = request({ isAuthenticated: true, userId: "u-1", scope: { tenantId: "t-1" } });
        const { core } = fakeCore();
        await runMiddleware(req, core, async () => {
            const permission = await requirePermissionContext(req);
            expect(permission.data).toBeDefined();
            expect(req).not.toHaveProperty("monsqlize");
        }, undefined, dataOptions());
    });

    it("uses configured data collection overrides", async () => {
        const req = request({ isAuthenticated: true, userId: "u-1", scope: { tenantId: "t-1" } });
        const { core, dataCalls } = fakeCore();
        await runMiddleware(req, core, async () => {
            const permission = await requirePermissionContext(req);
            await permission.data!.collection("order_records").find();
        }, undefined, dataOptions({
            collections: Object.freeze({
                order_records: Object.freeze({
                    resource: "db:orders",
                    scopeFields: Object.freeze({ tenantId: "tenant_id" }),
                }),
            }),
        }));

        expect(dataCalls).toEqual([{
            name: "order_records",
            options: { resource: "db:orders", scopeFields: { tenantId: "tenant_id" } },
        }]);
    });

    it("rejects occupied data aliases and collection reuse outside the owning request", async () => {
        const occupied = request({ isAuthenticated: true, userId: "u-1", scope: { tenantId: "t-1" } });
        Object.defineProperty(occupied, "monsqlize", { value: { forged: true }, enumerable: true });
        await expect(runMiddleware(occupied, fakeCore().core, async () => {
            await requirePermissionContext(occupied);
        }, undefined, dataOptions({ exposeAs: "monsqlize" })))
            .rejects.toMatchObject({ status: 500, code: "VEXT_AUTH_EXTENSION_CONFLICT" });

        const req = request({ isAuthenticated: true, userId: "u-1", scope: { tenantId: "t-1" } });
        const { core } = fakeCore();
        let staleCollection: AuthorizedCollection<Record<string, unknown>> | undefined;
        await runMiddleware(req, core, async () => {
            staleCollection = (await requirePermissionContext(req)).data!.collection("orders");
            await staleCollection.find();
        }, undefined, dataOptions({ exposeAs: "monsqlize" }));
        await expect(staleCollection!.find())
            .rejects.toMatchObject({ status: 500, code: "VEXT_AUTH_EXTENSION_CONFLICT" });
    });

    it("deduplicates concurrent subject resolution and reuses bounded policy contexts", async () => {
        let release!: () => void;
        const blocked = new Promise<void>((resolve) => {
            release = resolve;
        });
        const resolver = vi.fn(async () => {
            await blocked;
            return { userId: "u-1", scope: { tenantId: "t-1" } };
        });
        const req = request({ isAuthenticated: true, principalId: "u-1" });
        const { core, calls } = fakeCore();

        await runMiddleware(req, core, async () => {
            const first = requirePermissionContext(req);
            const second = requirePermissionContext(req);
            release();
            const [left, right] = await Promise.all([first, second]);
            expect(left).toBe(right);
            await left.can("read", "db:orders", { merchantId: "m-1" });
            await left.can("read", "db:orders", { merchantId: "m-1" });
        }, resolver);

        expect(resolver).toHaveBeenCalledTimes(1);
        expect(calls).toHaveLength(2);
        expect(calls[1]?.context).toEqual({ merchantId: "m-1" });
    });

    it("allows a custom resolver to adapt non-default auth but detects canonical owner conflicts", async () => {
        const { core } = fakeCore();
        const adaptable = request({ isAuthenticated: true, userId: "legacy-u", tenant: "t-1" });
        await runMiddleware(adaptable, core, async () => {
            const api = await requirePermissionContext(adaptable);
            expect(api.subject).toEqual({ userId: "mapped-u", scope: { tenantId: "t-1" } });
        }, async () => ({ userId: "mapped-u", scope: { tenantId: "t-1" } }));

        const conflicting = request({
            isAuthenticated: true,
            permissionSubject: { userId: "host-u", scope: { tenantId: "t-1" } },
        });
        await expect(runMiddleware(conflicting, core, async () => {
            await requirePermissionContext(conflicting);
        }, async () => ({ userId: "mapped-u", scope: { tenantId: "t-1" } })))
            .rejects.toMatchObject({ status: 401, code: "SCOPE_CONFLICT" });
    });

    it("rejects missing, unauthenticated, partial, and dual default auth shapes", async () => {
        const { core } = fakeCore();
        const cases: Array<{ auth?: unknown; code: string }> = [
            { code: "VEXT_AUTH_REQUIRED" },
            { auth: { isAuthenticated: false }, code: "VEXT_AUTH_REQUIRED" },
            { auth: { isAuthenticated: true, userId: "u-1" }, code: "INVALID_SUBJECT" },
            {
                auth: {
                    isAuthenticated: true,
                    permissionSubject: { userId: "u-1", scope: { tenantId: "t-1" } },
                    userId: "u-1",
                    scope: { tenantId: "t-1" },
                },
                code: "INVALID_SUBJECT",
            },
        ];
        for (const entry of cases) {
            const req = request(entry.auth);
            await expect(runMiddleware(req, core, async () => {
                await requirePermissionContext(req);
            })).rejects.toMatchObject({ status: 401, code: entry.code });
        }
    });

    it("rejects Proxy/accessor auth without executing traps", async () => {
        const { core } = fakeCore();
        let trapCalls = 0;
        const proxied = new Proxy({}, {
            get() {
                trapCalls += 1;
                throw new Error("must not execute");
            },
        });
        const accessor = { isAuthenticated: true };
        Object.defineProperty(accessor, "userId", {
            enumerable: true,
            get() {
                trapCalls += 1;
                return "u-1";
            },
        });

        for (const auth of [proxied, accessor]) {
            const req = request(auth);
            await expect(runMiddleware(req, core, async () => {
                await requirePermissionContext(req);
            })).rejects.toMatchObject({ status: 401, code: "INVALID_SUBJECT" });
        }
        expect(trapCalls).toBe(0);
    });

    it("rejects exotic and unsafe auth records while ignoring detached host metadata", async () => {
        const { core } = fakeCore();
        const forbidden = { isAuthenticated: true, userId: "u-1", scope: { tenantId: "t-1" } };
        Object.defineProperty(forbidden, "constructor", { value: "occupied", enumerable: true });
        const hiddenContract = { isAuthenticated: true, scope: { tenantId: "t-1" } };
        Object.defineProperty(hiddenContract, "userId", { value: "u-1", enumerable: false });
        const symbolAccessor = { isAuthenticated: true, userId: "u-1", scope: { tenantId: "t-1" } };
        Object.defineProperty(symbolAccessor, Symbol("host"), {
            enumerable: false,
            get() {
                throw new Error("must not execute");
            },
        });
        for (const auth of [null, [], new Date(), forbidden, hiddenContract, symbolAccessor]) {
            const req = request(auth);
            await expect(runMiddleware(req, core, async () => {
                await requirePermissionContext(req);
            })).rejects.toMatchObject({ status: 401, code: "INVALID_SUBJECT" });
        }

        const accepted = { isAuthenticated: true, userId: "u-1", scope: { tenantId: "t-1" } };
        Object.defineProperty(accepted, Symbol("host"), { value: "internal", enumerable: false });
        Object.defineProperty(accepted, "providerState", { value: "internal", enumerable: false });
        const acceptedRequest = request(accepted);
        await runMiddleware(acceptedRequest, core, async () => {
            expect((await requirePermissionContext(acceptedRequest)).subject.userId).toBe("u-1");
        });
    });

    it("fails closed on occupied/frozen extensions and auth replacement during an async resolver", async () => {
        const { core } = fakeCore();
        const occupied = request({ isAuthenticated: true, permission: { forged: true } });
        await expect(runMiddleware(occupied, core, async () => {
            await requirePermissionContext(occupied);
        }, async () => ({ userId: "u-1", scope: { tenantId: "t-1" } })))
            .rejects.toMatchObject({ status: 500, code: "VEXT_AUTH_EXTENSION_CONFLICT" });

        const frozen = request(Object.freeze({ isAuthenticated: true, userId: "u-1", scope: { tenantId: "t-1" } }));
        await expect(runMiddleware(frozen, core, async () => {
            await requirePermissionContext(frozen);
        })).rejects.toMatchObject({ status: 500, code: "VEXT_AUTH_EXTENSION_CONFLICT" });

        const replaced = request({ isAuthenticated: true, principal: "u-1" });
        await expect(runMiddleware(replaced, core, async () => {
            await requirePermissionContext(replaced);
        }, async (_auth, req) => {
            (req as never as { auth: unknown }).auth = { isAuthenticated: true };
            return { userId: "u-1", scope: { tenantId: "t-1" } };
        })).rejects.toMatchObject({ status: 401, code: "INVALID_SUBJECT" });
    });

    it("binds genuine extensions to one request and rejects state or auth occupation races", async () => {
        const { core } = fakeCore();
        const auth = { isAuthenticated: true, userId: "u-1", scope: { tenantId: "t-1" } };
        const first = request(auth);
        let firstApi: unknown;
        await runMiddleware(first, core, async () => {
            firstApi = await requirePermissionContext(first);
        });
        expect(await requirePermissionContext(first)).toBe(firstApi);
        await expect((firstApi as Awaited<ReturnType<typeof requirePermissionContext>>).can("read", "db:orders"))
            .rejects.toMatchObject({ status: 500, code: "VEXT_AUTH_EXTENSION_CONFLICT" });

        const direct = request(auth);
        await expect(runMiddleware(direct, core, async () => {
            const stale = (direct as never as { auth: { permission: Awaited<ReturnType<typeof requirePermissionContext>> } })
                .auth.permission;
            await stale.can("read", "db:orders");
        })).rejects.toMatchObject({ status: 500, code: "VEXT_AUTH_EXTENSION_CONFLICT" });

        const second = request(auth);
        await expect(runMiddleware(second, core, async () => {
            await requirePermissionContext(second);
        })).rejects.toMatchObject({ status: 500, code: "VEXT_AUTH_EXTENSION_CONFLICT" });
        await expect(requirePermissionContext(second))
            .rejects.toMatchObject({ status: 500, code: "VEXT_AUTH_EXTENSION_CONFLICT" });
        const third = request(auth);
        await expect(requirePermissionContext(third))
            .rejects.toMatchObject({ status: 401, code: "VEXT_AUTH_REQUIRED" });

        const racedAuth = { isAuthenticated: true, principal: "u-1" } as Record<string, unknown>;
        const raced = request(racedAuth);
        await expect(runMiddleware(raced, core, async () => {
            await requirePermissionContext(raced);
        }, async () => {
            Object.defineProperty(racedAuth, "permission", { value: {}, enumerable: true });
            return { userId: "u-1", scope: { tenantId: "t-1" } };
        })).rejects.toMatchObject({ status: 500, code: "VEXT_AUTH_EXTENSION_CONFLICT" });

        const repeated = request();
        await runMiddleware(repeated, core, () => undefined);
        await runMiddleware(repeated, core, () => undefined);
        const stateKey = Object.getOwnPropertySymbols(repeated)[0]!;
        const forged = request();
        Object.defineProperty(forged, stateKey, { value: {}, enumerable: false });
        await expect(runMiddleware(forged, core, () => undefined))
            .rejects.toMatchObject({ code: "VEXT_AUTH_EXTENSION_CONFLICT" });

        const frozen = Object.freeze(request());
        await expect(runMiddleware(frozen, core, () => undefined))
            .rejects.toMatchObject({ code: "VEXT_AUTH_EXTENSION_CONFLICT" });
    });

    it("fails closed without middleware, on proxied requests, and on invalid resolver results", async () => {
        const { core } = fakeCore();
        const bare = request({ isAuthenticated: true, userId: "u-1", scope: { tenantId: "t-1" } });
        await expect(requirePermissionContext(bare))
            .rejects.toMatchObject({ status: 401, code: "VEXT_AUTH_REQUIRED" });

        const proxied = new Proxy(bare, {});
        expect(hasPermissionContext(proxied)).toBe(false);
        await expect(runMiddleware(proxied, core, async () => {
            await requirePermissionContext(proxied);
        })).rejects.toMatchObject({ status: 401, code: "INVALID_SUBJECT" });

        for (const resolver of [
            async () => ({ userId: "" }),
            async () => {
                throw new Error("identity provider failed");
            },
        ]) {
            const req = request({ isAuthenticated: true, principal: "u-1" });
            await expect(runMiddleware(req, core, async () => {
                await requirePermissionContext(req);
            }, resolver as never)).rejects.toMatchObject({ status: 401, code: "INVALID_SUBJECT" });
        }

        const canonical = request({
            isAuthenticated: true,
            userId: "u-1",
            scope: { tenantId: "t-1" },
        });
        await runMiddleware(canonical, core, async () => {
            expect((await requirePermissionContext(canonical)).subject.userId).toBe("u-1");
        }, async () => ({ userId: "u-1", scope: { tenantId: "t-1" } }));
    });

    it("bounds per-request policy context caching and maps invalid contexts", async () => {
        const req = request({ isAuthenticated: true, userId: "u-1", scope: { tenantId: "t-1" } });
        const { core, calls } = fakeCore();
        await runMiddleware(req, core, async () => {
            const api = await requirePermissionContext(req);
            for (let index = 0; index < 33; index += 1) {
                await api.can("read", "db:orders", { merchantId: `m-${index}` });
            }
            await api.can("read", "db:orders", { merchantId: "m-32" });
            await expect(api.can("read", "db:orders", [] as never))
                .rejects.toMatchObject({ status: 400, code: "INVALID_ARGUMENT" });
        });
        expect(calls).toHaveLength(35);
    });

    it("maps permission API denials and conflicts through app.throw", async () => {
        const denied = request({ isAuthenticated: true, userId: "u-1", scope: { tenantId: "t-1" } });
        const deniedCore = fakeCore(() => false).core;
        await expect(runMiddleware(denied, deniedCore, async () => {
            const api = await requirePermissionContext(denied);
            await api.assert("delete", "db:orders");
        })).rejects.toMatchObject({ status: 403, code: "PERMISSION_DENIED" });

        const conflict = request({ isAuthenticated: true, userId: "u-1", scope: { tenantId: "t-1" } });
        const conflictCore = fakeCore(() => {
            throw new PermissionCoreError("REVISION_CONFLICT", "revision changed", {
                details: { kind: "revision-conflict", owner: "scope" },
            });
        }).core;
        await expect(runMiddleware(conflict, conflictCore, async () => {
            const api = await requirePermissionContext(conflict);
            await api.can("read", "db:orders");
        })).rejects.toMatchObject({ status: 409, code: "REVISION_CONFLICT" });
    });
});

describe("Vext permission HTTP error mapping", () => {
    const expectedStatus = {
        NOT_INITIALIZED: 503,
        CORE_CLOSED: 503,
        CORE_CLOSE_TIMEOUT: 503,
        INVALID_CONFIGURATION: 500,
        MONSQLIZE_CONTRACT_UNSUPPORTED: 500,
        SCHEMA_VERSION_MISMATCH: 503,
        SCHEMA_CONTRACT_MISMATCH: 503,
        PERSISTED_STATE_INVALID: 503,
        DATABASE_UNAVAILABLE: 503,
        INVALID_SUBJECT: 401,
        SCOPE_CONFLICT: 401,
        PERMISSION_DENIED: 403,
        INVALID_ARGUMENT: 400,
        INVALID_ACTION: 400,
        INVALID_RESOURCE: 400,
        INVALID_FILTER: 400,
        INVALID_POLICY: 400,
        POLICY_CONTEXT_MISSING: 400,
        INVALID_CURSOR: 400,
        CURSOR_STALE: 409,
        LIMIT_EXCEEDED: 400,
        REVISION_CONFLICT: 409,
        READ_CONFLICT: 503,
        IDEMPOTENCY_CONFLICT: 409,
        PREVIEW_REQUIRED: 409,
        PREVIEW_STALE: 409,
        MENU_MANAGEMENT_PREVIEW_CONFLICT: 409,
        ROLE_NOT_FOUND: 404,
        ROLE_ALREADY_EXISTS: 409,
        ROLE_IN_USE: 409,
        CIRCULAR_INHERITANCE: 409,
        MENU_NOT_FOUND: 404,
        MENU_ALREADY_EXISTS: 409,
        MENU_HIERARCHY_INVALID: 400,
        DEPENDENCY_EXISTS: 409,
        API_BINDING_NOT_FOUND: 404,
        API_BINDING_ALREADY_EXISTS: 409,
        AUDIT_ENTRY_NOT_FOUND: 404,
        STALE_REFERENCE: 409,
        DATA_OPERATION_UNSUPPORTED: 400,
        DATA_VALUE_UNSUPPORTED: 400,
        FIELD_PERMISSION_DENIED: 403,
        SCOPE_FIELD_MAPPING_REQUIRED: 500,
        DATA_BULK_SCOPE_MUTATION_UNSAFE: 400,
        VEXT_MONSQLIZE_REQUIRED: 500,
        VEXT_MONSQLIZE_INCOMPATIBLE: 500,
        VEXT_AUTH_REQUIRED: 401,
        VEXT_APP_EXTENSION_CONFLICT: 500,
        VEXT_AUTH_EXTENSION_CONFLICT: 500,
        VEXT_ROUTE_PERMISSION_INVALID: 500,
        VEXT_ROUTE_RESTART_REQUIRED: 503,
        DATABASE_ERROR: 500,
        TRANSACTION_FAILED: 500,
        INDEX_CONFLICT: 500,
    } satisfies Record<PermissionCoreErrorCode, number>;

    function detailsFor(code: PermissionCoreErrorCode): PermissionCoreErrorDetails | undefined {
        switch (code) {
            case "CORE_CLOSE_TIMEOUT":
                return { kind: "close-timeout", timeoutMs: 100, activeOperationLeases: 1, activeBorrowedTransactions: 0 };
            case "LIMIT_EXCEEDED":
                return { kind: "limit-exceeded", origin: "caller-input", limitName: "items", current: 2, max: 1, unit: "items" };
            case "DATA_VALUE_UNSUPPORTED":
                return { kind: "data-value-unsupported", origin: "caller-input", valueType: "function" };
            case "PREVIEW_REQUIRED":
                return { kind: "preview-required", reason: "capacity-risk", previewMethod: "roles.previewRuleChange", affectedTotal: 2, affectedDigest: "digest" };
            case "MENU_MANAGEMENT_PREVIEW_CONFLICT":
                return {
                    kind: "menu-management-preview-conflict",
                    configId: "admin",
                    changeDigest: "sha256:test",
                    conflicts: { total: 0, items: [], truncated: false, digest: "sha256:conflicts" },
                    warnings: { total: 0, items: [], truncated: false, digest: "sha256:warnings" },
                    operations: { total: 0, items: [], truncated: false, digest: "sha256:operations" },
                };
            case "SCHEMA_VERSION_MISMATCH":
                return { kind: "schema-version-mismatch", expected: 2, current: 1, scopeHash: "scope" };
            case "SCHEMA_CONTRACT_MISMATCH":
                return { kind: "schema-contract-mismatch", expected: "a", current: "b", scopeHash: "scope" };
            case "PERSISTED_STATE_INVALID":
                return { kind: "persisted-state-invalid", reason: "corrupt" };
            case "REVISION_CONFLICT":
                return { kind: "revision-conflict", owner: "scope" };
            case "READ_CONFLICT":
                return { kind: "read-conflict", owner: "scope" };
            case "PREVIEW_STALE":
                return { kind: "preview-stale", owner: "scope" };
            case "CURSOR_STALE":
                return { kind: "cursor-stale", owner: "scope" };
            case "DATABASE_UNAVAILABLE":
            case "DATABASE_ERROR":
            case "TRANSACTION_FAILED":
            case "INDEX_CONFLICT":
                return { kind: "database-failure", stage: "read" };
            case "AUDIT_ENTRY_NOT_FOUND":
                return { kind: "audit-lookup", by: "auditId" };
            default:
                return undefined;
        }
    }

    it("exhaustively maps every error code and discriminator-dependent branch", () => {
        for (const [code, status] of Object.entries(expectedStatus) as Array<[PermissionCoreErrorCode, number]>) {
            expect(vextPermissionHttpStatus({ code, details: detailsFor(code), retryable: false }), code).toBe(status);
        }
        expect(vextPermissionHttpStatus({
            code: "LIMIT_EXCEEDED",
            details: { kind: "limit-exceeded", origin: "persisted-authorization-state", limitName: "roles", current: 2, max: 1, unit: "items" },
            retryable: false,
        })).toBe(503);
        expect(vextPermissionHttpStatus({
            code: "DATA_VALUE_UNSUPPORTED",
            details: { kind: "data-value-unsupported", origin: "persisted-data-state", valueType: "symbol" },
            retryable: false,
        })).toBe(503);
        expect(vextPermissionHttpStatus({ code: "DATABASE_ERROR", details: detailsFor("DATABASE_ERROR"), retryable: true })).toBe(503);
        expect(vextPermissionHttpStatus({ code: "TRANSACTION_FAILED", details: detailsFor("TRANSACTION_FAILED"), retryable: true })).toBe(503);
        expect(vextPermissionHttpStatus("REVISION_CONFLICT")).toBe(500);
        expect(vextPermissionHttpStatus("DATABASE_UNAVAILABLE")).toBe(500);
    });

    it("preserves the public error contract without exposing 500 messages", async () => {

        const mapped = await mapVextPermissionError({
            error: new PermissionCoreError("VEXT_APP_EXTENSION_CONFLICT", "secret internal detail"),
            status: 500,
            body: { code: 500 },
            requestId: "req-1",
        });
        expect(mapped).toEqual({
            status: 500,
            body: {
                code: "VEXT_APP_EXTENSION_CONFLICT",
                message: "Internal Server Error",
                retryable: false,
                requestId: "req-1",
            },
        });
        expect(await mapVextPermissionError({
            error: new Error("unknown"),
            status: 500,
            body: { code: 500 },
            requestId: "req-2",
        })).toBeUndefined();

        const authError = new PermissionCoreError("VEXT_AUTH_REQUIRED", "Authentication required", {
            details: { kind: "validation", field: "req.auth", reason: "missing" },
            operationId: "op-auth",
        });
        let converted: unknown;
        try {
            throwVextPermissionError(fakeApp() as never, authError);
        } catch (error) {
            converted = error;
        }
        expect(converted).toBeInstanceOf(Error);
        expect(await mapVextPermissionError({
            error: converted as Error,
            status: 401,
            body: {},
            requestId: "req-auth",
        })).toEqual({
            status: 401,
            body: {
                code: "VEXT_AUTH_REQUIRED",
                message: "Authentication required",
                retryable: false,
                details: { kind: "validation", field: "req.auth", reason: "missing" },
                operationId: "op-auth",
                requestId: "req-auth",
            },
        });

        const committed = new PermissionCoreError("REVISION_CONFLICT", "revision changed", {
            details: { kind: "revision-conflict", owner: "scope" },
            committed: true,
            operationId: "op-committed",
        });
        expect(await mapVextPermissionError({
            error: committed,
            status: 409,
            body: {},
            requestId: "req-committed",
        })).toMatchObject({
            status: 409,
            body: { committed: true, operationId: "op-committed", requestId: "req-committed" },
        });
    });

    it("preserves non-permission throws and detects broken app.throw implementations", async () => {
        const ordinary = new Error("ordinary failure");
        expect(() => throwVextPermissionError(fakeApp() as never, ordinary)).toThrow(ordinary);

        const permissionError = new PermissionCoreError("VEXT_AUTH_REQUIRED", "Authentication required");
        expect(() => throwVextPermissionError({ throw: () => undefined } as never, permissionError))
            .toThrowError("Vext app.throw() returned instead of throwing");

        let primitive: unknown;
        try {
            throwVextPermissionError({
                throw() {
                    throw "primitive";
                },
            } as never, permissionError);
        } catch (error) {
            primitive = error;
        }
        expect(primitive).toBe("primitive");
        expect(await mapVextPermissionError({
            error: primitive as never,
            status: 500,
            body: {},
            requestId: "req-primitive",
        })).toBeUndefined();
    });
});
