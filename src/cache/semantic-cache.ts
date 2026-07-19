import { types as utilTypes } from "node:util";
import type { CacheLike } from "monsqlize";
import type {
    ButtonPermissionState,
    PermissionSubject,
    PolicyContext,
    RoutePermissionState,
    SubjectRuntimeResult,
    VisibleMenuTreeNode,
} from "../types";
import { ResourceSchemeRegistry } from "../check/resource-schemes";
import { digestCanonical } from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import {
    createClaimsFingerprint,
    createContextFingerprint,
    createScopeKey,
} from "../scope/scope";
import type { EffectiveAuthorizationState } from "../rbac/effective";
import {
    MAX_SEMANTIC_CACHE_VALUE_BYTES,
    buttonMapSnapshotCodec,
    createSemanticCacheEnvelope,
    decodeSemanticCacheEnvelope,
    menuTreeSnapshotCodec,
    permissionSnapshotCodec,
    routeStateSnapshotCodec,
    sameRevisions,
    type SemanticCacheFamily,
    type SemanticCacheRevisions,
    type SemanticSnapshotCodec,
} from "./value-codec";

export interface CachedAuthorizationState extends SemanticCacheRevisions {
    readonly state: EffectiveAuthorizationState;
}

export interface PermissionSemanticCacheHealth {
    readonly readIncidentActive: boolean;
    readonly invalidationIncidentActive: boolean;
    readonly invalidationRiskUntil?: number;
    readonly hits: number;
    readonly misses: number;
    readonly readFallbacks: number;
    readonly invalidationFailures: number;
    readonly lastDegradedAt?: number;
    readonly backendStats?: Readonly<Record<string, number>>;
}

interface InternalMetrics extends PermissionSemanticCacheHealth {
    readonly writeFailures: number;
    readonly oversizedSkips: number;
}

type ParsedInvalidationTarget =
    | { readonly kind: "scope" | "rbac" | "menu"; readonly scopeHash: string }
    | { readonly kind: "user"; readonly scopeHash: string; readonly userHash: string };

const DIGEST = /^[A-Za-z0-9_-]{43}$/u;
const TARGET = /^scope:([A-Za-z0-9_-]{43})(?::(rbac|menu)|:user:([A-Za-z0-9_-]{43}))?$/u;
const MAX_INVALIDATION_TARGETS = 1_000;
const MAX_BACKEND_STATS = 32;
const FORBIDDEN_STATS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function increment(value: number) {
    return value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;
}

function parseTarget(value: unknown): ParsedInvalidationTarget {
    if (typeof value !== "string") throw new Error("Cache invalidation target must be a string.");
    const match = TARGET.exec(value);
    if (!match) throw new Error("Cache invalidation target has an invalid shape.");
    const scopeHash = match[1]!;
    const qualifier = match[2];
    const userHash = match[3];
    if (userHash !== undefined) return Object.freeze({ kind: "user" as const, scopeHash, userHash });
    return Object.freeze({ kind: (qualifier ?? "scope") as "scope" | "rbac" | "menu", scopeHash });
}

export class PermissionSemanticCache {
    private backend?: CacheLike;
    private readonly prefix: string;
    private hits = 0;
    private misses = 0;
    private readFallbacks = 0;
    private invalidationFailures = 0;
    private writeFailures = 0;
    private oversizedSkips = 0;
    private readIncidentActive = false;
    private invalidationIncidentActive = false;
    private invalidationRiskUntil?: number;
    private lastDegradedAt?: number;

    constructor(
        backend: CacheLike,
        coreNamespaceHash: string,
        private readonly ttlMs: number,
        private readonly schemes: ResourceSchemeRegistry,
    ) {
        if (!DIGEST.test(coreNamespaceHash)) {
            throw new Error("coreNamespaceHash must be a canonical SHA-256 digest.");
        }
        this.backend = backend;
        this.prefix = `permission-core:v2:${coreNamespaceHash}:`;
    }

    detach() {
        this.backend = undefined;
    }

