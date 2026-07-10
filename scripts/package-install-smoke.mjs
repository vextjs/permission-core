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

fs.mkdirSync(consumerRoot, { recursive: true });
assertFile(path.join(packageRoot, "dist", "index.js"));
assertFile(path.join(packageRoot, "dist", "index.cjs"));
assertFile(path.join(packageRoot, "dist", "index.d.ts"));

const packOutput = run(npmCommand(), [
    "pack",
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
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
], consumerRoot);

if (fs.existsSync(path.join(consumerRoot, "node_modules", "vextjs"))) {
    throw new Error("Optional peer vextjs must not be installed for the base consumer smoke");
}

fs.writeFileSync(path.join(consumerRoot, "esm.mjs"), `
import { PermissionCore, ResourceSchemeRegistry } from "permission-core";
import { MenuPermissionExtensionRegistry } from "permission-core/menu";
import { createVextPermissionPlugin } from "permission-core/adapters/vext";
const core = new PermissionCore();
await core.init();
if (!ResourceSchemeRegistry || !MenuPermissionExtensionRegistry || !createVextPermissionPlugin) process.exit(2);
await core.close();
`);
fs.writeFileSync(path.join(consumerRoot, "cjs.cjs"), `
const root = require("permission-core");
const menu = require("permission-core/menu");
const vext = require("permission-core/adapters/vext");
if (!root.PermissionCore || !root.ResourceSchemeRegistry || !menu.MenuPermissionExtensionRegistry || !vext.createVextPermissionPlugin) process.exit(2);
`);
fs.writeFileSync(path.join(consumerRoot, "types.ts"), `
import { PermissionCore, type PermissionCoreOptions, type ResourceSchemeDefinition } from "permission-core";
import { createMenuPermission, type MenuPermissionOptions } from "permission-core/menu";
const schemes: ResourceSchemeDefinition[] = [];
const options: PermissionCoreOptions = { resourceSchemes: schemes };
const core = new PermissionCore(options);
const menuOptions: MenuPermissionOptions = { core };
createMenuPermission(menuOptions);
`);
fs.writeFileSync(path.join(consumerRoot, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        esModuleInterop: true,
        types: ["node"],
    },
    include: ["types.ts"],
}, null, 2));

run(process.execPath, [path.join(toolingRoot, "node_modules", "typescript", "bin", "tsc"), "--project", "tsconfig.json"], consumerRoot);
run(process.execPath, ["esm.mjs"], consumerRoot);
run(process.execPath, ["cjs.cjs"], consumerRoot);

console.log(`Package install smoke passed: ${consumerRoot}`);
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
