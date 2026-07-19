import type {
    ApiBinding,
    ApiBindingCreateInput,
    ApiBindingUpdateInput,
    MutationOptions,
    MutationResult,
    PermissionScope,
    PolicyValue,
    RequiredRevisionOptions,
} from "../types";
import { ResourceSchemeRegistry } from "../check/resource-schemes";
import { PermissionCoreError } from "../core/errors";
import { canonicalString, compareUtf8 } from "../internal/canonical";
import type { InternalApiBindingDocument } from "../persistence/documents";
import { SIMPLE_COLLATION } from "../persistence/indexes";
import type { PermissionRepository } from "../persistence/repository";
import {
    ManagementMutationExecutor,
    normalizeMutationOptions,
    normalizeRequiredRevisionOptions,
    type CacheInvalidator,
} from "../rbac/mutation-executor";
import { normalizeRbacId } from "../rbac/validation";
import { planMenuAggregate } from "./aggregate";
import {
    apiBindingDocumentFromInput,
    apiBindingManifestItemFromDocument,
    apiBindingView,
    materializeApiBindingDocument,
} from "./materialize";
import { MAX_API_BINDINGS, MenuScopeReader } from "./store";
import { normalizeApiBindingCreateInput, normalizeApiBindingUpdateInput } from "./validation";
import { decodeApiBindingReplay } from "./views";

const OPTIONAL_API_FIELDS = ["canonicalOwner", "description"] as const;

function readOptions(session: unknown, projection?: Readonly<Record<string, 0 | 1>>) {
    return {
        session,
        cache: 0,
        collation: SIMPLE_COLLATION,
        ...(projection === undefined ? {} : { projection }),
    };
}

function insertOptions(session: unknown) {
    return { session, cache: { invalidate: false as const } };
}

function writeOptions(session: unknown) {
    return { session, cache: { invalidate: false as const }, collation: SIMPLE_COLLATION };
}

function toPolicyValue(value: unknown): PolicyValue {
    return JSON.parse(canonicalString(value)) as PolicyValue;
}

export function databaseWriteFailure(reason: string): never {
    throw new PermissionCoreError("DATABASE_ERROR", "The API binding write result is inconsistent.", {
        details: { kind: "database-failure", stage: "write" },
        cause: new Error(reason),
    });
}

function persistedInvalid(reason: string): never {
    throw new PermissionCoreError("PERSISTED_STATE_INVALID", "Persisted API binding state is inconsistent.", {
        details: { kind: "persisted-state-invalid", stage: "load", reason },
    });
}

export function revisionConflict(owner: string, expected: number, current?: number): never {
    throw new PermissionCoreError("REVISION_CONFLICT", `${owner} revision changed.`, {
        details: { kind: "revision-conflict", owner, expected, ...(current === undefined ? {} : { current }) },
    });
}

export function apiUpdateDocument(document: Readonly<InternalApiBindingDocument>) {
    const set: Record<string, unknown> = {
        method: document.method,
        path: document.path,
        purpose: document.purpose,
        authorization: document.authorization,
        owners: document.owners,
        status: document.status,
        revision: document.revision,
        manifestItemBytes: document.manifestItemBytes,
        updatedAt: document.updatedAt,
    };
    const unset: Record<string, ""> = {};
    for (const field of OPTIONAL_API_FIELDS) {
        if (document[field] === undefined) unset[field] = "";
        else set[field] = document[field];
    }
    return { $set: set, ...(Object.keys(unset).length === 0 ? {} : { $unset: unset }) };
}

export function readNestedDuplicate(error: unknown) {
    let current = error;
    for (let depth = 0; depth < 6; depth += 1) {
        if (current !== null && typeof current === "object") {
            const record = current as Record<string, unknown>;
            if (record.code === 11000 || /\bE11000\b/iu.test(String(record.message ?? ""))) return true;
            current = record.cause;
        } else break;
    }
    return false;
}

export class ApiBindingMutationService {
    private readonly executor: ManagementMutationExecutor;

    constructor(
        private readonly repository: PermissionRepository,
        private readonly schemes: ResourceSchemeRegistry,
        invalidateCache?: CacheInvalidator,
    ) {
        this.executor = new ManagementMutationExecutor(repository, schemes, invalidateCache);
    }

