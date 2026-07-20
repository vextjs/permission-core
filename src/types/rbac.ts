import type {
    PermissionAction,
    PermissionRuleAction,
    PermissionScope,
} from "./foundation";
import type {
    AuthorizationCapacityAssessment,
    BatchMutationSummary,
    BoundedDetails,
    CountSample,
    CursorQuery,
    ImpactPreview,
    MutationOptions,
    MutationResult,
    PageResult,
    PreviewExecutionOptions,
    PreviewOptions,
    RequiredRevisionOptions,
    RequiredRevisionVectorOptions,
    SubjectRuntimeResult,
    VersionedResult,
} from "./management";
import type { PolicyConditionOutcome, RowCondition } from "./policy";
import type {
    MenuConfigRootManager,
    RoleMenuPermissionManager,
    SubjectMenuRuntime,
} from "./menu";
import type { SubjectDataRuntime } from "./data";

export type EntityStatus = "enabled" | "disabled" | "deprecated";

export interface Role {
    id: string;
    label: string;
    description?: string;
    status: EntityStatus;
    parentId: string | null;
    revision: number;
    createdAt: number;
    updatedAt: number;
}

export interface RoleAuthorizationSnapshot {
    id: string;
    status: EntityStatus;
    parentId: string | null;
    revision: number;
}

export interface PermissionRuleInput {
    action: PermissionRuleAction;
    resource: string;
    where?: RowCondition;
}

export type SourceIntegrity = "valid" | "invalid";
export type SourceAvailability = "active" | "inactive";
export type SourceDrift = "current" | "refresh-available";

export interface MenuRuleSourceState {
    integrity: SourceIntegrity;
    availability: SourceAvailability;
    drift: SourceDrift;
}

export type RuleSourceView =
    | {
        kind: "manual";
        sourceId: string;
        state: "active";
    }
    | {
        kind: "menu";
        grantId: string;
        grantRevision: number;
        sourceId: string;
        effect: "allow" | "deny";
        contribution: "node" | "api" | "data";
        assetId: string;
        apiBindingId?: string;
        dataResource?: string;
        state: MenuRuleSourceState;
        stateReason?:
            | "asset-disabled"
            | "asset-deprecated"
            | "binding-disabled"
            | "binding-deprecated"
            | "grant-missing"
            | "grant-revision-mismatch"
            | "reference-missing"
            | "contribution-refresh-available";
    };

export interface PermissionRuleView extends PermissionRuleInput {
    effect: "allow" | "deny";
    semanticKey: string;
    sources: BoundedDetails<RuleSourceView>;
}

export interface UserRoleBindingSet {
    userId: string;
    roleIds: readonly string[];
    revision: number;
    persisted: boolean;
    createdAt?: number;
    updatedAt?: number;
}

export interface RoleCreateInput {
    id: string;
    label: string;
    description?: string;
    status?: EntityStatus;
    parentId?: string | null;
}

export interface RoleUpdateInput {
    label?: string;
    description?: string | null;
}

export interface RoleAccessUpdateInput {
    status?: EntityStatus;
    parentId?: string | null;
}

export interface ManualRuleSelector {
    effect: "allow" | "deny";
    action: PermissionRuleAction;
    resource: string;
    where?: RowCondition;
    semanticKey?: string;
}

export type ManualRuleInput = PermissionRuleInput & {
    effect: "allow" | "deny";
};

export type ManualRuleChange =
    | { operation: "allow" | "deny"; rule: PermissionRuleInput }
    | { operation: "revoke"; selector: ManualRuleSelector };

export interface RoleRemovalImpact {
    roleId: string;
    children: CountSample;
    boundUsers: CountSample;
    ownRules: number;
    menuSources: number;
    removable: boolean;
    blockers: BoundedDetails<string>;
}

export interface RoleAccessUpdatePlan {
    roleId: string;
    before: Required<Pick<Role, "status" | "parentId">>;
    after: Required<Pick<Role, "status" | "parentId">>;
    descendants: CountSample;
    directlyBoundUsers: CountSample;
    affectedUsers: CountSample;
}

