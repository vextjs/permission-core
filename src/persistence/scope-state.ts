import type { MongoSession } from "monsqlize";
import type { PermissionScope } from "../types";
import {
    CANONICAL_CONTRACT_VERSION,
    canonicalByteLength,
    canonicalString,
    digestCanonical,
} from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import { createScopeKey, normalizeScope } from "../scope/scope";
import { PermissionCoreError } from "../core/errors";
import {
    PERSISTED_SCHEMA_VERSION,
    assertInternalDocumentBudget,
    type InternalScopeRevisionVector,
    type InternalScopeStateDocument,
} from "./documents";
import { SIMPLE_COLLATION } from "./indexes";
import type { InternalPermissionCollection } from "./native-collection";

export const EMPTY_REPLACE_MANIFEST_BYTES = canonicalByteLength({
    schemaVersion: 2,
    mode: "replace",
    nodes: [],
    apiBindings: [],
});
export const MAX_MENU_NODE_COUNT = 10_000;
export const MAX_API_BINDING_COUNT = 20_000;
export const MAX_REPLACE_MANIFEST_BYTES = 12 * 1024 * 1024;

export interface ScopeStateContract {
    readonly schemeContractDigest: string;
    readonly schemaContractKey: string;
}

export interface ScopeStateView extends InternalScopeStateDocument {
    readonly persisted: boolean;
}

export interface ScopeRevisionAdvance {
    readonly global: 0 | 1;
    readonly rbac: 0 | 1;
    readonly menu: 0 | 1;
    readonly audit: 0 | 1;
}

export interface ScopeAggregateUpdate {
    readonly menuNodeCount?: number;
    readonly apiBindingCount?: number;
    readonly replaceManifestBytes?: number;
}

export interface ScopeAggregateSnapshot {
    readonly menuNodeCount: number;
    readonly apiBindingCount: number;
    readonly replaceManifestBytes: number;
}

const NON_NEGATIVE_INTEGER_FIELDS = [
    "revision",
    "rbacRevision",
    "menuRevision",
    "auditRevision",
    "menuNodeCount",
    "apiBindingCount",
    "replaceManifestBytes",
    "createdAt",
    "updatedAt",
] as const;

const SCOPE_STATE_FIELDS = new Set([
    "scopeKey",
    "scope",
    "schemaVersion",
    "schemeContractDigest",
    "schemaContractKey",
    ...NON_NEGATIVE_INTEGER_FIELDS,
]);

function scopeHash(scopeKey: string) {
    return digestCanonical({ scopeKey });
}

function schemaVersionMismatch(scopeKey: string, current: unknown): never {
    throw new PermissionCoreError("SCHEMA_VERSION_MISMATCH", "The persisted scope schema version is not supported.", {
        details: {
            kind: "schema-version-mismatch",
            expected: PERSISTED_SCHEMA_VERSION,
            current: typeof current === "number" || typeof current === "string" ? current : typeof current,
            scopeHash: scopeHash(scopeKey),
        },
    });
}

function schemaContractMismatch(scopeKey: string, expected: string, current: unknown): never {
    throw new PermissionCoreError("SCHEMA_CONTRACT_MISMATCH", "The persisted scope contract cannot be interpreted by this core.", {
        details: {
            kind: "schema-contract-mismatch",
            expected,
            current: typeof current === "string" || typeof current === "number" ? current : typeof current,
            scopeHash: scopeHash(scopeKey),
        },
    });
}

function persistedStateInvalid(reason: string): never {
    throw new PermissionCoreError("PERSISTED_STATE_INVALID", "The persisted scope state is malformed.", {
        details: { kind: "persisted-state-invalid", stage: "load", reason },
    });
}

function assertEpochMilliseconds(value: number, field: string) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new PermissionCoreError("INVALID_ARGUMENT", `${field} must be a non-negative epoch millisecond value.`, {
            details: { kind: "validation", field, reason: "must be a non-negative safe integer" },
        });
    }
}

function readOptions(session?: MongoSession) {
    return {
        cache: 0,
        collation: SIMPLE_COLLATION,
        ...(session ? { session } : {}),
    };
}

function writeOptions(session: MongoSession) {
    return {
        session,
        collation: SIMPLE_COLLATION,
        cache: { invalidate: false as const },
    };
}

function insertOptions(session: MongoSession) {
    return {
        session,
        cache: { invalidate: false as const },
    };
}

