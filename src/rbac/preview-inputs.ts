import { types as utilTypes } from "node:util";
import type {
    ExpectedRevisionVector,
    ManualRuleChange,
    ManualRuleInput,
    PreviewExecutionOptions,
    PreviewOptions,
    RequiredRevisionVectorOptions,
} from "../types";
import { PermissionCoreError, validationError } from "../core/errors";
import { CanonicalByteLimitError, canonicalByteLength, compareUtf8 } from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import { normalizeManualRuleInput, normalizeManualRuleSelector, normalizePermissionRuleInput } from "./inputs";
import { normalizeMutationOptions, type NormalizedMutationOptions } from "./mutation-executor";
import { createSemanticKey } from "./materialize";
import { normalizeRbacId } from "./validation";
import type { ResourceSchemeRegistry } from "../check/resource-schemes";

const MANAGEMENT_INPUT_MAX_BYTES = 12 * 1024 * 1024;
const PREVIEW_TOKEN_MAX_BYTES = 16 * 1024;
const MAX_REPLACE_RULES = 2_048;

export interface NormalizedPreviewOptions {
    readonly actorId: string;
    readonly reason?: string;
    readonly requestId?: string;
}

export interface NormalizedPreviewExecutionOptions extends NormalizedMutationOptions {
    readonly expectedRevisions: ExpectedRevisionVector;
    readonly previewToken: string;
    readonly acknowledgeCapacityRisk?: true;
}

export function exactPreviewRecord(value: unknown, field: string, allowed: readonly string[]) {
    const input = value ?? {};
    if (input === null || typeof input !== "object" || Array.isArray(input) || utilTypes.isProxy(input)) {
        throw validationError("INVALID_ARGUMENT", field, "must be a plain object");
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
        throw validationError("INVALID_ARGUMENT", field, "must be a plain object");
    }
    const record: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(input)) {
        if (typeof key !== "string" || !allowed.includes(key)) {
            throw validationError("INVALID_ARGUMENT", field, `contains unsupported key ${String(key)}`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor?.enumerable || !("value" in descriptor) || descriptor.value === undefined) {
            throw validationError("INVALID_ARGUMENT", `${field}.${key}`, "must be an enumerable defined data property");
        }
        record[key] = descriptor.value;
    }
    return record;
}

export function densePreviewArray(value: unknown, field: string, max: number) {
    if (!Array.isArray(value) || utilTypes.isProxy(value)) {
        throw validationError("INVALID_ARGUMENT", field, "must be a dense array");
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length = lengthDescriptor?.value as number;
    if (length > max) {
        throw new PermissionCoreError("LIMIT_EXCEEDED", `${field} exceeds its item limit.`, {
            details: { kind: "limit-exceeded", origin: "caller-input", limitName: `${field}-items`, current: length, max, unit: "items" },
        });
    }
    const result = new Array<unknown>(length);
    let count = 0;
    for (const key of Reflect.ownKeys(value)) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length) {
            throw validationError("INVALID_ARGUMENT", field, "contains a non-index property");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor) || descriptor.value === undefined) {
            throw validationError("INVALID_ARGUMENT", `${field}[${key}]`, "must be an enumerable defined data property");
        }
        result[Number(key)] = descriptor.value;
        count += 1;
    }
    if (count !== length) {
        throw validationError("INVALID_ARGUMENT", field, "cannot be sparse");
    }
    return result;
}

export function assertManagementInputBudget(value: unknown) {
    try {
        canonicalByteLength(value, MANAGEMENT_INPUT_MAX_BYTES);
    } catch (error) {
        if (error instanceof CanonicalByteLimitError) {
            throw new PermissionCoreError("LIMIT_EXCEEDED", "The management input exceeds its byte limit.", {
                details: {
                    kind: "limit-exceeded",
                    origin: "caller-input",
                    limitName: "management-input-bytes",
                    current: error.current,
                    max: MANAGEMENT_INPUT_MAX_BYTES,
                    unit: "bytes",
                },
            });
        }
        throw error;
    }
}

function nonNegativeRevision(value: unknown, field: string) {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw validationError("INVALID_ARGUMENT", field, "must be a non-negative safe integer");
    }
    return value as number;
}

