import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("B1 package contract", () => {
    it("publishes root, match, and the native Vext plugin only", async () => {
        const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));

        expect(packageJson.version).toBe("3.0.0");
        expect(Object.keys(packageJson.exports)).toEqual([".", "./match", "./plugins/vext"]);
        expect(packageJson.exports["./menu"]).toBeUndefined();
        expect(packageJson.exports["./adapters/vext"]).toBeUndefined();
        expect(packageJson.exports["./plugins/vext"]).toEqual({
            types: "./dist/plugins/vext.d.ts",
            import: "./dist/plugins/vext.js",
            require: "./dist/plugins/vext.cjs",
        });
    });

    it("uses MonSQLize 3.1.0 as the exact host-owned peer", async () => {
        const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));

        expect(packageJson.peerDependencies.monsqlize).toBe("3.1.0");
        expect(packageJson.devDependencies.monsqlize).toBe("3.1.0");
        expect(packageJson.dependencies?.monsqlize).toBeUndefined();
        expect(packageJson.dependencies?.["cache-hub"]).toBeUndefined();
        expect(packageJson.peerDependencies.vextjs).toBe("0.3.26");
        expect(packageJson.peerDependenciesMeta.vextjs.optional).toBe(true);
    });
});