    private scopePrefix(scopeHash: string) {
        return `${this.prefix}scope:${scopeHash}:`;
    }

    private userPrefix(scopeHash: string, userHash: string) {
        return `${this.scopePrefix(scopeHash)}user:${userHash}:`;
    }

    private subjectIdentity(subject: Readonly<PermissionSubject>) {
        const scopeHash = createScopeKey(subject.scope);
        const userHash = digestCanonical({ userId: subject.userId });
        return Object.freeze({ scopeHash, userHash, prefix: this.userPrefix(scopeHash, userHash) });
    }

    private permissionsKey(subject: Readonly<PermissionSubject>) {
        const identity = this.subjectIdentity(subject);
        return Object.freeze({
            ...identity,
            key: `${identity.prefix}permissions`,
        });
    }

    private viewKey(
        subject: Readonly<PermissionSubject>,
        context: PolicyContext,
        family: Exclude<SemanticCacheFamily, "permissions">,
        selector: unknown,
    ) {
        const identity = this.subjectIdentity(subject);
        const claimsHash = createClaimsFingerprint(subject);
        const contextHash = createContextFingerprint(context);
        const selectorHash = digestCanonical(selector);
        return `${identity.prefix}${family}:${claimsHash}:${contextHash}:${selectorHash}`;
    }

    private recordReadFailure() {
        this.readFallbacks = increment(this.readFallbacks);
        this.readIncidentActive = true;
        this.lastDegradedAt = Date.now();
    }

    private successfulRead() {
        this.readIncidentActive = false;
    }

    private async read<T>(input: {
        readonly key: string;
        readonly family: SemanticCacheFamily;
        readonly codec: SemanticSnapshotCodec<T>;
        readonly revisions?: SemanticCacheRevisions;
    }): Promise<{ readonly value: T; readonly revisions: SemanticCacheRevisions } | undefined> {
        const backend = this.backend;
        if (backend === undefined) {
            this.recordReadFailure();
            return undefined;
        }
        let raw: unknown;
        try {
            raw = await backend.get(input.key);
        } catch {
            this.recordReadFailure();
            return undefined;
        }
        if (raw === undefined) {
            this.successfulRead();
            this.misses = increment(this.misses);
            return undefined;
        }
        try {
            const decoded = await decodeSemanticCacheEnvelope({
                key: input.key,
                family: input.family,
                ttlMs: this.ttlMs,
                value: raw,
                codec: input.codec,
            });
            this.successfulRead();
            if (decoded.expired || (input.revisions !== undefined && !sameRevisions(decoded.revisions, input.revisions))) {
                this.misses = increment(this.misses);
                return undefined;
            }
            this.hits = increment(this.hits);
            return Object.freeze({ value: decoded.value, revisions: decoded.revisions });
        } catch {
            this.recordReadFailure();
            return undefined;
        }
    }

    private async write<T>(input: {
        readonly key: string;
        readonly family: SemanticCacheFamily;
        readonly revisions: SemanticCacheRevisions;
        readonly value: T;
        readonly codec: SemanticSnapshotCodec<T>;
    }) {
        const backend = this.backend;
        if (backend === undefined) {
            this.writeFailures = increment(this.writeFailures);
            this.lastDegradedAt = Date.now();
            return false;
        }
        let encoded: Awaited<ReturnType<typeof createSemanticCacheEnvelope<T>>>;
        try {
            encoded = await createSemanticCacheEnvelope({
                key: input.key,
                family: input.family,
                revisions: input.revisions,
                ttlMs: this.ttlMs,
                value: input.value,
                codec: input.codec,
            });
        } catch {
            this.writeFailures = increment(this.writeFailures);
            this.lastDegradedAt = Date.now();
            return false;
        }
        if (encoded.bytes > MAX_SEMANTIC_CACHE_VALUE_BYTES) {
            this.oversizedSkips = increment(this.oversizedSkips);
            return false;
        }
        try {
            await backend.set(input.key, encoded.envelope, this.ttlMs);
            return true;
        } catch {
            this.writeFailures = increment(this.writeFailures);
            this.lastDegradedAt = Date.now();
            return false;
        }
    }

