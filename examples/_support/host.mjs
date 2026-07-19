import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import MonSQLize from "monsqlize";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { PermissionCore } from "permission-core";

const MONGODB_VERSION = "7.0.37";

function mongoBinary() {
    const downloadDirectory = resolve(".cache/mongodb-memory-server/binaries");
    const candidates = [
        process.env.PERMISSION_CORE_MONGOD_BINARY,
        resolve(downloadDirectory, `mongod-x64-win32-${MONGODB_VERSION}.exe`),
        resolve("../monSQLize/.cache/mongodb-memory-server/binaries", `mongod-x64-win32-${MONGODB_VERSION}.exe`),
    ];
    return {
        downloadDirectory,
        systemBinary: candidates.find((candidate) => candidate && existsSync(candidate)),
    };
}

function safeLabel(value) {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24);
}

export async function startExampleDatabase(label) {
    const runId = randomUUID().replaceAll("-", "");
    const databaseName = `permission_core_${safeLabel(label)}_${runId}`;
    const dbPath = resolve(".cache/mongodb-memory-server/instances", databaseName);
    const { downloadDirectory, systemBinary } = mongoBinary();

    mkdirSync(dbPath, { recursive: true });
    process.env.MONGOMS_DOWNLOAD_DIR = downloadDirectory;
    process.env.MONGOMS_VERSION = MONGODB_VERSION;

    const replSet = await MongoMemoryReplSet.create({
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
    const monsqlize = new MonSQLize({
        type: "mongodb",
        databaseName,
        config: { uri: replSet.getUri() },
    });
    await monsqlize.connect();

    let closePromise;
    return Object.freeze({
        monsqlize,
        databaseName,
        close() {
            closePromise ??= (async () => {
                await monsqlize.close();
                await replSet.stop({ doCleanup: true, force: true });
            })();
            return closePromise;
        },
    });
}

export async function startExampleCore(label, options = {}) {
    // The in-memory replica set is an example fixture. Production hosts pass their
    // already-connected MonSQLize 3.1 instance and retain database ownership.
    const database = await startExampleDatabase(label);
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const core = new PermissionCore({
        monsqlize: database.monsqlize,
        collectionPrefix: `pc_${safeLabel(label)}_${suffix}`,
        tokenSecret: "permission-core-runnable-example-token-secret",
        ...options,
    });

    try {
        await core.init();
    } catch (error) {
        await database.close().catch(() => undefined);
        throw error;
    }

    let closePromise;
    return Object.freeze({
        core,
        database,
        close() {
            closePromise ??= (async () => {
                await core.close();
                await database.close();
            })();
            return closePromise;
        },
    });
}

export function printExample(name, result) {
    console.log(JSON.stringify({ example: name, ok: true, ...result }, null, 2));
}
