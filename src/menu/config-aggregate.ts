import type {
    ApiBindingCreateInput,
    ApiResource,
    MenuManifestInput,
} from "../types";
import { ResourceSchemeRegistry } from "../check/resource-schemes";
import { validationError } from "../core/errors";
import { canonicalByteLength, canonicalString, compareUtf8, digestCanonical } from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import { normalizeMenuManifestInput } from "./validation";
import {
    MENU_CONFIG_CODEC_VERSION,
    type CompiledApiOwner,
    type CompiledConfigIndex,
    type CompiledMenuConfig,
    type CompiledResponseDefinition,
} from "./config-compiler";

const PURPOSE_PRIORITY: Readonly<Record<ApiBindingCreateInput["purpose"], number>> = Object.freeze({
    background: 0,
    entry: 1,
    lookup: 1,
    detail: 2,
    importExport: 2,
    operation: 3,
});
type CompiledApiOwnerRelation = NonNullable<ApiBindingCreateInput["owners"]>[number];

export interface CompiledApiBindingRef {
    readonly apiResource: ApiResource;
    readonly bindingId: string;
    readonly method: string;
    readonly path: string;
    readonly owners: readonly CompiledApiOwnerRelation[];
    readonly purpose: ApiBindingCreateInput["purpose"];
    readonly canonicalOwner?: ApiBindingCreateInput["canonicalOwner"];
}

export interface CompiledScopeMenuTarget {
    readonly aggregateDigest: string;
    readonly manifest: MenuManifestInput & { readonly schemaVersion: 2; readonly mode: "replace" };
    readonly apiCatalog: ReadonlyMap<ApiResource, CompiledApiBindingRef>;
    readonly responseCatalog: ReadonlyMap<ApiResource, CompiledResponseDefinition>;
    readonly configIndexes: ReadonlyMap<string, CompiledConfigIndex>;
    readonly metrics: {
        readonly menuConfigCount: number;
        readonly menuConfigBytes: number;
        readonly menuNodeCount: number;
        readonly apiBindingCount: number;
        readonly responseFieldCount: number;
        readonly responseFieldOwnerCount: number;
        readonly compiledManifestBytes: number;
    };
}

function ownerKey(owner: CompiledApiOwnerRelation) {
    return canonicalString([
        owner.type,
        owner.id,
        owner.required,
        owner.availabilityGroup ?? "",
        owner.availabilityMode ?? "",
    ]);
}

function mergeOwners(owners: readonly CompiledApiOwnerRelation[]) {
    const unique = new Map<string, CompiledApiOwnerRelation>();
    for (const owner of owners) unique.set(ownerKey(owner), owner);
    return Object.freeze([...unique.values()].sort((left, right) => compareUtf8(ownerKey(left), ownerKey(right))));
}

function bindingId(method: string, path: string) {
    return `mc-api-${digestCanonical([method, path])}`;
}

function apiResource(method: string, path: string) {
    return `api:${method}:${path}` as ApiResource;
}

function mergeBinding(owners: readonly CompiledApiOwner[]): CompiledApiBindingRef {
    const first = owners[0]!;
    const allOwners = mergeOwners(owners.map((entry) => entry.owner));
    const purpose = owners.reduce<ApiBindingCreateInput["purpose"]>((current, entry) =>
        PURPOSE_PRIORITY[entry.purpose] > PURPOSE_PRIORITY[current] ? entry.purpose : current, first.purpose);
    const canonicalOwner = allOwners[0] === undefined ? undefined : { type: allOwners[0].type, id: allOwners[0].id };
    return deepFreeze({
        apiResource: first.apiResource,
        bindingId: bindingId(first.method, first.path),
        method: first.method,
        path: first.path,
        owners: allOwners,
        purpose,
        ...(canonicalOwner === undefined ? {} : { canonicalOwner }),
    });
}

function responseFieldSignature(field: CompiledResponseDefinition["fields"][number]) {
    const { owners: _owners, ...definition } = field;
    return canonicalString(definition);
}

function mergeResponses(apiResourceKey: ApiResource, responses: readonly CompiledResponseDefinition[]) {
    const first = responses[0]!;
    const targetKey = first.target ?? "";
    const preserveKey = canonicalString(first.preserve);
    for (const response of responses) {
        if ((response.target ?? "") !== targetKey) {
            throw validationError("INVALID_ARGUMENT", `response.${apiResourceKey}.target`, "must be compatible across all owners");
        }
        if (canonicalString(response.preserve) !== preserveKey) {
            throw validationError("INVALID_ARGUMENT", `response.${apiResourceKey}.preserve`, "must be compatible across all owners");
        }
    }
    const owners = new Map<string, CompiledResponseDefinition["owners"][number]>();
    const fields = new Map<string, {
        definition: Omit<CompiledResponseDefinition["fields"][number], "owners">;
        owners: Map<string, CompiledResponseDefinition["owners"][number]>;
    }>();
    for (const response of responses) {
        for (const owner of response.owners) owners.set(canonicalString(owner), owner);
        for (const field of response.fields) {
            const { owners: fieldOwners, ...definition } = field;
            const existing = fields.get(field.field);
            if (existing !== undefined && responseFieldSignature(field) !== canonicalString(existing.definition)) {
                throw validationError("INVALID_ARGUMENT", `response.${apiResourceKey}.${field.field}`, "must use one field title/i18n/meta definition");
            }
            const entry = existing ?? { definition, owners: new Map<string, CompiledResponseDefinition["owners"][number]>() };
            for (const owner of fieldOwners) entry.owners.set(canonicalString(owner), owner);
            fields.set(field.field, entry);
        }
    }
    const mergedOwners = Object.freeze([...owners.values()].sort((left, right) => compareUtf8(canonicalString(left), canonicalString(right))));
    const mergedFields = Object.freeze([...fields.entries()].sort(([left], [right]) => compareUtf8(left, right)).map(([, entry]) => ({
        ...entry.definition,
        owners: Object.freeze([...entry.owners.values()].sort((left, right) => compareUtf8(canonicalString(left), canonicalString(right)))),
    })));
    const definitionDigest = digestCanonical({
        codecVersion: MENU_CONFIG_CODEC_VERSION,
        apiResource: apiResourceKey,
        target: first.target ?? "",
        preserve: first.preserve,
        fields: mergedFields,
        owners: mergedOwners,
    });
    return deepFreeze({
        apiResource: apiResourceKey,
        ...(first.target === undefined ? {} : { target: first.target }),
        targetDigest: first.targetDigest,
        preserve: first.preserve,
        fields: mergedFields,
        owners: mergedOwners,
        definitionDigest,
    }) satisfies CompiledResponseDefinition;
}

