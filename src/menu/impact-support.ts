import type {
    AuthorizationCapacityAssessment,
    CountSample,
    ManagementConflict,
    ManagementWarning,
} from "../types";
import { compareUtf8, digestCanonical } from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import type { AffectedUsers } from "../rbac/capacity";
import type { DetailBudgetAllocator } from "../rbac/result";

export function budgetCountSample(value: CountSample, budget: DetailBudgetAllocator): CountSample {
    const sampleIds = budget.sample(value.sampleIds, value.total);
    return deepFreeze({
        total: value.total,
        sampleIds,
        truncated: value.total > sampleIds.length,
        digest: value.digest,
    });
}

export function sampledCountSample(ids: readonly string[]): CountSample {
    const normalized = [...new Set(ids)].sort(compareUtf8);
    const sampleIds = normalized.slice(0, 100);
    return deepFreeze({
        total: normalized.length,
        sampleIds,
        truncated: normalized.length > sampleIds.length,
        digest: digestCanonical(normalized),
    });
}

export function capacityMessages(capacity: AuthorizationCapacityAssessment) {
    const warnings: ManagementWarning[] = [];
    const conflicts: ManagementConflict[] = [];
    if (capacity.disposition === "ack-required") {
        warnings.push({
            code: "CAPACITY_RISK_ACK_REQUIRED",
            message: "Execution requires explicit acknowledgement of the bounded capacity risk.",
            details: { assessmentDigest: capacity.digest },
        });
    }
    if (capacity.disposition === "blocked") {
        conflicts.push({
            id: "authorization-capacity",
            code: "AUTHORIZATION_CAPACITY_EXCEEDED",
            message: "At least one evaluated subject would exceed an authorization hard limit.",
        });
    }
    return deepFreeze({ warnings, conflicts });
}

export function emptyAffectedUsers(owner: string): AffectedUsers {
    return deepFreeze({
        total: 0,
        evaluated: Object.freeze([]),
        sampleIds: Object.freeze([]),
        digest: digestCanonical({ owner, total: 0 }),
    });
}

function userCacheTarget(scopeKey: string, userId: string) {
    return `scope:${scopeKey}:user:${digestCanonical({ userId })}`;
}

export function authorizationCacheTargets(scopeKey: string, users: AffectedUsers) {
    if (users.total <= 999) {
        return [
            `scope:${scopeKey}:menu`,
            ...users.evaluated.map((user) => userCacheTarget(scopeKey, user.userId)),
        ];
    }
    return [`scope:${scopeKey}`];
}
