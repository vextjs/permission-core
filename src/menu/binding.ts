import type { MenuNode } from "./types";

export function getNodeBinding(node: MenuNode) {
    if (node.resource) {
        return node.resource;
    }

    if (node.type === "button") {
        return { action: "invoke", resource: `ui:button:${node.id}` };
    }

    if (node.type === "page") {
        return { action: "read", resource: `ui:page:${node.id}` };
    }

    return { action: "read", resource: `ui:menu:${node.id}` };
}
