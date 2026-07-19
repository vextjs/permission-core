import type {
    ApiAuthorization,
    ApiBinding,
    ApiOwnerRelation,
    MenuRuntimeApiRisk,
} from "../types";
import { PermissionCoreError } from "../core/errors";
import { compareUtf8 } from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";

export type ApiPermissionCheck = (
    permission: ApiAuthorization["permissions"][number],
) => boolean | Promise<boolean>;

export interface ApiBindingAvailabilityDecision {
    readonly binding: Pick<ApiBinding, "id" | "owners">;
    readonly allowed: boolean;
}

export interface OwnerApiAvailabilityDecision {
    readonly enabled: boolean;
    readonly risks: readonly MenuRuntimeApiRisk[];
}

function persistedInvalid(reason: string): never {
    throw new PermissionCoreError("PERSISTED_STATE_INVALID", "Persisted API availability state is inconsistent.", {
        details: { kind: "persisted-state-invalid", stage: "load", reason },
    });
}

export async function evaluateApiAuthorization(
    authorization: ApiAuthorization,
    check: ApiPermissionCheck,
) {
    if (authorization.permissions.length === 0) {
        persistedInvalid("API authorization has no permission requirements");
    }
    const decisions: boolean[] = [];
    for (const permission of authorization.permissions) {
        const allowed = await check(permission);
        if (typeof allowed !== "boolean") {
            persistedInvalid("API permission check did not return a boolean decision");
        }
        decisions.push(allowed);
    }
    if (authorization.mode === "all") return decisions.every(Boolean);
    if (authorization.mode === "any") return decisions.some(Boolean);
    return persistedInvalid("API authorization mode is unsupported");
}

export async function evaluateApiBindingAvailability(
    binding: Pick<ApiBinding, "authorization" | "status">,
    check: ApiPermissionCheck,
) {
    if (binding.status === "disabled" || binding.status === "deprecated") return false;
    if (binding.status !== "enabled") return persistedInvalid("API binding status is unsupported");
    return evaluateApiAuthorization(binding.authorization, check);
}

export function evaluateOwnerApiAvailability(
    owner: Pick<ApiOwnerRelation, "type" | "id">,
    decisions: readonly ApiBindingAvailabilityDecision[],
): OwnerApiAvailabilityDecision {
    const risks: MenuRuntimeApiRisk[] = [];
    const ungrouped: boolean[] = [];
    const groups = new Map<string, { mode: "all" | "any"; decisions: boolean[] }>();
    const bindingIds = new Set<string>();

    for (const decision of decisions) {
        if (typeof decision.allowed !== "boolean") {
            persistedInvalid("API binding availability is not boolean");
        }
        if (bindingIds.has(decision.binding.id)) {
            persistedInvalid("API availability contains a duplicate binding decision");
        }
        bindingIds.add(decision.binding.id);
        const relations = decision.binding.owners.filter((relation) => (
            relation.type === owner.type && relation.id === owner.id
        ));
        if (relations.length > 1) {
            persistedInvalid("API binding contains duplicate owner relations");
        }
        const relation = relations[0];
        if (relation === undefined) continue;

        risks.push({
            bindingId: decision.binding.id,
            required: relation.required,
            allowed: decision.allowed,
        });
        const hasGroup = relation.availabilityGroup !== undefined;
        const hasMode = relation.availabilityMode !== undefined;
        if (hasGroup !== hasMode || (!relation.required && hasGroup)) {
            persistedInvalid("API owner availability relation is malformed");
        }
        if (!relation.required) continue;
        if (!hasGroup) {
            ungrouped.push(decision.allowed);
            continue;
        }

        const groupId = relation.availabilityGroup!;
        const mode = relation.availabilityMode!;
        if (mode !== "all" && mode !== "any") {
            persistedInvalid("API owner availability mode is unsupported");
        }
        const group = groups.get(groupId);
        if (group !== undefined && group.mode !== mode) {
            persistedInvalid("API owner availability group mixes all and any");
        }
        if (group === undefined) groups.set(groupId, { mode, decisions: [decision.allowed] });
        else group.decisions.push(decision.allowed);
    }

    const groupsAllowed = [...groups.values()].every((group) => (
        group.mode === "all" ? group.decisions.every(Boolean) : group.decisions.some(Boolean)
    ));
    return deepFreeze({
        enabled: ungrouped.every(Boolean) && groupsAllowed,
        risks: risks.sort((left, right) => compareUtf8(left.bindingId, right.bindingId)),
    });
}
