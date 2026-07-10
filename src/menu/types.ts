import type { PermissionCore } from "../core";
import type { PermissionRule, PermissionScope, PermissionSubject } from "../types";
import type { MenuPermissionExtensionRegistry } from "./extensions";

export type MenuAssetType =
    | "directory"
    | "menu"
    | "page"
    | "button"
    | "api"
    | "apiGroup"
    | "external"
    | "iframe";

export interface PermissionBinding {
    action: string;
    resource: string;
    required?: boolean;
}

export interface DataPermissionReference {
    action?: string;
    resource: string;
    label?: string;
}

export interface MenuNode {
    id: string;
    parentId?: string;
    pageId?: string;
    code?: string;
    type: MenuAssetType;
    title: string;
    path?: string;
    name?: string;
    component?: string;
    icon?: string;
    order?: number;
    hidden?: boolean;
    disabled?: boolean;
    status?: "enabled" | "disabled" | "deprecated";
    activeMenu?: string;
    i18nKey?: string;
    meta?: Record<string, unknown>;
    resource?: PermissionBinding;
    dataPermissions?: DataPermissionReference[];
}

export type ApiBindingPurpose =
    | "entry"
    | "lookup"
    | "detail"
    | "operation"
    | "importExport"
    | "background";

export interface ApiBinding {
    id: string;
    ownerType: "menu" | "page" | "button" | "apiGroup";
    ownerId: string;
    method: string;
    path: string;
    resource: string;
    action?: "invoke" | string;
    purpose: ApiBindingPurpose;
    required?: boolean;
    /** 同一路由的多权限分组；同组权限按 permissionMode 求值。 */
    permissionGroup?: string;
    /** 同组权限的求值模式；默认 `all`，保持历史 binding 语义。 */
    permissionMode?: "any" | "all";
    canonicalOwner?: boolean;
    description?: string;
}

export type AuthorizationTreeState =
    | "allow"
    | "deny"
    | "inherit-allow"
    | "inherit-deny"
    | "none"
    | "conflict";

export interface AuthorizationTreeNode {
    id: string;
    type: MenuAssetType;
    title: string;
    resource?: string;
    action?: string;
    state: AuthorizationTreeState;
    sourceRoleIds?: string[];
    apiBindings?: ApiBinding[];
    dataPermissions?: DataPermissionReference[];
    children?: AuthorizationTreeNode[];
}

export interface RoleAuthorizationInput {
    allow?: PermissionBinding[];
    deny?: PermissionBinding[];
    revoke?: PermissionBinding[];
    actorId?: string;
    reason?: string;
}

export interface PermissionAuditEntry {
    id: string;
    scopeKey: string;
    actorId?: string;
    roleId?: string;
    action: "role-authorization.save" | "manifest.import" | string;
    before?: unknown;
    after?: unknown;
    changes?: unknown;
    reason?: string;
    createdAt: number;
}

export interface VisibleMenuNode extends MenuNode {
    children?: VisibleMenuNode[];
}

export interface ButtonPermissionState {
    visible: boolean;
    enabled: boolean;
    reason?: "permission-denied" | "required-api-denied" | "disabled" | "not-found";
    resource?: string;
    apiBindings: string[];
}

export interface RoutePermissionState {
    allowed: boolean;
    reason?: "permission-denied" | "route-not-found" | "route-conflict" | "disabled";
    action?: string;
    resource?: string;
    node?: MenuNode;
}

export interface MenuValidationDiagnostic {
    code: string;
    severity: "error" | "warning";
    message: string;
    assetId?: string;
    resource?: string;
}

export interface RoleRuleSource {
    roleId: string;
    rules: PermissionRule[];
}

export interface MenuExtensionContext {
    scope: PermissionScope;
}

export type FrontendManifestLoader = (
    source: unknown,
    context: MenuExtensionContext,
) => FrontendMenuManifest | MenuNode[] | Promise<FrontendMenuManifest | MenuNode[]>;

