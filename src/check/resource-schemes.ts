import { PermissionCoreError } from "../core/errors";
import { PermissionCoreErrorCode, type ResourceSchemeDefinition } from "../types";
import { assertValidResource } from "../utils/validation";

import { matchResource } from "./wildcard";

const BUILT_IN_SCHEMES = new Set(["api", "db", "ui"]);
const SCHEME_NAME = /^[a-z][a-z0-9+.-]*$/;

/**
 * 实例级资源 scheme 注册表。
 *
 * 内置资源继续由 permission-core 自身校验和匹配；扩展只能注册新的 scheme，不能改写内置授权语义。
 */
export class ResourceSchemeRegistry {
    private readonly definitions = new Map<string, ResourceSchemeDefinition>();

    constructor(definitions: ResourceSchemeDefinition[] = []) {
        for (const definition of definitions) {
            this.register(definition);
        }
    }

    /** 注册一个自定义资源 scheme。 */
    register(definition: ResourceSchemeDefinition): this {
        const scheme = typeof definition.scheme === "string" ? definition.scheme.trim().toLowerCase() : "";
        if (!SCHEME_NAME.test(scheme) || BUILT_IN_SCHEMES.has(scheme)) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.INVALID_ARGUMENT,
                `Resource scheme '${definition.scheme}' cannot be registered`,
            );
        }
        if (this.definitions.has(scheme)) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.INVALID_ARGUMENT,
                `Resource scheme '${scheme}' is already registered`,
            );
        }
        if (typeof definition.validate !== "function" || typeof definition.match !== "function") {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.INVALID_ARGUMENT,
                `Resource scheme '${scheme}' must provide validate() and match()`,
            );
        }

        this.definitions.set(scheme, { ...definition, scheme });
        return this;
    }

    /** 判断指定 scheme 是否已注册。 */
    has(scheme: string): boolean {
        return this.definitions.has(scheme.toLowerCase());
    }

    /** 返回已注册定义的只读快照。 */
    list(): ResourceSchemeDefinition[] {
        return Array.from(this.definitions.values(), (definition) => ({ ...definition }));
    }

    /** 使用内置规则或已注册扩展校验资源。 */
    assertValid(resource: string): void {
        const definition = this.getDefinition(resource);
        if (!definition) {
            assertValidResource(resource);
            return;
        }
        if (!definition.validate(resource)) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.INVALID_RESOURCE_PATH,
                `Invalid ${definition.scheme} resource '${resource}'`,
            );
        }
    }

    /** 使用内置规则或已注册扩展匹配资源。 */
    match(pattern: string, resource: string): boolean {
        if (pattern === "*") {
            return true;
        }

        const patternDefinition = this.getDefinition(pattern);
        const resourceDefinition = this.getDefinition(resource);
        if (patternDefinition || resourceDefinition) {
            return patternDefinition !== undefined
                && patternDefinition === resourceDefinition
                && patternDefinition.match(pattern, resource);
        }

        return matchResource(pattern, resource);
    }

    private getDefinition(resource: string): ResourceSchemeDefinition | undefined {
        const separator = resource.indexOf(":");
        if (separator <= 0) {
            return undefined;
        }
        const scheme = resource.slice(0, separator);
        // HTTP 资源使用大写 METHOD:/path，不能被同名小写自定义 scheme 劫持。
        return scheme === scheme.toLowerCase() ? this.definitions.get(scheme) : undefined;
    }
}
