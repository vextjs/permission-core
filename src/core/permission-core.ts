import type { CacheLike, HealthView, MonSQLizeInstance } from "monsqlize";
import type {
    BoundedHealthCount,
    EffectivePermissionSnapshot,
    EffectiveResourcePattern,
    PermissionAction,
    PermissionCoreHealth,
    PermissionCoreLifecycle,
    PermissionCoreOptions,
    PermissionExplanation,
    PermissionScope,
    PermissionSubject,
    PolicyContext,
    SubjectPermissionContext,
    SubjectRuntimeResult,
    ScopedPermissionContext,
} from "../types";
import { ResourceSchemeRegistry } from "../check/resource-schemes";
import { PermissionSemanticCache } from "../cache";
import {
    CANONICAL_CONTRACT_VERSION,
    digestCanonical,
} from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import { SignedTokenCodec } from "../internal/signed-token";
import { createSubjectDataRuntime } from "../data";
import {
    ApiBindingImpactMutationService,
    ApiBindingMutationService,
    MenuManifestService,
    MenuNodeImpactMutationService,
    MenuNodeMutationService,
    MenuQueryService,
    RoleMenuAuthorizationResolver,
    RoleMenuPermissionMutationService,
    RoleMenuPermissionQueryService,
    RoleMenuPermissionRepairService,
    StructuralStaleReferenceService,
} from "../menu";
import { PermissionRepository } from "../persistence/repository";
import { RbacQueryService } from "../rbac/queries";
import { RbacPreviewService } from "../rbac/preview";
import { createScopedPermissionContext, createSubjectPermissionContext, type ScopedRbacServices } from "../rbac/public-context";
import { RoleMutationService } from "../rbac/role-mutations";
import { RuleMutationService } from "../rbac/rule-mutations";
import { UserRoleMutationService } from "../rbac/user-role-mutations";
import { normalizePolicyContext, normalizeScope, normalizeSubject } from "../scope/scope";
import {
    resolvePermissionCoreOptions,
    type ResolvedPermissionCoreOptions,
} from "./config";
import { PermissionCoreError } from "./errors";

interface MutableDatabaseHealth {
    status: "up" | "down" | "unknown";
    lastCheckedAt?: number;
    errorCode?: string;
}

const EMPTY_BOUNDED_HEALTH_COUNT: BoundedHealthCount = Object.freeze({
    value: 0,
    cap: 1000 as const,
    truncated: false,
});

const REQUIRED_MONSQLIZE_METHODS = [
    "collection",
    "db",
    "getDefaults",
    "health",
    "withTransaction",
] as const;

const REQUIRED_CACHE_METHODS = ["get", "set", "del", "delPattern"] as const;

function unsupported(field: string, reason: string): PermissionCoreError {
    return new PermissionCoreError(
        "MONSQLIZE_CONTRACT_UNSUPPORTED",
        `MonSQLize contract is missing ${field}: ${reason}.`,
        { details: { kind: "validation", field, reason } },
    );
}

