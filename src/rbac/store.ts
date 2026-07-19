import type { MongoSession } from "monsqlize";
import type { PermissionScope, RuleSourceView } from "../types";
import { PermissionCoreError } from "../core/errors";
import { ResourceSchemeRegistry } from "../check/resource-schemes";
import { canonicalString, compareUtf8 } from "../internal/canonical";
import { SIMPLE_COLLATION } from "../persistence/indexes";
import { mapDatabaseReadError, type PermissionRepository } from "../persistence/repository";
import type { ScopeStateView } from "../persistence/scope-state";
import type { InternalRoleDocument, InternalRoleRuleDocument } from "../persistence/documents";
import {
    createVirtualUserRoleSet,
    materializeRoleDocument,
    materializeRoleRuleDocument,
    materializeUserRoleSetDocument,
    type InternalUserRoleSetView,
} from "./materialize";
import { normalizeRbacId } from "./validation";

export const MAX_DIRECT_ROLES = 128;
export const MAX_ROLE_CHAIN_DEPTH = 32;
export const MAX_RULES_PER_ROLE = 2048;
export const MAX_EFFECTIVE_ROLES = 1024;
export const MAX_EFFECTIVE_RULES = 20_000;
export const MAX_EFFECTIVE_SOURCES = 50_000;
export const MAX_EFFECTIVE_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const RBAC_READ_PAGE_SIZE = 200;

function readOptions(session?: MongoSession) {
    return {
        cache: 0,
        collation: SIMPLE_COLLATION,
        ...(session === undefined ? {} : { session }),
    };
}

function persistedInvalid(reason: string): never {
    throw new PermissionCoreError("PERSISTED_STATE_INVALID", "Persisted RBAC state is inconsistent.", {
        details: { kind: "persisted-state-invalid", stage: "load", reason },
    });
}

function databaseReadFailure(message: string, cause: unknown): never {
    throw mapDatabaseReadError(message, cause);
}

export interface ResolvedAuthorizationRules {
    readonly rules: readonly Readonly<InternalRoleRuleDocument>[];
    readonly sourceViews: ReadonlyMap<string, RuleSourceView>;
}

export interface RbacAuthorizationResolver {
    resolveAuthorization(
        reader: RbacScopeReader,
        roleIds: readonly string[],
        rules: readonly Readonly<InternalRoleRuleDocument>[],
    ): Promise<ResolvedAuthorizationRules>;
    resolveManagement(
        reader: RbacScopeReader,
        roleIds: readonly string[],
        rules: readonly Readonly<InternalRoleRuleDocument>[],
    ): Promise<ResolvedAuthorizationRules>;
}

export class RbacScopeReader {
    readonly state: ScopeStateView;
    private readonly repository: PermissionRepository;
    private readonly resourceSchemes: ResourceSchemeRegistry;
    private readonly session?: MongoSession;
    private readonly authorizationResolver?: RbacAuthorizationResolver;

    constructor(
        repository: PermissionRepository,
        resourceSchemes: ResourceSchemeRegistry,
        state: ScopeStateView,
        session?: MongoSession,
        authorizationResolver?: RbacAuthorizationResolver,
    ) {
        this.repository = repository;
        this.resourceSchemes = resourceSchemes;
        this.state = state;
        this.session = session;
        this.authorizationResolver = authorizationResolver;
    }

    databaseSession() {
        return this.session;
    }

    private assertScopeStateForRows(rowCount: number) {
        if (!this.state.persisted && rowCount > 0) {
            persistedInvalid("RBAC documents exist without their owning scope state");
        }
    }

    private pageSize(preferred: number) {
        return Math.min(preferred, this.repository.findMaxLimit);
    }

    async readRole(roleIdInput: unknown): Promise<Readonly<InternalRoleDocument> | null> {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        try {
            const raw = await this.repository.collections.roles.findOne(
                { scopeKey: this.state.scopeKey, roleId },
                readOptions(this.session),
            );
            this.assertScopeStateForRows(raw === null ? 0 : 1);
            return raw === null
                ? null
                : materializeRoleDocument(raw, this.state.scope, this.state.scopeKey);
        } catch (error) {
            return databaseReadFailure("The role read failed.", error);
        }
    }

    async requireRole(roleIdInput: unknown): Promise<Readonly<InternalRoleDocument>> {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        const role = await this.readRole(roleId);
        if (role === null) {
            throw new PermissionCoreError("ROLE_NOT_FOUND", `Role ${roleId} was not found.`);
        }
        return role;
    }

