import { createHmac, hkdfSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";
import { SignedTokenCodec } from "../../src/internal/signed-token";
import { normalizePreviewExecutionOptions } from "../../src/rbac/preview-inputs";
import { issuePreviewToken, validatePreviewExecution } from "../../src/rbac/preview-token";
import { RbacQueryService } from "../../src/rbac/queries";
import { RbacPreviewService } from "../../src/rbac/preview";
import type { RbacScopeReader } from "../../src/rbac/store";
import type { PermissionRepository } from "../../src/persistence/repository";
import type { RoleMutationService } from "../../src/rbac/role-mutations";
import type { RuleMutationService } from "../../src/rbac/rule-mutations";

const secret = new Uint8Array(Buffer.from("permission-core-token-contract-secret-32-bytes", "utf8"));
const namespaceHash = "namespace-hash-for-token-contract";

function signRawToken(purpose: "pc:v2:manager-cursor" | "pc:v2:preview", body: string) {
    const encoded = Buffer.from(body, "utf8").toString("base64url");
    const key = Buffer.from(hkdfSync(
        "sha256",
        secret,
        Buffer.alloc(0),
        Buffer.from(purpose, "utf8"),
        32,
    ));
    const signature = createHmac("sha256", key).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
}

function expectedRevisions() {
    return {
        global: 1,
        rbac: 1,
        entities: [{ kind: "role" as const, id: "reader", revision: 1 }],
    };
}

function queryFixture() {
    const codec = new SignedTokenCodec(secret, namespaceHash);
    const service = new RbacQueryService(
        {} as PermissionRepository,
        new ResourceSchemeRegistry(),
        codec,
    );
    const reader = {
        state: { scopeKey: "scope-key", rbacRevision: 3 },
    } as unknown as RbacScopeReader;
    const readCursor = (service as unknown as {
        readCursor(token: string, method: string, reader: RbacScopeReader, queryHash: string): unknown;
    }).readCursor.bind(service);
    return { codec, readCursor, reader };
}

describe("RBAC signed token contracts", () => {
    it("rejects malformed token size, syntax, JSON, and payload shapes", () => {
        const codec = new SignedTokenCodec(secret, namespaceHash);
        const decode = (token: unknown) => codec.decode(
            token,
            "pc:v2:manager-cursor",
            "INVALID_CURSOR",
            64,
        );
        const malformed: readonly unknown[] = [
            null,
            "",
            "x".repeat(65),
            "one-part",
            "a.b.c",
            "a.+",
            signRawToken("pc:v2:manager-cursor", "{"),
            signRawToken("pc:v2:manager-cursor", "null"),
            signRawToken("pc:v2:manager-cursor", "[]"),
        ];

        for (const token of malformed) {
            expect(() => decode(token)).toThrowError(expect.objectContaining({ code: "INVALID_CURSOR" }));
        }
    });

    it("rejects a correctly signed token bound to another core namespace", () => {
        const issuer = new SignedTokenCodec(secret, "other-namespace");
        const verifier = new SignedTokenCodec(secret, namespaceHash);
        const token = issuer.encode("pc:v2:manager-cursor", { anchor: "a" });

        expect(() => verifier.decode(
            token,
            "pc:v2:manager-cursor",
            "INVALID_CURSOR",
            8 * 1024,
        )).toThrowError(expect.objectContaining({ code: "INVALID_CURSOR" }));
    });

    it("rejects non-canonical Base64URL aliases of an unchanged signature", () => {
        const codec = new SignedTokenCodec(secret, namespaceHash);
        const token = codec.encode("pc:v2:manager-cursor", { anchor: "a" });
        const [body, signature] = token.split(".") as [string, string];
        const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        const canonicalIndex = alphabet.indexOf(signature.at(-1)!);
        const alias = alphabet[(canonicalIndex & 0b11_1100) | 0b00_0001]!;
        const nonCanonicalSignature = `${signature.slice(0, -1)}${alias}`;

        expect(Buffer.from(nonCanonicalSignature, "base64url"))
            .toEqual(Buffer.from(signature, "base64url"));
        expect(() => codec.decode(
            `${body}.${nonCanonicalSignature}`,
            "pc:v2:manager-cursor",
            "INVALID_CURSOR",
            8 * 1024,
        )).toThrowError(expect.objectContaining({ code: "INVALID_CURSOR" }));
    });

    it("keeps manager, stale-reference, and preview purpose keys isolated", () => {
        const codec = new SignedTokenCodec(secret, namespaceHash);
        const manager = codec.encode("pc:v2:manager-cursor", { anchor: "a" });
        const stale = codec.encode("pc:v2:stale-reference-cursor", { anchor: "a" });
        const preview = codec.encode("pc:v2:preview", { anchor: "a" });

        expect(() => codec.decode(manager, "pc:v2:preview", "PREVIEW_STALE", 16 * 1024)).toThrowError(
            expect.objectContaining({ code: "PREVIEW_STALE" }),
        );
        expect(() => codec.decode(preview, "pc:v2:manager-cursor", "INVALID_CURSOR", 8 * 1024)).toThrowError(
            expect.objectContaining({ code: "INVALID_CURSOR" }),
        );
        expect(() => codec.decode(manager, "pc:v2:stale-reference-cursor", "INVALID_CURSOR", 8 * 1024)).toThrowError(
            expect.objectContaining({ code: "INVALID_CURSOR" }),
        );
        expect(() => codec.decode(stale, "pc:v2:manager-cursor", "INVALID_CURSOR", 8 * 1024)).toThrowError(
            expect.objectContaining({ code: "INVALID_CURSOR" }),
        );
    });

    it("rejects a validly signed manager cursor issued in the future", () => {
        const { codec, readCursor, reader } = queryFixture();
        const now = Date.now();
        const token = codec.encode("pc:v2:manager-cursor", {
            method: "roles.list",
            scopeKey: "scope-key",
            queryHash: "query-hash",
            rbacRevision: 3,
            anchor: { roleId: "reader" },
            issuedAt: now + 60_000,
            expiresAt: now + 60_000 + 15 * 60 * 1_000,
        });
        expect(() => readCursor(token, "roles.list", reader, "query-hash")).toThrowError(
            expect.objectContaining({ code: "CURSOR_STALE" }),
        );
    });

    it("rejects a validly signed cursor with a non-exact method anchor", () => {
        const { codec, readCursor, reader } = queryFixture();
        const now = Date.now();
        const anchors: readonly Readonly<Record<string, string>>[] = [
            { roleId: " reader " },
            { roleId: "reader", extra: "unexpected" },
        ];
        for (const anchor of anchors) {
            const token = codec.encode("pc:v2:manager-cursor", {
                method: "roles.list",
                scopeKey: "scope-key",
                queryHash: "query-hash",
                rbacRevision: 3,
                anchor,
                issuedAt: now,
                expiresAt: now + 15 * 60 * 1_000,
            });
            expect(() => readCursor(token, "roles.list", reader, "query-hash")).toThrowError(
                expect.objectContaining({ code: "INVALID_CURSOR" }),
            );
        }
    });

    it("treats expiresAt as an exclusive manager cursor boundary", () => {
        vi.useFakeTimers();
        try {
            const now = 2_000_000;
            vi.setSystemTime(now);
            const { codec, readCursor, reader } = queryFixture();
            const token = codec.encode("pc:v2:manager-cursor", {
                method: "roles.list",
                scopeKey: "scope-key",
                queryHash: "query-hash",
                rbacRevision: 3,
                anchor: { roleId: "reader" },
                issuedAt: now - 15 * 60 * 1_000,
                expiresAt: now,
            });
            expect(() => readCursor(token, "roles.list", reader, "query-hash")).toThrowError(
                expect.objectContaining({ code: "CURSOR_STALE" }),
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it("treats expiresAt as an exclusive preview token boundary", () => {
        const codec = new SignedTokenCodec(secret, namespaceHash);
        const service = new RbacPreviewService(
            {} as PermissionRepository,
            new ResourceSchemeRegistry(),
            codec,
            {} as RoleMutationService,
            {} as RuleMutationService,
        );
        const now = 3_000_000;
        const expected = expectedRevisions();
        const token = codec.encode("pc:v2:preview", {
            method: "roles.previewAccessUpdate",
            actorId: "admin",
            scopeKey: "scope-key",
            inputHash: "input-hash",
            planHash: "plan-hash",
            capacityDigest: "capacity-digest",
            expectedRevisions: expected,
            issuedAt: now - 5 * 60 * 1_000,
            expiresAt: now,
        });
        const validate = (service as unknown as {
            validateExecution(method: string, reader: RbacScopeReader, envelope: unknown, options: unknown, now: number): void;
        }).validateExecution.bind(service);
        const reader = { state: { scopeKey: "scope-key" } } as unknown as RbacScopeReader;

        expect(() => validate(
            "roles.previewAccessUpdate",
            reader,
            {
                inputHash: "input-hash",
                planHash: "plan-hash",
                expectedRevisions: expected,
                capacity: { digest: "capacity-digest", disposition: "safe" },
            },
            { actorId: "admin", expectedRevisions: expected, previewToken: token },
            now,
        )).toThrowError(expect.objectContaining({ code: "PREVIEW_STALE" }));
    });

    it("accepts a 16 KiB preview token input and rejects one byte over", () => {
        expect(normalizePreviewExecutionOptions({
            expectedRevisions: expectedRevisions(),
            previewToken: "x".repeat(16 * 1024),
        }, "reader").previewToken).toHaveLength(16 * 1024);

        expect(() => normalizePreviewExecutionOptions({
            expectedRevisions: expectedRevisions(),
            previewToken: "x".repeat(16 * 1024 + 1),
        }, "reader")).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    });

    it("rejects capacity acknowledgement when the bound assessment is safe", () => {
        const codec = new SignedTokenCodec(secret, namespaceHash);
        const now = 4_000_000;
        const expected = expectedRevisions();
        const envelope = {
            inputHash: "input-hash",
            planHash: "plan-hash",
            capacityDigest: "capacity-digest",
            expectedRevisions: expected,
        };
        const token = issuePreviewToken({
            tokens: codec,
            method: "menus.previewSetStatus",
            actorId: "admin",
            scopeKey: "scope-key",
            envelope,
            issuedAt: now,
        });

        expect(() => validatePreviewExecution({
            tokens: codec,
            method: "menus.previewSetStatus",
            scopeKey: "scope-key",
            envelope,
            options: {
                actorId: "admin",
                previewToken: token,
                expectedRevisions: expected,
                acknowledgeCapacityRisk: true,
            },
            now: now + 1,
            capacityDisposition: "safe",
        })).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENT" }));
    });
});
