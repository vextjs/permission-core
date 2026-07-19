import { types as utilTypes } from "node:util";
import { isWellFormedUnicode } from "./unicode";

export const MAX_BSON_DOCUMENT_DEPTH = 100;

export class BsonEncodingError extends TypeError {
    constructor(message: string) {
        super(message);
        this.name = "BsonEncodingError";
    }
}

export class BsonByteLimitError extends BsonEncodingError {
    readonly current: number;
    readonly max: number;

    constructor(current: number, max: number) {
        super(`BSON document exceeds ${max} bytes.`);
        this.name = "BsonByteLimitError";
        this.current = current;
        this.max = max;
    }
}

interface BsonByteBudget {
    used: number;
    readonly max: number;
}

function consume(budget: BsonByteBudget, bytes: number) {
    budget.used += bytes;
    if (budget.used > budget.max) {
        throw new BsonByteLimitError(budget.used, budget.max);
    }
}

function assertBsonKey(key: string, path: string) {
    if (!isWellFormedUnicode(key)) {
        throw new BsonEncodingError(`${path} contains malformed Unicode in a field name.`);
    }
    if (key.includes("\u0000")) {
        throw new BsonEncodingError(`${path} contains a NUL byte in a BSON field name.`);
    }
}

function writeElement(
    key: string,
    value: unknown,
    path: string,
    depth: number,
    ancestors: Set<object>,
    budget: BsonByteBudget,
) {
    assertBsonKey(key, path);
    consume(budget, 1 + Buffer.byteLength(key, "utf8") + 1);

    if (value === null) {
        return;
    }
    if (typeof value === "boolean") {
        consume(budget, 1);
        return;
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new BsonEncodingError(`${path} contains a non-finite number.`);
        }
        const usesInt32 = Number.isInteger(value)
            && value >= -2_147_483_648
            && value <= 2_147_483_647;
        consume(budget, usesInt32 ? 4 : 8);
        return;
    }
    if (typeof value === "string") {
        if (!isWellFormedUnicode(value)) {
            throw new BsonEncodingError(`${path} contains malformed Unicode.`);
        }
        consume(budget, 4 + Buffer.byteLength(value, "utf8") + 1);
        return;
    }
    if (typeof value !== "object") {
        throw new BsonEncodingError(`${path} contains unsupported ${typeof value}.`);
    }
    writeDocument(value, path, depth, ancestors, budget, true);
}

function writeDocument(
    value: object,
    path: string,
    depth: number,
    ancestors: Set<object>,
    budget: BsonByteBudget,
    allowArray: boolean,
) {
    if (utilTypes.isProxy(value)) {
        throw new BsonEncodingError(`${path} cannot be a Proxy.`);
    }
    if (depth > MAX_BSON_DOCUMENT_DEPTH) {
        throw new BsonEncodingError(`${path} exceeds BSON nesting depth ${MAX_BSON_DOCUMENT_DEPTH}.`);
    }
    if (ancestors.has(value)) {
        throw new BsonEncodingError(`${path} contains a cycle.`);
    }

    const isArray = Array.isArray(value);
    if (isArray && !allowArray) {
        throw new BsonEncodingError(`${path} must be a plain BSON document.`);
    }
    if (!isArray) {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new BsonEncodingError(`${path} must be a plain BSON document.`);
        }
    }

    ancestors.add(value);
    consume(budget, 4);
    try {
        if (isArray) {
            const length = (Object.getOwnPropertyDescriptor(value, "length") as PropertyDescriptor).value as number;
            const descriptors = new Map<number, PropertyDescriptor>();
            for (const key of Reflect.ownKeys(value)) {
                if (key === "length") {
                    continue;
                }
                if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length) {
                    throw new BsonEncodingError(`${path} contains a non-index array property.`);
                }
                const descriptor = Object.getOwnPropertyDescriptor(value, key);
                if (!descriptor?.enumerable || !("value" in descriptor)) {
                    throw new BsonEncodingError(`${path}[${key}] must be an enumerable data property.`);
                }
                descriptors.set(Number(key), descriptor);
            }
            if (descriptors.size !== length) {
                throw new BsonEncodingError(`${path} cannot be a sparse array.`);
            }
            for (let index = 0; index < length; index += 1) {
                writeElement(
                    String(index),
                    (descriptors.get(index) as PropertyDescriptor).value,
                    `${path}[${index}]`,
                    depth + 1,
                    ancestors,
                    budget,
                );
            }
        } else {
            for (const key of Reflect.ownKeys(value)) {
                if (typeof key !== "string") {
                    throw new BsonEncodingError(`${path} cannot contain symbol keys.`);
                }
                const descriptor = Object.getOwnPropertyDescriptor(value, key);
                if (!descriptor?.enumerable || !("value" in descriptor)) {
                    throw new BsonEncodingError(`${path}.${key} must be an enumerable data property.`);
                }
                writeElement(key, descriptor.value, `${path}.${key}`, depth + 1, ancestors, budget);
            }
        }
    } finally {
        ancestors.delete(value);
    }
    consume(budget, 1);
}

export function bsonDocumentByteLengthUpperBound(
    value: unknown,
    maxBytes = Number.POSITIVE_INFINITY,
) {
    if (!(maxBytes === Number.POSITIVE_INFINITY || (Number.isSafeInteger(maxBytes) && maxBytes >= 0))) {
        throw new TypeError("maxBytes must be a non-negative safe integer or Infinity.");
    }
    if (value === null || typeof value !== "object") {
        throw new BsonEncodingError("$ must be a plain BSON document.");
    }
    const budget: BsonByteBudget = { used: 0, max: maxBytes };
    writeDocument(value, "$", 0, new Set(), budget, false);
    return budget.used;
}
