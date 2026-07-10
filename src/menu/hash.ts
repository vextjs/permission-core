import { createHash } from "node:crypto";

function normalizeForHash(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(normalizeForHash);
    }
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .sort(([left], [right]) => left.localeCompare(right))
                .map(([key, item]) => [key, normalizeForHash(item)]),
        );
    }
    return value;
}

export function stableSerialize(value: unknown) {
    return JSON.stringify(normalizeForHash(value));
}

export function createMenuHash(value: unknown) {
    return createHash("sha256").update(stableSerialize(value)).digest("hex");
}
