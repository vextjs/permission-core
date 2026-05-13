import { PermissionCoreErrorCode } from "../types";

export { PermissionCoreErrorCode };

/**
 * permission-core 统一异常类型。
 */
export class PermissionCoreError extends Error {
    /** 错误码。 */
    readonly code: PermissionCoreErrorCode;
    /** 附加上下文数据。 */
    readonly data?: unknown;

    /**
     * @param code 公开错误码。
     * @param message 可直接写入日志或响应的错误信息。
     * @param data 额外上下文数据。
     */
    constructor(code: PermissionCoreErrorCode, message: string, data?: unknown) {
        super(message);
        this.name = "PermissionCoreError";
        this.code = code;
        this.data = data;
    }
}

/**
 * 判断一个值是否为 permission-core 统一异常。
 */
export function isPermissionCoreError(
    value: unknown
): value is PermissionCoreError {
    return value instanceof PermissionCoreError;
}