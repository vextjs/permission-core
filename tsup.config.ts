import { defineConfig } from "tsup";

export default defineConfig({
    entry: {
        index: "src/index.ts",
        match: "src/match.ts",
        menu: "src/menu/index.ts",
        "adapters/vext": "src/adapters/vext/index.ts"
    },
    format: ["esm", "cjs"],
    dts: true,
    sourcemap: true,
    clean: true,
    target: "node18",
    outDir: "dist",
    treeshake: true
});