export interface RoleRuleReplacePlan {
    roleId: string;
    operations: BoundedDetails<{
        semanticKey: string;
        action: "insert" | "update" | "delete";
    }>;
    unchanged: CountSample;
    affectedUsers: CountSample;
}

export interface ManualRuleChangePlan {
    roleId: string;
    operation: ManualRuleChange["operation"];
    semanticKey: string;
    sourceOperation: "insert" | "delete" | "noop";
    affectedUsers: CountSample;
}

export type ManualRuleChangeResult =
    | { operation: "allow" | "deny"; rule: PermissionRuleView }
    | { operation: "revoke"; removed: number; remainingCount: number; remainingDigest: string };

export interface RoleChainEntry {
    role: RoleAuthorizationSnapshot;
    depth: number;
    included: boolean;
    excludedReason?: "disabled" | "deprecated";
}

export interface EffectiveRuleEntry extends PermissionRuleView {
    sourceRoleId: string;
    inherited: boolean;
    depth: number;
}

export interface RuleConflict {
    action: PermissionRuleAction;
    resource: string;
    allowSemanticKeys: BoundedDetails<string>;
    denySemanticKeys: BoundedDetails<string>;
    resolution: "deny";
}

export interface EffectiveRoleRules {
    role: RoleAuthorizationSnapshot;
    chain: readonly RoleChainEntry[];
    rules: BoundedDetails<EffectiveRuleEntry>;
    conflicts: BoundedDetails<RuleConflict>;
}

export interface EffectiveUserRoleEntry {
    role: RoleAuthorizationSnapshot;
    direct: boolean;
    viaRoleIds: readonly string[];
    depth: number;
    included: boolean;
    excludedReason?: "disabled" | "deprecated";
}

export interface UserEffectiveRoles {
    userId: string;
    direct: UserRoleBindingSet;
    effective: BoundedDetails<EffectiveUserRoleEntry>;
}

export interface SubjectRoleAuthorizationSnapshot {
    id: string;
    status: EntityStatus;
    parentId: string | null;
}

export interface SubjectEffectiveRoleEntry {
    role: SubjectRoleAuthorizationSnapshot;
    direct: boolean;
    viaRoleIds: readonly string[];
    depth: number;
    included: boolean;
    excludedReason?: "disabled" | "deprecated";
}

export interface SubjectEffectiveRuleEntry extends PermissionRuleInput {
    effect: "allow" | "deny";
    sourceRoleId: string;
    inherited: boolean;
    depth: number;
}

export interface SubjectRuleConflict {
    action: PermissionRuleAction;
    resource: string;
    allowCount: number;
    denyCount: number;
    conditional: boolean;
    resolution: "deny";
}

export interface EffectivePermissionSnapshot {
    subject: { userId: string; scope: PermissionScope };
    directRoleIds: readonly string[];
    roles: BoundedDetails<SubjectEffectiveRoleEntry>;
    rules: BoundedDetails<SubjectEffectiveRuleEntry>;
    conflicts: BoundedDetails<SubjectRuleConflict>;
}

export interface PermissionDecisionTrace {
    effect: "allow" | "deny";
    ruleAction: PermissionRuleAction;
    ruleResource: string;
    sourceRoleId: string;
    inherited: boolean;
    whereOutcome: PolicyConditionOutcome;
}

export type PermissionDecisionReason =
    | "allow"
    | "explicit-deny"
    | "policy-unknown"
    | "no-allow"
    | "role-disabled"
    | "context-missing";

export interface PermissionActionEvaluation {
    action: PermissionAction;
    allowed: boolean;
    reason: PermissionDecisionReason;
    evaluatedAllows: BoundedDetails<PermissionDecisionTrace>;
    evaluatedDenies: BoundedDetails<PermissionDecisionTrace>;
}

export interface PermissionExplanation {
    allowed: boolean;
    action: PermissionAction;
    resource: string;
    reason: PermissionDecisionReason;
    evaluations: readonly PermissionActionEvaluation[];
}

export interface EffectiveResourcePattern {
    action: PermissionRuleAction;
    resource: string;
    conditional: boolean;
    where?: RowCondition;
    sourceRoleIds: BoundedDetails<string>;
}