    async readRoles(roleIdInputs: readonly unknown[]) {
        const roleIds = [...new Set(roleIdInputs.map((value) => normalizeRbacId(value, "roleIds")))];
        if (roleIds.length === 0) {
            return new Map<string, Readonly<InternalRoleDocument>>();
        }
        if (roleIds.length > MAX_EFFECTIVE_ROLES) {
            throw new PermissionCoreError("LIMIT_EXCEEDED", "The role read exceeds the effective role limit.", {
                details: {
                    kind: "limit-exceeded",
                    origin: "persisted-authorization-state",
                    limitName: "effective-roles",
                    current: roleIds.length,
                    max: MAX_EFFECTIVE_ROLES,
                    unit: "items",
                },
            });
        }
        try {
            const expected = new Set(roleIds);
            const result = new Map<string, Readonly<InternalRoleDocument>>();
            const chunkSize = this.pageSize(roleIds.length);
            for (let offset = 0; offset < roleIds.length; offset += chunkSize) {
                const chunk = roleIds.slice(offset, offset + chunkSize);
                const rows = await this.repository.collections.roles.find({
                    scopeKey: this.state.scopeKey,
                    roleId: { $in: chunk },
                }, readOptions(this.session)).limit(chunk.length).toArray();
                this.assertScopeStateForRows(rows.length);
                if (rows.length > chunk.length) {
                    persistedInvalid("role batch read exceeded its bounded chunk");
                }
                for (const row of rows) {
                    const role = materializeRoleDocument(row, this.state.scope, this.state.scopeKey);
                    if (!expected.has(role.roleId) || result.has(role.roleId)) {
                        persistedInvalid("role batch read returned an unexpected identity");
                    }
                    result.set(role.roleId, role);
                }
            }
            return result;
        } catch (error) {
            return databaseReadFailure("The role batch read failed.", error);
        }
    }

    async readRulesForRoles(roleIdInputs: readonly unknown[]) {
        const roleIds = [...new Set(roleIdInputs.map((value) => normalizeRbacId(value, "roleIds")))]
            .sort(compareUtf8);
        if (roleIds.length === 0) {
            return Object.freeze([]) as readonly Readonly<InternalRoleRuleDocument>[];
        }
        try {
            const baseFilter = {
                scopeKey: this.state.scopeKey,
                roleId: { $in: roleIds },
            };
            const expected = new Set(roleIds);
            const perRole = new Map<string, number>();
            const seenSemanticKeys = new Map<string, Set<string>>();
            let sourceCount = 0;
            const rules: Readonly<InternalRoleRuleDocument>[] = [];
            let after: { roleId: string; semanticKey: string } | null = null;
            const pageSize = this.pageSize(RBAC_READ_PAGE_SIZE);
            while (true) {
                const filter = after === null
                    ? baseFilter
                    : {
                        $and: [
                            baseFilter,
                            {
                                $or: [
                                    { roleId: { $gt: after.roleId } },
                                    { roleId: after.roleId, semanticKey: { $gt: after.semanticKey } },
                                ],
                            },
                        ],
                    };
                const rows = await this.repository.collections.roleRules.find(
                    filter,
                    readOptions(this.session),
                )
                    .sort({ roleId: 1, semanticKey: 1 })
                    .limit(pageSize)
                    .toArray();
                this.assertScopeStateForRows(rows.length);
                if (rows.length > pageSize) {
                    persistedInvalid("rule keyset read exceeded its bounded page");
                }
                if (rows.length === 0) {
                    break;
                }
                for (const row of rows) {
                    const rule = materializeRoleRuleDocument(
                        row,
                        this.state.scope,
                        this.state.scopeKey,
                        this.resourceSchemes,
                    );
                    if (!expected.has(rule.roleId)) {
                        persistedInvalid("rule batch read returned an unexpected role identity");
                    }
                    if (
                        after !== null
                        && (
                            compareUtf8(rule.roleId, after.roleId) < 0
                            || (
                                rule.roleId === after.roleId
                                && compareUtf8(rule.semanticKey, after.semanticKey) <= 0
                            )
                        )
                    ) {
                        persistedInvalid("rule keyset read did not advance monotonically");
                    }
                    let roleSemanticKeys = seenSemanticKeys.get(rule.roleId);
                    if (roleSemanticKeys === undefined) {
                        roleSemanticKeys = new Set();
                        seenSemanticKeys.set(rule.roleId, roleSemanticKeys);
                    }
                    if (roleSemanticKeys.has(rule.semanticKey)) {
                        persistedInvalid("rule unique identity returned duplicate documents");
                    }
                    roleSemanticKeys.add(rule.semanticKey);
                    const roleCount = (perRole.get(rule.roleId) ?? 0) + 1;
                    if (roleCount > MAX_RULES_PER_ROLE) {
                        throw new PermissionCoreError("LIMIT_EXCEEDED", "A role exceeds its semantic rule limit.", {
                            details: {
                                kind: "limit-exceeded",
                                origin: "persisted-authorization-state",
                                limitName: "rules-per-role",
                                current: roleCount,
                                max: MAX_RULES_PER_ROLE,
                                unit: "items",
                            },
                        });
                    }
                    perRole.set(rule.roleId, roleCount);
                    sourceCount += rule.sources.length;
                    if (sourceCount > MAX_EFFECTIVE_SOURCES) {
                        throw new PermissionCoreError("LIMIT_EXCEEDED", "The effective source read exceeds its limit.", {
                            details: {
                                kind: "limit-exceeded",
                                origin: "persisted-authorization-state",
                                limitName: "effective-sources",
                                current: sourceCount,
                                max: MAX_EFFECTIVE_SOURCES,
                                unit: "items",
                            },
                        });
                    }
                    rules.push(rule);
                    if (rules.length > MAX_EFFECTIVE_RULES) {
                        throw new PermissionCoreError("LIMIT_EXCEEDED", "The effective rule read exceeds its limit.", {
                            details: {
                                kind: "limit-exceeded",
                                origin: "persisted-authorization-state",
                                limitName: "effective-rules",
                                current: rules.length,
                                max: MAX_EFFECTIVE_RULES,
                                unit: "items",
                            },
                        });
                    }
                    after = { roleId: rule.roleId, semanticKey: rule.semanticKey };
                }
                if (rows.length < pageSize) {
                    break;
                }
            }
            return Object.freeze(rules);
        } catch (error) {
            return databaseReadFailure("The role rule read failed.", error);
        }
    }

