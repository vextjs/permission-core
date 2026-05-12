import { PermissionCoreErrorCode } from "../types";

export { PermissionCoreErrorCode };

// 所有对外异常统一收口到 PermissionCoreError，方便宿主做错误映射。
export class PermissionCoreError extends Error {
    readonly code: PermissionCoreErrorCode;
    readonly data?: unknown;

    constructor(code: PermissionCoreErrorCode, message: string, data?: unknown) {
        super(message);
        this.name = "PermissionCoreError";
        this.code = code;
        this.data = data;
    }
}

export function isPermissionCoreError(
    value: unknown
): value is PermissionCoreError {
    return value instanceof PermissionCoreError;
}