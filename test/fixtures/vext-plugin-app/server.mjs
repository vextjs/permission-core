import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import MonSQLize from "monsqlize";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { bootstrap } from "vextjs";

const MONGODB_VERSION = "7.0.37";
const DATABASE = Symbol.for("permission-core.vext.api-fixture.database");
const CLOSE_TRACE = Symbol.for("permission-core.vext.api-fixture.close-trace");
const stopFile = process.env.VEXT_FIXTURE_STOP_FILE;
const databaseName = `permission_core_vext_${randomUUID().replaceAll("-", "")}`;
const rootDir = resolve("test/fixtures/vext-plugin-app");
const downloadDirectory = resolve(".cache/mongodb-memory-server/binaries");
const dbPath = resolve(".cache/mongodb-memory-server/instances", databaseName);
const binaryCandidates = [
    process.env.PERMISSION_CORE_MONGOD_BINARY,
    resolve(downloadDirectory, `mongod-x64-win32-${MONGODB_VERSION}.exe`),
    resolve("../monSQLize/.cache/mongodb-memory-server/binaries", `mongod-x64-win32-${MONGODB_VERSION}.exe`),
];
const systemBinary = binaryCandidates.find((candidate) => candidate && existsSync(candidate));

mkdirSync(dbPath, { recursive: true });
process.env.MONGOMS_DOWNLOAD_DIR = downloadDirectory;
process.env.MONGOMS_VERSION = MONGODB_VERSION;

let replSet;
let monsqlize;
let runtime;
let stopTimer;
let closing;

async function close() {
    closing ??= (async () => {
        if (stopTimer) clearInterval(stopTimer);
        let closeError;
        try {
            if (runtime) {
                await runtime.internals.shutdown(runtime.serverHandle, { skipExit: true });
                const trace = globalThis[CLOSE_TRACE];
                if (trace?.permissionLifecycle !== "closed" || trace.databaseClosed !== true) {
                    throw new Error("Vext fixture did not close permission core before the database owner");
                }
                console.log("VEXT_API_FIXTURE_CLOSED=permission:closed,database:true");
            }
        } catch (error) {
            closeError = error;
        }
        const trace = globalThis[CLOSE_TRACE];
        if (monsqlize && trace?.databaseClosed !== true) {
            await monsqlize.close().catch((error) => { closeError ??= error; });
        }
        if (replSet) {
            await replSet.stop({ doCleanup: true, force: true }).catch((error) => { closeError ??= error; });
        }
        delete globalThis[DATABASE];
        delete globalThis[CLOSE_TRACE];
        if (closeError) throw closeError;
    })();
    return closing;
}

try {
    replSet = await MongoMemoryReplSet.create({
        binary: {
            version: MONGODB_VERSION,
            ...(systemBinary ? { systemBinary } : {}),
        },
        instanceOpts: [{ dbPath }],
        replSet: {
            count: 1,
            dbName: databaseName,
            storageEngine: "wiredTiger",
        },
    });
    monsqlize = new MonSQLize({
        type: "mongodb",
        databaseName,
        config: { uri: replSet.getUri() },
    });
    await monsqlize.connect();
    globalThis[DATABASE] = monsqlize;
    runtime = await bootstrap(rootDir);

    const scoped = runtime.app.permission.scope({ tenantId: "vext-host" });
    await scoped.roles.create({ id: "route-reader", label: "Route reader" });
    await scoped.roles.allow("route-reader", { action: "invoke", resource: "GET:/orders/:id" });
    await scoped.roles.allow("route-reader", { action: "invoke", resource: "GET:/capabilities/one" });
    await scoped.userRoles.assign("u-vext", "route-reader");
    await scoped.roles.create({ id: "duplicate-role", label: "Duplicate role" });

    console.log(`VEXT_API_FIXTURE_READY=http://${runtime.serverHandle.host}:${runtime.serverHandle.port}`);
    if (stopFile) {
        stopTimer = setInterval(() => {
            if (!existsSync(stopFile)) return;
            void close().then(() => process.exit(0), (error) => {
                console.error(error);
                process.exit(1);
            });
        }, 100);
        stopTimer.unref();
    }
} catch (error) {
    console.error(error);
    await close().catch((closeError) => console.error(closeError));
    process.exitCode = 1;
}
