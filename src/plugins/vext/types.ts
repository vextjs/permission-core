import type { MonSQLizeInstance } from "monsqlize";
import type {
    ApiAuthorization,
    ApiBindingCreateInput,
    PermissionAction,
    PermissionCoreOptions,
    PermissionScope,
    PermissionSubject,
    PolicyContext,
    PolicyValue,
} from "../../types";
import type { PermissionCore } from "../../core";
import type {
    VextPluginContext,
    VextRequest,
} from "vextjs";

export interface PermissionVextPluginOptions {
    monsqlize?: MonSQLizeInstance;
    resolveMonSQLize?: (
        app: VextPluginContext,
    ) => MonSQLizeInstance | Promise<MonSQLizeInstance>;
    databasePlugin?: string;
    authPlugin?: string;
    core?: Omit<PermissionCoreOptions, "monsqlize">;
    resolveSubject?: (
        auth: Readonly<Record<string, unknown>>,
        req: VextRequest,
    ) => PermissionSubject | Promise<PermissionSubject>;
    validateRouteManifest?: (
        event: VextRouteManifestValidationEvent,
    ) => void | Promise<void>;
}

export type VextPermissionAuthInput =
    | {
        isAuthenticated: true;
        permissionSubject: PermissionSubject;
        userId?: never;
        scope?: never;
        claims?: never;
    }
    | {
        isAuthenticated: true;
        permissionSubject?: never;
        userId: string;
        scope: PermissionScope;
        claims?: Readonly<Record<string, PolicyValue>>;
    };

export interface VextRequestPermissionApi {
    readonly subject: PermissionSubject;
    can(
        action: PermissionAction,
        resource: string,
        context?: PolicyContext,
    ): Promise<boolean>;
    assert(
        action: PermissionAction,
        resource: string,
        context?: PolicyContext,
    ): Promise<void>;
}

export type PermissionVextRequest<
    TAuth extends VextPermissionAuthInput = VextPermissionAuthInput,
> = VextRequest & {
    auth: TAuth & { permission: VextRequestPermissionApi };
};

export interface VextPermissionRequirement {
    action: PermissionAction;
    resource?: string;
}

export type VextRoutePermission =
    | false
    | true
    | VextPermissionRequirement
    | {
        mode: "any" | "all";
        requirements: readonly VextPermissionRequirement[];
    };

export interface VextRouteManifestEntry {
    routeKey: string;
    method: string;
    path: string;
    authorization: ApiAuthorization | null;
    sourceFile?: string;
}

export interface VextRoutePermissionManifest {
    schemaVersion: 1;
    digest: string;
    routes: readonly VextRouteManifestEntry[];
}

export interface VextRouteManifestValidationEvent {
    manifest: VextRoutePermissionManifest;
    apiBindings: readonly ApiBindingCreateInput[];
}

declare module "vextjs" {
    interface RouteOptions {
        permission?: VextRoutePermission;
    }

    interface VextApp {
        readonly permission: PermissionCore;
    }
}
