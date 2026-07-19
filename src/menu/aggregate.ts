import { PermissionCoreError } from "../core/errors";
import type {
    InternalApiBindingDocument,
    InternalMenuNodeDocument,
} from "../persistence/documents";
import {
    EMPTY_REPLACE_MANIFEST_BYTES,
    MAX_API_BINDING_COUNT,
    MAX_MENU_NODE_COUNT,
    MAX_REPLACE_MANIFEST_BYTES,
    type ScopeAggregateUpdate,
    type ScopeStateView,
} from "../persistence/scope-state";

type ManifestDocument = Pick<InternalMenuNodeDocument | InternalApiBindingDocument, "manifestItemBytes">;

function persistedInvalid(reason: string): never {
    throw new PermissionCoreError("PERSISTED_STATE_INVALID", "The persisted menu aggregate is inconsistent.", {
        details: { kind: "persisted-state-invalid", stage: "aggregate-counter", reason },
    });
}

function limitExceeded(limitName: string, current: number, max: number, unit: "items" | "bytes"): never {
    throw new PermissionCoreError("LIMIT_EXCEEDED", "The menu post-state exceeds its aggregate limit.", {
        details: {
            kind: "limit-exceeded",
            origin: "persisted-authorization-state",
            limitName,
            current,
            max,
            unit,
        },
    });
}

function commaBytes(count: number) {
    return count === 0 ? 0 : count - 1;
}

function assertUniqueDocuments<T extends ManifestDocument>(
    documents: readonly T[],
    field: string,
    identity: (document: T) => string,
) {
    const seen = new Set<string>();
    for (const document of documents) {
        const id = identity(document);
        if (seen.has(id)) persistedInvalid(`${field} contains duplicate identity ${id}`);
        seen.add(id);
    }
}

function itemBytes(documents: readonly ManifestDocument[], field: string) {
    let total = 0;
    for (const document of documents) {
        if (!Number.isSafeInteger(document.manifestItemBytes) || document.manifestItemBytes < 1) {
            persistedInvalid(`${field} contains an invalid manifestItemBytes value`);
        }
        total += document.manifestItemBytes;
        if (!Number.isSafeInteger(total)) persistedInvalid(`${field} byte sum is not a safe integer`);
    }
    return total;
}

export function calculateReplaceManifestBytes(input: {
    readonly menuNodeCount: number;
    readonly apiBindingCount: number;
    readonly itemBytes: number;
}) {
    for (const [field, value] of Object.entries(input)) {
        if (!Number.isSafeInteger(value) || value < 0) {
            persistedInvalid(`${field} must be a non-negative safe integer`);
        }
    }
    const result = EMPTY_REPLACE_MANIFEST_BYTES
        + input.itemBytes
        + commaBytes(input.menuNodeCount)
        + commaBytes(input.apiBindingCount);
    if (!Number.isSafeInteger(result) || result < EMPTY_REPLACE_MANIFEST_BYTES) {
        persistedInvalid("the computed replace manifest byte count is invalid");
    }
    return result;
}

export function planMenuAggregate(input: {
    readonly state: ScopeStateView;
    readonly beforeNodes?: readonly Readonly<InternalMenuNodeDocument>[];
    readonly afterNodes?: readonly Readonly<InternalMenuNodeDocument>[];
    readonly beforeBindings?: readonly Readonly<InternalApiBindingDocument>[];
    readonly afterBindings?: readonly Readonly<InternalApiBindingDocument>[];
}): ScopeAggregateUpdate {
    const beforeNodes = input.beforeNodes ?? [];
    const afterNodes = input.afterNodes ?? [];
    const beforeBindings = input.beforeBindings ?? [];
    const afterBindings = input.afterBindings ?? [];
    assertUniqueDocuments(beforeNodes, "beforeNodes", (document) => document.nodeId);
    assertUniqueDocuments(afterNodes, "afterNodes", (document) => document.nodeId);
    assertUniqueDocuments(beforeBindings, "beforeBindings", (document) => document.bindingId);
    assertUniqueDocuments(afterBindings, "afterBindings", (document) => document.bindingId);
    if (
        beforeNodes.length > input.state.menuNodeCount
        || beforeBindings.length > input.state.apiBindingCount
    ) {
        persistedInvalid("touched record count exceeds its declared aggregate count");
    }
    const menuNodeCount = input.state.menuNodeCount - beforeNodes.length + afterNodes.length;
    const apiBindingCount = input.state.apiBindingCount - beforeBindings.length + afterBindings.length;
    if (menuNodeCount < 0 || apiBindingCount < 0) {
        persistedInvalid("a touched record is not represented by its aggregate count");
    }
    if (menuNodeCount > MAX_MENU_NODE_COUNT) {
        limitExceeded("menuNodeCount", menuNodeCount, MAX_MENU_NODE_COUNT, "items");
    }
    if (apiBindingCount > MAX_API_BINDING_COUNT) {
        limitExceeded("apiBindingCount", apiBindingCount, MAX_API_BINDING_COUNT, "items");
    }

    const currentCommaBytes = commaBytes(input.state.menuNodeCount) + commaBytes(input.state.apiBindingCount);
    const currentItemBytes = input.state.replaceManifestBytes - EMPTY_REPLACE_MANIFEST_BYTES - currentCommaBytes;
    if (!Number.isSafeInteger(currentItemBytes) || currentItemBytes < 0) {
        persistedInvalid("replaceManifestBytes cannot represent the declared aggregate counts");
    }
    if (currentItemBytes < input.state.menuNodeCount + input.state.apiBindingCount) {
        persistedInvalid("replaceManifestBytes cannot contain the declared aggregate items");
    }
    const beforeItemBytes = itemBytes(beforeNodes, "beforeNodes") + itemBytes(beforeBindings, "beforeBindings");
    const afterItemBytes = itemBytes(afterNodes, "afterNodes") + itemBytes(afterBindings, "afterBindings");
    if (beforeItemBytes > currentItemBytes) {
        persistedInvalid("touched manifest item bytes exceed the declared aggregate bytes");
    }
    const replaceManifestBytes = calculateReplaceManifestBytes({
        menuNodeCount,
        apiBindingCount,
        itemBytes: currentItemBytes - beforeItemBytes + afterItemBytes,
    });
    if (replaceManifestBytes > MAX_REPLACE_MANIFEST_BYTES) {
        limitExceeded("replaceManifestBytes", replaceManifestBytes, MAX_REPLACE_MANIFEST_BYTES, "bytes");
    }
    return Object.freeze({ menuNodeCount, apiBindingCount, replaceManifestBytes });
}