export interface RoleManager {
    readonly menuPermissions: RoleMenuPermissionManager;
    create(input: RoleCreateInput, options?: MutationOptions): Promise<MutationResult<Role>>;
    get(roleId: string): Promise<VersionedResult<Role>>;
    list(query?: CursorQuery & { status?: EntityStatus; search?: string; parentId?: string | null }): Promise<PageResult<Role>>;
    update(roleId: string, patch: RoleUpdateInput, options: RequiredRevisionOptions): Promise<MutationResult<Role>>;
    previewAccessUpdate(roleId: string, patch: RoleAccessUpdateInput, options?: PreviewOptions): Promise<ImpactPreview<RoleAccessUpdatePlan>>;
    executeAccessUpdate(roleId: string, patch: RoleAccessUpdateInput, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<Role>>;
    getRemovalImpact(roleId: string): Promise<VersionedResult<RoleRemovalImpact>>;
    remove(roleId: string, options: RequiredRevisionOptions): Promise<MutationResult<{ removedRoleId: string }>>;
    allow(roleId: string, rule: PermissionRuleInput, options?: MutationOptions): Promise<MutationResult<PermissionRuleView>>;
    deny(roleId: string, rule: PermissionRuleInput, options?: MutationOptions): Promise<MutationResult<PermissionRuleView>>;
    revoke(roleId: string, selector: ManualRuleSelector, options?: MutationOptions): Promise<MutationResult<{ removed: number; remainingCount: number; remainingDigest: string }>>;
    previewRuleChange(roleId: string, change: ManualRuleChange, options?: PreviewOptions): Promise<ImpactPreview<ManualRuleChangePlan>>;
    executeRuleChange(roleId: string, change: ManualRuleChange, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<ManualRuleChangeResult>>;
    previewReplaceRules(roleId: string, rules: readonly ManualRuleInput[], options?: PreviewOptions): Promise<ImpactPreview<RoleRuleReplacePlan>>;
    replaceRules(roleId: string, rules: readonly ManualRuleInput[], options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<BatchMutationSummary>>;
    getOwnRules(roleId: string): Promise<VersionedResult<PermissionRuleView[]>>;
    listOwnRules(roleId: string, query?: CursorQuery & { effect?: "allow" | "deny"; sourceKind?: "manual" | "menu" }): Promise<PageResult<PermissionRuleView>>;
    getEffectiveRules(roleId: string): Promise<VersionedResult<EffectiveRoleRules>>;
    getChain(roleId: string): Promise<VersionedResult<RoleChainEntry[]>>;
}

export interface UserRoleManager {
    assign(userId: string, roleId: string, options?: MutationOptions): Promise<MutationResult<UserRoleBindingSet>>;
    revoke(userId: string, roleId: string, options?: MutationOptions): Promise<MutationResult<UserRoleBindingSet>>;
    set(userId: string, roleIds: readonly string[], options: RequiredRevisionOptions): Promise<MutationResult<UserRoleBindingSet>>;
    clear(userId: string, options: RequiredRevisionOptions): Promise<MutationResult<UserRoleBindingSet>>;
    getDirect(userId: string): Promise<VersionedResult<UserRoleBindingSet>>;
    getEffective(userId: string): Promise<VersionedResult<UserEffectiveRoles>>;
    listUsersByRole(roleId: string, query?: CursorQuery): Promise<PageResult<UserRoleBindingSet>>;
}

export interface ScopedPermissionContext {
    readonly roles: RoleManager;
    readonly userRoles: UserRoleManager;
    readonly menus: MenuConfigRootManager;
}

export interface SubjectPermissionContext {
    can(action: PermissionAction, resource: string): Promise<boolean>;
    cannot(action: PermissionAction, resource: string): Promise<boolean>;
    assert(action: PermissionAction, resource: string): Promise<void>;
    getPermissions(): Promise<SubjectRuntimeResult<EffectivePermissionSnapshot>>;
    getResources(action?: PermissionAction): Promise<SubjectRuntimeResult<EffectiveResourcePattern[]>>;
    explain(action: PermissionAction, resource: string): Promise<SubjectRuntimeResult<PermissionExplanation>>;
    readonly menus: SubjectMenuRuntime;
    readonly data: SubjectDataRuntime;
}

export type { AuthorizationCapacityAssessment };
