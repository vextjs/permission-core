import { existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import MonSQLize from "monsqlize";
import { MongoMemoryReplSet } from "mongodb-memory-server";

const MONGODB_VERSION = "7.0.37";

export interface RealMongoContext {
    readonly monsqlize: MonSQLize;
    readonly uri: string;
    readonly databaseName: string;
    readonly external: boolean;
    close(): Promise<void>;
}

function resolveSystemBinary() {
    const configured = process.env.PERMISSION_CORE_MONGOD_BINARY;
    const candidates = [
        configured,
        resolve(process.cwd(), ".cache", "mongodb-memory-server", "binaries", `mongod-x64-win32-${MONGODB_VERSION}.exe`),
        resolve(process.cwd(), "..", "monSQLize", ".cache", "mongodb-memory-server", "binaries", `mongod-x64-win32-${MONGODB_VERSION}.exe`),
    ];
    return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
}

export async function startRealMongo(
    defaults: { findMaxLimit?: number } = {},
): Promise<RealMongoContext> {
    const externalUri = process.env.PERMISSION_CORE_REPLSET_URI;
    const databaseName = `permission_core_${randomUUID().replaceAll("-", "")}`;
    let server: MongoMemoryReplSet | undefined;
    let uri = externalUri;

    if (!uri) {
        const downloadDirectory = resolve(process.cwd(), ".cache", "mongodb-memory-server", "binaries");
        const dbPath = join(process.cwd(), ".cache", "mongodb-memory-server", "instances", databaseName);
        mkdirSync(dbPath, { recursive: true });
        process.env.MONGOMS_DOWNLOAD_DIR = downloadDirectory;
        process.env.MONGOMS_VERSION = MONGODB_VERSION;
        const systemBinary = resolveSystemBinary();
        server = await MongoMemoryReplSet.create({
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
        uri = server.getUri();
    }

    let monsqlize: MonSQLize;
    try {
        monsqlize = new MonSQLize({
            type: "mongodb",
            databaseName,
            config: { uri },
            ...(defaults.findMaxLimit === undefined
                ? {}
                : { findLimit: Math.min(500, defaults.findMaxLimit) }),
            ...defaults,
        });
        await monsqlize.connect();
    } catch (error) {
        await server?.stop({ doCleanup: true, force: true });
        throw error;
    }

    return {
        monsqlize,
        uri,
        databaseName,
        external: Boolean(externalUri),
        async close() {
            try {
                await monsqlize.close();
            } finally {
                await server?.stop({ doCleanup: true, force: true });
            }
        },
    };
}
