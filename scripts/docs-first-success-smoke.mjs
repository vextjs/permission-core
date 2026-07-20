import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { MongoMemoryReplSet } from "mongodb-memory-server";

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
const quickStart = fs.readFileSync(
    path.join(toolingRoot, "website", "docs", "zh", "guide", "quick-start.md"),
    "utf-8",
);
const displayedSource = /<!-- docs:first-success:start -->\s*```js\r?\n([\s\S]*?)```\s*<!-- docs:first-success:end -->/u.exec(quickStart)?.[1];
if (!displayedSource) {
    throw new Error("Chinese Quick Start is missing the executable First Success block");
}
fs.writeFileSync(path.join(consumerRoot, "first-success.mjs"), displayedSource);

run(npmCommand(), [
    "install",
    tarballPath,
    "monsqlize@3.1.0",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
], consumerRoot, {
    stage: "consumer install",
    timeoutMs: INSTALL_TIMEOUT_MS,
});

const replSet = await MongoMemoryReplSet.create({
    binary: {
        version: MONGODB_VERSION,
        ...(cachedMongoBinary ? { systemBinary: cachedMongoBinary } : {}),
    },
    replSet: { count: 1, storageEngine: "wiredTiger" },
});
let stdout;
try {
    stdout = (await runAsync(process.execPath, ["first-success.mjs"], consumerRoot, {
        capture: true,
        stage: "Chinese Quick Start First Success",
        timeoutMs: EXAMPLE_TIMEOUT_MS,
        env: {
            MONGODB_URI: replSet.getUri(),
            MONGODB_DATABASE: `permission_core_quick_start_${Date.now()}`,
        },
    })).trim();
} finally {
    await replSet.stop({ doCleanup: true, force: true });
}

const jsonStart = stdout.lastIndexOf("\n{") + 1;
const result = JSON.parse(stdout.slice(jsonStart));
if (result.allowed !== true || result.deleteAllowed !== false) {
    throw new Error(`Unexpected Chinese Quick Start output:\n${stdout}`);
}

console.log("Docs First Success smoke passed: displayed Quick Start allowed=true deleteAllowed=false");
if (outputRootArgument) {
    console.log(`FIRST_SUCCESS_SMOKE_RETAINED=${outputRoot}`);
} else {
    fs.rmSync(outputRoot, { recursive: true, force: true });
}

/** Execute one bounded child process and surface its captured failure output. */
function run(command, args, cwd, { capture = false, stage, timeoutMs, env = {} }) {
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
            ...env,
        },
    });
    if (result.error?.code === "ETIMEDOUT") {
        throw new Error(`${stage} timed out after ${String(timeoutMs)} ms:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    }
    if (result.status !== 0) {
        throw new Error(`${stage} failed (${String(result.status)}):\n${result.error?.message ?? result.stderr ?? ""}`);
    }
    return result.stdout ?? "";
}

/** Run the displayed example without blocking the Mongo fixture event loop. */
function runAsync(command, args, cwd, { capture = false, stage, timeoutMs, env = {} }) {
    return new Promise((resolvePromise, rejectPromise) => {
        const child = spawn(command, args, {
            cwd,
            windowsHide: true,
            stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
            env: { ...process.env, ...env },
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.setEncoding("utf-8");
        child.stderr?.setEncoding("utf-8");
        child.stdout?.on("data", (chunk) => { stdout += chunk; });
        child.stderr?.on("data", (chunk) => { stderr += chunk; });

        const timer = setTimeout(() => {
            child.kill();
            rejectPromise(new Error(`${stage} timed out after ${String(timeoutMs)} ms:\n${stdout}\n${stderr}`));
        }, timeoutMs);
        child.once("error", (error) => {
            clearTimeout(timer);
            rejectPromise(new Error(`${stage} failed to start: ${error.message}`));
        });
        child.once("close", (code, signal) => {
            clearTimeout(timer);
            if (code !== 0) {
                rejectPromise(new Error(`${stage} failed (${String(code ?? signal)}):\n${stdout}\n${stderr}`));
                return;
            }
            resolvePromise(stdout);
        });
    });
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
