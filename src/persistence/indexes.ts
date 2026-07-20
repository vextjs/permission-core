import { canonicalString } from "../internal/canonical";
import { PermissionCoreError } from "../core/errors";
import type { InternalCollectionKey } from "./documents";
import type { InternalPermissionCollection } from "./native-collection";

export const SIMPLE_COLLATION = Object.freeze({ locale: "simple" } as const);

export interface InternalIndexSpec {
    readonly name: string;
    readonly key: Readonly<Record<string, 1 | -1>>;
    readonly unique?: true;
    readonly partialFilterExpression?: Readonly<Record<string, unknown>>;
    readonly collation: typeof SIMPLE_COLLATION;
}

function index(
    name: string,
    key: Record<string, 1 | -1>,
    options: Pick<InternalIndexSpec, "unique" | "partialFilterExpression"> = {},
): InternalIndexSpec {
    return Object.freeze({
        name,
        key: Object.freeze(key),
        ...options,
        collation: SIMPLE_COLLATION,
    });
}

const STRING_FIELD = Object.freeze({ $type: "string" });

export const INTERNAL_INDEX_CATALOG: Readonly<Record<InternalCollectionKey, readonly InternalIndexSpec[]>> = Object.freeze({
    roles: Object.freeze([
        index("pc_roles_scope_role_uq", { scopeKey: 1, roleId: 1 }, { unique: true }),
        index("pc_roles_scope_parent", { scopeKey: 1, parentId: 1 }),
        index("pc_roles_scope_status_label", { scopeKey: 1, status: 1, label: 1, roleId: 1 }),
    ]),
    roleRules: Object.freeze([
        index("pc_rules_scope_role_semantic_uq", { scopeKey: 1, roleId: 1, semanticKey: 1 }, { unique: true }),
        index("pc_rules_scope_role_source_uq", { scopeKey: 1, roleId: 1, "sources.sourceId": 1 }, { unique: true }),
        index("pc_rules_scope_role_grant", { scopeKey: 1, roleId: 1, "sources.grantId": 1 }),
        index("pc_rules_scope_kind_asset_role", { scopeKey: 1, "sources.kind": 1, "sources.assetId": 1, roleId: 1 }),
        index("pc_rules_scope_api_role", { scopeKey: 1, "sources.apiBindingId": 1, roleId: 1 }),
        index("pc_rules_scope_data_role", { scopeKey: 1, "sources.dataResource": 1, roleId: 1 }),
        index("pc_rules_scope_resource_action", { scopeKey: 1, resource: 1, action: 1 }),
    ]),
    userRoleSets: Object.freeze([
        index("pc_user_roles_scope_user_uq", { scopeKey: 1, userId: 1 }, { unique: true }),
        index("pc_user_roles_scope_roles_user", { scopeKey: 1, roleIds: 1, userId: 1 }),
    ]),
    roleMenuGrants: Object.freeze([
        index("pc_grants_scope_role_grant_uq", { scopeKey: 1, roleId: 1, grantId: 1 }, { unique: true }),
        index("pc_grants_scope_role_effect", { scopeKey: 1, roleId: 1, effect: 1, grantId: 1 }),
        index("pc_grants_scope_grant_revision", { scopeKey: 1, grantId: 1, grantRevision: 1 }),
    ]),
    menuConfigs: Object.freeze([
        index("pc_menu_config_scope_config_uq", { scopeKey: 1, configId: 1 }, { unique: true }),
        index("pc_menu_config_scope_updated", { scopeKey: 1, updatedAt: -1, configId: 1 }),
        index("pc_menu_config_scope_digest", { scopeKey: 1, configDigest: 1, configId: 1 }),
        index("pc_menu_config_scope_title", { scopeKey: 1, title: 1, configId: 1 }, {
            partialFilterExpression: Object.freeze({ title: STRING_FIELD }),
        }),
    ]),
    menuNodes: Object.freeze([
        index("pc_menu_scope_node_uq", { scopeKey: 1, nodeId: 1 }, { unique: true }),
        index("pc_menu_scope_path_uq", { scopeKey: 1, path: 1 }, {
            unique: true,
            partialFilterExpression: Object.freeze({ path: STRING_FIELD }),
        }),
        index("pc_menu_scope_name_uq", { scopeKey: 1, name: 1 }, {
            unique: true,
            partialFilterExpression: Object.freeze({ name: STRING_FIELD }),
        }),
        index("pc_menu_scope_parent_code_uq", { scopeKey: 1, parentId: 1, code: 1 }, {
            unique: true,
            partialFilterExpression: Object.freeze({ code: STRING_FIELD }),
        }),
        index("pc_menu_scope_parent_order", { scopeKey: 1, parentId: 1, order: 1, nodeId: 1 }),
    ]),
    apiBindings: Object.freeze([
        index("pc_api_scope_binding_uq", { scopeKey: 1, bindingId: 1 }, { unique: true }),
        index("pc_api_scope_method_path_uq", { scopeKey: 1, method: 1, path: 1 }, { unique: true }),
        index("pc_api_scope_owners", { scopeKey: 1, "owners.id": 1, "owners.type": 1, bindingId: 1 }),
        index("pc_api_scope_status_method_path", { scopeKey: 1, status: 1, method: 1, path: 1 }),
    ]),
    scopeState: Object.freeze([
        index("pc_scope_state_scope_uq", { scopeKey: 1 }, { unique: true }),
        index("pc_scope_state_contract_scope", { schemaContractKey: 1, scopeKey: 1 }),
    ]),
    auditEntries: Object.freeze([
        index("pc_audit_scope_audit_uq", { scopeKey: 1, auditId: 1 }, { unique: true }),
        index("pc_audit_scope_operation_uq", { scopeKey: 1, operationId: 1 }, { unique: true }),
        index("pc_audit_scope_actor_idempotency_uq", {
            scopeKey: 1,
            actorId: 1,
            operation: 1,
            idempotencyKey: 1,
        }, {
            unique: true,
            partialFilterExpression: Object.freeze({ idempotencyKey: STRING_FIELD }),
        }),
        index("pc_audit_scope_created", { scopeKey: 1, createdAt: -1, auditId: -1 }),
        index("pc_audit_scope_actor_created", { scopeKey: 1, actorId: 1, createdAt: -1, auditId: -1 }),
        index("pc_audit_scope_operation_created", { scopeKey: 1, operation: 1, createdAt: -1, auditId: -1 }),
        index("pc_audit_scope_action_created", { scopeKey: 1, action: 1, createdAt: -1, auditId: -1 }),
        index("pc_audit_scope_resource_created", { scopeKey: 1, resourceHash: 1, createdAt: -1, auditId: -1 }),
        index("pc_audit_scope_request_created", { scopeKey: 1, requestIdHash: 1, createdAt: -1, auditId: -1 }),
        index("pc_audit_scope_outcome_created", {
            scopeKey: 1,
            "operationalState.cacheOutcome": 1,
            createdAt: -1,
            auditId: -1,
        }),
        index("pc_audit_reconcile_queue", {
            scopeKey: 1,
            "operationalState.cacheOutcome": 1,
            reconcileAvailableAt: 1,
            createdAt: 1,
            auditId: 1,
        }),
        index("pc_audit_health_outcome", { "operationalState.cacheOutcome": 1, scopeKey: 1, auditId: 1 }),
    ]),
});

