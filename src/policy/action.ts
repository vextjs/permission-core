import type { PermissionAction, PermissionRuleAction } from "../types";
import { validationError } from "../core/errors";
import { isWellFormedUnicode } from "../internal/unicode";

const ACTION_PATTERN = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/u;
const MAX_ACTION_BYTES = 64;

function normalizeAction(value: unknown, mode: "request" | "rule") {
    if (
        typeof value !== "string"
        || !value
        || Buffer.byteLength(value, "utf8") > MAX_ACTION_BYTES
        || !isWellFormedUnicode(value)
    ) {
        throw validationError(
            "INVALID_ACTION",
            "action",
            `must be a non-empty well-formed string of at most ${MAX_ACTION_BYTES} UTF-8 bytes`,
        );
    }
    if (value === "*") {
        if (mode === "request") {
            throw validationError("INVALID_ACTION", "action", "request actions cannot use a wildcard");
        }
        return value;
    }
    if (!ACTION_PATTERN.test(value)) {
        throw validationError("INVALID_ACTION", "action", "does not match the permission action grammar");
    }
    return value;
}

export function normalizePermissionAction(value: unknown): PermissionAction {
    return normalizeAction(value, "request") as PermissionAction;
}

export function normalizePermissionRuleAction(value: unknown): PermissionRuleAction {
    return normalizeAction(value, "rule") as PermissionRuleAction;
}

export function expandPermissionAction(value: unknown): readonly PermissionAction[] {
    const action = normalizePermissionAction(value);
    return action === "write"
        ? Object.freeze(["create", "update"] as const)
        : Object.freeze([action]);
}

export function matchPermissionRuleAction(
    ruleActionInput: unknown,
    requestActionInput: unknown,
) {
    const ruleAction = normalizePermissionRuleAction(ruleActionInput);
    const requestAction = normalizePermissionAction(requestActionInput);
    if (requestAction === "write") {
        return ruleAction === "*" || ruleAction === "write";
    }
    if (ruleAction === "*" || ruleAction === requestAction) {
        return true;
    }
    return ruleAction === "write" && (requestAction === "create" || requestAction === "update");
}