export function normalizeExpectedRoleRevisionVector(value: unknown, roleId: string): ExpectedRevisionVector {
    const record = exactPreviewRecord(value, "expectedRevisions", ["global", "rbac", "entities"]);
    if (!Object.hasOwn(record, "global") || !Object.hasOwn(record, "rbac") || !Object.hasOwn(record, "entities")) {
        throw validationError("INVALID_ARGUMENT", "expectedRevisions", "requires global, rbac, and entities");
    }
    const entities = densePreviewArray(record.entities, "expectedRevisions.entities", 65);
    if (entities.length !== 1) {
        throw validationError("INVALID_ARGUMENT", "expectedRevisions.entities", "must contain exactly the target role revision");
    }
    const entity = exactPreviewRecord(entities[0], "expectedRevisions.entities[0]", ["kind", "id", "revision"]);
    if (entity.kind !== "role") {
        throw validationError("INVALID_ARGUMENT", "expectedRevisions.entities[0].kind", "must be role");
    }
    const entityId = normalizeRbacId(entity.id, "expectedRevisions.entities[0].id");
    if (entityId !== roleId) {
        throw validationError("INVALID_ARGUMENT", "expectedRevisions.entities[0].id", "must equal the target roleId");
    }
    return deepFreeze({
        global: nonNegativeRevision(record.global, "expectedRevisions.global"),
        rbac: nonNegativeRevision(record.rbac, "expectedRevisions.rbac"),
        entities: [{ kind: "role", id: entityId, revision: nonNegativeRevision(entity.revision, "expectedRevisions.entities[0].revision") }],
    });
}

const MENU_ENTITY_KINDS = new Set([
    "role",
    "role-menu-grant",
    "menu-node",
    "api-binding",
    "scope",
]);

export function normalizeExpectedMenuRevisionVector(value: unknown): ExpectedRevisionVector {
    const record = exactPreviewRecord(value, "expectedRevisions", ["global", "rbac", "menu", "entities"]);
    if (!Object.hasOwn(record, "global") || !Object.hasOwn(record, "menu") || !Object.hasOwn(record, "entities")) {
        throw validationError("INVALID_ARGUMENT", "expectedRevisions", "requires global, menu, and entities");
    }
    const entities = densePreviewArray(record.entities, "expectedRevisions.entities", 65)
        .map((value, index) => {
            const entity = exactPreviewRecord(value, `expectedRevisions.entities[${index}]`, ["kind", "id", "revision"]);
            if (!MENU_ENTITY_KINDS.has(entity.kind as string)) {
                throw validationError("INVALID_ARGUMENT", `expectedRevisions.entities[${index}].kind`, "is not valid for a menu mutation");
            }
            return {
                kind: entity.kind as "role" | "role-menu-grant" | "menu-node" | "api-binding" | "scope",
                id: normalizeRbacId(entity.id, `expectedRevisions.entities[${index}].id`),
                revision: nonNegativeRevision(entity.revision, `expectedRevisions.entities[${index}].revision`),
            };
        })
        .sort((left, right) => compareUtf8(left.kind, right.kind) || compareUtf8(left.id, right.id));
    const keys = entities.map((entity) => `${entity.kind}\u0000${entity.id}`);
    if (new Set(keys).size !== keys.length) {
        throw validationError("INVALID_ARGUMENT", "expectedRevisions.entities", "cannot contain duplicate owners");
    }
    return deepFreeze({
        global: nonNegativeRevision(record.global, "expectedRevisions.global"),
        ...(Object.hasOwn(record, "rbac")
            ? { rbac: nonNegativeRevision(record.rbac, "expectedRevisions.rbac") }
            : {}),
        menu: nonNegativeRevision(record.menu, "expectedRevisions.menu"),
        entities,
    });
}

export function normalizePreviewOptions(value?: PreviewOptions): NormalizedPreviewOptions {
    const record = exactPreviewRecord(value, "options", ["actorId", "reason", "requestId"]);
    const base = normalizeMutationOptions(record);
    return deepFreeze({
        actorId: base.actorId,
        ...(base.reason === undefined ? {} : { reason: base.reason }),
        ...(base.requestId === undefined ? {} : { requestId: base.requestId }),
    });
}

export function normalizePreviewExecutionOptions(
    value: RequiredRevisionVectorOptions & PreviewExecutionOptions,
    roleId: string,
): NormalizedPreviewExecutionOptions {
    const record = exactPreviewRecord(value, "options", [
        "actorId", "reason", "requestId", "idempotencyKey",
        "expectedRevisions", "previewToken", "acknowledgeCapacityRisk",
    ]);
    if (!Object.hasOwn(record, "expectedRevisions") || !Object.hasOwn(record, "previewToken")) {
        throw validationError("INVALID_ARGUMENT", "options", "requires expectedRevisions and previewToken");
    }
    if (
        typeof record.previewToken !== "string"
        || record.previewToken.length === 0
        || Buffer.byteLength(record.previewToken, "utf8") > PREVIEW_TOKEN_MAX_BYTES
    ) {
        throw validationError("INVALID_ARGUMENT", "previewToken", `must contain 1..${PREVIEW_TOKEN_MAX_BYTES} UTF-8 bytes`);
    }
    if (record.acknowledgeCapacityRisk !== undefined && record.acknowledgeCapacityRisk !== true) {
        throw validationError("INVALID_ARGUMENT", "acknowledgeCapacityRisk", "must be literal true when provided");
    }
    const mutationOptions = normalizeMutationOptions(Object.fromEntries(
        ["actorId", "reason", "requestId", "idempotencyKey"]
            .filter((key) => Object.hasOwn(record, key))
            .map((key) => [key, record[key]]),
    ));
    return deepFreeze({
        ...mutationOptions,
        expectedRevisions: normalizeExpectedRoleRevisionVector(record.expectedRevisions, roleId),
        previewToken: record.previewToken,
        ...(record.acknowledgeCapacityRisk === true ? { acknowledgeCapacityRisk: true as const } : {}),
    });
}