function indexConflict(collection: string, indexName: string, reason: string, cause?: unknown) {
    return new PermissionCoreError("INDEX_CONFLICT", `Index ${indexName} on ${collection} conflicts with the current schema contract.`, {
        details: { kind: "database-failure", stage: "index" },
        cause: cause ?? new Error(reason),
    });
}

function readErrorField(error: unknown, field: "code" | "codeName") {
    return error !== null && typeof error === "object"
        ? (error as Record<string, unknown>)[field]
        : undefined;
}

function readErrorFieldDeep(error: unknown, field: "code" | "codeName") {
    let current = error;
    for (let depth = 0; depth < 5; depth += 1) {
        const value = readErrorField(current, field);
        if (value !== undefined) {
            return value;
        }
        current = current !== null && typeof current === "object"
            ? (current as Record<string, unknown>).cause
            : undefined;
        if (current === undefined) {
            break;
        }
    }
    return undefined;
}

export function isMongoIndexConflict(error: unknown) {
    const code = readErrorFieldDeep(error, "code");
    const codeName = readErrorFieldDeep(error, "codeName");
    return code === 85
        || code === 86
        || codeName === "IndexOptionsConflict"
        || codeName === "IndexKeySpecsConflict";
}

function sameKey(actual: unknown, expected: Readonly<Record<string, 1 | -1>>) {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) {
        return false;
    }
    const actualEntries = Object.entries(actual as Record<string, unknown>);
    const expectedEntries = Object.entries(expected);
    return actualEntries.length === expectedEntries.length
        && actualEntries.every(([name, direction], position) => {
            const expectedEntry = expectedEntries[position];
            return name === expectedEntry[0] && direction === expectedEntry[1];
        });
}

