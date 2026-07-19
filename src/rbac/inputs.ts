import { types as utilTypes } from "node:util";
import type {
    EntityStatus,
    ManualRuleInput,
    ManualRuleSelector,
    PermissionRuleInput,
    RoleAccessUpdateInput,
    RoleCreateInput,
    RoleUpdateInput,
} from "../types";
import { PermissionCoreError, validationError } from "../core/errors";
import { ResourceSchemeRegistry } from "../check/resource-schemes";
import { compareUtf8 } from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import { normalizePermissionRuleAction } from "../policy/action";
import { normalizeRowCondition } from "../policy/condition";
import { createSemanticKey } from "./materialize";
import {
    normalizeDescription,
    normalizeRbacId,
    normalizeRoleLabel,
} from "./validation";

function exactInput(value: unknown, allowed: readonly string[], field: string) {
    if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) {
        throw validationError("INVALID_ARGUMENT", field, "must be a plain object");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw validationError("INVALID_ARGUMENT", field, "must be a plain object");
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || !allowed.includes(key)) {
            throw validationError("INVALID_ARGUMENT", field, `contains unsupported key ${String(key)}`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor) || descriptor.value === undefined) {
            throw validationError("INVALID_ARGUMENT", `${field}.${key}`, "must be an enumerable defined data property");
        }
        snapshot[key] = descriptor.value;
    }
    return snapshot;
}

function normalizeStatus(value: unknown, field: string): EntityStatus {
    if (value !== "enabled" && value !== "disabled" && value !== "deprecated") {
        throw validationError("INVALID_ARGUMENT", field, "must be enabled, disabled, or deprecated");
    }
    return value;
}

function denseArray(value: unknown, field: string, maximum: number) {
    if (!Array.isArray(value) || utilTypes.isProxy(value)) {
        throw validationError("INVALID_ARGUMENT", field, "must be a dense array");
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value as number : -1;
    if (!Number.isSafeInteger(length) || length < 0) {
        throw validationError("INVALID_ARGUMENT", field, "must be a dense array");
    }
    if (length > maximum) {
        throw new PermissionCoreError("LIMIT_EXCEEDED", `${field} exceeds its item limit.`, {
            details: {
                kind: "limit-exceeded",
                origin: "caller-input",
                limitName: `${field}-items`,
                current: length,
                max: maximum,
                unit: "items",
            },
        });
    }
    const snapshot = new Array<unknown>(length);
    let count = 0;
    for (const key of Reflect.ownKeys(value)) {
        if (key === "length") {
            continue;
        }
        if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length) {
            throw validationError("INVALID_ARGUMENT", field, "cannot contain non-index properties");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
            throw validationError("INVALID_ARGUMENT", `${field}[${key}]`, "must be an enumerable data property");
        }
        snapshot[Number(key)] = descriptor.value;
        count += 1;
    }
    if (count !== length) {
        throw validationError("INVALID_ARGUMENT", field, "cannot be sparse");
    }
    return snapshot;
}

export function normalizeRoleCreateInput(value: RoleCreateInput) {
    const input = exactInput(value, ["id", "label", "description", "status", "parentId"], "role");
    if (!Object.hasOwn(input, "id") || !Object.hasOwn(input, "label")) {
        throw validationError("INVALID_ARGUMENT", "role", "requires id and label");
    }
    return deepFreeze({
        id: normalizeRbacId(input.id, "role.id"),
        label: normalizeRoleLabel(input.label, "role.label"),
        ...(Object.hasOwn(input, "description")
            ? { description: normalizeDescription(input.description, "role.description") }
            : {}),
        status: Object.hasOwn(input, "status") ? normalizeStatus(input.status, "role.status") : "enabled",
        parentId: Object.hasOwn(input, "parentId")
            ? (input.parentId === null ? null : normalizeRbacId(input.parentId, "role.parentId"))
            : null,
    });
}

