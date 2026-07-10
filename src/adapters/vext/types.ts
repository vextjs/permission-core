import type { PermissionCore, PermissionCoreOptions } from "../../core";
import type { MenuPermissionManagerLike } from "../../menu";
import type { PermissionScope, PermissionSubject } from "../../types";
import type { VextPlugin, VextPluginContext } from "vextjs";

export type VextPermissionRequirement = string | {
    action: string;
    resource?: string | ((req: VextPermissionRequest) => string | undefined);
    context?: Record<string, unknown> | ((req: VextPermissionRequest) => Record<string, unknown> | undefined);
};

export interface VextRouteAuthRequirement {
    required?: boolean;
    roles?: string[];
    scopes?: string[];
    permissions?: VextPermissionRequirement[];
    mode?: "any" | "all";
}

export interface VextPermissionAuthContext {
    isAuthenticated?: boolean;
    subject?: string;
    userId?: string;
    roles?: string[];
    scopes?: string[];
    claims?: Record<string, unknown>;
    can?: (action: string, resource?: string, context?: Record<string, unknown>) => boolean | Promise<boolean>;
    assert?: (action: string, resource?: string, context?: Record<string, unknown>) => void | Promise<void>;
    [key: string]: unknown;
}

export interface VextPermissionRequest {
    method?: string;
    path?: string;
    url?: string;
    headers?: Record<string, string | string[] | undefined>;
    route?: string | {
        method?: string;
        path?: string;
        options?: {
            auth?: false | true | VextRouteAuthRequirement;
            docs?: {
                extensions?: Record<string, unknown>;
            };
        };
    };
    /** Vext 运行时提供的内部路由配置快照；公开 route auth 可通过此处被 adapter 消费。 */
    _routeOptions?: {
        auth?: false | true | VextRouteAuthRequirement;
        docs?: {
            extensions?: Record<string, unknown>;
        };
    };
    auth?: VextPermissionAuthContext;
    app?: {
        throw?: (status: number, message: string, code?: string) => never;
    };
    [key: string]: unknown;
}

export type VextPermissionMiddlewareNext = () => void | Promise<void>;
export type VextPermissionMiddleware = (
    req: VextPermissionRequest,
    res: unknown,
    next: VextPermissionMiddlewareNext,
) => void | Promise<void>;

export type VextPermissionApp = VextPluginContext;
export type VextPermissionPlugin = VextPlugin;

export interface VextPermissionAdapterOptions {
    core: PermissionCore;
    menu?: MenuPermissionManagerLike;
    defaultScope?: PermissionScope;
    tenantRequired?: boolean;
    resolveSubject?: (
        req: VextPermissionRequest,
        auth: VextPermissionAuthContext | undefined,
        context?: Record<string, unknown>,
    ) => PermissionSubject | Promise<PermissionSubject>;
    routeResource?: (
        req: VextPermissionRequest,
        action: string,
        context?: Record<string, unknown>,
    ) => string | undefined | Promise<string | undefined>;
    /** 是否直接执行路由 `auth.permissions` guard；默认开启。 */
    guardRoutePermissions?: boolean;
}

export interface VextPermissionPluginOptions extends Omit<VextPermissionAdapterOptions, "core"> {
    core?: PermissionCore;
    createCore?: () => PermissionCore | Promise<PermissionCore>;
    coreOptions?: PermissionCoreOptions;
    init?: boolean;
    closeOnAppClose?: boolean;
    /** 是否由插件关闭 core；默认只关闭插件内部创建的 core。 */
    ownsCore?: boolean;
    /** 是否由插件初始化并关闭 menu manager；默认不接管外部 menu。 */
    ownsMenu?: boolean;
}

export interface VextRouteManifestPayload {
    routes: Array<{
        method: string;
        path: string;
        operationId?: string;
        docsSummary?: string | null;
        tags?: string[];
        hidden?: boolean;
        auth?: false | true | VextRouteAuthRequirement;
        options?: {
            auth?: false | true | VextRouteAuthRequirement;
        };
    }>;
}
