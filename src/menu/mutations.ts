import type {
    AuthorizationCapacityAssessment,
    BatchMutationSummary,
    EntityRevisionRef,
    ExpectedRevisionVector,
    ImpactPreview,
    ManagementConflict,
    ManagementWarning,
    PolicyValue,
} from "../types";
import { canonicalString, compareUtf8, digestCanonical } from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import type { SignedTokenCodec } from "../internal/signed-token";
import {
    DetailBudgetAllocator,
    RESPONSE_DETAIL_LIMIT,
    assertAuthorizationResponseBudget,
    revisionVector,
} from "../rbac/result";
import type { NormalizedPreviewExecutionOptions, NormalizedPreviewOptions } from "../rbac/preview-inputs";
import { PREVIEW_TTL_MS, issuePreviewToken, validatePreviewExecution } from "../rbac/preview-token";
import type { MenuScopeReader } from "./store";

export interface PreparedMenuPlan<TPlan> {
    readonly method: string;
    readonly reader: MenuScopeReader;
    readonly inputHash: string;
    readonly planHash: string;
    readonly completePlan: PolicyValue;
    readonly requiredDecisionDetailCount?: number;
    publicPlan(budget: DetailBudgetAllocator): TPlan;
    readonly expectedRevisions: ExpectedRevisionVector;
    readonly revisionEntities: readonly EntityRevisionRef[];
    readonly summaryCounts: Omit<BatchMutationSummary, "samples">;
    readonly summarySamples: readonly BatchMutationSummary["samples"]["items"][number][];
    readonly warnings: readonly ManagementWarning[];
    readonly conflicts: readonly ManagementConflict[];
    readonly capacity: AuthorizationCapacityAssessment | null;
}

function toPolicyRecord(value: unknown) {
    return JSON.parse(canonicalString(value)) as Readonly<Record<string, PolicyValue>>;
}

export function expectedMenuRevisions(
    reader: MenuScopeReader,
    entities: readonly EntityRevisionRef[] = [],
    includeRbac = false,
): ExpectedRevisionVector {
    const normalized = [...entities]
        .sort((left, right) => compareUtf8(left.kind, right.kind) || compareUtf8(left.id, right.id));
    return deepFreeze({
        global: reader.state.revision,
        ...(includeRbac ? { rbac: reader.state.rbacRevision } : {}),
        menu: reader.state.menuRevision,
        entities: normalized,
    });
}

export function emptyBatchCounts(overrides: Partial<Omit<BatchMutationSummary, "samples">> = {}) {
    return deepFreeze({
        inserted: 0,
        updated: 0,
        unchanged: 0,
        deleted: 0,
        conflicted: 0,
        ...overrides,
    });
}

export function sortBatchMutationSamples(
    samples: readonly BatchMutationSummary["samples"]["items"][number][],
) {
    return [...samples]
        .sort((left, right) => compareUtf8(left.outcome, right.outcome) || compareUtf8(left.id, right.id));
}

export function menuPlanHash(method: string, inputHash: string, expected: ExpectedRevisionVector, completePlan: PolicyValue) {
    return digestCanonical({ method, inputHash, expectedRevisions: expected, plan: completePlan });
}

function budgetCapacity(
    value: AuthorizationCapacityAssessment | null,
    budget: DetailBudgetAllocator,
) {
    if (value === null) return null;
    const affectedUserIds = budget.sample(value.affectedUsers.sampleIds, value.affectedUsers.total);
    const violatingUserIds = budget.sample(value.violatingUsers.sampleIds, value.violatingUsers.total);
    return deepFreeze({
        ...value,
        affectedUsers: {
            ...value.affectedUsers,
            sampleIds: affectedUserIds,
            truncated: value.affectedUsers.total > affectedUserIds.length,
        },
        violatingUsers: {
            ...value.violatingUsers,
            sampleIds: violatingUserIds,
            truncated: value.violatingUsers.total > violatingUserIds.length,
        },
    });
}

