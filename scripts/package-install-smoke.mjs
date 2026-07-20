import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const packageRootArgument = process.argv.find((argument) => argument.startsWith("--package-root="));
const outputRootArgument = process.argv.find((argument) => argument.startsWith("--output-root="));
const toolingRoot = process.cwd();
const packageRoot = path.resolve(packageRootArgument?.slice("--package-root=".length) ?? toolingRoot);
const outputRoot = outputRootArgument
    ? path.resolve(outputRootArgument.slice("--output-root=".length))
    : fs.mkdtempSync(path.join(os.tmpdir(), "permission-core-package-smoke-"));
const consumerRoot = path.join(outputRoot, "consumer");
const vextConsumerRoot = path.join(outputRoot, "vext-consumer");

fs.mkdirSync(consumerRoot, { recursive: true });
assertFile(path.join(packageRoot, "dist", "index.js"));
assertFile(path.join(packageRoot, "dist", "index.cjs"));
assertFile(path.join(packageRoot, "dist", "index.d.ts"));
assertFile(path.join(packageRoot, "dist", "plugins", "vext.js"));
assertFile(path.join(packageRoot, "dist", "plugins", "vext.cjs"));
assertFile(path.join(packageRoot, "dist", "plugins", "vext.d.ts"));

const packOutput = run(npmCommand(), [
    "pack",
    "--dry-run=false",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    outputRoot,
], packageRoot, true);
const packResult = JSON.parse(packOutput);
const tarballPath = path.join(outputRoot, packResult[0].filename);
assertFile(tarballPath);

fs.writeFileSync(path.join(consumerRoot, "package.json"), JSON.stringify({
    name: "permission-core-package-smoke",
    version: "1.0.0",
    private: true,
    type: "module",
}, null, 2));
run(npmCommand(), [
    "install",
    tarballPath,
    "@types/node@22.19.19",
    "--dry-run=false",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
], consumerRoot);

if (fs.existsSync(path.join(consumerRoot, "node_modules", "vextjs"))) {
    throw new Error("Optional peer vextjs must not be installed for the base consumer smoke");
}

const monsqlizePackage = JSON.parse(fs.readFileSync(
    path.join(consumerRoot, "node_modules", "monsqlize", "package.json"),
    "utf-8",
));
if (monsqlizePackage.version !== "3.1.0") {
    throw new Error(`Expected MonSQLize 3.1.0, received ${String(monsqlizePackage.version)}`);
}

