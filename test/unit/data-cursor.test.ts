import { describe, expect, it } from "vitest";
import { PermissionCoreError } from "../../src/core/errors";
import { DataCursorCodec } from "../../src/data/cursor";

describe("DataCursorCodec", () => {
    it("uses unique authenticated ciphertext and binds both secret and namespace AAD", () => {
        const payload = {
            purpose: "probe",
            anchor: [{ path: "sequence", type: "number", value: { tag: "number", value: 1 } }],
        } as const;
        const codec = new DataCursorCodec(Buffer.from("data-cursor-secret-a"), "namespace-a");
        const first = codec.encode(payload);
        const second = codec.encode(payload);

        expect(first).not.toBe(second);
        expect(first).not.toContain("sequence");
        expect(codec.decode(first)).toEqual(payload);
        expect(() => new DataCursorCodec(Buffer.from("data-cursor-secret-b"), "namespace-a").decode(first)).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "INVALID_CURSOR" }),
        );
        expect(() => new DataCursorCodec(Buffer.from("data-cursor-secret-a"), "namespace-b").decode(first)).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "INVALID_CURSOR" }),
        );
        const tampered = `${first.slice(0, -1)}${first.endsWith("A") ? "B" : "A"}`;
        expect(() => codec.decode(tampered)).toThrowError(
            expect.objectContaining<Partial<PermissionCoreError>>({ code: "INVALID_CURSOR" }),
        );
    });
});