function createVirtualState(
    scope: Readonly<PermissionScope>,
    scopeKey: string,
    contract: ScopeStateContract,
): ScopeStateView {
    return deepFreeze({
        scopeKey,
        scope,
        schemaVersion: PERSISTED_SCHEMA_VERSION,
        schemeContractDigest: contract.schemeContractDigest,
        schemaContractKey: contract.schemaContractKey,
        revision: 0,
        rbacRevision: 0,
        menuRevision: 0,
        auditRevision: 0,
        menuNodeCount: 0,
        apiBindingCount: 0,
        replaceManifestBytes: EMPTY_REPLACE_MANIFEST_BYTES,
        createdAt: 0,
        updatedAt: 0,
        persisted: false,
    });
}

function validateState(
    raw: Record<string, unknown>,
    expectedScope: Readonly<PermissionScope>,
    expectedScopeKey: string,
    contract: ScopeStateContract,
): ScopeStateView {
    const unexpectedField = Object.keys(raw).find((field) => field !== "_id" && !SCOPE_STATE_FIELDS.has(field));
    if (unexpectedField) {
        persistedStateInvalid(`unexpected field ${unexpectedField}`);
    }
    const { _id: _ignored, ...plain } = raw;
    if (raw.schemaVersion !== PERSISTED_SCHEMA_VERSION) {
        schemaVersionMismatch(expectedScopeKey, raw.schemaVersion);
    }
    if (raw.scopeKey !== expectedScopeKey) {
        schemaContractMismatch(expectedScopeKey, expectedScopeKey, raw.scopeKey);
    }

    let normalizedPersistedScope: Readonly<PermissionScope>;
    try {
        normalizedPersistedScope = normalizeScope(raw.scope as PermissionScope);
    } catch {
        schemaContractMismatch(expectedScopeKey, canonicalString(expectedScope), "malformed-scope");
    }
    if (
        canonicalString(raw.scope) !== canonicalString(normalizedPersistedScope)
        || createScopeKey(normalizedPersistedScope) !== expectedScopeKey
        || canonicalString(normalizedPersistedScope) !== canonicalString(expectedScope)
    ) {
        schemaContractMismatch(expectedScopeKey, canonicalString(expectedScope), raw.scope);
    }

    const persistedDigest = raw.schemeContractDigest;
    const persistedKey = raw.schemaContractKey;
    const recomputedKey = typeof persistedDigest === "string"
        ? digestCanonical({
            canonicalContractVersion: CANONICAL_CONTRACT_VERSION,
            schemaVersion: PERSISTED_SCHEMA_VERSION,
            schemeContractDigest: persistedDigest,
        })
        : undefined;
    if (
        persistedDigest !== contract.schemeContractDigest
        || persistedKey !== contract.schemaContractKey
        || recomputedKey !== persistedKey
    ) {
        schemaContractMismatch(expectedScopeKey, contract.schemaContractKey, persistedKey ?? persistedDigest);
    }

    for (const field of NON_NEGATIVE_INTEGER_FIELDS) {
        const value = raw[field];
        if (!Number.isSafeInteger(value) || (value as number) < 0) {
            persistedStateInvalid(`${field} must be a non-negative safe integer`);
        }
    }
    if ((raw.updatedAt as number) < (raw.createdAt as number)) {
        persistedStateInvalid("updatedAt cannot precede createdAt");
    }
    const revision = raw.revision as number;
    const rbacRevision = raw.rbacRevision as number;
    const menuRevision = raw.menuRevision as number;
    const auditRevision = raw.auditRevision as number;
    if (
        revision < rbacRevision
        || revision < menuRevision
        || revision > rbacRevision + menuRevision
        || auditRevision < revision
    ) {
        persistedStateInvalid("revision vector violates domain ownership invariants");
    }
    const menuNodeCount = raw.menuNodeCount as number;
    const apiBindingCount = raw.apiBindingCount as number;
    const replaceManifestBytes = raw.replaceManifestBytes as number;
    if (menuNodeCount > MAX_MENU_NODE_COUNT || apiBindingCount > MAX_API_BINDING_COUNT) {
        persistedStateInvalid("menu aggregate count exceeds the v2 limit");
    }
    if (
        replaceManifestBytes < EMPTY_REPLACE_MANIFEST_BYTES
        || replaceManifestBytes > MAX_REPLACE_MANIFEST_BYTES
        || (
            menuNodeCount === 0
            && apiBindingCount === 0
            && replaceManifestBytes !== EMPTY_REPLACE_MANIFEST_BYTES
        )
        || (
            (menuNodeCount > 0 || apiBindingCount > 0)
            && replaceManifestBytes <= EMPTY_REPLACE_MANIFEST_BYTES
        )
    ) {
        persistedStateInvalid("replace manifest aggregate is inconsistent");
    }
    try {
        assertInternalDocumentBudget(plain);
    } catch {
        persistedStateInvalid("scope state document budget is invalid");
    }

    return deepFreeze({
        scopeKey: expectedScopeKey,
        scope: expectedScope,
        schemaVersion: PERSISTED_SCHEMA_VERSION,
        schemeContractDigest: contract.schemeContractDigest,
        schemaContractKey: contract.schemaContractKey,
        revision: raw.revision as number,
        rbacRevision: raw.rbacRevision as number,
        menuRevision: raw.menuRevision as number,
        auditRevision: raw.auditRevision as number,
        menuNodeCount: raw.menuNodeCount as number,
        apiBindingCount: raw.apiBindingCount as number,
        replaceManifestBytes: raw.replaceManifestBytes as number,
        createdAt: raw.createdAt as number,
        updatedAt: raw.updatedAt as number,
        persisted: true,
    });
}