function assertMonSQLizeCapabilities(monsqlize: MonSQLizeInstance) {
    const runtime = monsqlize as unknown as Record<string, unknown>;
    for (const method of REQUIRED_MONSQLIZE_METHODS) {
        if (typeof runtime[method] !== "function") {
            throw unsupported(`monsqlize.${method}`, "function is required");
        }
    }

    let defaults: unknown;
    try {
        defaults = monsqlize.getDefaults();
    } catch (cause) {
        throw new PermissionCoreError(
            "MONSQLIZE_CONTRACT_UNSUPPORTED",
            "MonSQLize getDefaults() failed during capability probing.",
            { details: { kind: "validation", field: "monsqlize.getDefaults", reason: "call failed" }, cause },
        );
    }
    if (defaults === null || typeof defaults !== "object" || Array.isArray(defaults)) {
        throw unsupported("monsqlize.getDefaults", "must return an object snapshot");
    }
    const findMaxLimit = (defaults as Record<string, unknown>).findMaxLimit;
    if (!Number.isSafeInteger(findMaxLimit) || (findMaxLimit as number) < 1) {
        throw unsupported("monsqlize.getDefaults().findMaxLimit", "must be a positive safe integer");
    }

    let database: unknown;
    try {
        database = monsqlize.db();
    } catch (cause) {
        throw new PermissionCoreError(
            "MONSQLIZE_CONTRACT_UNSUPPORTED",
            "MonSQLize db() failed during capability probing.",
            { details: { kind: "validation", field: "monsqlize.db", reason: "call failed" }, cause },
        );
    }
    if (database === null || typeof database !== "object" || typeof (database as Record<string, unknown>).admin !== "function") {
        throw unsupported("monsqlize.db().admin", "database admin accessor is required");
    }
    let admin: unknown;
    try {
        admin = (database as { admin(): unknown }).admin();
    } catch (cause) {
        throw new PermissionCoreError(
            "MONSQLIZE_CONTRACT_UNSUPPORTED",
            "MonSQLize db().admin() failed during capability probing.",
            { details: { kind: "validation", field: "monsqlize.db().admin", reason: "call failed" }, cause },
        );
    }
    if (admin === null || typeof admin !== "object" || typeof (admin as Record<string, unknown>).serverStatus !== "function") {
        throw unsupported("monsqlize.db().admin().serverStatus", "function is required");
    }
    const configuredMaxTimeMS = (defaults as Record<string, unknown>).maxTimeMS;
    const maxTimeMS = configuredMaxTimeMS === undefined ? 2_000 : configuredMaxTimeMS;
    if (!Number.isSafeInteger(maxTimeMS) || (maxTimeMS as number) < 1) {
        throw unsupported("monsqlize.getDefaults().maxTimeMS", "must be a positive safe integer when provided");
    }
    return Object.freeze({ findMaxLimit: findMaxLimit as number, maxTimeMS: maxTimeMS as number });
}

function assertCacheCapabilities(cache: CacheLike) {
    if (cache === null || typeof cache !== "object") {
        throw unsupported("monsqlize.getCache", "must return a cache object");
    }
    const runtime = cache as unknown as Record<string, unknown>;
    for (const method of REQUIRED_CACHE_METHODS) {
        if (typeof runtime[method] !== "function") {
            throw unsupported(`monsqlize.getCache().${method}`, "function is required when permission cache is enabled");
        }
    }
}

function isPermissionCoreError(value: unknown): value is PermissionCoreError {
    return value instanceof PermissionCoreError;
}

function databaseUnavailable(cause?: unknown) {
    return new PermissionCoreError(
        "DATABASE_UNAVAILABLE",
        "MonSQLize health check did not report an available connection.",
        {
            details: { kind: "database-failure", stage: "health" },
            cause,
        },
    );
}

function validateHealthView(value: HealthView): value is HealthView {
    return value !== null
        && typeof value === "object"
        && (value.status === "up" || value.status === "down")
        && typeof value.connected === "boolean";
}

function waitWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
        timer.unref?.();
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

export class PermissionCore {
    private readonly options: ResolvedPermissionCoreOptions;
    private readonly schemes: ResourceSchemeRegistry;
    private readonly schemaContractKey: string;
    private lifecycle: PermissionCoreLifecycle = "new";
    private databaseHealth: MutableDatabaseHealth = { status: "unknown" };
    private indexedContractMismatchScopes = EMPTY_BOUNDED_HEALTH_COUNT;
    private pendingCacheOutcomes = EMPTY_BOUNDED_HEALTH_COUNT;
    private lastMismatchScopeHash?: string;
    private coreNamespaceHash?: string;
    private dataMaxTimeMS?: number;
    private repository?: PermissionRepository;
    private queryService?: RbacQueryService;
    private rbacServices?: ScopedRbacServices;
    private semanticCache?: PermissionSemanticCache;
    private initPromise?: Promise<PermissionCoreHealth>;
    private closePromise?: Promise<void>;
    private closeRequested = false;
    private activeOperationLeases = 0;
    private readonly operationDrainWaiters = new Set<() => void>();
    private lastInitError?: { code: string; message: string };

    constructor(options: PermissionCoreOptions) {
        this.options = resolvePermissionCoreOptions(options);
        this.schemes = new ResourceSchemeRegistry(this.options.resourceSchemes);
        this.schemaContractKey = digestCanonical({
            canonicalContractVersion: CANONICAL_CONTRACT_VERSION,
            schemaVersion: 2,
            schemeContractDigest: this.schemes.schemeContractDigest,
        });
    }