    async readRulesForRole(roleIdInput: unknown) {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        return this.readRulesForRoles([roleId]);
    }

    async resolveRulesForAuthorization(roleIdInputs: readonly unknown[]): Promise<ResolvedAuthorizationRules> {
        const roleIds = [...new Set(roleIdInputs.map((value) => normalizeRbacId(value, "roleIds")))]
            .sort(compareUtf8);
        const rules = await this.readRulesForRoles(roleIds);
        if (this.authorizationResolver === undefined) {
            return Object.freeze({ rules, sourceViews: new Map<string, RuleSourceView>() });
        }
        return this.authorizationResolver.resolveAuthorization(this, roleIds, rules);
    }

    async resolveRulesForManagement(
        roleIdInputs: readonly unknown[],
        rulesInput?: readonly Readonly<InternalRoleRuleDocument>[],
    ): Promise<ResolvedAuthorizationRules> {
        const roleIds = [...new Set(roleIdInputs.map((value) => normalizeRbacId(value, "roleIds")))]
            .sort(compareUtf8);
        const rules = rulesInput ?? await this.readRulesForRoles(roleIds);
        if (this.authorizationResolver === undefined) {
            return Object.freeze({ rules, sourceViews: new Map<string, RuleSourceView>() });
        }
        return this.authorizationResolver.resolveManagement(this, roleIds, rules);
    }

    async readManualRuleKeysForRole(roleIdInput: unknown) {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        const semanticKeys: string[] = [];
        let after: string | undefined;
        const pageSize = this.pageSize(RBAC_READ_PAGE_SIZE);
        try {
            while (true) {
                const base = {
                    scopeKey: this.state.scopeKey,
                    roleId,
                    sources: { $elemMatch: { kind: "manual" } },
                };
                const filter = after === undefined
                    ? base
                    : { $and: [base, { semanticKey: { $gt: after } }] };
                const rows = await this.repository.collections.roleRules.find(filter, {
                    ...readOptions(this.session),
                    projection: { _id: 0, roleId: 1, semanticKey: 1 },
                })
                    .sort({ semanticKey: 1 })
                    .limit(pageSize)
                    .toArray();
                this.assertScopeStateForRows(rows.length);
                if (rows.length > pageSize) {
                    persistedInvalid("manual rule keyset read exceeded its bounded page");
                }
                if (rows.length === 0) {
                    break;
                }
                for (const row of rows) {
                    if (
                        row.roleId !== roleId
                        || typeof row.semanticKey !== "string"
                        || !/^[A-Za-z0-9_-]{43}$/u.test(row.semanticKey)
                        || (after !== undefined && compareUtf8(row.semanticKey, after) <= 0)
                    ) {
                        persistedInvalid("manual rule keyset returned an invalid or non-monotonic identity");
                    }
                    after = row.semanticKey;
                    semanticKeys.push(row.semanticKey);
                    if (semanticKeys.length > MAX_RULES_PER_ROLE) {
                        throw new PermissionCoreError("LIMIT_EXCEEDED", "A role exceeds its semantic rule limit.", {
                            details: {
                                kind: "limit-exceeded",
                                origin: "persisted-authorization-state",
                                limitName: "rules-per-role",
                                current: semanticKeys.length,
                                max: MAX_RULES_PER_ROLE,
                                unit: "items",
                            },
                        });
                    }
                }
                if (rows.length < pageSize) {
                    break;
                }
            }
            return Object.freeze(semanticKeys);
        } catch (error) {
            return databaseReadFailure("The manual rule identity read failed.", error);
        }
    }

