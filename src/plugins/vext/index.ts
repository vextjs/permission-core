import { defineAppExtensions } from "vextjs";
import type { PermissionCore } from "../../core";

export { permissionPlugin } from "./plugin";
export {
    hasPermissionContext,
    requirePermissionContext,
} from "./request";
export type * from "./types";

export const appExtensions = defineAppExtensions<{
    permission: PermissionCore;
}>();