    async init(): Promise<PermissionCoreHealth> {
        if (this.lifecycle === "closing" || this.lifecycle === "closed" || this.closeRequested) {
            throw new PermissionCoreError("CORE_CLOSED", "PermissionCore is closing or closed.");
        }
        if (this.lifecycle === "ready") {
            return this.snapshotHealth();
        }
        if (this.initPromise) {
            return this.initPromise;
        }

        this.lifecycle = "initializing";
        const operation = this.performInit();
        this.initPromise = operation;
        try {
            return await operation;
        } finally {
            if (this.initPromise === operation) {
                this.initPromise = undefined;
            }
        }
    }

    private async performInit() {
        try {
            const capabilities = assertMonSQLizeCapabilities(this.options.monsqlize);
            this.schemes.verifyProbes();
            const repository = new PermissionRepository(
                this.options.monsqlize,
                this.options.collectionPrefix,
                {
                    schemeContractDigest: this.schemes.schemeContractDigest,
                    schemaContractKey: this.schemaContractKey,
                },
                capabilities.findMaxLimit,
            );
            const namespace = repository.getScopeStateNamespace();
            const coreNamespaceHash = digestCanonical({
                version: 2,
                namespace,
                collectionPrefix: this.options.collectionPrefix,
                schemeContractDigest: this.schemes.schemeContractDigest,
            });

            let cache: CacheLike | undefined;
            if (this.options.cache.enabled) {
                try {
                    cache = this.options.monsqlize.getCache();
                } catch (cause) {
                    throw new PermissionCoreError(
                        "MONSQLIZE_CONTRACT_UNSUPPORTED",
                        "MonSQLize getCache() failed while permission cache was enabled.",
                        { details: { kind: "validation", field: "monsqlize.getCache", reason: "call failed" }, cause },
                    );
                }
                assertCacheCapabilities(cache);
            }
            const semanticCache = cache === undefined
                ? undefined
                : new PermissionSemanticCache(
                    cache,
                    coreNamespaceHash,
                    this.options.cache.enabled ? this.options.cache.ttlMs : 0,
                    this.schemes,
                );
            const invalidateCache = semanticCache === undefined
                ? undefined
                : (targets: readonly string[]) => semanticCache.invalidate(targets);

            await this.refreshDatabaseHealth(true);
            await repository.ensureIndexes();
            await repository.getDatabaseTime();
            await repository.probeTransaction();
            const repositoryHealth = await repository.readHealth(this.schemaContractKey);
            this.indexedContractMismatchScopes = repositoryHealth.indexedContractMismatchScopes;
            this.pendingCacheOutcomes = repositoryHealth.pendingCacheOutcomes;
            this.lastMismatchScopeHash = repositoryHealth.lastMismatchScopeHash;
            this.repository = repository;
            const tokens = new SignedTokenCodec(this.options.tokenSecret, coreNamespaceHash);
            const roleMenuResolver = new RoleMenuAuthorizationResolver(repository, this.schemes);
            const queryService = new RbacQueryService(
                repository,
                this.schemes,
                tokens,
                roleMenuResolver,
            );
            const roleMutations = new RoleMutationService(repository, this.schemes, invalidateCache);
            const ruleMutations = new RuleMutationService(
                repository,
                this.schemes,
                invalidateCache,
                roleMenuResolver,
            );
            this.queryService = queryService;
            const menuQueries = new MenuQueryService(repository, this.schemes, tokens);
            const menuNodes = new MenuNodeMutationService(repository, this.schemes, invalidateCache);
            const menuNodeImpacts = new MenuNodeImpactMutationService(repository, this.schemes, tokens, invalidateCache);
            const apiBindings = new ApiBindingMutationService(repository, this.schemes, invalidateCache);
            const apiBindingImpacts = new ApiBindingImpactMutationService(repository, this.schemes, tokens, invalidateCache);
            const menuManifest = new MenuManifestService(repository, this.schemes, tokens, invalidateCache);
            const staleReferences = new StructuralStaleReferenceService(repository, this.schemes, tokens, invalidateCache);
            this.rbacServices = Object.freeze({
                queries: queryService,
                roles: roleMutations,
                previews: new RbacPreviewService(repository, this.schemes, tokens, roleMutations, ruleMutations),
                userRoles: new UserRoleMutationService(repository, this.schemes, invalidateCache),
                roleMenu: Object.freeze({
                    mutations: new RoleMenuPermissionMutationService(repository, this.schemes, tokens, invalidateCache),
                    queries: new RoleMenuPermissionQueryService(
                        repository,
                        this.schemes,
                        tokens,
                        roleMenuResolver,
                    ),
                    repair: new RoleMenuPermissionRepairService(repository, this.schemes, tokens, invalidateCache),
                }),
                menuManagement: Object.freeze({
                    queries: menuQueries,
                    nodes: menuNodes,
                    nodeImpacts: menuNodeImpacts,
                    bindings: apiBindings,
                    bindingImpacts: apiBindingImpacts,
                    manifest: menuManifest,
                    stale: staleReferences,
                }),
            });
            this.semanticCache = semanticCache;
            this.coreNamespaceHash = coreNamespaceHash;
            this.dataMaxTimeMS = capabilities.maxTimeMS;
            this.lastInitError = undefined;
            if (this.lifecycle === "initializing") {
                this.lifecycle = "ready";
            }
            return this.snapshotHealth();
        } catch (error) {
            const normalized = isPermissionCoreError(error)
                ? error
                : databaseUnavailable(error);
            this.lastInitError = { code: normalized.code, message: normalized.message };
            if (this.lifecycle === "initializing") {
                this.lifecycle = "new";
            }
            throw normalized;
        }
    }

