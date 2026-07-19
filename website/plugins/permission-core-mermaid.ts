import { RemarkCodeBlockToGlobalComponentPluginFactory } from "rspress-plugin-devkit";
import type { MermaidConfig } from "mermaid";

type PermissionCoreMermaidOptions = {
    componentPath: string;
    mermaidConfig?: MermaidConfig;
};

export function permissionCoreMermaidPlugin(options: PermissionCoreMermaidOptions) {
    const transform = new RemarkCodeBlockToGlobalComponentPluginFactory({
        components: [
            {
                lang: "mermaid",
                componentPath: options.componentPath,
                childrenProvider() {
                    return [];
                },
                propsProvider(code) {
                    return {
                        code,
                        config: options.mermaidConfig ?? {},
                    };
                },
            },
        ],
    });

    return {
        name: "permission-core-mermaid",
        markdown: {
            remarkPlugins: [transform.remarkPlugin],
            globalComponents: transform.mdxComponents,
        },
        builderConfig: transform.builderConfig,
    };
}
