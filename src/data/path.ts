import { validationError } from "../core/errors";
import { isWellFormedUnicode } from "../internal/unicode";

const SAFE_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_PATH_BYTES = 256;
const MAX_PATH_SEGMENTS = 16;

export function normalizeDataPath(value: unknown, field: string, code: "INVALID_ARGUMENT" | "INVALID_FILTER" = "INVALID_ARGUMENT") {
    if (
        typeof value !== "string"
        || !value
        || !isWellFormedUnicode(value)
        || Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES
    ) {
        throw validationError(code, field, `must be a safe path of at most ${MAX_PATH_BYTES} UTF-8 bytes`);
    }
    const segments = value.split(".");
    if (
        segments.length > MAX_PATH_SEGMENTS
        || segments.some((segment) => !SAFE_SEGMENT.test(segment) || FORBIDDEN_SEGMENTS.has(segment))
    ) {
        throw validationError(code, field, `must contain 1..${MAX_PATH_SEGMENTS} safe field segments`);
    }
    return value;
}

export function pathsOverlap(left: string, right: string) {
    return left === right || left.startsWith(`${right}.`) || right.startsWith(`${left}.`);
}

export function declaredPathClosure(paths: readonly string[]) {
    const closure = new Set<string>();
    for (const path of paths) {
        const segments = path.split(".");
        for (let length = 1; length <= segments.length; length += 1) {
            closure.add(segments.slice(0, length).join("."));
        }
    }
    return closure;
}

export function assertNonOverlappingPaths(paths: readonly string[], field: string) {
    for (let left = 0; left < paths.length; left += 1) {
        for (let right = left + 1; right < paths.length; right += 1) {
            if (pathsOverlap(paths[left], paths[right])) {
                throw validationError("INVALID_ARGUMENT", field, `contains overlapping paths ${paths[left]} and ${paths[right]}`);
            }
        }
    }
}

export interface DataPathResult {
    readonly found: boolean;
    readonly value?: unknown;
}

export function readDataPath(root: unknown, path: string): DataPathResult {
    let current = root;
    for (const segment of path.split(".")) {
        if (current === null || typeof current !== "object" || Array.isArray(current)) {
            return { found: false };
        }
        const descriptor = Object.getOwnPropertyDescriptor(current, segment);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
            return { found: false };
        }
        current = descriptor.value;
    }
    return { found: true, value: current };
}

export function writeDataPath(root: Record<string, unknown>, path: string, value: unknown) {
    const segments = path.split(".");
    let current = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
        const segment = segments[index];
        const existing = Object.getOwnPropertyDescriptor(current, segment);
        if (!existing) {
            const next: Record<string, unknown> = {};
            current[segment] = next;
            current = next;
            continue;
        }
        if (!existing.enumerable || !("value" in existing) || existing.value === null || typeof existing.value !== "object" || Array.isArray(existing.value)) {
            throw validationError("INVALID_ARGUMENT", path, "cannot be written through a non-object path segment");
        }
        current = existing.value as Record<string, unknown>;
    }
    current[segments.at(-1)!] = value;
}

export function deleteDataPath(root: Record<string, unknown>, path: string) {
    const segments = path.split(".");
    let current: Record<string, unknown> = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
        const next = readDataPath(current, segments[index]);
        if (!next.found || next.value === null || typeof next.value !== "object" || Array.isArray(next.value)) {
            return;
        }
        current = next.value as Record<string, unknown>;
    }
    delete current[segments.at(-1)!];
}

export function collectDocumentPaths(value: unknown, prefix = ""): string[] {
    if (value === null || typeof value !== "object" || value instanceof Date || value instanceof Uint8Array) {
        return prefix ? [prefix] : [];
    }
    if (Array.isArray(value)) {
        const paths = prefix ? [prefix] : [];
        for (const item of value) {
            if (item !== null && typeof item === "object" && !(item instanceof Date) && !(item instanceof Uint8Array)) {
                paths.push(...collectDocumentPaths(item, prefix));
            }
        }
        return [...new Set(paths)];
    }
    const paths: string[] = [];
    for (const key of Object.keys(value)) {
        const path = prefix ? `${prefix}.${key}` : key;
        paths.push(path);
        paths.push(...collectDocumentPaths((value as Record<string, unknown>)[key], path));
    }
    return [...new Set(paths)];
}
