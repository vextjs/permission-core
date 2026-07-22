import type { PolicyValue } from "./foundation";

export interface EntityRevisionRef {
    kind: "role" | "user-role-set" | "role-menu-grant" | "menu-config" | "menu-node" | "api-binding" | "scope";
    id: string;
    revision: number;
}

export interface RevisionVector {
    global: number;
    rbac: number;
    menu: number;
    audit: number;
    entities: readonly EntityRevisionRef[];
}

export interface ExpectedRevisionVector {
    global?: number;
    rbac?: number;
    menu?: number;
    entities?: readonly EntityRevisionRef[];
}

export interface BoundedDetails<T> {
    total: number;
    items: readonly T[];
    truncated: boolean;
    digest: string;
}

export interface ResponseDetailBudget {
    limit: 100;
    returned: number;
    truncated: boolean;
    digest: string;
}

export interface ManagementWarning {
    code: string;
    message: string;
    details?: Readonly<Record<string, PolicyValue>>;
}

export interface ManagementConflict {
    id: string;
    code: string;
    message: string;
    currentRevision?: number;
}

export interface CountSample {
    total: number;
    sampleIds: readonly string[];
    truncated: boolean;
    digest: string;
}

export interface EffectiveCapacityUsage {
    effectiveRoles: number;
    semanticRules: number;
    sourceRefs: number;
    snapshotBytes: number;
}

export interface AuthorizationCapacityAssessment {
    accessDirection: "expand" | "restrict" | "mixed" | "none";
    capacityDirection: "non-increasing" | "expanding" | "mixed";
    proof: "exact" | "conservative" | "partial";
    affectedUsers: CountSample;
    evaluatedUsers: number;
    unverifiedUsers: number;
    violatingUsers: CountSample;
    maxEvaluated: EffectiveCapacityUsage;
    limits: EffectiveCapacityUsage;
    disposition: "safe" | "ack-required" | "blocked";
    digest: string;
}

export interface BatchMutationSummary {
    inserted: number;
    updated: number;
    unchanged: number;
    deleted: number;
    conflicted: number;
    samples: BoundedDetails<{
        id: string;
        outcome: "inserted" | "updated" | "unchanged" | "deleted" | "conflicted";
        conflict?: {
            code: string;
            message: string;
            currentRevision?: number;
        };
    }>;
}

export interface MutationOptions {
    actorId?: string;
    reason?: string;
    requestId?: string;
    idempotencyKey?: string;
}

export interface PreviewOptions {
    actorId?: string;
    reason?: string;
    requestId?: string;
}

export type ScopedMutationDefaults = PreviewOptions;

export type RequiredRevisionOptions = MutationOptions & {
    expectedRevision: number;
    expectedRevisions?: never;
};

export type RequiredRevisionVectorOptions = MutationOptions & {
    expectedRevisions: ExpectedRevisionVector;
    expectedRevision?: never;
};

export interface PreviewExecutionOptions {
    previewToken: string;
    acknowledgeCapacityRisk?: true;
}

export interface AuthorizationPreviewExpectation {
    expectedRevisions: ExpectedRevisionVector;
}

export interface AuditPreviewExpectation {
    expectedAuditRevision: number;
}

export interface MutationResult<T> {
    committed: true;
    changed: boolean;
    data: T;
    revision: number;
    revisions: RevisionVector;
    operationId: string;
    auditId: string;
    replayed: boolean;
    cache: {
        status: "not-needed" | "completed" | "bypassed" | "degraded";
        reason?: string;
    };
    warnings: BoundedDetails<ManagementWarning>;
    detailBudget: ResponseDetailBudget;
}

export interface VersionedResult<T> {
    data: T;
    revision: number;
    revisions: RevisionVector;
    etag: string;
    detailBudget: ResponseDetailBudget;
}

export interface SubjectRuntimeResult<T> {
    data: T;
    detailBudget: ResponseDetailBudget;
}

export interface PageResult<T> {
    items: readonly T[];
    pageInfo: {
        hasNext: boolean;
        endCursor: string | null;
    };
    revision: number;
    revisions: RevisionVector;
    etag: string;
    detailBudget: ResponseDetailBudget;
}

export interface CursorQuery {
    first?: number;
    after?: string;
}

export type ImpactPreview<
    TPlan,
    TExpectation extends AuthorizationPreviewExpectation | AuditPreviewExpectation = AuthorizationPreviewExpectation,
    TSummary = BatchMutationSummary,
> =
    | {
        executable: true;
        previewToken: string;
        expected: TExpectation;
        revisions: RevisionVector;
        summary: TSummary;
        plan: TPlan;
        capacity: AuthorizationCapacityAssessment | null;
        warnings: BoundedDetails<ManagementWarning>;
        conflicts: BoundedDetails<ManagementConflict>;
        detailBudget: ResponseDetailBudget;
        expiresAt: number;
    }
    | {
        executable: false;
        previewToken: null;
        expected: null;
        revisions: RevisionVector;
        summary: TSummary;
        plan: TPlan;
        capacity: AuthorizationCapacityAssessment | null;
        warnings: BoundedDetails<ManagementWarning>;
        conflicts: BoundedDetails<ManagementConflict>;
        detailBudget: ResponseDetailBudget;
        expiresAt: null;
    };