    private async refreshDatabaseHealth(throwOnDown: boolean) {
        const checkedAt = Date.now();
        try {
            const health = await this.options.monsqlize.health();
            if (!validateHealthView(health)) {
                throw unsupported("monsqlize.health", "must return the documented HealthView");
            }
            if (health.status !== "up" || !health.connected) {
                this.databaseHealth = {
                    status: "down",
                    lastCheckedAt: checkedAt,
                    errorCode: "DATABASE_UNAVAILABLE",
                };
                if (throwOnDown) {
                    throw databaseUnavailable();
                }
                return;
            }
            this.databaseHealth = { status: "up", lastCheckedAt: checkedAt };
        } catch (error) {
            if (isPermissionCoreError(error) && error.code === "MONSQLIZE_CONTRACT_UNSUPPORTED") {
                throw error;
            }
            this.databaseHealth = {
                status: "down",
                lastCheckedAt: checkedAt,
                errorCode: "DATABASE_UNAVAILABLE",
            };
            if (throwOnDown) {
                throw isPermissionCoreError(error) ? error : databaseUnavailable(error);
            }
        }
    }

    async health(): Promise<PermissionCoreHealth> {
        if (this.lifecycle === "ready") {
            await this.refreshDatabaseHealth(false);
            if (this.databaseHealth.status === "up" && this.repository) {
                try {
                    const repositoryHealth = await this.repository.readHealth(this.schemaContractKey);
                    this.indexedContractMismatchScopes = repositoryHealth.indexedContractMismatchScopes;
                    this.pendingCacheOutcomes = repositoryHealth.pendingCacheOutcomes;
                    this.lastMismatchScopeHash = repositoryHealth.lastMismatchScopeHash;
                } catch {
                    this.databaseHealth = {
                        status: "down",
                        lastCheckedAt: Date.now(),
                        errorCode: "DATABASE_UNAVAILABLE",
                    };
                }
            }
        }
        return this.snapshotHealth();
    }

