import { defineConfig } from "vitest/config";
import coverageThresholds from "./scripts/coverage-thresholds.json";

export default defineConfig({
    test: {
        environment: "node",
        include: ["test/**/*.test.ts"],
        fileParallelism: false,
        coverage: {
            provider: "v8",
            all: true,
            include: ["src/**/*.ts"],
            reporter: ["text", "json-summary", "html"],
            thresholds: {
                ...coverageThresholds.global,
                ...Object.fromEntries(Object.entries(coverageThresholds.groups)
                    .map(([prefix, values]) => [`${prefix}**`, values])),
            },
        }
    }
});