    private async assertOwners(
        reader: MenuScopeReader,
        input: ReturnType<typeof normalizeApiBindingCreateInput>,
        session: unknown,
        excludeBindingId?: string,
    ) {
        const nodes = await reader.readNodesByIds(input.owners.map((owner) => owner.id));
        for (const owner of input.owners) {
            const node = nodes.get(owner.id);
            if (node === undefined) {
                throw new PermissionCoreError("MENU_NOT_FOUND", `API owner ${owner.id} was not found.`);
            }
            if (node.type !== owner.type) {
                throw new PermissionCoreError("INVALID_ARGUMENT", "API owner type does not match its menu node.", {
                    details: { kind: "validation", field: "owners", reason: `${owner.id} is ${node.type}, not ${owner.type}` },
                });
            }
        }
        const groupedOwners = input.owners.filter((owner) => owner.availabilityGroup !== undefined);
        if (groupedOwners.length === 0) return;
        const existing = await this.readBindingsForOwners(reader, groupedOwners.map((owner) => owner.id), session, excludeBindingId);
        for (const owner of groupedOwners) {
            for (const binding of existing) {
                for (const relation of binding.owners) {
                    if (
                        relation.type === owner.type
                        && relation.id === owner.id
                        && relation.availabilityGroup === owner.availabilityGroup
                        && relation.availabilityMode !== owner.availabilityMode
                    ) {
                        throw new PermissionCoreError("INVALID_ARGUMENT", "API owner availability modes conflict across bindings.", {
                            details: { kind: "validation", field: "owners", reason: `${owner.id}/${owner.availabilityGroup} mixes all and any` },
                        });
                    }
                }
            }
        }
    }

    private async readBindingsForOwners(
        reader: MenuScopeReader,
        ownerIds: readonly string[],
        session: unknown,
        excludeBindingId?: string,
    ) {
        if (ownerIds.length === 0) return [];
        const result: Readonly<InternalApiBindingDocument>[] = [];
        let after: string | undefined;
        const pageSize = Math.min(200, this.repository.findMaxLimit);
        while (result.length <= MAX_API_BINDINGS) {
            const base: Record<string, unknown> = {
                scopeKey: reader.state.scopeKey,
                "owners.id": { $in: [...new Set(ownerIds)] },
                ...(excludeBindingId === undefined ? {} : { bindingId: { $ne: excludeBindingId } }),
            };
            const filter = after === undefined ? base : { $and: [base, { bindingId: { $gt: after } }] };
            const rows = await this.repository.collections.apiBindings.find(filter, readOptions(session))
                .sort({ bindingId: 1 })
                .limit(pageSize)
                .toArray();
            if (rows.length === 0) break;
            for (const row of rows) {
                const binding = materializeApiBindingDocument(row, reader.state.scope, reader.state.scopeKey, this.schemes);
                if (after !== undefined && compareUtf8(binding.bindingId, after) <= 0) persistedInvalid("owner validation keyset did not advance");
                after = binding.bindingId;
                result.push(binding);
                if (result.length > MAX_API_BINDINGS) persistedInvalid("owner validation exceeds the API inventory limit");
            }
            if (rows.length < pageSize) break;
        }
        return result;
    }

    async create(
        scope: PermissionScope,
        input: ApiBindingCreateInput,
        options?: MutationOptions,
    ): Promise<MutationResult<ApiBinding>> {
        const binding = normalizeApiBindingCreateInput(input, this.schemes);
        const normalizedOptions = normalizeMutationOptions(options);
        try {
            return await this.executor.execute({
                scope,
                operation: "apiBindings.create",
                action: "create",
                resource: `api-binding:${binding.id}`,
                request: toPolicyValue({ binding }),
                options: normalizedOptions,
                decodeReplay: (value) => decodeApiBindingReplay(value, this.schemes),
                work: async ({ transaction, state, now }) => {
                    const reader = new MenuScopeReader(this.repository, this.schemes, state, transaction.session);
                    if (await reader.readBinding(binding.id)) {
                        throw new PermissionCoreError("API_BINDING_ALREADY_EXISTS", `API binding ${binding.id} already exists.`);
                    }
                    const endpoint = await this.repository.collections.apiBindings.findOne(
                        { scopeKey: state.scopeKey, method: binding.method, path: binding.path },
                        readOptions(transaction.session, { _id: 1, bindingId: 1 }),
                    );
                    if (endpoint !== null) {
                        throw new PermissionCoreError("API_BINDING_ALREADY_EXISTS", `${binding.method} ${binding.path} is already bound.`);
                    }
                    await this.assertOwners(reader, binding, transaction.session);
                    const document = apiBindingDocumentFromInput(state.scopeKey, state.scope, binding, 1, now);
                    const aggregate = planMenuAggregate({ state, afterBindings: [document] });
                    const result = await this.repository.collections.apiBindings.insertOne(
                        { ...document },
                        insertOptions(transaction.session),
                    );
                    if (result.acknowledged !== true) databaseWriteFailure("API binding insert was not acknowledged");
                    const postImage = await reader.requireBinding(binding.id);
                    if (canonicalString(postImage) !== canonicalString(document)) {
                        databaseWriteFailure("API binding insert post-image differs from the validated document");
                    }
                    const data = apiBindingView(postImage);
                    return {
                        changed: true,
                        data,
                        primaryRevision: 1,
                        entity: { kind: "api-binding", id: binding.id, before: 0, after: 1 },
                        revisionImpact: { rbac: false, menu: true },
                        scopeAggregate: aggregate,
                        change: { kind: "api-binding", before: null, after: data },
                        cacheTargets: [`scope:${state.scopeKey}:menu`],
                    };
                },
            });
        } catch (error) {
            if (readNestedDuplicate(error)) {
                throw new PermissionCoreError("API_BINDING_ALREADY_EXISTS", "The API binding conflicts with an existing ID or endpoint.", { cause: error });
            }
            throw error;
        }
    }