    async getPermissions(subject: Readonly<PermissionSubject>): Promise<CachedAuthorizationState | undefined> {
        const identity = this.permissionsKey(subject);
        const cached = await this.read({
            key: identity.key,
            family: "permissions",
            codec: permissionSnapshotCodec(subject, identity.scopeHash, this.schemes),
        });
        return cached === undefined
            ? undefined
            : Object.freeze({
                state: cached.value,
                rbacRevision: cached.revisions.rbacRevision,
                menuRevision: cached.revisions.menuRevision,
            });
    }

    async setPermissions(
        subject: Readonly<PermissionSubject>,
        revisions: SemanticCacheRevisions,
        state: EffectiveAuthorizationState,
    ) {
        const identity = this.permissionsKey(subject);
        return this.write({
            key: identity.key,
            family: "permissions",
            revisions,
            value: state,
            codec: permissionSnapshotCodec(subject, identity.scopeHash, this.schemes),
        });
    }

    async getMenuTree(
        subject: Readonly<PermissionSubject>,
        context: PolicyContext,
        revisions: SemanticCacheRevisions,
        rootId: string | undefined,
    ) {
        const key = this.viewKey(subject, context, "menu-tree", { rootId: rootId ?? null });
        const cached = await this.read({
            key,
            family: "menu-tree",
            revisions,
            codec: menuTreeSnapshotCodec(this.schemes),
        });
        return cached?.value;
    }

    async setMenuTree(
        subject: Readonly<PermissionSubject>,
        context: PolicyContext,
        revisions: SemanticCacheRevisions,
        rootId: string | undefined,
        value: SubjectRuntimeResult<VisibleMenuTreeNode[]>,
    ) {
        const key = this.viewKey(subject, context, "menu-tree", { rootId: rootId ?? null });
        return this.write({ key, family: "menu-tree", revisions, value, codec: menuTreeSnapshotCodec(this.schemes) });
    }

    async getButtonMap(
        subject: Readonly<PermissionSubject>,
        context: PolicyContext,
        revisions: SemanticCacheRevisions,
        ownerNodeId: string,
    ) {
        const key = this.viewKey(subject, context, "button-map", { ownerNodeId });
        const cached = await this.read({
            key,
            family: "button-map",
            revisions,
            codec: buttonMapSnapshotCodec(this.schemes),
        });
        return cached?.value;
    }

    async setButtonMap(
        subject: Readonly<PermissionSubject>,
        context: PolicyContext,
        revisions: SemanticCacheRevisions,
        ownerNodeId: string,
        value: SubjectRuntimeResult<Readonly<Record<string, ButtonPermissionState>>>,
    ) {
        const key = this.viewKey(subject, context, "button-map", { ownerNodeId });
        return this.write({ key, family: "button-map", revisions, value, codec: buttonMapSnapshotCodec(this.schemes) });
    }

    async getRouteState(
        subject: Readonly<PermissionSubject>,
        context: PolicyContext,
        revisions: SemanticCacheRevisions,
        path: string,
    ) {
        const key = this.viewKey(subject, context, "route-state", { path });
        const cached = await this.read({
            key,
            family: "route-state",
            revisions,
            codec: routeStateSnapshotCodec(this.schemes),
        });
        return cached?.value;
    }

    async setRouteState(
        subject: Readonly<PermissionSubject>,
        context: PolicyContext,
        revisions: SemanticCacheRevisions,
        path: string,
        value: SubjectRuntimeResult<RoutePermissionState>,
    ) {
        const key = this.viewKey(subject, context, "route-state", { path });
        return this.write({ key, family: "route-state", revisions, value, codec: routeStateSnapshotCodec(this.schemes) });
    }

    private recordInvalidationFailure() {
        const now = Date.now();
        this.invalidationFailures = increment(this.invalidationFailures);
        this.invalidationIncidentActive = true;
        this.invalidationRiskUntil = Math.max(this.invalidationRiskUntil ?? 0, now + this.ttlMs);
        this.lastDegradedAt = now;
    }

