import type {
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
import type {
    EntityStatus,
    MenuRuleSourceState,
    PermissionRuleInput,
    RuleConflict,
    SourceDrift,
    SourceIntegrity,
} from "./rbac";
import type {
    PermissionAction,
    PermissionRuleAction,
    PolicyValue,
} from "./foundation";
import type { RowCondition } from "./policy";

export type SourceRewriteResolution =
    | { action: "replace"; replacementSemanticKey: string }
    | { action: "revoke"; replacementSemanticKey?: never };

export type SourceRewriteDecision =
    | { mode: "reject"; resolutions?: never }
    | { mode: "apply"; resolutions: Readonly<Record<string, SourceRewriteResolution>> };

export type MenuNodeType = "directory" | "menu" | "page" | "button" | "external" | "iframe";
export type MenuDataPermissionAction = "read" | "create" | "update" | "delete" | "write" | "*";
export type MenuDataPermissionResource = `db:${string}` | `db:${string}:field:${string}`;

export interface MenuDataPermissionTemplate {
    action: MenuDataPermissionAction;
    resource: MenuDataPermissionResource;
    where?: RowCondition;
    label?: string;
}

export interface MenuPermissionRequirement {
    action: PermissionAction;
    resource: string;
}

export interface MenuNode {
    id: string;
    parentId: string | null;
    type: MenuNodeType;
    title: string;
    path?: string;
    name?: string;
    code?: string;
    component?: string;
    url?: string;
    icon?: string;
    order: number;
    status: EntityStatus;
    hidden: boolean;
    i18nKey?: string;
    meta?: Readonly<Record<string, PolicyValue>>;
    permission?: MenuPermissionRequirement;
    dataPermissions?: readonly MenuDataPermissionTemplate[];
    revision: number;
    createdAt: number;
    updatedAt: number;
}

export interface MenuNodeCreateInput {
    id: string;
    parentId?: string | null;
    type: MenuNodeType;
    title: string;
    path?: string;
    name?: string;
    code?: string;
    component?: string;
    url?: string;
    icon?: string;
    status?: EntityStatus;
    hidden?: boolean;
    i18nKey?: string;
    meta?: Readonly<Record<string, PolicyValue>>;
    permission?: MenuPermissionRequirement;
    dataPermissions?: readonly MenuDataPermissionTemplate[];
}

export interface MenuNodeUpdateInput {
    title?: string;
    component?: string | null;
    icon?: string | null;
    hidden?: boolean;
    i18nKey?: string | null;
    meta?: Readonly<Record<string, PolicyValue>> | null;
}

export interface MenuNodeImpactUpdateInput extends MenuNodeUpdateInput {
    path?: string | null;
    name?: string | null;
    code?: string | null;
    url?: string | null;
    permission?: MenuPermissionRequirement | null;
    dataPermissions?: readonly MenuDataPermissionTemplate[] | null;
}

export interface MenuNodeImpactUpdateRequest {
    patch: MenuNodeImpactUpdateInput;
    sourceRewrite?: SourceRewriteDecision;
}

export interface MenuNodeFilter {
    parentId?: string | null;
    type?: MenuNodeType | readonly MenuNodeType[];
    status?: EntityStatus;
    hidden?: boolean;
    search?: string;
}

export interface MenuMoveInput {
    nodeId: string;
    parentId: string | null;
    beforeId?: string;
    afterId?: string;
}

export interface MenuReorderInput {
    parentId: string | null;
    orderedNodeIds: readonly string[];
}

export interface MenuTreeNode extends MenuNode {
    children: readonly MenuTreeNode[];
}

export interface SourceRewriteImpact {
    roleId: string;
    grantId: string;
    sourceId: string;
    semanticKey: string;
    reason: "permission-change" | "asset-remove" | "binding-change" | "invalid-reference";
    resolutions: readonly ("replace" | "revoke")[];
    replacementCandidates: BoundedDetails<{ semanticKey: string; rule: PermissionRuleInput }>;
}

export type MenuNodePreviewState = Omit<MenuNode, "revision" | "createdAt" | "updatedAt">;

export interface MenuNodeUpdatePlan {
    nodeId: string;
    request: MenuNodeImpactUpdateRequest;
    before: MenuNodePreviewState;
    after: MenuNodePreviewState;
    sourceImpacts: BoundedDetails<SourceRewriteImpact>;
}

export interface MenuMovePlan {
    nodeId: string;
    fromParentId: string | null;
    toParentId: string | null;
    siblingsBefore: CountSample;
    siblingsAfter: CountSample;
    descendantCount: number;
}

export interface MenuReorderPlan {
    parentId: string | null;
    before: CountSample;
    after: CountSample;
}

export interface MenuRemovalImpact {
    nodeId: string;
    descendants: CountSample;
    apiBindings: CountSample;
    roleSources: CountSample;
    removableWithoutCascade: boolean;
}

export interface MenuRemovalPlan {
    rootNodeId: string;
    cascade: boolean;
    nodes: BoundedDetails<string>;
    detachedApiBindings: BoundedDetails<string>;
    sourceImpacts: BoundedDetails<SourceRewriteImpact>;
}

export interface MenuStatusPlan {
    nodeId: string;
    before: EntityStatus;
    after: EntityStatus;
    affectedSources: CountSample;
    affectedRoles: CountSample;
    affectedUsers: CountSample;
}

export interface MenuRemoveInput {
    cascade: boolean;
    sourceRewrite?: SourceRewriteDecision;
}

export interface StaleReference {
    type: "api-owner" | "parent";
    id: string;
    assetId?: string;
    reason: string;
}

export type StructuralStaleResolution =
    | { action: "remove"; replacementId?: never }
    | { action: "rebind"; replacementId: string };

export interface StaleRepairInput {
    referenceIds: readonly string[];
    resolutions: Readonly<Record<string, StructuralStaleResolution>>;
}

export interface StaleRepairPlan {
    operations: BoundedDetails<{
        referenceId: string;
        action: "remove" | "rebind";
        replacementId?: string;
    }>;
    sourceImpacts: BoundedDetails<SourceRewriteImpact>;
}

export interface ApiPermissionRequirement {
    action: PermissionAction;
    resource: string;
}

export interface ApiAuthorization {
    mode: "all" | "any";
    permissions: readonly ApiPermissionRequirement[];
}

export interface ApiOwnerRelation {
    type: "menu" | "page" | "button";
    id: string;
    required: boolean;
    availabilityGroup?: string;
    availabilityMode?: "all" | "any";
}

export interface ApiBinding {
    id: string;
    method: string;
    path: string;
    purpose: "entry" | "lookup" | "detail" | "operation" | "importExport" | "background";
    authorization: ApiAuthorization;
    owners: readonly ApiOwnerRelation[];
    canonicalOwner?: { type: ApiOwnerRelation["type"]; id: string };
    status: EntityStatus;
    description?: string;
    revision: number;
    createdAt: number;
    updatedAt: number;
}

export interface ApiBindingCreateInput {
    id: string;
    method: string;
    path: string;
    purpose: ApiBinding["purpose"];
    authorization: ApiAuthorization;
    owners?: readonly ApiOwnerRelation[];
    canonicalOwner?: ApiBinding["canonicalOwner"];
    status?: EntityStatus;
    description?: string;
}

export interface ApiBindingUpdateInput {
    purpose?: ApiBinding["purpose"];
    description?: string | null;
}

export interface ApiBindingImpactUpdateInput extends ApiBindingUpdateInput {
    method?: string;
    path?: string;
    authorization?: ApiAuthorization;
    owners?: readonly ApiOwnerRelation[];
    canonicalOwner?: ApiBinding["canonicalOwner"] | null;
}

export interface ApiBindingImpactUpdateRequest {
    patch: ApiBindingImpactUpdateInput;
    sourceRewrite?: SourceRewriteDecision;
}

export interface ApiBindingRemoveInput {
    sourceRewrite?: SourceRewriteDecision;
}

export interface ApiBindingReplaceInput {
    bindings: readonly ApiBindingCreateInput[];
    sourceRewrite?: SourceRewriteDecision;
}

export interface ApiBindingFilter {
    method?: string;
    path?: string;
    status?: EntityStatus;
    purpose?: ApiBinding["purpose"];
    ownerId?: string;
}

export interface ApiBindingImpact {
    bindingId: string;
    ownerRelations: CountSample;
    roleSources: CountSample;
    removableWithoutRewrite: boolean;
}

export type ApiBindingPreviewState = Omit<ApiBinding, "revision" | "createdAt" | "updatedAt">;

export interface ApiBindingRewritePlan {
    bindingId: string;
    request: ApiBindingImpactUpdateRequest;
    before: ApiBindingPreviewState;
    after: ApiBindingPreviewState;
    sourceImpacts: BoundedDetails<SourceRewriteImpact>;
}

export interface ApiBindingRemovalPlan {
    bindingId: string;
    sourceImpacts: BoundedDetails<SourceRewriteImpact>;
    detachedOwners: BoundedDetails<ApiOwnerRelation>;
}

export interface ApiBindingStatusPlan {
    bindingId: string;
    before: EntityStatus;
    after: EntityStatus;
    affectedSources: CountSample;
    affectedRoles: CountSample;
    affectedUsers: CountSample;
}

export interface ApiBindingReplacePlan {
    operations: BoundedDetails<{ bindingId: string; action: "insert" | "update" | "delete" }>;
    unchanged: CountSample;
    sourceImpacts: BoundedDetails<SourceRewriteImpact>;
}

export interface MenuManifestNodeInput extends MenuNodeCreateInput {
    order: number;
}

export interface MenuManifestInput {
    schemaVersion: 2;
    mode: "merge" | "replace";
    nodes: readonly MenuManifestNodeInput[];
    apiBindings: readonly ApiBindingCreateInput[];
    sourceRewrite?: SourceRewriteDecision;
}

export interface MenuManifestPlan {
    mode: "merge" | "replace";
    nodeOperations: BoundedDetails<{ id: string; action: "insert" | "update" | "delete" }>;
    unchangedNodes: CountSample;
    bindingOperations: BoundedDetails<{ id: string; action: "insert" | "update" | "delete" }>;
    unchangedBindings: CountSample;
    sourceImpacts: BoundedDetails<SourceRewriteImpact>;
}

export interface FrontendMenuManifest {
    schemaVersion: 2;
    nodes: readonly MenuManifestNodeInput[];
    apiBindings: readonly ApiBindingCreateInput[];
}

export type MenuManifestExportRecord =
    | { kind: "node"; value: MenuManifestNodeInput }
    | { kind: "api-binding"; value: ApiBindingCreateInput };

export interface MenuPermissionSelection {
    nodeIds: readonly string[];
    include: {
        descendants: boolean;
        buttons: boolean;
        apis: "none" | "required" | "all";
        dataPermissions: boolean;
    };
    apiChoices: {
        bindingIds: readonly string[];
        permissionsByBinding: Readonly<Record<string, readonly string[]>>;
    };
}

export interface MenuPermissionAssignment {
    effect: "allow" | "deny";
    selection: MenuPermissionSelection;
}

export type MenuPermissionChoiceRequirement =
    | {
        choiceId: string;
        kind: "availability-any";
        anchorId: string;
        ownerAssetId: string;
        availabilityGroup: string;
        candidates: BoundedDetails<{ bindingId: string; method: string; path: string; required: true }>;
        selectedBindingIds: readonly string[];
        minSelections: 1;
        resolved: boolean;
    }
    | {
        choiceId: string;
        kind: "authorization-any";
        anchorId: string;
        ownerAssetId: string;
        bindingId: string;
        candidates: BoundedDetails<{ semanticKey: string; requirement: ApiPermissionRequirement }>;
        selectedSemanticKeys: readonly string[];
        minSelections: 1;
        resolved: boolean;
    };

export type MenuPermissionChange =
    | { operation: "grant" | "deny"; selection: MenuPermissionSelection }
    | { operation: "revoke"; grantIds: readonly string[] }
    | { operation: "set"; assignments: readonly MenuPermissionAssignment[] };

export interface MenuGrantIntent {
    anchorId: string;
    include: MenuPermissionSelection["include"];
    apiChoices: MenuPermissionSelection["apiChoices"];
}

export interface MenuGrantSnapshotRef {
    contributionContractDigest: string;
    contributionDigest: string;
    contributingAssetCount: number;
    contributingBindingCount: number;
}

export interface MenuGrantSnapshot extends MenuGrantSnapshotRef {
    contributingAssetIds: BoundedDetails<string>;
    contributingBindingIds: BoundedDetails<string>;
}

export interface MenuRuleContribution {
    sourceId: string;
    grantId: string;
    semanticKey: string;
    effect: "allow" | "deny";
    action: PermissionRuleAction;
    resource: string;
    where?: RowCondition;
    contribution: "node" | "api" | "data";
    assetId: string;
    apiBindingId?: string;
    dataResource?: string;
}

export interface MenuPermissionPlan {
    roleId: string;
    operation: MenuPermissionChange["operation"];
    choiceRequirements: BoundedDetails<MenuPermissionChoiceRequirement>;
    grants: BoundedDetails<{
        grantId: string;
        effect: "allow" | "deny";
        intent: MenuGrantIntent;
        snapshot: MenuGrantSnapshot;
        contributions: BoundedDetails<MenuRuleContribution>;
    }>;
    removals: BoundedDetails<{ grantId: string; sourceIds: BoundedDetails<string> }>;
}

export interface MenuPermissionGrantResult {
    roleId: string;
    grantIds: BoundedDetails<string>;
    refreshedGrantIds: BoundedDetails<string>;
    generatedSources: number;
    removedSources: number;
    generatedSemanticRules: number;
}

export interface DirectMenuGrantSnapshot {
    grantId: string;
    revision: number;
    effect: "allow" | "deny";
    intent: MenuGrantIntent;
    snapshot: MenuGrantSnapshot;
    contributions: BoundedDetails<MenuRuleContribution>;
    sourceStatus: {
        integrity: SourceIntegrity;
        availability: "active" | "partially-active" | "inactive";
        drift: SourceDrift;
    };
    sourceStates: BoundedDetails<{
        sourceId: string;
        state: MenuRuleSourceState;
        reason?:
            | "asset-disabled" | "asset-deprecated"
            | "binding-disabled" | "binding-deprecated"
            | "grant-missing" | "grant-revision-mismatch" | "reference-missing"
            | "contribution-refresh-available";
    }>;
    stateReasons: BoundedDetails<string>;
}

export interface DirectMenuPermissionSnapshot {
    roleId: string;
    grants: readonly DirectMenuGrantSnapshot[];
}

export interface EffectiveMenuPermissionSnapshot {
    roleId: string;
    grants: BoundedDetails<DirectMenuGrantSnapshot & {
        sourceRoleId: string;
        inherited: boolean;
        depth: number;
    }>;
    conflicts: BoundedDetails<RuleConflict>;
}

export interface AuthorizationTreeNode {
    node: MenuNode;
    state: "direct-allow" | "direct-deny" | "inherited-allow" | "inherited-deny" | "conflict" | "none";
    sourceStatus: DirectMenuGrantSnapshot["sourceStatus"] | null;
    selection: "none" | "partial" | "all";
    grantIds: BoundedDetails<string>;
    apiBindingStates: BoundedDetails<{
        bindingId: string;
        coverage: "allow" | "deny" | "conflict" | "conditional" | "none";
        reason:
            | "direct-rule" | "inherited-rule" | "direct-and-inherited"
            | "requires-subject-context" | "no-role-rule"
            | "asset-inactive" | "integrity-invalid" | "refresh-available";
    }>;
    children: readonly AuthorizationTreeNode[];
}

export interface StaleMenuPermissionSource {
    roleId: string;
    grantId: string;
    sourceId: string;
    reason: "asset-missing" | "binding-missing" | "permission-changed" | "selection-drift";
}

export interface StaleMenuPermissionRepairInput {
    sourceIds: readonly string[];
    sourceRewrite?: SourceRewriteDecision;
}

export interface StaleMenuPermissionRepairPlan {
    sourceImpacts: BoundedDetails<SourceRewriteImpact>;
}

export interface MenuManifestManager {
    preview(input: MenuManifestInput, options?: PreviewOptions): Promise<ImpactPreview<MenuManifestPlan>>;
    import(input: MenuManifestInput, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<BatchMutationSummary>>;
    export(): Promise<VersionedResult<FrontendMenuManifest>>;
    exportPage(query?: CursorQuery & { kind?: MenuManifestExportRecord["kind"] }): Promise<PageResult<MenuManifestExportRecord>>;
}

export interface MenuManager {
    readonly manifest: MenuManifestManager;
    create(input: MenuNodeCreateInput, options?: MutationOptions): Promise<MutationResult<MenuNode>>;
    get(nodeId: string): Promise<VersionedResult<MenuNode>>;
    list(query?: CursorQuery & MenuNodeFilter): Promise<PageResult<MenuNode>>;
    getTree(options?: { rootId?: string; includeHidden?: boolean }): Promise<VersionedResult<MenuTreeNode[]>>;
    update(nodeId: string, patch: MenuNodeUpdateInput, options: RequiredRevisionOptions): Promise<MutationResult<MenuNode>>;
    previewUpdate(nodeId: string, request: MenuNodeImpactUpdateRequest, options?: PreviewOptions): Promise<ImpactPreview<MenuNodeUpdatePlan>>;
    executeUpdate(nodeId: string, request: MenuNodeImpactUpdateRequest, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<MenuNode>>;
    previewMove(input: MenuMoveInput, options?: PreviewOptions): Promise<ImpactPreview<MenuMovePlan>>;
    move(input: MenuMoveInput, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<MenuNode>>;
    previewReorder(input: MenuReorderInput, options?: PreviewOptions): Promise<ImpactPreview<MenuReorderPlan>>;
    reorder(input: MenuReorderInput, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<BatchMutationSummary>>;
    previewSetStatus(nodeId: string, status: EntityStatus, options?: PreviewOptions): Promise<ImpactPreview<MenuStatusPlan>>;
    setStatus(nodeId: string, status: EntityStatus, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<MenuNode>>;
    getRemovalImpact(nodeId: string): Promise<VersionedResult<MenuRemovalImpact>>;
    previewRemove(nodeId: string, input: MenuRemoveInput, options?: PreviewOptions): Promise<ImpactPreview<MenuRemovalPlan>>;
    remove(nodeId: string, input: MenuRemoveInput, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<BatchMutationSummary>>;
    findStaleReferences(query?: CursorQuery): Promise<PageResult<StaleReference>>;
    previewRepairStaleReferences(input: StaleRepairInput, options?: PreviewOptions): Promise<ImpactPreview<StaleRepairPlan>>;
    repairStaleReferences(input: StaleRepairInput, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<BatchMutationSummary>>;
}

export interface ApiBindingManager {
    create(input: ApiBindingCreateInput, options?: MutationOptions): Promise<MutationResult<ApiBinding>>;
    get(bindingId: string): Promise<VersionedResult<ApiBinding>>;
    list(query?: CursorQuery & ApiBindingFilter): Promise<PageResult<ApiBinding>>;
    update(bindingId: string, patch: ApiBindingUpdateInput, options: RequiredRevisionOptions): Promise<MutationResult<ApiBinding>>;
    previewSetStatus(bindingId: string, status: EntityStatus, options?: PreviewOptions): Promise<ImpactPreview<ApiBindingStatusPlan>>;
    setStatus(bindingId: string, status: EntityStatus, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<ApiBinding>>;
    getRemovalImpact(bindingId: string): Promise<VersionedResult<ApiBindingImpact>>;
    previewUpdate(bindingId: string, request: ApiBindingImpactUpdateRequest, options?: PreviewOptions): Promise<ImpactPreview<ApiBindingRewritePlan>>;
    executeUpdate(bindingId: string, request: ApiBindingImpactUpdateRequest, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<ApiBinding>>;
    previewRemove(bindingId: string, input: ApiBindingRemoveInput, options?: PreviewOptions): Promise<ImpactPreview<ApiBindingRemovalPlan>>;
    remove(bindingId: string, input: ApiBindingRemoveInput, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<BatchMutationSummary>>;
    previewReplace(input: ApiBindingReplaceInput, options?: PreviewOptions): Promise<ImpactPreview<ApiBindingReplacePlan>>;
    replace(input: ApiBindingReplaceInput, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<BatchMutationSummary>>;
}

export interface RoleMenuPermissionManager {
    preview(roleId: string, change: MenuPermissionChange, options?: PreviewOptions): Promise<ImpactPreview<MenuPermissionPlan>>;
    grant(roleId: string, selection: MenuPermissionSelection, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<MenuPermissionGrantResult>>;
    revoke(roleId: string, input: { grantIds: readonly string[] }, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<BatchMutationSummary>>;
    deny(roleId: string, selection: MenuPermissionSelection, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<MenuPermissionGrantResult>>;
    set(roleId: string, assignments: readonly MenuPermissionAssignment[], options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<BatchMutationSummary>>;
    getDirect(roleId: string): Promise<VersionedResult<DirectMenuPermissionSnapshot>>;
    listDirect(roleId: string, query?: CursorQuery & { effect?: "allow" | "deny" }): Promise<PageResult<DirectMenuGrantSnapshot>>;
    getEffective(roleId: string): Promise<VersionedResult<EffectiveMenuPermissionSnapshot>>;
    getAuthorizationTree(roleId: string): Promise<VersionedResult<AuthorizationTreeNode[]>>;
    listStale(query?: CursorQuery): Promise<PageResult<StaleMenuPermissionSource>>;
    previewRepairStale(input: StaleMenuPermissionRepairInput, options?: PreviewOptions): Promise<ImpactPreview<StaleMenuPermissionRepairPlan>>;
    repairStale(input: StaleMenuPermissionRepairInput, options: RequiredRevisionVectorOptions & PreviewExecutionOptions): Promise<MutationResult<BatchMutationSummary>>;
}

export interface MenuRuntimeApiRisk {
    bindingId: string;
    required: boolean;
    allowed: boolean;
}

export interface VisibleMenuTreeNode {
    id: string;
    parentId: string | null;
    type: Exclude<MenuNodeType, "button">;
    title: string;
    path?: string;
    name?: string;
    component?: string;
    url?: string;
    icon?: string;
    order: number;
    i18nKey?: string;
    meta?: Readonly<Record<string, PolicyValue>>;
    permission?: MenuPermissionRequirement;
    visible: true;
    enabled: boolean;
    reason: "allowed" | "api-unavailable";
    apiRisks: BoundedDetails<MenuRuntimeApiRisk>;
    children: readonly VisibleMenuTreeNode[];
}

export interface ButtonPermissionState {
    visible: boolean;
    enabled: boolean;
    reason: "allowed" | "permission-denied" | "api-unavailable" | "hidden" | "disabled";
    action: PermissionAction;
    resource: string;
    apiRisks: BoundedDetails<MenuRuntimeApiRisk>;
}

export interface RoutePermissionState {
    allowed: boolean;
    reason: "allowed" | "not-found" | "permission-denied" | "api-unavailable" | "disabled";
    nodeId?: string;
    action?: PermissionAction;
    resource?: string;
    matchedPath?: string;
    apiRisks: BoundedDetails<MenuRuntimeApiRisk>;
    navigationReachable: boolean;
    navigationReason: "reachable" | "self-hidden" | "hidden-ancestor" | "disabled-ancestor" | "denied-ancestor" | "self-unavailable" | "not-found";
}

export interface SubjectMenuRuntime {
    getVisibleTree(options?: { rootId?: string }): Promise<SubjectRuntimeResult<VisibleMenuTreeNode[]>>;
    getButtonMap(ownerNodeId: string): Promise<SubjectRuntimeResult<Readonly<Record<string, ButtonPermissionState>>>>;
    getRouteState(path: string): Promise<SubjectRuntimeResult<RoutePermissionState>>;
}