    forSubject(subject: PermissionSubject, context?: PolicyContext): SubjectPermissionContext {
        const queryService = this.requireQueryService();
        const repository = this.requireRepository();
        const normalizedSubject = normalizeSubject(subject);
        const normalizedContext = normalizePolicyContext(context);
        const coreNamespaceHash = this.coreNamespaceHash;
        const dataMaxTimeMS = this.dataMaxTimeMS;
        if (!coreNamespaceHash || dataMaxTimeMS === undefined) {
            throw new PermissionCoreError("NOT_INITIALIZED", "PermissionCore data runtime is unavailable.");
        }
        const run = <T>(operation: () => Promise<T>) => this.runPermissionOperation(operation);
        const data = createSubjectDataRuntime({
            monsqlize: this.options.monsqlize,
            repository,
            queryService,
            schemes: this.schemes,
            subject: normalizedSubject,
            context: normalizedContext,
            run,
            coreNamespaceHash,
            tokenSecret: this.options.tokenSecret,
            maxTimeMS: dataMaxTimeMS,
        });
        return createSubjectPermissionContext(
            repository,
            queryService,
            this.schemes,
            normalizedSubject,
            normalizedContext,
            (operation) => this.runPermissionOperation(operation),
            data,
            this.semanticCache,
        );
    }

    scope(scopeInput: PermissionScope): ScopedPermissionContext {
        const services = this.requireRbacServices();
        const scope = normalizeScope(scopeInput);
        return createScopedPermissionContext(
            scope,
            services,
            (operation) => this.runPermissionOperation(operation),
        );
    }

    can(subject: PermissionSubject, action: PermissionAction, resource: string, context?: PolicyContext) {
        return this.forSubject(subject, context).can(action, resource);
    }

    cannot(subject: PermissionSubject, action: PermissionAction, resource: string, context?: PolicyContext) {
        return this.forSubject(subject, context).cannot(action, resource);
    }

    assert(subject: PermissionSubject, action: PermissionAction, resource: string, context?: PolicyContext) {
        return this.forSubject(subject, context).assert(action, resource);
    }

    getPermissions(
        subject: PermissionSubject,
        context?: PolicyContext,
    ): Promise<SubjectRuntimeResult<EffectivePermissionSnapshot>> {
        return this.forSubject(subject, context).getPermissions();
    }

    getResources(
        subject: PermissionSubject,
        action?: PermissionAction,
        context?: PolicyContext,
    ): Promise<SubjectRuntimeResult<EffectiveResourcePattern[]>> {
        return this.forSubject(subject, context).getResources(action);
    }

    explain(
        subject: PermissionSubject,
        action: PermissionAction,
        resource: string,
        context?: PolicyContext,
    ): Promise<SubjectRuntimeResult<PermissionExplanation>> {
        return this.forSubject(subject, context).explain(action, resource);
    }

    private requireQueryService() {
        if (this.lifecycle === "closing" || this.lifecycle === "closed" || this.closeRequested) {
            throw new PermissionCoreError("CORE_CLOSED", "PermissionCore is closing or closed.");
        }
        if (this.lifecycle !== "ready" || !this.queryService) {
            throw new PermissionCoreError("NOT_INITIALIZED", "PermissionCore has not been initialized.");
        }
        return this.queryService;
    }

    private requireRepository() {
        this.requireQueryService();
        if (!this.repository) {
            throw new PermissionCoreError("NOT_INITIALIZED", "PermissionCore repository is unavailable.");
        }
        return this.repository;
    }

    private requireRbacServices() {
        this.requireQueryService();
        if (!this.rbacServices) {
            throw new PermissionCoreError("NOT_INITIALIZED", "PermissionCore RBAC services are unavailable.");
        }
        return this.rbacServices;
    }

    private async runPermissionOperation<T>(operation: () => Promise<T>): Promise<T> {
        this.requireQueryService();
        this.activeOperationLeases += 1;
        try {
            return await operation();
        } finally {
            this.activeOperationLeases -= 1;
            if (this.activeOperationLeases === 0) {
                for (const resolve of this.operationDrainWaiters) {
                    resolve();
                }
                this.operationDrainWaiters.clear();
            }
        }
    }

    async close(): Promise<void> {
        if (this.lifecycle === "closed") {
            return;
        }
        if (this.closePromise) {
            return this.closePromise;
        }

        this.closeRequested = true;
        this.lifecycle = "closing";
        const operation = this.performClose();
        this.closePromise = operation;
        try {
            await operation;
        } finally {
            if (this.closePromise === operation) {
                this.closePromise = undefined;
            }
        }
    }

