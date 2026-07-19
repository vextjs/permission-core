import { describe, expect, it, vi } from "vitest";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";
import { SignedTokenCodec } from "../../src/internal/signed-token";
import { RbacQueryService } from "../../src/rbac/queries";
import type { PolicyValue } from "../../src/types/foundation";

const secret = new Uint8Array(Buffer.from("rbac-query-boundary-secret-32-bytes!!", "utf8"));
const scope = { tenantId: "tenant-a" } as const;

function fixture() {
    const tokens = new SignedTokenCodec(secret, "query-boundary-namespace");
    const service = new RbacQueryService(
        { findMaxLimit: 100 } as never,
        new ResourceSchemeRegistry(),
        tokens,
    );
    const reader = {
        state: {
            scopeKey: "scope-key",
            rbacRevision: 3,
            menuRevision: 4,
            revision: 5,
            auditRevision: 6,
        },
    } as never;
    const readCursor = (service as unknown as {
        readCursor(token: string | undefined, method: string, reader: unknown, queryHash: string): unknown;
    }).readCursor.bind(service);
    const writeCursor = (service as unknown as {
        writeCursor(method: string, reader: unknown, queryHash: string, anchor: Readonly<Record<string, string>>): string;
    }).writeCursor.bind(service);
    return { service, tokens, reader, readCursor, writeCursor };
}

describe("RBAC query input guards", () => {
    it("rejects exotic role-list query records before repository I/O", async () => {
        const { service } = fixture();
        const accessor = {};
        Object.defineProperty(accessor, "first", { enumerable: true, get: () => 1 });
        const invalid = [
            [],
            new Date(),
            new Proxy({}, {}),
            { extra: true },
            accessor,
            { first: 0 },
            { first: 201 },
            { after: "" },
            { status: "archived" },
            { search: 1 },
            { search: " " },
            { search: "x".repeat(129) },
            { parentId: " __proto__ " },
        ];
        for (const query of invalid) {
            await expect(service.listRoles(scope, query as never)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        }
    });

    it("rejects malformed rule-list and basic pagination filters before opening a reader", async () => {
        const { service } = fixture();
        await expect(service.listOwnRules(scope, "reader", { effect: "audit" } as never)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        await expect(service.listOwnRules(scope, "reader", { sourceKind: "external" } as never)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
        await expect(service.listUsersByRole(scope, "reader", { first: 1, after: "" })).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    });
});

describe("RBAC manager cursor contracts", () => {
    it("round-trips each canonical cursor anchor", () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(1_000_000);
            const { reader, readCursor, writeCursor } = fixture();
            const role = writeCursor("roles.list", reader, "roles-query", { roleId: "reader" });
            const rule = writeCursor("roles.listOwnRules", reader, "rules-query", {
                effect: "allow",
                semanticKey: "x".repeat(43),
            });
            const user = writeCursor("userRoles.listUsersByRole", reader, "users-query", { userId: "user-1" });
            expect(readCursor(role, "roles.list", reader, "roles-query")).toEqual({ roleId: "reader" });
            expect(readCursor(rule, "roles.listOwnRules", reader, "rules-query")).toEqual({ effect: "allow", semanticKey: "x".repeat(43) });
            expect(readCursor(user, "userRoles.listUsersByRole", reader, "users-query")).toEqual({ userId: "user-1" });
            expect(readCursor(undefined, "roles.list", reader, "roles-query")).toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });

    it("rejects payload shape, revision binding, interval, scope, and state drift", () => {
        vi.useFakeTimers();
        try {
            const now = 2_000_000;
            vi.setSystemTime(now);
            const { tokens, reader, readCursor } = fixture();
            const encode = (overrides: Record<string, unknown> = {}) => tokens.encode("pc:v2:manager-cursor", {
                method: "roles.list",
                scopeKey: "scope-key",
                queryHash: "query",
                rbacRevision: 3,
                anchor: { roleId: "reader" },
                issuedAt: now - 1,
                expiresAt: now - 1 + 15 * 60 * 1_000,
                ...overrides,
            });
            const invalid = [
                encode({ extra: true }),
                encode({ rbacRevision: -1 }),
                encode({ menuRevision: 4 }),
                encode({ expiresAt: now + 100 }),
                encode({ method: "roles.other" }),
                encode({ scopeKey: "other" }),
                encode({ queryHash: "other" }),
                encode({ rbacRevision: 2 }),
                encode({ issuedAt: now + 1, expiresAt: now + 1 + 15 * 60 * 1_000 }),
            ];
            for (const token of invalid) expect(() => readCursor(token, "roles.list", reader, "query")).toThrow();

            const listOwnMissingMenu = encode({ method: "roles.listOwnRules", anchor: { effect: "allow", semanticKey: "x".repeat(43) } });
            expect(() => readCursor(listOwnMissingMenu, "roles.listOwnRules", reader, "query")).toThrow();
            const listOwnStaleMenu = encode({
                method: "roles.listOwnRules",
                menuRevision: 3,
                anchor: { effect: "allow", semanticKey: "x".repeat(43) },
            });
            expect(() => readCursor(listOwnStaleMenu, "roles.listOwnRules", reader, "query")).toThrow();
        } finally {
            vi.useRealTimers();
        }
    });

    it("rejects malformed and unsupported cursor anchors", () => {
        vi.useFakeTimers();
        try {
            const now = 3_000_000;
            vi.setSystemTime(now);
            const { tokens, reader, readCursor } = fixture();
            const encode = (method: string, anchor: PolicyValue, menuRevision?: number) => tokens.encode("pc:v2:manager-cursor", {
                method,
                scopeKey: "scope-key",
                queryHash: "query",
                rbacRevision: 3,
                ...(menuRevision === undefined ? {} : { menuRevision }),
                anchor,
                issuedAt: now - 1,
                expiresAt: now - 1 + 15 * 60 * 1_000,
            });
            const invalid: Array<[string, string, PolicyValue, number?]> = [
                ["roles.list", "roles.list", {}],
                ["roles.list", "roles.list", { roleId: " reader " }],
                ["roles.listOwnRules", "roles.listOwnRules", { effect: "audit", semanticKey: "x".repeat(43) }, 4],
                ["roles.listOwnRules", "roles.listOwnRules", { effect: "allow", semanticKey: "bad" }, 4],
                ["userRoles.listUsersByRole", "userRoles.listUsersByRole", { extra: true }],
                ["unknown", "unknown", { id: "value" }],
            ];
            for (const [payloadMethod, requestedMethod, anchor, menuRevision] of invalid) {
                expect(() => readCursor(encode(payloadMethod, anchor, menuRevision), requestedMethod, reader, "query")).toThrow();
            }
        } finally {
            vi.useRealTimers();
        }
    });
});