    async readRule(roleIdInput: unknown, semanticKey: unknown) {
        const roleId = normalizeRbacId(roleIdInput, "roleId");
        if (typeof semanticKey !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(semanticKey)) {
            throw new PermissionCoreError("INVALID_ARGUMENT", "semanticKey must be a canonical digest.", {
                details: {
                    kind: "validation",
                    field: "semanticKey",
                    reason: "must be a 43-character SHA-256 base64url digest",
                },
            });
        }
        try {
            const raw = await this.repository.collections.roleRules.findOne(
                { scopeKey: this.state.scopeKey, roleId, semanticKey },
                readOptions(this.session),
            );
            this.assertScopeStateForRows(raw === null ? 0 : 1);
            if (raw === null) {
                return null;
            }
            const rule = materializeRoleRuleDocument(
                raw,
                this.state.scope,
                this.state.scopeKey,
                this.resourceSchemes,
            );
            if (rule.roleId !== roleId || rule.semanticKey !== semanticKey) {
                persistedInvalid("rule identity does not match its indexed lookup");
            }
            return rule;
        } catch (error) {
            return databaseReadFailure("The semantic rule read failed.", error);
        }
    }

    async readUserRoleSet(userIdInput: unknown): Promise<InternalUserRoleSetView> {
        const userId = normalizeRbacId(userIdInput, "userId");
        try {
            const raw = await this.repository.collections.userRoleSets.findOne(
                { scopeKey: this.state.scopeKey, userId },
                readOptions(this.session),
            );
            this.assertScopeStateForRows(raw === null ? 0 : 1);
            return raw === null
                ? createVirtualUserRoleSet(this.state.scope, this.state.scopeKey, userId)
                : materializeUserRoleSetDocument(raw, this.state.scope, this.state.scopeKey);
        } catch (error) {
            return databaseReadFailure("The user role set read failed.", error);
        }
    }

    async verifyRbacUnchanged() {
        const current = await this.repository.scopeStates.read(this.state.scope, this.session);
        if (
            current.revision !== this.state.revision
            || current.rbacRevision !== this.state.rbacRevision
            || current.persisted !== this.state.persisted
        ) {
            throw new PermissionCoreError("READ_CONFLICT", "RBAC state changed during the read.", {
                details: {
                    kind: "read-conflict",
                    owner: "scope.rbac",
                    expected: canonicalString({ global: this.state.revision, rbac: this.state.rbacRevision }),
                    current: canonicalString({ global: current.revision, rbac: current.rbacRevision }),
                },
            });
        }
        return current;
    }

    async verifyAuthorizationUnchanged() {
        const current = await this.repository.scopeStates.read(this.state.scope, this.session);
        if (
            current.revision !== this.state.revision
            || current.rbacRevision !== this.state.rbacRevision
            || current.menuRevision !== this.state.menuRevision
            || current.persisted !== this.state.persisted
        ) {
            throw new PermissionCoreError("READ_CONFLICT", "Authorization state changed during the read.", {
                details: {
                    kind: "read-conflict",
                    owner: "scope.authorization",
                    expected: canonicalString({
                        global: this.state.revision,
                        rbac: this.state.rbacRevision,
                        menu: this.state.menuRevision,
                    }),
                    current: canonicalString({
                        global: current.revision,
                        rbac: current.rbacRevision,
                        menu: current.menuRevision,
                    }),
                },
            });
        }
        return current;
    }
}

export class RbacReadStore {
    constructor(
        private readonly repository: PermissionRepository,
        private readonly resourceSchemes: ResourceSchemeRegistry,
        private readonly authorizationResolver?: RbacAuthorizationResolver,
    ) {}

    async open(scope: PermissionScope, session?: MongoSession) {
        try {
            const state = await this.repository.scopeStates.read(scope, session);
            return new RbacScopeReader(
                this.repository,
                this.resourceSchemes,
                state,
                session,
                this.authorizationResolver,
            );
        } catch (error) {
            return databaseReadFailure("The RBAC scope state read failed.", error);
        }
    }
}