    private async performClose() {
        const startedAt = Date.now();
        const pendingInit = this.initPromise;
        if (pendingInit) {
            const remaining = Math.max(0, this.options.closeDrainTimeoutMs - (Date.now() - startedAt));
            try {
                await waitWithin(pendingInit.catch(() => undefined), remaining);
            } catch {
                throw new PermissionCoreError(
                    "CORE_CLOSE_TIMEOUT",
                    "PermissionCore close drain timed out.",
                    {
                        details: {
                            kind: "close-timeout",
                            timeoutMs: this.options.closeDrainTimeoutMs,
                            activeOperationLeases: 0,
                            activeBorrowedTransactions: 0,
                        },
                    },
                );
            }
        }

        if (this.activeOperationLeases > 0) {
            const remaining = Math.max(0, this.options.closeDrainTimeoutMs - (Date.now() - startedAt));
            try {
                await waitWithin(new Promise<void>((resolve) => {
                    if (this.activeOperationLeases === 0) {
                        resolve();
                    } else {
                        this.operationDrainWaiters.add(resolve);
                    }
                }), remaining);
            } catch {
                throw new PermissionCoreError(
                    "CORE_CLOSE_TIMEOUT",
                    "PermissionCore close drain timed out.",
                    {
                        details: {
                            kind: "close-timeout",
                            timeoutMs: this.options.closeDrainTimeoutMs,
                            activeOperationLeases: this.activeOperationLeases,
                            activeBorrowedTransactions: 0,
                        },
                    },
                );
            }
        }

        this.repository = undefined;
        this.queryService = undefined;
        this.rbacServices = undefined;
        this.semanticCache?.detach();
        this.dataMaxTimeMS = undefined;
        this.lifecycle = "closed";
    }

    private snapshotHealth(): PermissionCoreHealth {
        const ready = this.lifecycle === "ready";
        const database = { ...this.databaseHealth };
        const cacheHealth = this.semanticCache?.snapshotHealth(ready) ?? {
            readIncidentActive: false,
            invalidationIncidentActive: false,
            hits: 0,
            misses: 0,
            readFallbacks: 0,
            invalidationFailures: 0,
        };
        const degraded = ready
            && database.status === "up"
            && (
                this.indexedContractMismatchScopes.value > 0
                || this.pendingCacheOutcomes.value > 0
                || cacheHealth.readIncidentActive
                || cacheHealth.invalidationIncidentActive
            );
        const snapshot: PermissionCoreHealth = {
            status: !ready || database.status !== "up" ? "down" : degraded ? "degraded" : "up",
            lifecycle: this.lifecycle,
            initialized: ready,
            ...(this.coreNamespaceHash ? { coreNamespaceHash: this.coreNamespaceHash } : {}),
            ...(this.coreNamespaceHash ? {
                namespace: {
                    identitySource: "monsqlize-collection-namespace",
                    collectionPrefix: this.options.collectionPrefix,
                    usesDefaultCollectionPrefix: this.options.usesDefaultCollectionPrefix,
                    schemeContractDigest: this.schemes.schemeContractDigest,
                },
            } : {}),
            database,
            schema: {
                expectedVersion: 2,
                expectedSchemeContractDigest: this.schemes.schemeContractDigest,
                expectedSchemaContractKey: this.schemaContractKey,
                indexedContractMismatchScopes: { ...this.indexedContractMismatchScopes },
                detectionCoverage: "supported-writer-state",
                ...(this.lastMismatchScopeHash ? {
                    lastMismatchScopeHash: this.lastMismatchScopeHash,
                    lastMismatchReason: "scheme-contract" as const,
                } : {}),
            },
            tokens: {
                keySource: this.options.tokenKeySource,
                crossInstanceStable: this.options.tokenKeySource === "configured",
            },
            cache: {
                permissionLayer: this.options.cache.enabled ? "enabled" : "bypassed",
                consistencyAssurance: this.options.cache.enabled ? "caller-attested" : "not-applicable",
                backendState: "opaque",
                ...cacheHealth,
            },
            audit: {
                pendingCacheOutcomes: { ...this.pendingCacheOutcomes },
            },
            ...(this.lastInitError ? { lastInitError: { ...this.lastInitError } } : {}),
        };
        return deepFreeze(snapshot);
    }
}
