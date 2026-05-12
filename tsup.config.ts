import { defineConfig } from "tsup";

export default defineConfig({
    entry: {
        index: "src/index.ts",
        match: "src/match.ts"
    },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "node18",
    outDir: "dist",
    treeshake: true
});