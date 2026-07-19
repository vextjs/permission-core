import type { MonSQLizeInstance } from "monsqlize";

export type BuiltInPermissionAction =
    | "invoke"
    | "read"
    | "create"
    | "update"
    | "delete"
    | "write"
    | "manage";

export type PermissionAction = BuiltInPermissionAction | (string & {});
export type PermissionRuleAction = PermissionAction | "*";

export interface ResourceSchemeProbe {
    pattern: string;
    resource: string;
    expected: boolean;
}

export interface ResourceSchemeDefinition {
    scheme: string;
    version: string;
    probes: readonly ResourceSchemeProbe[];
    validate(resource: string): boolean;
    match(pattern: string, resource: string): boolean;
}

export type PermissionSemanticCacheOptions =
    | {
        enabled: false;
        ttlMs?: never;
        consistency?: never;
    }
    | {
        enabled: true;
        ttlMs?: number;
        consistency: "ordered-bounded-stale";
    };

export interface PermissionCoreOptions {
    monsqlize: MonSQLizeInstance;
    collectionPrefix?: string;
    cache?: PermissionSemanticCacheOptions;
    closeDrainTimeoutMs?: number;
    tokenSecret?: string | Uint8Array;
    resourceSchemes?: ResourceSchemeDefinition[];
}

export interface PermissionScope {
    tenantId: string;
    appId?: string;
    moduleId?: string;
    namespace?: string;
}

export type PolicyScalar = null | boolean | number | string;
export type PolicyValue =
    | PolicyScalar
    | readonly PolicyValue[]
    | Readonly<{ [key: string]: PolicyValue }>;

export interface PermissionSubject {
    userId: string;
    scope: PermissionScope;
    claims?: Readonly<Record<string, PolicyValue>>;
}

export type PolicyContext = Readonly<Record<string, PolicyValue>>;
export type PermissionCoreLifecycle = "new" | "initializing" | "ready" | "closing" | "closed";

export interface BoundedHealthCount {
    value: number;
    cap: 1000;
    truncated: boolean;
}

export interface PermissionCoreHealth {
    status: "up" | "degraded" | "down";
    lifecycle: PermissionCoreLifecycle;
    initialized: boolean;
    coreNamespaceHash?: string;
    namespace?: {
        identitySource: "monsqlize-collection-namespace";
        collectionPrefix: string;
        usesDefaultCollectionPrefix: boolean;
        schemeContractDigest: string;
    };
    database: {
        status: "up" | "down" | "unknown";
        lastCheckedAt?: number;
        errorCode?: string;
    };
    schema: {
        expectedVersion: 2;
        expectedSchemeContractDigest: string;
        expectedSchemaContractKey: string;
        indexedContractMismatchScopes: BoundedHealthCount;
        detectionCoverage: "supported-writer-state";
        lastMismatchScopeHash?: string;
        lastMismatchReason?: "schema-version" | "scheme-contract" | "contract-corrupt";
    };
    tokens: {
        keySource: "ephemeral" | "configured";
        crossInstanceStable: boolean;
    };
    cache: {
        permissionLayer: "enabled" | "bypassed";
        consistencyAssurance: "not-applicable" | "caller-attested";
        backendState: "opaque";
        readIncidentActive: boolean;
        invalidationIncidentActive: boolean;
        invalidationRiskUntil?: number;
        hits: number;
        misses: number;
        readFallbacks: number;
        invalidationFailures: number;
        lastDegradedAt?: number;
        backendStats?: Readonly<Record<string, number>>;
    };
    audit: {
        pendingCacheOutcomes: BoundedHealthCount;
    };
    lastInitError?: {
        code: string;
        message: string;
    };
}