export function buildMenuPreview<TPlan>(input: {
    readonly tokens: SignedTokenCodec;
    readonly actor: NormalizedPreviewOptions;
    readonly issuedAt: number;
    readonly prepared: PreparedMenuPlan<TPlan>;
}): ImpactPreview<TPlan> {
    const budget = new DetailBudgetAllocator();
    const sortedConflicts = [...input.prepared.conflicts]
        .sort((left, right) => compareUtf8(left.code, right.code) || compareUtf8(left.id, right.id));
    const sortedWarnings = [...input.prepared.warnings]
        .sort((left, right) => compareUtf8(left.code, right.code) || compareUtf8(left.message, right.message));
    const requiredDecisionDetailCount = input.prepared.requiredDecisionDetailCount ?? 0;
    if (!Number.isSafeInteger(requiredDecisionDetailCount) || requiredDecisionDetailCount < 0) {
        throw new TypeError("Required decision detail count must be a non-negative safe integer.");
    }
    const allocateContextDetails = () => ({
        conflicts: budget.bounded(sortedConflicts),
        warnings: budget.bounded(sortedWarnings),
        capacity: budgetCapacity(input.prepared.capacity, budget),
    });
    let plan: TPlan;
    let contextDetails: ReturnType<typeof allocateContextDetails>;
    if (requiredDecisionDetailCount > 0 && requiredDecisionDetailCount <= RESPONSE_DETAIL_LIMIT) {
        const capacityDetailCount = input.prepared.capacity === null
            ? 0
            : input.prepared.capacity.affectedUsers.sampleIds.length
                + input.prepared.capacity.violatingUsers.sampleIds.length;
        const contextDetailCount = Math.min(
            RESPONSE_DETAIL_LIMIT,
            sortedConflicts.length + sortedWarnings.length + capacityDetailCount,
        );
        const planDetailAllowance = Math.max(
            requiredDecisionDetailCount,
            RESPONSE_DETAIL_LIMIT - contextDetailCount,
        );
        plan = budget.withRemainingLimit(
            planDetailAllowance,
            () => input.prepared.publicPlan(budget),
        );
        contextDetails = allocateContextDetails();
    } else {
        contextDetails = allocateContextDetails();
        plan = input.prepared.publicPlan(budget);
    }
    const { conflicts, warnings, capacity } = contextDetails;
    const sortedSamples = sortBatchMutationSamples(input.prepared.summarySamples);
    const summary: BatchMutationSummary = deepFreeze({
        ...input.prepared.summaryCounts,
        samples: budget.bounded(sortedSamples),
    });
    const revisions = revisionVector(input.prepared.reader.state, input.prepared.revisionEntities);
    const capacityDigest = digestCanonical(input.prepared.capacity);
    const executable = input.prepared.conflicts.length === 0
        && input.prepared.capacity?.disposition !== "blocked";
    const detailBudget = budget.finish({
        plan: input.prepared.completePlan,
        capacity: input.prepared.capacity,
        warnings: sortedWarnings,
        conflicts: sortedConflicts,
        summary: { ...input.prepared.summaryCounts, samples: sortedSamples },
    });
    const common = {
        revisions,
        summary,
        plan,
        capacity,
        warnings,
        conflicts,
        detailBudget,
    };
    if (!executable) {
        const result = deepFreeze({
            executable: false as const,
            previewToken: null,
            expected: null,
            ...common,
            expiresAt: null,
        });
        assertAuthorizationResponseBudget(result);
        return result;
    }
    const previewToken = issuePreviewToken({
        tokens: input.tokens,
        method: input.prepared.method,
        actorId: input.actor.actorId,
        scopeKey: input.prepared.reader.state.scopeKey,
        envelope: {
            inputHash: input.prepared.inputHash,
            planHash: input.prepared.planHash,
            capacityDigest,
            expectedRevisions: toPolicyRecord(input.prepared.expectedRevisions),
        },
        issuedAt: input.issuedAt,
    });
    const result = deepFreeze({
        executable: true as const,
        previewToken,
        expected: { expectedRevisions: input.prepared.expectedRevisions },
        ...common,
        expiresAt: input.issuedAt + PREVIEW_TTL_MS,
    });
    assertAuthorizationResponseBudget(result);
    return result;
}

export function validateMenuExecution<TPlan>(input: {
    readonly tokens: SignedTokenCodec;
    readonly prepared: PreparedMenuPlan<TPlan>;
    readonly options: NormalizedPreviewExecutionOptions;
    readonly now: number;
}) {
    validatePreviewExecution({
        tokens: input.tokens,
        method: input.prepared.method,
        scopeKey: input.prepared.reader.state.scopeKey,
        envelope: {
            inputHash: input.prepared.inputHash,
            planHash: input.prepared.planHash,
            capacityDigest: digestCanonical(input.prepared.capacity),
            expectedRevisions: toPolicyRecord(input.prepared.expectedRevisions),
        },
        options: input.options,
        now: input.now,
        capacityDisposition: input.prepared.capacity?.disposition ?? "safe",
    });
    if (input.prepared.conflicts.length > 0) {
        throw new TypeError("A conflicted menu plan cannot be executed.");
    }
}
