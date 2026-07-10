import { describe, expect, it } from "vitest";

import { PermissionCore } from "../../src";
import {
    MenuPermissionExtensionRegistry,
    createMenuPermission,
    type MenuNode,
} from "../../src/menu";

const SCOPE = { tenantId: "tenant-a", appId: "admin" };

function registerUrnScheme(core: PermissionCore) {
    core.resourceSchemes.register({
        scheme: "urn",
        validate: (resource) => /^urn:[a-z]+:[a-z0-9.*-]+$/i.test(resource),
        match(pattern, resource) {
            const patternParts = pattern.split(":");
            const resourceParts = resource.split(":");
            return patternParts.length === resourceParts.length
                && patternParts.every((part, index) => part === "*" || part === resourceParts[index]);
        },
    });
}

describe("resource scheme and menu extension points", () => {
    it("uses a live custom resource scheme across role writes and authorization checks", async () => {
        const core = new PermissionCore();
        await core.init();
        registerUrnScheme(core);

        const scoped = core.scope(SCOPE);
        await scoped.roles.create("document-reader", { label: "Document Reader" });
        await scoped.roles.allow("document-reader", "read", "urn:document:*");
        await scoped.users.assign("user-1", "document-reader");

        await expect(core.canSubject({ ...SCOPE, userId: "user-1" }, "read", "urn:document:invoice-1"))
            .resolves.toBe(true);
        await expect(core.canSubject({ ...SCOPE, userId: "user-1" }, "read", "urn:folder:invoice-1"))
            .resolves.toBe(false);
        await expect(scoped.roles.allow("document-reader", "read", "urn:document:"))
            .rejects.toThrow("Invalid urn resource");
        expect(() => core.resourceSchemes.register({
            scheme: "db",
            validate: () => true,
            match: () => true,
        })).toThrow("cannot be registered");
        core.resourceSchemes.register({ scheme: "get", validate: () => true, match: () => false });
        expect(core.resourceSchemes.match("GET:/health", "GET:/health")).toBe(true);
        expect(core.resourceSchemes.has("urn")).toBe(true);
        expect(core.resourceSchemes.list().map((definition) => definition.scheme)).toEqual(["urn", "get"]);
        const listedSchemes = core.resourceSchemes.list();
        listedSchemes[0].match = () => false;
        expect(core.resourceSchemes.match("urn:document:*", "urn:document:invoice-1")).toBe(true);
        expect(() => registerUrnScheme(core)).toThrow("already registered");

        await core.close();
    });

    it("supports API loaders and fails closed on invalid extension contracts", async () => {
        const core = new PermissionCore();
        await core.init();
        const extensions = new MenuPermissionExtensionRegistry()
            .registerApiLoader("fixture-api", (source) => source as never)
            .registerApiBindingNormalizer((binding) => ({ ...binding, description: "Normalized API" }));
        expect(() => extensions.registerApiLoader("fixture-api", () => [])).toThrow("already registered");
        expect(() => extensions.registerFrontendLoader("", () => [])).toThrow("name is required");
        const menu = createMenuPermission({ core, extensions });

        await menu.loadApiManifest(SCOPE, "fixture-api", [{
            id: "list-documents",
            ownerType: "apiGroup",
            ownerId: "documents",
            method: "GET",
            path: "/api/documents",
            resource: "api:GET:/api/documents",
            purpose: "entry",
        }]);
        expect((await menu.validate(SCOPE)).some((diagnostic) => diagnostic.code === "V-14")).toBe(false);

        extensions.registerValidator(() => undefined as never);
        await expect(menu.validate(SCOPE)).rejects.toThrow("must return a diagnostic array");
        await menu.close();
        await core.close();
    });

    it("runs loaders and normalizers while preserving built-in validation", async () => {
        const core = new PermissionCore();
        await core.init();
        registerUrnScheme(core);
        const extensions = new MenuPermissionExtensionRegistry()
            .registerFrontendLoader("fixture", (source) => source as MenuNode[])
            .registerNodeNormalizer((node) => ({ ...node, title: `Normalized ${node.title}` }))
            .registerValidator((nodes) => nodes.some((node) => node.title.startsWith("Normalized"))
                ? [{ code: "X-NORMALIZED", severity: "warning", message: "Extension normalizer ran" }]
                : []);
        const menu = createMenuPermission({ core, extensions });

        await menu.loadFrontendManifest(SCOPE, "fixture", [{
            id: "documents",
            type: "menu",
            title: "Documents",
            resource: { action: "read", resource: "urn:document:*" },
        }]);
        await expect(menu.validate(SCOPE)).resolves.toEqual(expect.arrayContaining([
            expect.objectContaining({ code: "X-NORMALIZED" }),
        ]));
        expect((await menu.validate(SCOPE)).some((diagnostic) => diagnostic.code === "V-RESOURCE")).toBe(false);

        await expect(menu.loadFrontendManifest(SCOPE, "missing", [])).rejects.toThrow("Unknown frontend manifest loader");
        await expect(menu.loadFrontendManifest(SCOPE, "fixture", [{
            id: "orphan",
            parentId: "missing",
            type: "menu",
            title: "Orphan",
        }])).rejects.toThrow("Menu manifest validation failed: V-03");

        await menu.close();
        await core.close();
    });
});
