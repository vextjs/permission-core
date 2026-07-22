import type { MonSQLizeInstance } from "monsqlize";
import type {
    ApiAuthorization,
    ApiResource,
    AuthorizedCollection,
    AuthorizedCollectionOptions,
    PermissionAction,
    PermissionCoreOptions,
    PermissionScope,
    PermissionSubject,
    PolicyContext,
    PolicyValue,
    SubjectRuntimeResult,
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
    subject?: PermissionVextSubjectOptions;
    data?: PermissionVextDataOptions;
    /** @deprecated Use subject.resolve(req). */
    resolveSubject?: (
        auth: Readonly<Record<string, unknown>>,
        req: VextRequest,
    ) => PermissionSubject | Promise<PermissionSubject>;
}

export interface PermissionVextSubjectOptions {
    resolve: (req: VextRequest) => PermissionSubject | Promise<PermissionSubject>;
}

export interface PermissionVextDataCollectionOptions {
    resource?: string;
    scopeFields?: AuthorizedCollectionOptions["scopeFields"];
}

export interface PermissionVextDataOptions {
    exposeAs?: false | "monsqlize";
    scopeFields: AuthorizedCollectionOptions["scopeFields"];
    collections?: Readonly<Record<string, PermissionVextDataCollectionOptions>>;
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

export interface VextRequestDataApi {
    collection<
        TDocument extends object,
        TCreate extends object = Omit<TDocument, "_id">,
    >(name: string): AuthorizedCollection<TDocument, TCreate>;
}

export interface VextRequestPermissionApi {
    readonly subject: PermissionSubject;
    readonly data?: VextRequestDataApi;
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
    filterResponse(
        apiResource: ApiResource,
        payload: unknown,
        context?: PolicyContext,
    ): Promise<SubjectRuntimeResult<unknown>>;
}

export type PermissionVextRequest<
    TAuth extends VextPermissionAuthInput = VextPermissionAuthInput,
> = VextRequest & {
    auth: TAuth & { permission: VextRequestPermissionApi };
    monsqlize?: VextRequestDataApi;
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

declare module "vextjs" {
    interface RouteOptions {
        permission?: VextRoutePermission;
    }

    interface VextApp {
        readonly permission: PermissionCore;
    }

    interface VextRequest {
        readonly monsqlize?: VextRequestDataApi;
    }
}
