import { describe, expect, it } from "vitest";
import {
    isPermissionCoreError,
    PermissionCoreError,
} from "../../src/core/errors";

const ERROR_BRAND = Symbol.for("permission-core.error.v2");

describe("PermissionCoreError runtime identity", () => {
    it("recognizes local and independently bundled branded errors", () => {
        const local = new PermissionCoreError("PERMISSION_DENIED", "Denied");
        const foreign = new Error("Conflict") as Error & { code: string };
        foreign.code = "ROLE_ALREADY_EXISTS";
        Object.defineProperty(foreign, ERROR_BRAND, {
            value: true,
            enumerable: false,
            writable: false,
            configurable: false,
        });

        expect(isPermissionCoreError(local)).toBe(true);
        expect(isPermissionCoreError(foreign)).toBe(true);
    });

    it("rejects unbranded and enumerable-brand lookalikes", () => {
        const lookalike = Object.assign(new Error("Denied"), {
            name: "PermissionCoreError",
            code: "PERMISSION_DENIED",
        });
        const enumerableBrand = Object.assign(new Error("Denied"), {
            code: "PERMISSION_DENIED",
            [ERROR_BRAND]: true,
        });

        expect(isPermissionCoreError(lookalike)).toBe(false);
        expect(isPermissionCoreError(enumerableBrand)).toBe(false);
        expect(isPermissionCoreError({ code: "PERMISSION_DENIED", [ERROR_BRAND]: true })).toBe(false);
    });

    it("requires structured details for menu management preview conflicts", () => {
        expect(() => new PermissionCoreError("MENU_MANAGEMENT_PREVIEW_CONFLICT", "conflict"))
            .toThrow(TypeError);

        const error = new PermissionCoreError("MENU_MANAGEMENT_PREVIEW_CONFLICT", "conflict", {
            details: {
                kind: "menu-management-preview-conflict",
                configId: "admin",
                changeDigest: "sha256:test",
                conflicts: { total: 0, items: [], truncated: false, digest: "sha256:conflicts" },
                warnings: { total: 0, items: [], truncated: false, digest: "sha256:warnings" },
                operations: {
                    total: 1,
                    items: [{ operation: "menu.remove", targetId: "orders", outcome: "removed" }],
                    truncated: false,
                    digest: "sha256:operations",
                },
            },
        });

        expect(error.details).toMatchObject({
            kind: "menu-management-preview-conflict",
            configId: "admin",
        });
    });
});