fs.writeFileSync(path.join(consumerRoot, "esm.mjs"), `
import * as root from "permission-core";
import * as match from "permission-core/match";

const rootKeys = Object.keys(root).sort();
const matchKeys = Object.keys(match).sort();
if (JSON.stringify(rootKeys) !== JSON.stringify(["PermissionCore", "PermissionCoreError"])) process.exit(2);
if (JSON.stringify(matchKeys) !== JSON.stringify(["matchResource"])) process.exit(3);
if (!match.matchResource("GET:/api/orders/*", "GET:/api/orders/42")) process.exit(4);

const core = new root.PermissionCore({ monsqlize: {} });
const health = await core.health();
if (health.lifecycle !== "new" || health.initialized !== false) process.exit(5);
await core.close();

for (const specifier of [
    "permission-core/persistence",
    "permission-core/menu",
    "permission-core/adapters/vext",
]) {
    try {
        await import(specifier);
        process.exit(6);
    } catch (error) {
        if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
    }
}
`);
fs.writeFileSync(path.join(consumerRoot, "cjs.cjs"), `
const root = require("permission-core");
const match = require("permission-core/match");

(async () => {
    const rootKeys = Object.keys(root).sort();
    const matchKeys = Object.keys(match).sort();
    if (JSON.stringify(rootKeys) !== JSON.stringify(["PermissionCore", "PermissionCoreError"])) process.exit(2);
    if (JSON.stringify(matchKeys) !== JSON.stringify(["matchResource"])) process.exit(3);
    if (!match.matchResource("GET:/api/orders/*", "GET:/api/orders/42")) process.exit(4);

    const core = new root.PermissionCore({ monsqlize: {} });
    const health = await core.health();
    if (health.lifecycle !== "new" || health.initialized !== false) process.exit(5);
    await core.close();

    for (const specifier of [
        "permission-core/persistence",
        "permission-core/menu",
        "permission-core/adapters/vext",
    ]) {
        try {
            require(specifier);
            process.exit(6);
        } catch (error) {
            if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw error;
        }
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
`);
fs.writeFileSync(path.join(consumerRoot, "types.ts"), `
import { PermissionCore, type PermissionCoreOptions, type ResourceSchemeDefinition } from "permission-core";
import { matchResource } from "permission-core/match";
import type { MonSQLizeInstance } from "monsqlize";

declare const monsqlize: MonSQLizeInstance;
const schemes: ResourceSchemeDefinition[] = [];
const options: PermissionCoreOptions = { monsqlize, resourceSchemes: schemes };
const core = new PermissionCore(options);
const matched: boolean = matchResource("GET:/api/orders/*", "GET:/api/orders/42");
void core;
void matched;
`);
fs.writeFileSync(path.join(consumerRoot, "negative-types.ts"), `
// @ts-expect-error permission-core intentionally does not expose persistence internals.
import "permission-core/persistence";
// @ts-expect-error menu is not part of the v2 public package surface.
import "permission-core/menu";
// @ts-expect-error framework adapters are not exported by the core package.
import "permission-core/adapters/vext";
`);
fs.writeFileSync(path.join(consumerRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        noUncheckedSideEffectImports: true,
        skipLibCheck: false,
        esModuleInterop: true,
        types: ["node"],
    },
    include: ["types.ts", "negative-types.ts"],
}, null, 2));

run(process.execPath, [path.join(toolingRoot, "node_modules", "typescript", "bin", "tsc"), "--project", "tsconfig.json"], consumerRoot);
run(process.execPath, ["esm.mjs"], consumerRoot);
run(process.execPath, ["cjs.cjs"], consumerRoot);

fs.mkdirSync(vextConsumerRoot, { recursive: true });
fs.writeFileSync(path.join(vextConsumerRoot, "package.json"), JSON.stringify({
    name: "permission-core-vext-package-smoke",
    version: "1.0.0",
    private: true,
    type: "module",
}, null, 2));
run(npmCommand(), [
    "install",
    tarballPath,
    "vextjs@0.3.26",
    "@types/node@22.19.19",
    "--dry-run=false",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
], vextConsumerRoot);