function sameDocument(actual: unknown, expected: unknown) {
    if (actual === undefined || expected === undefined) {
        return actual === expected;
    }
    try {
        return canonicalString(actual) === canonicalString(expected);
    } catch {
        return false;
    }
}

function sameCollation(actual: unknown, expected: typeof SIMPLE_COLLATION) {
    // MongoDB omits index collation metadata when the effective contract is binary/simple.
    return actual === undefined || sameDocument(actual, expected);
}

function verifyIndex(collection: string, expected: InternalIndexSpec, actual: Record<string, unknown>) {
    if (!sameKey(actual.key, expected.key)) {
        throw indexConflict(collection, expected.name, "key order or direction differs");
    }
    if (Boolean(actual.unique) !== Boolean(expected.unique)) {
        throw indexConflict(collection, expected.name, "unique differs");
    }
    if (!sameDocument(actual.partialFilterExpression, expected.partialFilterExpression)) {
        throw indexConflict(collection, expected.name, "partialFilterExpression differs");
    }
    if (!sameCollation(actual.collation, expected.collation)) {
        throw indexConflict(
            collection,
            expected.name,
            `collation differs: actual=${JSON.stringify(actual.collation)} expected=${JSON.stringify(expected.collation)}`,
        );
    }
    if (actual.sparse === true) {
        throw indexConflict(collection, expected.name, "unexpected sparse option");
    }
    if (actual.expireAfterSeconds !== undefined) {
        throw indexConflict(collection, expected.name, "unexpected TTL option");
    }
    if (actual.hidden === true) {
        throw indexConflict(collection, expected.name, "unexpected hidden option");
    }
}

export function verifyIndexDefinitions(
    collection: string,
    expected: readonly InternalIndexSpec[],
    actual: readonly Record<string, unknown>[],
) {
    for (const spec of expected) {
        const candidates = actual.filter((candidate) => candidate.name === spec.name);
        if (candidates.length !== 1) {
            throw indexConflict(collection, spec.name, candidates.length === 0 ? "index is missing" : "index name is duplicated");
        }
        verifyIndex(collection, spec, candidates[0]);
    }
}

export async function createAndVerifyIndexes(
    collectionName: string,
    collection: InternalPermissionCollection,
    specs: readonly InternalIndexSpec[],
) {
    try {
        await collection.createIndexes(specs.map((spec) => ({
            name: spec.name,
            key: { ...spec.key },
            ...(spec.unique ? { unique: true } : {}),
            ...(spec.partialFilterExpression ? { partialFilterExpression: spec.partialFilterExpression } : {}),
            collation: spec.collation,
        })));
    } catch (error) {
        if (isMongoIndexConflict(error)) {
            throw indexConflict(collectionName, "unknown", "MongoDB rejected an existing index definition", error);
        }
        throw error;
    }

    const actual = await collection.listIndexes();
    verifyIndexDefinitions(collectionName, specs, actual);
}
