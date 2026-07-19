import {
    createHmac,
    hkdfSync,
    timingSafeEqual,
} from "node:crypto";
import type { PolicyValue } from "../types";
import { PermissionCoreError } from "../core/errors";
import { canonicalString } from "./canonical";

export type SignedTokenPurpose = "pc:v2:manager-cursor" | "pc:v2:preview" | "pc:v2:stale-reference-cursor";

const TOKEN_PART = /^[A-Za-z0-9_-]+$/u;

function invalidToken(code: "INVALID_CURSOR" | "PREVIEW_STALE", reason: string): never {
    if (code === "INVALID_CURSOR") {
        throw new PermissionCoreError(code, "The cursor is invalid.", {
            details: { kind: "validation", field: "cursor", reason },
        });
    }
    throw new PermissionCoreError(code, "The preview is stale.", {
        details: { kind: "preview-stale", owner: "preview-token", expected: "valid", current: reason },
    });
}

function asRecord(value: unknown, code: "INVALID_CURSOR" | "PREVIEW_STALE") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        invalidToken(code, "payload-shape");
    }
    return value as Readonly<Record<string, PolicyValue>>;
}

export class SignedTokenCodec {
    private readonly keys = new Map<SignedTokenPurpose, Buffer>();

    constructor(
        private readonly secret: Uint8Array,
        private readonly coreNamespaceHash: string,
    ) {}

    private key(purpose: SignedTokenPurpose) {
        const existing = this.keys.get(purpose);
        if (existing) {
            return existing;
        }
        const key = Buffer.from(hkdfSync(
            "sha256",
            this.secret,
            Buffer.alloc(0),
            Buffer.from(purpose, "utf8"),
            32,
        ));
        this.keys.set(purpose, key);
        return key;
    }

    encode(purpose: SignedTokenPurpose, payload: Readonly<Record<string, PolicyValue>>) {
        const body = canonicalString({
            version: 2,
            purpose,
            coreNamespaceHash: this.coreNamespaceHash,
            ...payload,
        });
        const encoded = Buffer.from(body, "utf8").toString("base64url");
        const signature = createHmac("sha256", this.key(purpose)).update(encoded).digest("base64url");
        return `${encoded}.${signature}`;
    }

    decode(
        token: unknown,
        purpose: SignedTokenPurpose,
        code: "INVALID_CURSOR" | "PREVIEW_STALE",
        maxBytes: number,
    ) {
        if (typeof token !== "string" || token.length === 0 || Buffer.byteLength(token, "utf8") > maxBytes) {
            invalidToken(code, "token-size");
        }
        const parts = token.split(".");
        if (parts.length !== 2 || parts.some((part) => !TOKEN_PART.test(part))) {
            invalidToken(code, "token-format");
        }
        const [encoded, signature] = parts as [string, string];
        const expected = createHmac("sha256", this.key(purpose)).update(encoded).digest();
        const actual = Buffer.from(signature, "base64url");
        if (
            actual.toString("base64url") !== signature
            || actual.byteLength !== expected.byteLength
            || !timingSafeEqual(actual, expected)
        ) {
            invalidToken(code, "token-mac");
        }

        let decoded: unknown;
        let text: string;
        try {
            text = Buffer.from(encoded, "base64url").toString("utf8");
            decoded = JSON.parse(text);
        } catch {
            invalidToken(code, "token-payload");
        }
        const record = asRecord(decoded, code);
        if (
            canonicalString(record) !== text
            || record.version !== 2
            || record.purpose !== purpose
            || record.coreNamespaceHash !== this.coreNamespaceHash
        ) {
            invalidToken(code, "token-binding");
        }
        return record;
    }
}