function vectorOf(state: ScopeStateView): InternalScopeRevisionVector {
    return {
        global: state.revision,
        rbac: state.rbacRevision,
        menu: state.menuRevision,
        audit: state.auditRevision,
    };
}

function revisionConflict(expected: InternalScopeRevisionVector, current: InternalScopeRevisionVector): never {
    const fields = ["global", "rbac", "menu", "audit"] as const;
    const field = fields.find((candidate) => expected[candidate] !== current[candidate]);
    if (!field) {
        persistedStateInvalid("scope revision CAS failed without an observable revision change");
    }
    throw new PermissionCoreError("REVISION_CONFLICT", `Scope ${field} revision changed.`, {
        details: {
            kind: "revision-conflict",
            owner: `scope.${field}`,
            expected: expected[field],
            current: current[field],
        },
    });
}

export class ScopeStateStore {
    constructor(
        private readonly collection: InternalPermissionCollection,
        private readonly contract: ScopeStateContract,
    ) {}

    async read(scopeInput: PermissionScope, session?: MongoSession): Promise<ScopeStateView> {
        const scope = normalizeScope(scopeInput);
        const scopeKey = createScopeKey(scope);
        const raw = await this.collection.findOne({ scopeKey }, readOptions(session));
        if (raw === null) {
            return createVirtualState(scope, scopeKey, this.contract);
        }
        if (typeof raw !== "object" || Array.isArray(raw)) {
            persistedStateInvalid("scope state document must be an object");
        }
        return validateState(raw, scope, scopeKey, this.contract);
    }

    async ensureForMutation(
        scopeInput: PermissionScope,
        session: MongoSession,
        now: number,
    ): Promise<ScopeStateView> {
        assertEpochMilliseconds(now, "now");
        const current = await this.read(scopeInput, session);
        if (current.persisted) {
            return current;
        }

        const document: InternalScopeStateDocument = {
            scopeKey: current.scopeKey,
            scope: current.scope,
            schemaVersion: PERSISTED_SCHEMA_VERSION,
            schemeContractDigest: this.contract.schemeContractDigest,
            schemaContractKey: this.contract.schemaContractKey,
            revision: 0,
            rbacRevision: 0,
            menuRevision: 0,
            auditRevision: 0,
            menuNodeCount: 0,
            apiBindingCount: 0,
            replaceManifestBytes: EMPTY_REPLACE_MANIFEST_BYTES,
            createdAt: now,
            updatedAt: now,
        };
        assertInternalDocumentBudget(document);
        await this.collection.insertOne({ ...document }, insertOptions(session));
        return deepFreeze({ ...document, persisted: true });
    }

