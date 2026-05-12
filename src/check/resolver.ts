import { PermissionCoreError } from "../core/errors";
import { PermissionCoreErrorCode, type PermissionRule } from "../types";
import { deduplicateRules } from "../utils";
import type { StorageAdapter } from "../storage";

export class Resolver {
    async resolveRoleChain(roleId: string, storage: StorageAdapter): Promise<string[]> {
        const visited = new Set<string>();
        const chain: string[] = [];
        let currentRoleId: string | null = roleId;

        // 继承链按“当前角色 -> 父角色 -> 更高父角色”展开，便于后续保留覆盖顺序。
        while (currentRoleId) {
            if (visited.has(currentRoleId)) {
                throw new PermissionCoreError(
                    PermissionCoreErrorCode.CIRCULAR_INHERITANCE,
                    `Circular inheritance detected at role '${currentRoleId}'`,
                );
            }

            visited.add(currentRoleId);
            chain.push(currentRoleId);

            const role = await storage.getRole(currentRoleId);
            currentRoleId = role?.parent ?? null;
        }

        return chain;
    }

    async mergeRules(
        roleIds: string[],
        storage: StorageAdapter,
        strict: boolean,
    ): Promise<PermissionRule[]> {
        const mergedRules: PermissionRule[] = [];
        const processedRoleIds = new Set<string>();

        // 多个角色可能共享父角色，这里去重后再合并规则，避免重复展开。
        for (const roleId of roleIds) {
            const chain = await this.resolveRoleChain(roleId, storage);

            for (const currentRoleId of chain) {
                if (processedRoleIds.has(currentRoleId)) {
                    continue;
                }

                processedRoleIds.add(currentRoleId);
                mergedRules.push(...(await storage.getRules(currentRoleId)));
            }
        }

        const uniqueRules = deduplicateRules(mergedRules);
        if (!strict) {
            return uniqueRules;
        }

        // strict 模式下先排 deny，再排 allow，后续判定可以用最小代价处理优先级。
        return [
            ...uniqueRules.filter((rule) => rule.type === "deny"),
            ...uniqueRules.filter((rule) => rule.type === "allow"),
        ];
    }
}