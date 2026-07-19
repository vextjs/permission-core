import { isWellFormedUnicode } from "../internal/unicode";

export type ResourceMode = "pattern" | "resource";
export type BuiltInKind = "global" | "http" | "api" | "db" | "ui";

interface HttpResource {
    method: string;
    path: string;
    segments: readonly string[];
}

interface DbResource {
    collection: string;
    field?: string;
}

const HTTP_METHOD_PATTERN = /^[A-Z][A-Z0-9-]*$/u;
const COLLECTION_PATTERN = /^[A-Za-z_-][A-Za-z0-9_-]{0,63}$/u;
const FIELD_SEGMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const UI_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/u;

function parseHttpResource(value: string, mode: ResourceMode): HttpResource | null {
    if (!isWellFormedUnicode(value)) {
        return null;
    }
    const separator = value.indexOf(":");
    if (separator <= 0 || separator === value.length - 1 || Buffer.byteLength(value, "utf8") > 1024) {
        return null;
    }
    const method = value.slice(0, separator);
    const path = value.slice(separator + 1);
    if ((method === "*" && mode !== "pattern") || (method !== "*" && !HTTP_METHOD_PATTERN.test(method))) {
        return null;
    }
    if (path === "*" && mode === "pattern") {
        return { method, path, segments: ["*"] };
    }
    if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
        return null;
    }
    if (path === "/") {
        return { method, path, segments: [] };
    }
    const segments = path.slice(1).split("/");
    if (segments.some((segment) => !segment)) {
        return null;
    }
    for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index];
        if (segment === "*") {
            if (mode !== "pattern" || index !== segments.length - 1) {
                return null;
            }
            continue;
        }
        if (segment.startsWith(":")) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(segment.slice(1))) {
                return null;
            }
            continue;
        }
        if (segment.includes("*")) {
            return null;
        }
    }
    return { method, path, segments };
}

function matchHttp(pattern: HttpResource, resource: HttpResource) {
    if (pattern.method !== "*" && pattern.method !== resource.method) {
        return false;
    }
    if (pattern.path === "*") {
        return true;
    }
    let resourceIndex = 0;
    for (let patternIndex = 0; patternIndex < pattern.segments.length; patternIndex += 1) {
        const patternSegment = pattern.segments[patternIndex];
        if (patternSegment === "*") {
            return resourceIndex < resource.segments.length;
        }
        const resourceSegment = resource.segments[resourceIndex];
        if (resourceSegment === undefined) {
            return false;
        }
        if (!patternSegment.startsWith(":") && patternSegment !== resourceSegment) {
            return false;
        }
        resourceIndex += 1;
    }
    return resourceIndex === resource.segments.length;
}

function isSafeFieldPath(value: string) {
    const segments = value.split(".");
    return Buffer.byteLength(value, "utf8") <= 512
        && segments.length <= 32
        && segments.every((segment) => FIELD_SEGMENT_PATTERN.test(segment));
}

function parseDbResource(value: string, mode: ResourceMode): DbResource | null {
    if (!isWellFormedUnicode(value)) {
        return null;
    }
    const parts = value.split(":");
    if (parts[0] !== "db" || (parts.length !== 2 && parts.length !== 4)) {
        return null;
    }
    const collection = parts[1];
    if (collection !== "*" && !COLLECTION_PATTERN.test(collection)) {
        return null;
    }
    if (collection === "*" && mode !== "pattern") {
        return null;
    }
    if (parts.length === 2) {
        return { collection };
    }
    if (parts[2] !== "field") {
        return null;
    }
    const field = parts[3];
    if (mode === "resource") {
        return field && field !== "*" && isSafeFieldPath(field) ? { collection, field } : null;
    }
    if (field === "*") {
        return { collection, field };
    }
    if (field.endsWith(".*")) {
        const prefix = field.slice(0, -2);
        return isSafeFieldPath(prefix) ? { collection, field } : null;
    }
    return isSafeFieldPath(field) ? { collection, field } : null;
}

function matchDb(pattern: DbResource, resource: DbResource) {
    if ((pattern.field === undefined) !== (resource.field === undefined)) {
        return false;
    }
    if (pattern.collection !== "*" && pattern.collection !== resource.collection) {
        return false;
    }
    if (pattern.field === undefined || resource.field === undefined) {
        return true;
    }
    if (pattern.field === "*") {
        return true;
    }
    if (pattern.field.endsWith(".*")) {
        return resource.field.startsWith(`${pattern.field.slice(0, -2)}.`);
    }
    return pattern.field === resource.field;
}

function parseUiResource(value: string, mode: ResourceMode): readonly string[] | null {
    if (!isWellFormedUnicode(value)) {
        return null;
    }
    const parts = value.split(":");
    if (parts[0] !== "ui" || parts.length < 2) {
        return null;
    }
    const segments = parts.slice(1);
    for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index];
        if (segment === "*") {
            if (mode !== "pattern" || index !== segments.length - 1) {
                return null;
            }
        } else if (!UI_SEGMENT_PATTERN.test(segment)) {
            return null;
        }
    }
    if (mode === "resource" && segments.length < 2) {
        return null;
    }
    return segments;
}

function matchUi(pattern: readonly string[], resource: readonly string[]) {
    for (let index = 0; index < pattern.length; index += 1) {
        if (pattern[index] === "*") {
            return resource.length > index;
        }
        if (pattern[index] !== resource[index]) {
            return false;
        }
    }
    return pattern.length === resource.length;
}

export function getBuiltInResourceKind(value: string): BuiltInKind | undefined {
    if (value === "*") {
        return "global";
    }
    if (value.startsWith("api:")) {
        return "api";
    }
    if (value.startsWith("db:")) {
        return "db";
    }
    if (value.startsWith("ui:")) {
        return "ui";
    }
    if (/^(?:\*|[A-Z][A-Z0-9-]*):/u.test(value)) {
        return "http";
    }
    return undefined;
}

export function isValidBuiltInResource(value: string, mode: ResourceMode, kind: BuiltInKind) {
    if (kind === "global") {
        return mode === "pattern" && value === "*";
    }
    if (kind === "http") {
        return parseHttpResource(value, mode) !== null;
    }
    if (kind === "api") {
        return parseHttpResource(value.slice(4), mode) !== null;
    }
    if (kind === "db") {
        return parseDbResource(value, mode) !== null;
    }
    return parseUiResource(value, mode) !== null;
}

export function matchBuiltInResource(pattern: string, resource: string) {
    const patternKind = getBuiltInResourceKind(pattern);
    const resourceKind = getBuiltInResourceKind(resource);
    if (
        !patternKind
        || !resourceKind
        || !isValidBuiltInResource(pattern, "pattern", patternKind)
        || !isValidBuiltInResource(resource, "resource", resourceKind)
    ) {
        return false;
    }
    if (pattern === "*") {
        return true;
    }
    if (patternKind !== resourceKind) {
        return false;
    }
    if (patternKind === "http") {
        return matchHttp(parseHttpResource(pattern, "pattern")!, parseHttpResource(resource, "resource")!);
    }
    if (patternKind === "api") {
        return matchHttp(parseHttpResource(pattern.slice(4), "pattern")!, parseHttpResource(resource.slice(4), "resource")!);
    }
    if (patternKind === "db") {
        return matchDb(parseDbResource(pattern, "pattern")!, parseDbResource(resource, "resource")!);
    }
    if (patternKind === "ui") {
        return matchUi(parseUiResource(pattern, "pattern")!, parseUiResource(resource, "resource")!);
    }
    return false;
}