    async advance(
        scopeInput: PermissionScope,
        expected: InternalScopeRevisionVector,
        increments: ScopeRevisionAdvance,
        aggregate: ScopeAggregateUpdate,
        session: MongoSession,
        now: number,
        expectedAggregate?: ScopeAggregateSnapshot,
    ): Promise<ScopeStateView> {
        assertEpochMilliseconds(now, "now");
        if (
            increments.audit !== 1
            || (increments.global === 0 && (increments.rbac !== 0 || increments.menu !== 0))
            || (increments.global === 1 && increments.rbac === 0 && increments.menu === 0)
            || (Object.keys(aggregate).length > 0 && (increments.global !== 1 || increments.menu !== 1))
        ) {
            throw new PermissionCoreError("INVALID_ARGUMENT", "The scope revision advance violates the v2 revision contract.", {
                details: {
                    kind: "validation",
                    field: "increments",
                    reason: "audit must advance once and authorization-domain changes must advance global consistently",
                },
            });
        }
        for (const [field, value] of Object.entries(aggregate)) {
            if (!Number.isSafeInteger(value) || (value as number) < 0) {
                throw new PermissionCoreError("PERSISTED_STATE_INVALID", "The scope aggregate update is invalid.", {
                    details: {
                        kind: "persisted-state-invalid",
                        stage: "aggregate-counter",
                        reason: `${field} must be a non-negative safe integer`,
                    },
                });
            }
            if (
                (field === "menuNodeCount" && (value as number) > MAX_MENU_NODE_COUNT)
                || (field === "apiBindingCount" && (value as number) > MAX_API_BINDING_COUNT)
                || (
                    field === "replaceManifestBytes"
                    && ((value as number) < EMPTY_REPLACE_MANIFEST_BYTES || (value as number) > MAX_REPLACE_MANIFEST_BYTES)
                )
            ) {
                throw new PermissionCoreError("LIMIT_EXCEEDED", "The scope aggregate update exceeds the v2 limit.", {
                    details: {
                        kind: "limit-exceeded",
                        origin: "persisted-authorization-state",
                        limitName: field,
                        current: value as number,
                        max: field === "menuNodeCount"
                            ? MAX_MENU_NODE_COUNT
                            : field === "apiBindingCount" ? MAX_API_BINDING_COUNT : MAX_REPLACE_MANIFEST_BYTES,
                        unit: field === "replaceManifestBytes" ? "bytes" : "items",
                    },
                });
            }
        }
        if (expectedAggregate !== undefined) {
            for (const [field, value] of Object.entries(expectedAggregate)) {
                if (!Number.isSafeInteger(value) || value < 0) {
                    throw new PermissionCoreError("PERSISTED_STATE_INVALID", "The expected scope aggregate is invalid.", {
                        details: {
                            kind: "persisted-state-invalid",
                            stage: "aggregate-counter",
                            reason: `${field} must be a non-negative safe integer`,
                        },
                    });
                }
            }
        }

        const scope = normalizeScope(scopeInput);
        const scopeKey = createScopeKey(scope);
        const result = await this.collection.updateOne({
            scopeKey,
            schemaVersion: PERSISTED_SCHEMA_VERSION,
            schemeContractDigest: this.contract.schemeContractDigest,
            schemaContractKey: this.contract.schemaContractKey,
            revision: expected.global,
            rbacRevision: expected.rbac,
            menuRevision: expected.menu,
            auditRevision: expected.audit,
            ...(expectedAggregate ?? {}),
        }, {
            $inc: {
                revision: increments.global,
                rbacRevision: increments.rbac,
                menuRevision: increments.menu,
                auditRevision: increments.audit,
            },
            $set: { ...aggregate, updatedAt: now },
        }, writeOptions(session));

        if (result.matchedCount !== 1) {
            const current = await this.read(scope, session);
            const currentVector = vectorOf(current);
            if (canonicalString(expected) !== canonicalString(currentVector)) {
                revisionConflict(expected, currentVector);
            }
            if (expectedAggregate !== undefined) {
                const aggregateField = (["menuNodeCount", "apiBindingCount", "replaceManifestBytes"] as const)
                    .find((field) => expectedAggregate[field] !== current[field]);
                if (aggregateField !== undefined) {
                    persistedStateInvalid(`${aggregateField} changed without a matching scope revision`);
                }
            }
            persistedStateInvalid("scope state CAS failed without an observable revision or aggregate change");
        }

        const postImage = await this.read(scope, session);
        const expectedPost: InternalScopeRevisionVector = {
            global: expected.global + increments.global,
            rbac: expected.rbac + increments.rbac,
            menu: expected.menu + increments.menu,
            audit: expected.audit + increments.audit,
        };
        const currentPost = vectorOf(postImage);
        if (canonicalString(expectedPost) !== canonicalString(currentPost)) {
            persistedStateInvalid("revision post-image does not match the committed increment");
        }
        for (const [field, value] of Object.entries(aggregate)) {
            if (postImage[field as keyof ScopeStateView] !== value) {
                persistedStateInvalid(`${field} post-image does not match the committed aggregate`);
            }
        }
        if (postImage.updatedAt !== now) {
            persistedStateInvalid("updatedAt post-image does not match Mongo server time");
        }
        return postImage;
    }
}
