import * as fs from "node:fs";
import * as path from "node:path";

const thresholds = JSON.parse(fs.readFileSync(new URL("./coverage-thresholds.json", import.meta.url), "utf-8"));

const summaryArgument = process.argv.find((argument) => argument.startsWith("--summary="));
const scaleArgument = process.argv.find((argument) => argument.startsWith("--scale="));
const summaryPath = path.resolve(summaryArgument?.slice("--summary=".length) ?? "coverage/coverage-summary.json");
const scale = Number(scaleArgument?.slice("--scale=".length) ?? "1");

if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error("--scale must be a positive number");
}
if (!fs.existsSync(summaryPath)) {
    throw new Error(`Coverage summary not found: ${summaryPath}`);
}

const summary = JSON.parse(fs.readFileSync(summaryPath, "utf-8"));
const failures = [];

verifyMetrics("global", summary.total, thresholds.global);

const fileEntries = Object.entries(summary).filter(([filePath]) => filePath !== "total");
for (const [prefix, groupThresholds] of Object.entries(thresholds.groups)) {
    const normalizedPrefix = prefix.replaceAll("\\", "/");
    const matched = fileEntries
        .filter(([filePath]) => path.relative(process.cwd(), filePath).replaceAll("\\", "/").startsWith(normalizedPrefix))
        .map(([, metrics]) => metrics);
    if (matched.length === 0) {
        failures.push(`${prefix}: no coverage files matched`);
        continue;
    }
    verifyMetrics(prefix, aggregateMetrics(matched), groupThresholds);
}

if (failures.length > 0) {
    for (const failure of failures) {
        console.error(`COVERAGE_THRESHOLD_FAILED ${failure}`);
    }
    process.exitCode = 1;
} else {
    console.log(`Coverage thresholds passed: ${summaryPath}`);
}

function verifyMetrics(label, actual, expected) {
    for (const metric of ["statements", "branches", "functions", "lines"]) {
        const minimum = expected[metric] * scale;
        const value = actual[metric]?.pct;
        if (typeof value !== "number" || value + Number.EPSILON < minimum) {
            failures.push(`${label} ${metric}: ${String(value)} < ${minimum}`);
        }
    }
}

function aggregateMetrics(entries) {
    return Object.fromEntries(["statements", "branches", "functions", "lines"].map((metric) => {
        const total = entries.reduce((sum, entry) => sum + entry[metric].total, 0);
        const covered = entries.reduce((sum, entry) => sum + entry[metric].covered, 0);
        return [metric, { total, covered, pct: total === 0 ? 100 : Math.floor((covered / total) * 10_000) / 100 }];
    }));
}