const runtimeSupport = `
function createMonSQLizeStub() {
    const collections = new Map();
    let closeCalls = 0;
    const cache = {
        get: async () => undefined,
        set: async () => undefined,
        del: async () => false,
        delPattern: async () => 0,
    };
    function findChain() {
        const chain = {
            limit() { return chain; },
            skip() { return chain; },
            sort() { return chain; },
            project() { return chain; },
            hint() { return chain; },
            collation() { return chain; },
            comment() { return chain; },
            maxTimeMS() { return chain; },
            batchSize() { return chain; },
            async explain() { return {}; },
            stream() { return undefined; },
            async toArray() { return []; },
        };
        return chain;
    }
    function collection(name) {
        if (collections.has(name)) return collections.get(name);
        const indexes = [{ name: "_id_", key: { _id: 1 } }];
        const handle = {
            getNamespace: () => ({ iid: "package-smoke:" + name, type: "mongodb", db: "package-smoke", collection: name }),
            raw: () => handle,
            findOne: async () => null,
            find: () => findChain(),
            findAndCount: async () => ({ data: [], total: 0 }),
            findPage: async () => ({ data: [], nextCursor: null }),
            count: async () => 0,
            countDocuments: async () => 0,
            insertOne: async () => ({ acknowledged: true, insertedId: "id" }),
            insertMany: async () => ({ acknowledged: true, insertedCount: 0, insertedIds: {} }),
            updateOne: async () => ({ acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null }),
            updateMany: async () => ({ acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null }),
            deleteOne: async () => ({ acknowledged: true, deletedCount: 0 }),
            deleteMany: async () => ({ acknowledged: true, deletedCount: 0 }),
            async createIndexes(specs) {
                for (const spec of specs) {
                    const index = indexes.findIndex((candidate) => candidate.name === spec.name);
                    if (index >= 0) indexes[index] = { ...spec };
                    else indexes.push({ ...spec });
                }
                return specs.map((spec) => spec.name);
            },
            listIndexes: async () => indexes.map((item) => ({ ...item })),
        };
        collections.set(name, handle);
        return handle;
    }
    const instance = {
        connect: async () => ({}),
        getCache: () => cache,
        getDefaults: () => Object.freeze({ findMaxLimit: 10000 }),
        close: async () => { closeCalls += 1; },
        health: async () => ({ status: "up", connected: true }),
        collection,
        db: () => ({ admin: () => ({ serverStatus: async () => ({ ok: 1, localTime: new Date() }) }) }),
        withTransaction: async (callback) => callback({
            state: "active",
            abort: async () => undefined,
            session: { id: "package-smoke", inTransaction: () => true },
        }),
    };
    return { instance, getCloseCalls: () => closeCalls };
}

function createHost() {
    const handlers = new Map();
    const closeHandlers = [];
    const app = {
        logger: {
            error() {}, info() {}, warn() {}, debug() {}, fatal() {}, child() { return app.logger; },
        },
        throw(input) {
            const error = new Error(input.message);
            Object.assign(error, input);
            throw error;
        },
        config: {}, services: {}, adapter: {}, cache: {}, fetch() {},
        hooks: {
            on(name, handler) {
                const values = handlers.get(name) ?? new Set();
                values.add(handler);
                handlers.set(name, values);
                return () => values.delete(handler);
            },
            has(name) { return (handlers.get(name)?.size ?? 0) > 0; },
        },
        use() {},
        extend(key, value) { app[key] = value; },
        onClose(handler) { closeHandlers.push(handler); },
    };
    return {
        app,
        async emit(name, payload) {
            let result;
            for (const handler of handlers.get(name) ?? []) {
                const current = await handler(payload);
                if (current !== undefined) result = current;
            }
            return result;
        },
        async close() {
            for (const handler of [...closeHandlers].reverse()) await handler();
        },
    };
}
`;
fs.writeFileSync(path.join(vextConsumerRoot, "runtime-support.mjs"), runtimeSupport + "\nexport { createHost, createMonSQLizeStub };\n");
fs.writeFileSync(path.join(vextConsumerRoot, "runtime-support.cjs"), runtimeSupport + "\nmodule.exports = { createHost, createMonSQLizeStub };\n");