export function normalizeMenuPreviewExecutionOptions(
    value: RequiredRevisionVectorOptions & PreviewExecutionOptions,
): NormalizedPreviewExecutionOptions {
    const record = exactPreviewRecord(value, "options", [
        "actorId", "reason", "requestId", "idempotencyKey",
        "expectedRevisions", "previewToken", "acknowledgeCapacityRisk",
    ]);
    if (!Object.hasOwn(record, "expectedRevisions") || !Object.hasOwn(record, "previewToken")) {
        throw validationError("INVALID_ARGUMENT", "options", "requires expectedRevisions and previewToken");
    }
    if (
        typeof record.previewToken !== "string"
        || record.previewToken.length === 0
        || Buffer.byteLength(record.previewToken, "utf8") > PREVIEW_TOKEN_MAX_BYTES
    ) {
        throw validationError("INVALID_ARGUMENT", "previewToken", `must contain 1..${PREVIEW_TOKEN_MAX_BYTES} UTF-8 bytes`);
    }
    if (record.acknowledgeCapacityRisk !== undefined && record.acknowledgeCapacityRisk !== true) {
        throw validationError("INVALID_ARGUMENT", "acknowledgeCapacityRisk", "must be literal true when provided");
    }
    const mutationOptions = normalizeMutationOptions(Object.fromEntries(
        ["actorId", "reason", "requestId", "idempotencyKey"]
            .filter((key) => Object.hasOwn(record, key))
            .map((key) => [key, record[key]]),
    ));
    return deepFreeze({
        ...mutationOptions,
        expectedRevisions: normalizeExpectedMenuRevisionVector(record.expectedRevisions),
        previewToken: record.previewToken,
        ...(record.acknowledgeCapacityRisk === true ? { acknowledgeCapacityRisk: true as const } : {}),
    });
}

export function normalizeManualRuleChange(
    value: ManualRuleChange,
    resourceSchemes: ResourceSchemeRegistry,
) {
    const record = exactPreviewRecord(value, "change", ["operation", "rule", "selector"]);
    if (record.operation === "allow" || record.operation === "deny") {
        if (!Object.hasOwn(record, "rule") || Object.hasOwn(record, "selector")) {
            throw validationError("INVALID_ARGUMENT", "change", "allow and deny require only rule");
        }
        const rule = normalizePermissionRuleInput(record.rule as never, resourceSchemes);
        const normalized = deepFreeze({ operation: record.operation, rule } as const);
        assertManagementInputBudget(normalized);
        return normalized;
    }
    if (record.operation === "revoke") {
        if (!Object.hasOwn(record, "selector") || Object.hasOwn(record, "rule")) {
            throw validationError("INVALID_ARGUMENT", "change", "revoke requires only selector");
        }
        const selector = normalizeManualRuleSelector(record.selector as never, resourceSchemes);
        const normalized = deepFreeze({ operation: "revoke", selector } as const);
        assertManagementInputBudget(normalized);
        return normalized;
    }
    throw validationError("INVALID_ARGUMENT", "change.operation", "must be allow, deny, or revoke");
}

export function normalizeManualRuleList(
    value: readonly ManualRuleInput[],
    resourceSchemes: ResourceSchemeRegistry,
) {
    const entries = densePreviewArray(value, "rules", MAX_REPLACE_RULES)
        .map((entry, index) => {
            try {
                const rule = normalizeManualRuleInput(entry as ManualRuleInput, resourceSchemes);
                return {
                    ...rule,
                    semanticKey: createSemanticKey(rule.effect, rule.action, rule.resource, rule.where),
                };
            } catch (error) {
                if (error instanceof PermissionCoreError && error.details?.kind === "validation") {
                    throw validationError("INVALID_ARGUMENT", `rules[${index}]`, error.details.reason);
                }
                throw error;
            }
        });
    const byKey = new Map(entries.map((entry) => [entry.semanticKey, entry]));
    const normalized = [...byKey.values()].sort((left, right) => compareUtf8(left.semanticKey, right.semanticKey));
    assertManagementInputBudget(normalized);
    return deepFreeze(normalized);
}