    async update(
        scope: PermissionScope,
        bindingIdInput: string,
        patchInput: ApiBindingUpdateInput,
        optionsInput: RequiredRevisionOptions,
    ): Promise<MutationResult<ApiBinding>> {
        const bindingId = normalizeRbacId(bindingIdInput, "bindingId");
        const patch = normalizeApiBindingUpdateInput(patchInput);
        const options = normalizeRequiredRevisionOptions(optionsInput);
        return this.executor.execute({
            scope,
            operation: "apiBindings.update",
            action: "update",
            resource: `api-binding:${bindingId}`,
            request: toPolicyValue({ bindingId, patch, expectedRevision: options.expectedRevision }),
            options,
            decodeReplay: (value) => decodeApiBindingReplay(value, this.schemes),
            work: async ({ transaction, state, now }) => {
                const reader = new MenuScopeReader(this.repository, this.schemes, state, transaction.session);
                const current = await reader.requireBinding(bindingId);
                if (current.revision !== options.expectedRevision) {
                    revisionConflict(`api-binding:${bindingId}`, options.expectedRevision, current.revision);
                }
                if (current.status === "deprecated") {
                    throw new PermissionCoreError("INVALID_ARGUMENT", "Deprecated API bindings can only be restored through setStatus.", {
                        details: { kind: "validation", field: "bindingId", reason: "API binding is deprecated" },
                    });
                }
                const create = apiBindingManifestItemFromDocument(current);
                const candidate: Record<string, unknown> = { ...create };
                for (const [key, value] of Object.entries(patch)) {
                    if (value === null) delete candidate[key];
                    else candidate[key] = value;
                }
                const normalized = normalizeApiBindingCreateInput(candidate as unknown as ApiBindingCreateInput, this.schemes);
                const changed = canonicalString(normalized) !== canonicalString(create);
                if (!changed) {
                    const data = apiBindingView(current);
                    return {
                        changed: false,
                        data,
                        primaryRevision: current.revision,
                        entity: { kind: "api-binding", id: bindingId, before: current.revision, after: current.revision },
                        revisionImpact: { rbac: false, menu: false },
                        change: { kind: "api-binding-metadata", before: data, after: data },
                        cacheTargets: [],
                    };
                }
                const next = apiBindingDocumentFromInput(
                    state.scopeKey,
                    state.scope,
                    normalized,
                    current.revision + 1,
                    current.createdAt,
                    now,
                );
                const aggregate = planMenuAggregate({ state, beforeBindings: [current], afterBindings: [next] });
                const result = await this.repository.collections.apiBindings.updateOne(
                    { scopeKey: state.scopeKey, bindingId, revision: current.revision },
                    apiUpdateDocument(next),
                    writeOptions(transaction.session),
                );
                if (result.matchedCount !== 1) revisionConflict(`api-binding:${bindingId}`, current.revision);
                if (result.modifiedCount !== 1) databaseWriteFailure("changed API binding update did not modify exactly one document");
                const postImage = await reader.requireBinding(bindingId);
                if (canonicalString(postImage) !== canonicalString(next)) {
                    databaseWriteFailure("API binding update post-image differs from the validated document");
                }
                const before = apiBindingView(current);
                const data = apiBindingView(postImage);
                return {
                    changed: true,
                    data,
                    primaryRevision: data.revision,
                    entity: { kind: "api-binding", id: bindingId, before: current.revision, after: data.revision },
                    revisionImpact: { rbac: false, menu: true },
                    scopeAggregate: aggregate,
                    change: { kind: "api-binding-metadata", before, after: data },
                    cacheTargets: [`scope:${state.scopeKey}:menu`],
                };
            },
        });
    }
}