fs.writeFileSync(path.join(vextConsumerRoot, "esm.mjs"), `
import { PermissionCoreError } from "permission-core";
import * as pluginEntry from "permission-core/plugins/vext";
import { createHost, createMonSQLizeStub } from "./runtime-support.mjs";

const expected = ["appExtensions", "hasPermissionContext", "permissionPlugin", "requirePermissionContext", "toApiBindingInputs"];
if (JSON.stringify(Object.keys(pluginEntry).sort()) !== JSON.stringify(expected)) process.exit(2);
const stub = createMonSQLizeStub();
const host = createHost();
const plugin = pluginEntry.permissionPlugin({ monsqlize: stub.instance });
if (plugin.name !== "permission-core" || !Object.isFrozen(plugin)) process.exit(3);
await plugin.setup(host.app);
const patch = await host.emit("error:beforeResponse", {
    error: new PermissionCoreError("ROLE_ALREADY_EXISTS", "Already exists"),
    requestId: "esm-package-smoke",
});
if (patch?.status !== 409 || patch?.body?.code !== "ROLE_ALREADY_EXISTS") process.exit(4);
await host.close();
if (stub.getCloseCalls() !== 0) process.exit(5);
`);
fs.writeFileSync(path.join(vextConsumerRoot, "cjs.cjs"), `
const { PermissionCoreError } = require("permission-core");
const pluginEntry = require("permission-core/plugins/vext");
const { createHost, createMonSQLizeStub } = require("./runtime-support.cjs");

(async () => {
    const expected = ["appExtensions", "hasPermissionContext", "permissionPlugin", "requirePermissionContext", "toApiBindingInputs"];
    if (JSON.stringify(Object.keys(pluginEntry).sort()) !== JSON.stringify(expected)) process.exit(2);
    const stub = createMonSQLizeStub();
    const host = createHost();
    const plugin = pluginEntry.permissionPlugin({ monsqlize: stub.instance });
    if (plugin.name !== "permission-core" || !Object.isFrozen(plugin)) process.exit(3);
    await plugin.setup(host.app);
    const patch = await host.emit("error:beforeResponse", {
        error: new PermissionCoreError("ROLE_ALREADY_EXISTS", "Already exists"),
        requestId: "cjs-package-smoke",
    });
    if (patch?.status !== 409 || patch?.body?.code !== "ROLE_ALREADY_EXISTS") process.exit(4);
    await host.close();
    if (stub.getCloseCalls() !== 0) process.exit(5);
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
`);
fs.writeFileSync(path.join(vextConsumerRoot, "types.ts"), `
import type { MonSQLizeInstance } from "monsqlize";
import type { RouteOptions, VextRequest } from "vextjs";
import {
    permissionPlugin,
    requirePermissionContext,
    type PermissionVextPluginOptions,
    type VextRoutePermission,
} from "permission-core/plugins/vext";

declare const monsqlize: MonSQLizeInstance;
declare const req: VextRequest;
const permission: VextRoutePermission = {
    mode: "any",
    requirements: [{ action: "invoke", resource: "GET:/orders" }],
};
const route: RouteOptions = { permission };
const options: PermissionVextPluginOptions = { monsqlize };
const plugin = permissionPlugin(options);
const context = requirePermissionContext(req);
void route;
void plugin;
void context;
`);
fs.writeFileSync(path.join(vextConsumerRoot, "negative-types.ts"), `
// @ts-expect-error the removed adapter path must remain unavailable.
import "permission-core/adapters/vext";
`);
fs.writeFileSync(path.join(vextConsumerRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        noUncheckedSideEffectImports: true,
        skipLibCheck: false,
        esModuleInterop: true,
        types: ["node"],
    },
    include: ["types.ts", "negative-types.ts"],
}, null, 2));

run(process.execPath, [path.join(toolingRoot, "node_modules", "typescript", "bin", "tsc"), "--project", "tsconfig.json"], vextConsumerRoot);
run(process.execPath, ["esm.mjs"], vextConsumerRoot);
run(process.execPath, ["cjs.cjs"], vextConsumerRoot);

console.log(`Package install smoke passed: ${consumerRoot}`);
console.log(`Vext package install smoke passed: ${vextConsumerRoot}`);
console.log(`PACKAGE_SMOKE_RETAINED=${outputRoot}`);

/** Execute one child command and fail with its captured output. */
function run(command, args, cwd, capture = false) {
    const result = spawnSync(command, args, {
        cwd,
        encoding: "utf-8",
        stdio: capture ? "pipe" : "inherit",
        shell: process.platform === "win32",
    });
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(" ")} failed (${String(result.status)}):\n${result.error?.message ?? result.stderr ?? ""}`);
    }
    return result.stdout ?? "";
}

/** Resolve npm's platform-specific executable name. */
function npmCommand() {
    return process.platform === "win32" ? "npm.cmd" : "npm";
}

/** Fail before pack/install when a required package artifact is absent. */
function assertFile(filePath) {
    if (!fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
        throw new Error(`Required package artifact is missing: ${filePath}`);
    }
}
