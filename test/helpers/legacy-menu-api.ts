import type {
    ScopedPermissionContext,
    SubjectPermissionContext,
} from "../../src";
import type {
    ApiBindingManager,
    LegacyRoleMenuPermissionManager,
    LegacySubjectMenuRuntime,
    MenuManager,
} from "../../src/types/menu";
import type {
    RoleManager,
    UserRoleManager,
} from "../../src/types";

export interface LegacyScopedPermissionContext {
    readonly roles: Omit<RoleManager, "menuPermissions"> & {
        readonly menuPermissions: LegacyRoleMenuPermissionManager;
    };
    readonly userRoles: UserRoleManager;
    readonly menus: MenuManager;
    readonly apiBindings: ApiBindingManager;
}

export type LegacySubjectPermissionContext = Omit<SubjectPermissionContext, "menus"> & {
    readonly menus: LegacySubjectMenuRuntime;
};

export function legacyMenuScope(
    scoped: ScopedPermissionContext,
): LegacyScopedPermissionContext {
    return scoped as unknown as LegacyScopedPermissionContext;
}

export function legacySubject(
    subject: SubjectPermissionContext,
): LegacySubjectPermissionContext {
    return subject as unknown as LegacySubjectPermissionContext;
}