export function aggregateCompiledMenuConfigs(
    configsInput: readonly CompiledMenuConfig[],
    schemes = new ResourceSchemeRegistry(),
): CompiledScopeMenuTarget {
    const configs = [...configsInput].sort((left, right) => compareUtf8(left.configId, right.configId));
    if (new Set(configs.map((config) => config.configId)).size !== configs.length) {
        throw validationError("INVALID_ARGUMENT", "configs", "cannot contain duplicate configId values");
    }
    const nodes = configs.flatMap((config) => config.nodes);
    const pathOwners = new Map<string, string>();
    for (const node of nodes) {
        if (node.path === undefined) continue;
        const owner = pathOwners.get(node.path);
        if (owner !== undefined && owner !== node.id) {
            throw validationError("INVALID_ARGUMENT", "configs", `path ${node.path} is declared by multiple compiled nodes`);
        }
        pathOwners.set(node.path, node.id);
    }

    const ownerGroups = new Map<string, CompiledApiOwner[]>();
    for (const owner of configs.flatMap((config) => config.apiOwners)) {
        const key = canonicalString([owner.method, owner.path]);
        const group = ownerGroups.get(key) ?? [];
        group.push(owner);
        ownerGroups.set(key, group);
    }
    const apiBindings = [...ownerGroups.values()].map(mergeBinding).sort((left, right) => compareUtf8(left.bindingId, right.bindingId));
    const manifest = normalizeMenuManifestInput({
        schemaVersion: 2,
        mode: "replace",
        nodes,
        apiBindings: apiBindings.map((binding) => ({
            id: binding.bindingId,
            method: binding.method,
            path: binding.path,
            purpose: binding.purpose,
            authorization: {
                mode: "all",
                permissions: [{ action: "invoke", resource: binding.apiResource }],
            },
            owners: binding.owners,
            ...(binding.canonicalOwner === undefined ? {} : { canonicalOwner: binding.canonicalOwner }),
            status: "enabled",
        })),
    }, schemes) as MenuManifestInput & { schemaVersion: 2; mode: "replace" };

    const responseGroups = new Map<ApiResource, CompiledResponseDefinition[]>();
    for (const response of configs.flatMap((config) => config.responseDefinitions)) {
        const group = responseGroups.get(response.apiResource) ?? [];
        group.push(response);
        responseGroups.set(response.apiResource, group);
    }
    const responseCatalog = new Map<ApiResource, CompiledResponseDefinition>();
    for (const [key, group] of [...responseGroups.entries()].sort(([left], [right]) => compareUtf8(left, right))) {
        responseCatalog.set(key, mergeResponses(key, group));
    }
    const apiCatalog = new Map<ApiResource, CompiledApiBindingRef>();
    for (const binding of apiBindings) apiCatalog.set(apiResource(binding.method, binding.path), binding);
    const configIndexes = new Map<string, CompiledConfigIndex>();
    for (const config of configs) configIndexes.set(config.configId, config.index);
    const responseDefinitions = [...responseCatalog.values()];
    const aggregateDigest = digestCanonical({
        codecVersion: MENU_CONFIG_CODEC_VERSION,
        configs: configs.map((config) => ({ configId: config.configId, digest: config.configDigest })),
        manifest,
        responses: responseDefinitions,
    });
    return deepFreeze({
        aggregateDigest,
        manifest,
        apiCatalog,
        responseCatalog,
        configIndexes,
        metrics: {
            menuConfigCount: configs.length,
            menuConfigBytes: configs.reduce((total, config) => total + config.metrics.configBytes, 0),
            menuNodeCount: manifest.nodes.length,
            apiBindingCount: manifest.apiBindings.length,
            responseFieldCount: responseDefinitions.reduce((total, response) => total + response.fields.length, 0),
            responseFieldOwnerCount: responseDefinitions.reduce(
                (total, response) => total + response.fields.reduce((fieldTotal, field) => fieldTotal + field.owners.length, 0),
                0,
            ),
            compiledManifestBytes: canonicalByteLength(manifest),
        },
    });
}
