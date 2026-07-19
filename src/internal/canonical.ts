import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import { isWellFormedUnicode } from "./unicode";

export const CANONICAL_CONTRACT_VERSION = "pc-canonical-v2";
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export class CanonicalEncodingError extends TypeError {
    constructor(message: string) {
        super(message);
        this.name = "CanonicalEncodingError";
    }
}

export class CanonicalByteLimitError extends CanonicalEncodingError {
    readonly current: number;
    readonly max: number;

    constructor(current: number, max: number) {
        super(`Canonical form exceeds ${max} UTF-8 bytes.`);
        this.name = "CanonicalByteLimitError";
        this.current = current;
        this.max = max;
    }
}

export function compareUtf8(left: string, right: string) {
    if (!isWellFormedUnicode(left) || !isWellFormedUnicode(right)) {
        throw new CanonicalEncodingError("UTF-8 comparison requires well-formed Unicode strings.");
    }
    return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

type CanonicalWriter = (chunk: string) => void;

function writeJsonString(value: string, write: CanonicalWriter) {
    write("\"");
    let chunk = "";
    const flush = () => {
        if (chunk) {
            write(chunk);
            chunk = "";
        }
    };

    for (const character of value) {
        const codePoint = character.codePointAt(0) as number;
        let escaped: string | undefined;
        if (character === "\"") {
            escaped = "\\\"";
        } else if (character === "\\") {
            escaped = "\\\\";
        } else if (character === "\b") {
            escaped = "\\b";
        } else if (character === "\f") {
            escaped = "\\f";
        } else if (character === "\n") {
            escaped = "\\n";
        } else if (character === "\r") {
            escaped = "\\r";
        } else if (character === "\t") {
            escaped = "\\t";
        } else if (codePoint < 0x20) {
            escaped = `\\u${codePoint.toString(16).padStart(4, "0")}`;
        }

        if (escaped) {
            flush();
            write(escaped);
            continue;
        }
        chunk += character;
        if (chunk.length >= 4096) {
            flush();
        }
    }
    flush();
    write("\"");
}

function writeCanonical(
    value: unknown,
    ancestors: Set<object>,
    path: string,
    write: CanonicalWriter,
): void {
    if (value === null) {
        write("null");
        return;
    }
    if (typeof value === "string") {
        if (!isWellFormedUnicode(value)) {
            throw new CanonicalEncodingError(`${path} contains an unpaired UTF-16 surrogate.`);
        }
        writeJsonString(value, write);
        return;
    }
    if (typeof value === "boolean") {
        write(JSON.stringify(value));
        return;
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new CanonicalEncodingError(`${path} contains a non-finite number.`);
        }
        write(Object.is(value, -0) ? "0" : JSON.stringify(value));
        return;
    }
    if (typeof value !== "object") {
        throw new CanonicalEncodingError(`${path} contains unsupported ${typeof value}.`);
    }
    if (utilTypes.isProxy(value)) {
        throw new CanonicalEncodingError(`${path} cannot be a Proxy.`);
    }
    if (ancestors.has(value)) {
        throw new CanonicalEncodingError(`${path} contains a cycle.`);
    }

    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            const ownKeys = Reflect.ownKeys(value);
            const indexKeys: string[] = [];
            for (const key of ownKeys) {
                if (key === "length") {
                    continue;
                }
                if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length) {
                    throw new CanonicalEncodingError(`${path} contains a non-index array property.`);
                }
                const descriptor = Object.getOwnPropertyDescriptor(value, key);
                if (!descriptor?.enumerable || !("value" in descriptor)) {
                    throw new CanonicalEncodingError(`${path}[${key}] must be an enumerable data property.`);
                }
                indexKeys.push(key);
            }
            if (indexKeys.length !== value.length) {
                throw new CanonicalEncodingError(`${path} cannot be a sparse array.`);
            }
            write("[");
            for (let index = 0; index < value.length; index += 1) {
                if (index > 0) {
                    write(",");
                }
                writeCanonical(value[index], ancestors, `${path}[${index}]`, write);
            }
            write("]");
            return;
        }

        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new CanonicalEncodingError(`${path} must be a plain object.`);
        }

        const keys = Reflect.ownKeys(value);
        if (keys.some((key) => typeof key !== "string")) {
            throw new CanonicalEncodingError(`${path} cannot contain symbol keys.`);
        }

        const stringKeys = keys as string[];
        for (const key of stringKeys) {
            if (!isWellFormedUnicode(key)) {
                throw new CanonicalEncodingError(`${path} contains an unpaired UTF-16 surrogate in an object key.`);
            }
            if (FORBIDDEN_KEYS.has(key)) {
                throw new CanonicalEncodingError(`${path} contains forbidden key ${key}.`);
            }
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor?.enumerable || !("value" in descriptor)) {
                throw new CanonicalEncodingError(`${path}.${key} must be an enumerable data property.`);
            }
        }

        stringKeys.sort(compareUtf8);
        write("{");
        for (let index = 0; index < stringKeys.length; index += 1) {
            const key = stringKeys[index];
            if (index > 0) {
                write(",");
            }
            writeJsonString(key, write);
            write(":");
            writeCanonical((value as Record<string, unknown>)[key], ancestors, `${path}.${key}`, write);
        }
        write("}");
    } finally {
        ancestors.delete(value);
    }
}

export function canonicalString(value: unknown) {
    const chunks: string[] = [];
    writeCanonical(value, new Set(), "$", (chunk) => chunks.push(chunk));
    return chunks.join("");
}

export function canonicalByteLength(value: unknown, maxBytes = Number.POSITIVE_INFINITY) {
    if (!(maxBytes === Number.POSITIVE_INFINITY || (Number.isSafeInteger(maxBytes) && maxBytes >= 0))) {
        throw new TypeError("maxBytes must be a non-negative safe integer or Infinity.");
    }
    let bytes = 0;
    writeCanonical(value, new Set(), "$", (chunk) => {
        bytes += Buffer.byteLength(chunk, "utf8");
        if (bytes > maxBytes) {
            throw new CanonicalByteLimitError(bytes, maxBytes);
        }
    });
    return bytes;
}

export function canonicalBytes(value: unknown) {
    return Buffer.from(canonicalString(value), "utf8");
}

export function sha256Base64Url(bytes: Uint8Array) {
    if (utilTypes.isProxy(bytes) || !(bytes instanceof Uint8Array)) {
        throw new CanonicalEncodingError("SHA-256 input must be a non-Proxy Uint8Array.");
    }
    const digest = createHash("sha256").update(bytes).digest("base64url");
    if (!/^[A-Za-z0-9_-]{43}$/.test(digest)) {
        throw new Error("SHA-256 base64url output violated the canonical digest contract.");
    }
    return digest;
}

export function digestCanonical(value: unknown) {
    return sha256Base64Url(canonicalBytes(value));
}
