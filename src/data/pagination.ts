import { PermissionCoreError } from "../core/errors";
import { readDataPath } from "./path";

export type MongoSortScalarType = "null" | "bool" | "number" | "string" | "date" | "binData" | "objectId";

const MONGO_SORT_SCALAR_TYPES = new Set<MongoSortScalarType>([
    "null",
    "bool",
    "number",
    "string",
    "date",
    "binData",
    "objectId",
]);

function persistedSortInvalid(path: string, reason: string): never {
    throw new PermissionCoreError("PERSISTED_STATE_INVALID", "The protected pagination sort domain is unsupported.", {
        details: {
            kind: "persisted-state-invalid",
            stage: "load",
            reason: `${path}: ${reason}`,
        },
    });
}

function bsonType(value: object) {
    const descriptor = Object.getOwnPropertyDescriptor(value, "_bsontype");
    if (descriptor && "value" in descriptor && typeof descriptor.value === "string") {
        return descriptor.value;
    }
    const inherited = (value as { _bsontype?: unknown })._bsontype;
    return typeof inherited === "string" ? inherited : undefined;
}

export function detectMongoSortScalarType(value: unknown): MongoSortScalarType | undefined {
    if (value === null) return "null";
    if (typeof value === "boolean") return "bool";
    if (typeof value === "number" && Number.isFinite(value)) return "number";
    if (typeof value === "string") return "string";
    if (value instanceof Date && Number.isFinite(value.getTime())) return "date";
    if (Buffer.isBuffer(value) || value instanceof Uint8Array || (value && typeof value === "object" && bsonType(value) === "Binary")) {
        return "binData";
    }
    if (value && typeof value === "object" && bsonType(value) === "ObjectId") return "objectId";
    return undefined;
}

export function classifyMongoSortScalar(value: unknown, path: string): MongoSortScalarType {
    const type = detectMongoSortScalarType(value);
    if (type) return type;
    persistedSortInvalid(path, "sort values must be non-missing scalar BSON values from one stable type domain");
}

export function readSortScalarTypes(
    document: Readonly<Record<string, unknown>>,
    sortEntries: readonly (readonly [string, 1 | -1])[],
) {
    return Object.freeze(sortEntries.map(([path]) => {
        const resolved = readDataPath(document, path);
        if (!resolved.found) persistedSortInvalid(path, "sort field is missing");
        return classifyMongoSortScalar(resolved.value, path);
    }));
}

export function sortDomainFilter(
    sortEntries: readonly (readonly [string, 1 | -1])[],
    types: readonly MongoSortScalarType[],
) {
    if (sortEntries.length !== types.length) persistedSortInvalid("sort", "cursor type arity does not match the sort contract");
    return {
        $and: sortEntries.flatMap(([path], index) => [
            { [path]: { $type: types[index] } },
            { [path]: { $not: { $type: "array" } } },
        ]),
    };
}

export function isMongoSortScalarType(value: unknown): value is MongoSortScalarType {
    return typeof value === "string" && MONGO_SORT_SCALAR_TYPES.has(value as MongoSortScalarType);
}
