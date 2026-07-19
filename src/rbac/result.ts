import type {
    BoundedDetails,
    EntityRevisionRef,
    ResponseDetailBudget,
    RevisionVector,
} from "../types";
import { PermissionCoreError } from "../core/errors";
import {
    CanonicalByteLimitError,
    canonicalByteLength,
    compareUtf8,
    digestCanonical,
} from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import type { ScopeStateView } from "../persistence/scope-state";
import { MAX_EFFECTIVE_SNAPSHOT_BYTES } from "./store";

export const RESPONSE_DETAIL_LIMIT = 100;

export class DetailBudgetAllocator {
    private returned = 0;
    private total = 0;
    private returnLimit = RESPONSE_DETAIL_LIMIT;

    withRemainingLimit<T>(maxAdditional: number, work: () => T): T {
        if (!Number.isSafeInteger(maxAdditional) || maxAdditional < 0 || maxAdditional > RESPONSE_DETAIL_LIMIT) {
            throw new TypeError("Additional detail budget must be a safe integer within the response limit.");
        }
        const previousLimit = this.returnLimit;
        this.returnLimit = Math.min(previousLimit, this.returned + maxAdditional);
        try {
            return work();
        } finally {
            this.returnLimit = previousLimit;
        }
    }

    bounded<T>(items: readonly T[]): BoundedDetails<T> {
        const complete = [...items];
        const selected = this.sample(complete, complete.length);
        return deepFreeze({
            total: complete.length,
            items: selected,
            truncated: selected.length < complete.length,
            digest: digestCanonical(complete),
        });
    }

    sample<T>(items: readonly T[], total: number): readonly T[] {
        if (!Number.isSafeInteger(total) || total < items.length) {
            throw new TypeError("Detail sample total must be a safe integer no smaller than the supplied sample.");
        }
        const available = Math.max(0, this.returnLimit - this.returned);
        const selected = [...items].slice(0, available);
        this.returned += selected.length;
        this.total += total;
        return deepFreeze(selected);
    }

    finish(completeTree: unknown): ResponseDetailBudget {
        return deepFreeze({
            limit: RESPONSE_DETAIL_LIMIT as 100,
            returned: this.returned,
            truncated: this.total > this.returned,
            digest: digestCanonical(completeTree),
        });
    }
}

export function revisionVector(
    state: ScopeStateView,
    entities: readonly EntityRevisionRef[] = [],
): RevisionVector {
    const normalized = [...entities]
        .sort((left, right) => compareUtf8(left.kind, right.kind) || compareUtf8(left.id, right.id));
    if (normalized.length > 65) {
        throw new PermissionCoreError("LIMIT_EXCEEDED", "The revision vector exceeds its entity limit.", {
            details: {
                kind: "limit-exceeded",
                origin: "persisted-authorization-state",
                limitName: "revision-vector-entities",
                current: normalized.length,
                max: 65,
                unit: "items",
            },
        });
    }
    for (let index = 1; index < normalized.length; index += 1) {
        if (normalized[index]!.kind === normalized[index - 1]!.kind && normalized[index]!.id === normalized[index - 1]!.id) {
            throw new PermissionCoreError("PERSISTED_STATE_INVALID", "The revision vector contains a duplicate entity.", {
                details: { kind: "persisted-state-invalid", stage: "load", reason: "duplicate revision entity" },
            });
        }
    }
    return deepFreeze({
        global: state.revision,
        rbac: state.rbacRevision,
        menu: state.menuRevision,
        audit: state.auditRevision,
        entities: normalized.map((entity) => ({ ...entity })),
    });
}

export function rbacEtag(revision: number, queryHash: string) {
    return `W/\"pc-rbac-${revision}-${queryHash}\"`;
}

export function assertAuthorizationResponseBudget(value: unknown) {
    try {
        canonicalByteLength(value, MAX_EFFECTIVE_SNAPSHOT_BYTES);
    } catch (error) {
        if (error instanceof CanonicalByteLimitError) {
            throw new PermissionCoreError("LIMIT_EXCEEDED", "The authorization response exceeds its byte limit.", {
                details: {
                    kind: "limit-exceeded",
                    origin: "persisted-authorization-state",
                    limitName: "public-response-bytes",
                    current: error.current,
                    max: MAX_EFFECTIVE_SNAPSHOT_BYTES,
                    unit: "bytes",
                },
            });
        }
        throw error;
    }
}

function isPublicResponseLimit(error: unknown) {
    return error instanceof PermissionCoreError
        && error.code === "LIMIT_EXCEEDED"
        && error.details?.kind === "limit-exceeded"
        && error.details.limitName === "public-response-bytes";
}

export function fitAuthorizationPage<T>(
    maximumItems: number,
    build: (itemCount: number) => T,
): T {
    if (!Number.isSafeInteger(maximumItems) || maximumItems < 0) {
        throw new TypeError("Page item count must be a non-negative safe integer.");
    }
    if (maximumItems === 0) return build(0);

    let low = 1;
    let high = maximumItems;
    let best: T | undefined;
    while (low <= high) {
        const itemCount = Math.floor((low + high) / 2);
        try {
            best = build(itemCount);
            low = itemCount + 1;
        } catch (error) {
            if (!isPublicResponseLimit(error)) throw error;
            high = itemCount - 1;
        }
    }
    return best ?? build(1);
}