    private successfulInvalidation() {
        if (
            this.invalidationIncidentActive
            && this.invalidationRiskUntil !== undefined
            && Date.now() >= this.invalidationRiskUntil
        ) {
            this.invalidationIncidentActive = false;
            this.invalidationRiskUntil = undefined;
        }
    }

    async invalidate(targets: readonly string[]): Promise<"completed"> {
        try {
            const uniqueTargets = [...new Set(targets)].sort(compareUtf8Strings);
            if (uniqueTargets.length > MAX_INVALIDATION_TARGETS) {
                throw new Error(`Cache invalidation cannot exceed ${MAX_INVALIDATION_TARGETS} targets.`);
            }
            const parsed = uniqueTargets.map(parseTarget);
            const backend = this.backend;
            if (backend === undefined) throw new Error("Permission cache is detached.");
            for (const target of parsed) {
                const scopePrefix = this.scopePrefix(target.scopeHash);
                if (target.kind === "user") {
                    const userPrefix = this.userPrefix(target.scopeHash, target.userHash);
                    await backend.del(`${userPrefix}permissions`);
                    await backend.delPattern(`${userPrefix}menu-tree:*`);
                    await backend.delPattern(`${userPrefix}button-map:*`);
                    await backend.delPattern(`${userPrefix}route-state:*`);
                    continue;
                }
                await backend.delPattern(`${scopePrefix}*`);
            }
            this.successfulInvalidation();
            return "completed";
        } catch (error) {
            this.recordInvalidationFailure();
            throw error;
        }
    }

    invalidateSubject(subject: Readonly<PermissionSubject>) {
        const identity = this.subjectIdentity(subject);
        return this.invalidate([`scope:${identity.scopeHash}:user:${identity.userHash}`]);
    }

    private backendStats(): Readonly<Record<string, number>> | undefined {
        const backend = this.backend as (CacheLike & { getStats?: () => unknown }) | undefined;
        if (backend === undefined || typeof backend.getStats !== "function") return undefined;
        try {
            const value = backend.getStats();
            if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) {
                return undefined;
            }
            const prototype = Object.getPrototypeOf(value);
            if (prototype !== Object.prototype && prototype !== null) return undefined;
            const keys = Reflect.ownKeys(value);
            if (keys.length > MAX_BACKEND_STATS) return undefined;
            const stats: Record<string, number> = {};
            for (const key of keys) {
                if (typeof key !== "string") return undefined;
                const descriptor = Object.getOwnPropertyDescriptor(value, key);
                const item = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
                if (
                    FORBIDDEN_STATS_KEYS.has(key)
                    || !descriptor?.enumerable
                    || !("value" in descriptor)
                    || typeof item !== "number"
                    || !Number.isFinite(item)
                    || item < 0
                ) {
                    return undefined;
                }
                stats[key] = item;
            }
            return deepFreeze(stats);
        } catch {
            return undefined;
        }
    }

    snapshotHealth(includeBackendStats: boolean): PermissionSemanticCacheHealth {
        const backendStats = includeBackendStats ? this.backendStats() : undefined;
        return deepFreeze({
            readIncidentActive: this.readIncidentActive,
            invalidationIncidentActive: this.invalidationIncidentActive,
            ...(this.invalidationRiskUntil === undefined ? {} : { invalidationRiskUntil: this.invalidationRiskUntil }),
            hits: this.hits,
            misses: this.misses,
            readFallbacks: this.readFallbacks,
            invalidationFailures: this.invalidationFailures,
            ...(this.lastDegradedAt === undefined ? {} : { lastDegradedAt: this.lastDegradedAt }),
            ...(backendStats === undefined ? {} : { backendStats }),
        });
    }

    snapshotMetrics(): InternalMetrics {
        return deepFreeze({
            ...this.snapshotHealth(false),
            writeFailures: this.writeFailures,
            oversizedSkips: this.oversizedSkips,
        });
    }
}

function compareUtf8Strings(left: string, right: string) {
    return Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8"));
}