export type ApiManifestLoader = (
    source: unknown,
    context: MenuExtensionContext,
) => ApiManifest | ApiBinding[] | Promise<ApiManifest | ApiBinding[]>;

export type MenuNodeNormalizer = (
    node: MenuNode,
    context: MenuExtensionContext,
) => MenuNode | Promise<MenuNode>;

export type ApiBindingNormalizer = (
    binding: ApiBinding,
    context: MenuExtensionContext,
) => ApiBinding | Promise<ApiBinding>;

export interface MenuValidationContext extends MenuExtensionContext {
    roleRules: RoleRuleSource[];
}

export type MenuConfigurationValidator = (
    nodes: MenuNode[],
    apiBindings: ApiBinding[],
    context: MenuValidationContext,
) => MenuValidationDiagnostic[] | Promise<MenuValidationDiagnostic[]>;

export interface ImportSummary {
    inserted: number;
    updated: number;
    unchanged: number;
    deleted: number;
    revision: number;
    changes: {
        insertedIds: string[];
        updatedIds: string[];
        deletedIds: string[];
    };
}

export interface ManifestImportOptions {
    mode?: "replace" | "merge";
    actorId?: string;
    reason?: string;
}

export interface MenuPermissionSnapshot<T> {
    data: T;
    version: string;
    etag: string;
}

export interface FrontendMenuManifest {
    nodes: MenuNode[];
    apiBindings?: ApiBinding[];
}

export interface ApiManifest {
    bindings: ApiBinding[];
}

export interface MenuPermissionOptions {
    core: PermissionCore;
    storage?: MenuPermissionStorageAdapter;
    strictApiBindings?: boolean;
    cache?: false | {
        maxEntries?: number;
    };
    /** 可选的 manifest 加载、归一化和校验扩展注册表。 */
    extensions?: MenuPermissionExtensionRegistry;
}

export interface MenuPermissionStorageAdapter {
    init?(): Promise<void>;
    close?(): Promise<void>;

    listMenuNodes(scope: PermissionScope): Promise<MenuNode[]>;
    upsertMenuNodes(scope: PermissionScope, nodes: MenuNode[]): Promise<ImportSummary>;
    replaceMenuNodes(scope: PermissionScope, nodes: MenuNode[]): Promise<ImportSummary>;

    listApiBindings(scope: PermissionScope): Promise<ApiBinding[]>;
    upsertApiBindings(scope: PermissionScope, bindings: ApiBinding[]): Promise<ImportSummary>;
    replaceApiBindings(scope: PermissionScope, bindings: ApiBinding[]): Promise<ImportSummary>;

    getRevision(scope: PermissionScope): Promise<number>;

    listAuditEntries(scope: PermissionScope): Promise<PermissionAuditEntry[]>;
    appendAuditEntries(scope: PermissionScope, entries: PermissionAuditEntry[]): Promise<void>;
}

export interface VisibleTreeOptions {
    includeDisabled?: boolean;
}

export interface ButtonMapOptions {
    strictApiBindings?: boolean;
}

export type ButtonPermissionMap = Record<string, ButtonPermissionState>;

export interface MenuPermissionManagerLike {
    init?(): Promise<void>;
    close?(): Promise<void>;
    getVisibleMenuTree(subject: PermissionSubject, options?: VisibleTreeOptions): Promise<VisibleMenuNode[]>;
    getVisibleButtons(subject: PermissionSubject, pageId: string, options?: ButtonMapOptions): Promise<ButtonPermissionMap>;
    getVisibleMenuSnapshot(subject: PermissionSubject, options?: VisibleTreeOptions): Promise<MenuPermissionSnapshot<VisibleMenuNode[]>>;
    getButtonPermissionSnapshot(subject: PermissionSubject, pageId: string, options?: ButtonMapOptions): Promise<MenuPermissionSnapshot<ButtonPermissionMap>>;
}
