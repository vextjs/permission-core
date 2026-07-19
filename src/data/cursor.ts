import {
    createCipheriv,
    createDecipheriv,
    hkdfSync,
    randomBytes,
} from "node:crypto";
import { PermissionCoreError } from "../core/errors";

const PURPOSE = "pc:v2:data-cursor-aead";
const PREFIX = "pcd2.";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_TOKEN_BYTES = 8 * 1024;

function invalid(reason: string, cause?: unknown): never {
    throw new PermissionCoreError("INVALID_CURSOR", `Invalid data cursor: ${reason}.`, {
        details: { kind: "validation", field: "cursor", reason },
        cause,
    });
}

function exactPayload(value: unknown) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("payload must be an object");
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid("payload must be a plain object");
    return value as Readonly<Record<string, unknown>>;
}

export class DataCursorCodec {
    private readonly key: Buffer;
    private readonly aad: Buffer;

    constructor(secret: Uint8Array, coreNamespaceHash: string) {
        this.key = Buffer.from(hkdfSync(
            "sha256",
            Buffer.from(secret),
            Buffer.from(coreNamespaceHash, "utf8"),
            Buffer.from(PURPOSE, "utf8"),
            32,
        ));
        this.aad = Buffer.from(`${PURPOSE}\0${coreNamespaceHash}`, "utf8");
    }

    encode(payload: Readonly<Record<string, unknown>>) {
        const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
        const iv = randomBytes(IV_BYTES);
        const cipher = createCipheriv("aes-256-gcm", this.key, iv);
        cipher.setAAD(this.aad);
        const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const token = `${PREFIX}${Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString("base64url")}`;
        if (Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) invalid("token exceeds 8 KiB");
        return token;
    }

    decode(token: unknown) {
        if (typeof token !== "string" || !token.startsWith(PREFIX) || Buffer.byteLength(token, "utf8") > MAX_TOKEN_BYTES) {
            invalid("format or size is unsupported");
        }
        try {
            const wire = Buffer.from(token.slice(PREFIX.length), "base64url");
            if (wire.length <= IV_BYTES + TAG_BYTES) invalid("payload is truncated");
            const iv = wire.subarray(0, IV_BYTES);
            const tag = wire.subarray(wire.length - TAG_BYTES);
            const encrypted = wire.subarray(IV_BYTES, wire.length - TAG_BYTES);
            const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
            decipher.setAAD(this.aad);
            decipher.setAuthTag(tag);
            const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
            return exactPayload(JSON.parse(plaintext.toString("utf8")));
        } catch (error) {
            if (error instanceof PermissionCoreError) throw error;
            invalid("authentication or payload decoding failed", error);
        }
    }
}