export function normalizeRoleUpdateInput(value: RoleUpdateInput) {
    const input = exactInput(value, ["label", "description"], "patch");
    if (Object.keys(input).length === 0) {
        throw validationError("INVALID_ARGUMENT", "patch", "must contain label or description");
    }
    return deepFreeze({
        ...(Object.hasOwn(input, "label") ? { label: normalizeRoleLabel(input.label, "patch.label") } : {}),
        ...(Object.hasOwn(input, "description")
            ? {
                description: input.description === null
                    ? null
                    : normalizeDescription(input.description, "patch.description"),
            }
            : {}),
    });
}

export function normalizeRoleAccessUpdateInput(value: RoleAccessUpdateInput) {
    const input = exactInput(value, ["status", "parentId"], "patch");
    if (Object.keys(input).length === 0) {
        throw validationError("INVALID_ARGUMENT", "patch", "must contain status or parentId");
    }
    return deepFreeze({
        ...(Object.hasOwn(input, "status") ? { status: normalizeStatus(input.status, "patch.status") } : {}),
        ...(Object.hasOwn(input, "parentId")
            ? { parentId: input.parentId === null ? null : normalizeRbacId(input.parentId, "patch.parentId") }
            : {}),
    });
}

export function normalizePermissionRuleInput(
    value: PermissionRuleInput,
    resourceSchemes: ResourceSchemeRegistry,
) {
    const input = exactInput(value, ["action", "resource", "where"], "rule");
    if (!Object.hasOwn(input, "action") || !Object.hasOwn(input, "resource")) {
        throw validationError("INVALID_ARGUMENT", "rule", "requires action and resource");
    }
    const action = normalizePermissionRuleAction(input.action);
    resourceSchemes.validate(input.resource as string, "pattern");
    const resource = input.resource as string;
    const where = Object.hasOwn(input, "where") ? normalizeRowCondition(input.where) : undefined;
    return deepFreeze({ action, resource, ...(where === undefined ? {} : { where }) });
}

export function normalizeManualRuleInput(
    value: ManualRuleInput,
    resourceSchemes: ResourceSchemeRegistry,
) {
    const input = exactInput(value, ["effect", "action", "resource", "where"], "rule");
    const effect = input.effect;
    if (effect !== "allow" && effect !== "deny") {
        throw validationError("INVALID_ARGUMENT", "rule.effect", "must be allow or deny");
    }
    const rule = normalizePermissionRuleInput({
        action: input.action as never,
        resource: input.resource as string,
        ...(Object.hasOwn(input, "where") ? { where: input.where as never } : {}),
    }, resourceSchemes);
    return deepFreeze({ effect, ...rule } as const);
}

export function normalizeManualRuleSelector(
    value: ManualRuleSelector,
    resourceSchemes: ResourceSchemeRegistry,
) {
    const input = exactInput(value, ["effect", "action", "resource", "where", "semanticKey"], "selector");
    const effect = input.effect;
    if (effect !== "allow" && effect !== "deny") {
        throw validationError("INVALID_ARGUMENT", "selector.effect", "must be allow or deny");
    }
    const rule = normalizePermissionRuleInput({
        action: input.action as never,
        resource: input.resource as string,
        ...(Object.hasOwn(input, "where") ? { where: input.where as never } : {}),
    }, resourceSchemes);
    const semanticKey = createSemanticKey(effect, rule.action, rule.resource, rule.where);
    if (Object.hasOwn(input, "semanticKey") && input.semanticKey !== semanticKey) {
        throw validationError("INVALID_ARGUMENT", "selector.semanticKey", "does not match the normalized selector");
    }
    return deepFreeze({ effect, ...rule, semanticKey } as const);
}

export function normalizeRoleIdList(value: readonly string[]) {
    const roleIds = denseArray(value, "roleIds", 128).map((roleId, index) => normalizeRbacId(roleId, `roleIds[${index}]`));
    const unique = new Set(roleIds);
    if (unique.size !== roleIds.length) {
        throw validationError("INVALID_ARGUMENT", "roleIds", "must be unique after identifier normalization");
    }
    return Object.freeze([...roleIds].sort(compareUtf8));
}
