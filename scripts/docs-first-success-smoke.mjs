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
const PACK_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 300_000;
const EXAMPLE_TIMEOUT_MS = 180_000;
const MONGODB_VERSION = "7.0.37";
const cachedMongoBinary = [
    process.env.PERMISSION_CORE_MONGOD_BINARY,
    ...findMongoBinaries(path.join(toolingRoot, ".cache", "mongodb-memory-server", "binaries")),
    ...findMongoBinaries(path.resolve(toolingRoot, "../monSQLize/.cache/mongodb-memory-server/binaries")),
].find((candidate) => candidate && fs.existsSync(candidate));

fs.mkdirSync(consumerRoot, { recursive: true });
assertFile(path.join(packageRoot, "dist", "index.js"));

const packOutput = run(npmCommand(), [
    "pack",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    outputRoot,
], packageRoot, {
    capture: true,
    stage: "package",
    timeoutMs: PACK_TIMEOUT_MS,
});
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
], consumerRoot, {
    stage: "consumer install",
    timeoutMs: INSTALL_TIMEOUT_MS,
});
const stdout = run(process.execPath, ["first-success.mjs"], consumerRoot, {
    capture: true,
    stage: "First Success example",
    timeoutMs: EXAMPLE_TIMEOUT_MS,
}).trim();
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

/** Execute one bounded child process and surface its captured failure output. */
function run(command, args, cwd, { capture = false, stage, timeoutMs }) {
    const useShell = process.platform === "win32" && /\.cmd$/i.test(command);
    const result = spawnSync(command, args, {
        cwd,
        encoding: "utf-8",
        stdio: capture ? "pipe" : "inherit",
        shell: useShell,
        timeout: timeoutMs,
        windowsHide: true,
        env: {
            ...process.env,
            ...(cachedMongoBinary
                ? { PERMISSION_CORE_MONGOD_BINARY: cachedMongoBinary }
                : {}),
        },
    });
    if (result.error?.code === "ETIMEDOUT") {
        throw new Error(`${stage} timed out after ${String(timeoutMs)} ms`);
    }
    if (result.status !== 0) {
        throw new Error(`${stage} failed (${String(result.status)}):\n${result.error?.message ?? result.stderr ?? ""}`);
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

function findMongoBinaries(directory) {
    if (!fs.statSync(directory, { throwIfNoEntry: false })?.isDirectory()) return [];
    return fs.readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile()
            && entry.name.startsWith("mongod-")
            && entry.name.includes(MONGODB_VERSION)
            && (process.platform === "win32"
                ? entry.name.endsWith(".exe")
                : path.extname(entry.name) === ""))
        .map((entry) => path.join(directory, entry.name));
}
