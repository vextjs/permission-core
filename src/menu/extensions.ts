import { PermissionCoreError } from "../core";
import { PermissionCoreErrorCode } from "../types";

import type {
    ApiBinding,
    ApiBindingNormalizer,
    ApiManifest,
    ApiManifestLoader,
    FrontendManifestLoader,
    FrontendMenuManifest,
    MenuConfigurationValidator,
    MenuExtensionContext,
    MenuNode,
    MenuNodeNormalizer,
    MenuValidationContext,
    MenuValidationDiagnostic,
} from "./types";

/**
 * 菜单权限扩展注册表。
 *
 * loader 按名称选择；normalizer 和 validator 按注册顺序执行，异常直接中止导入，避免扩展失败后写入半归一化配置。
 */
export class MenuPermissionExtensionRegistry {
    private readonly frontendLoaders = new Map<string, FrontendManifestLoader>();
    private readonly apiLoaders = new Map<string, ApiManifestLoader>();
    private readonly nodeNormalizers: MenuNodeNormalizer[] = [];
    private readonly apiBindingNormalizers: ApiBindingNormalizer[] = [];
    private readonly validators: MenuConfigurationValidator[] = [];

    registerFrontendLoader(name: string, loader: FrontendManifestLoader): this {
        this.registerLoader(this.frontendLoaders, name, loader);
        return this;
    }

    registerApiLoader(name: string, loader: ApiManifestLoader): this {
        this.registerLoader(this.apiLoaders, name, loader);
        return this;
    }

    registerNodeNormalizer(normalizer: MenuNodeNormalizer): this {
        this.assertFunction(normalizer, "menu node normalizer");
        this.nodeNormalizers.push(normalizer);
        return this;
    }

    registerApiBindingNormalizer(normalizer: ApiBindingNormalizer): this {
        this.assertFunction(normalizer, "API binding normalizer");
        this.apiBindingNormalizers.push(normalizer);
        return this;
    }

    registerValidator(validator: MenuConfigurationValidator): this {
        this.assertFunction(validator, "menu validator");
        this.validators.push(validator);
        return this;
    }

    async loadFrontend(name: string, source: unknown, context: MenuExtensionContext) {
        const loader = this.getLoader(this.frontendLoaders, name, "frontend");
        return loader(source, context);
    }

    async loadApi(name: string, source: unknown, context: MenuExtensionContext) {
        const loader = this.getLoader(this.apiLoaders, name, "API");
        return loader(source, context);
    }

    async normalizeFrontend(
        manifest: FrontendMenuManifest,
        context: MenuExtensionContext,
    ): Promise<FrontendMenuManifest> {
        const nodes: MenuNode[] = [];
        for (const node of manifest.nodes) {
            nodes.push(await this.normalizeNode(node, context));
        }
        const apiBindings: ApiBinding[] = [];
        for (const binding of manifest.apiBindings ?? []) {
            apiBindings.push(await this.normalizeApiBinding(binding, context));
        }
        return {
            nodes,
            apiBindings: manifest.apiBindings ? apiBindings : undefined,
        };
    }

    async normalizeApi(manifest: ApiManifest, context: MenuExtensionContext): Promise<ApiManifest> {
        const bindings: ApiBinding[] = [];
        for (const binding of manifest.bindings) {
            bindings.push(await this.normalizeApiBinding(binding, context));
        }
        return { bindings };
    }

    async validate(
        nodes: MenuNode[],
        apiBindings: ApiBinding[],
        context: MenuValidationContext,
    ): Promise<MenuValidationDiagnostic[]> {
        const diagnostics: MenuValidationDiagnostic[] = [];
        for (const validator of this.validators) {
            const result = await validator(
                structuredClone(nodes),
                structuredClone(apiBindings),
                structuredClone(context),
            );
            if (!Array.isArray(result)) {
                throw new PermissionCoreError(
                    PermissionCoreErrorCode.INVALID_ARGUMENT,
                    "Menu validator must return a diagnostic array",
                );
            }
            diagnostics.push(...result);
        }
        return diagnostics;
    }

    private async normalizeNode(node: MenuNode, context: MenuExtensionContext) {
        let current = structuredClone(node);
        for (const normalizer of this.nodeNormalizers) {
            current = await normalizer(current, context);
        }
        return current;
    }

    private async normalizeApiBinding(binding: ApiBinding, context: MenuExtensionContext) {
        let current = structuredClone(binding);
        for (const normalizer of this.apiBindingNormalizers) {
            current = await normalizer(current, context);
        }
        return current;
    }

    private registerLoader<T extends FrontendManifestLoader | ApiManifestLoader>(
        loaders: Map<string, T>,
        name: string,
        loader: T,
    ) {
        const normalizedName = name.trim();
        this.assertFunction(loader, `${normalizedName || "unnamed"} manifest loader`);
        if (!normalizedName || loaders.has(normalizedName)) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.INVALID_ARGUMENT,
                normalizedName ? `Manifest loader '${normalizedName}' is already registered` : "Manifest loader name is required",
            );
        }
        loaders.set(normalizedName, loader);
    }

    private getLoader<T>(loaders: Map<string, T>, name: string, kind: string): T {
        const loader = loaders.get(name);
        if (!loader) {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.INVALID_ARGUMENT,
                `Unknown ${kind} manifest loader '${name}'`,
            );
        }
        return loader;
    }

    private assertFunction(value: unknown, label: string): asserts value is (...args: never[]) => unknown {
        if (typeof value !== "function") {
            throw new PermissionCoreError(
                PermissionCoreErrorCode.INVALID_ARGUMENT,
                `${label} must be a function`,
            );
        }
    }
}
