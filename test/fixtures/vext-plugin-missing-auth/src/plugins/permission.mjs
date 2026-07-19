const PLUGIN = Symbol.for("permission-core.vext.missing-auth-fixture.plugin");
const injected = globalThis[PLUGIN];
const permissionPlugin = injected
    ? undefined
    : (await import("permission-core/plugins/vext")).permissionPlugin;

export default injected ?? permissionPlugin({ monsqlize: {} });
