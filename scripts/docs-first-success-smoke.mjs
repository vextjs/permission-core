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
    : fs.mkdtempSync(path.join(os.tmpdir(), "permission-core-first-success-"));
const consumerRoot = path.join(outputRoot, "consumer");
const cachedMongoBinary = path.join(
    toolingRoot,
    ".cache",
    "mongodb-memory-server",
    "binaries",
    "mongod-x64-win32-7.0.37.exe",
);

fs.mkdirSync(consumerRoot, { recursive: true });
assertFile(path.join(packageRoot, "dist", "index.js"));

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
    name: "permission-core-first-success-consumer",
    version: "1.0.0",
    private: true,
    type: "module",
}, null, 2));
fs.mkdirSync(path.join(consumerRoot, "_support"), { recursive: true });
fs.copyFileSync(path.join(toolingRoot, "examples", "basic.mjs"), path.join(consumerRoot, "first-success.mjs"));
fs.copyFileSync(
    path.join(toolingRoot, "examples", "_support", "host.mjs"),
    path.join(consumerRoot, "_support", "host.mjs"),
);

run(npmCommand(), [
    "install",
    tarballPath,
    "monsqlize@3.1.0",
    "mongodb-memory-server@10.4.3",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
], consumerRoot);
const stdout = run(process.execPath, ["first-success.mjs"], consumerRoot, true).trim();
const jsonStart = stdout.lastIndexOf('\n{') + 1;
const result = JSON.parse(stdout.slice(jsonStart));
if (result.example !== "basic"
    || result.ok !== true
    || result.permissionChecks?.allowed !== true
    || result.permissionChecks?.cannotDelete !== true
    || JSON.stringify(result.userRoles?.afterSet) !== JSON.stringify(["order-reader"])) {
    throw new Error(`Unexpected First Success output:\n${stdout}`);
}

console.log("Docs First Success smoke passed: basic allowed=true cannotDelete=true afterSet=order-reader");
console.log(`FIRST_SUCCESS_SMOKE_RETAINED=${outputRoot}`);

/** Execute one child process and surface its captured failure output. */
function run(command, args, cwd, capture = false) {
    const result = spawnSync(command, args, {
        cwd,
        encoding: "utf-8",
        stdio: capture ? "pipe" : "inherit",
        shell: process.platform === "win32",
        env: {
            ...process.env,
            ...(fs.existsSync(cachedMongoBinary)
                ? { PERMISSION_CORE_MONGOD_BINARY: cachedMongoBinary }
                : {}),
        },
    });
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(" ")} failed (${String(result.status)}):\n${result.error?.message ?? result.stderr ?? ""}`);
    }
    return result.stdout ?? "";
}

function npmCommand() {
    return process.platform === "win32" ? "npm.cmd" : "npm";
}

function assertFile(filePath) {
    if (!fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
        throw new Error(`Required package artifact is missing: ${filePath}`);
    }
}
