import * as fs from "node:fs";
import * as path from "node:path";

const stableRoot = resolveRequiredPath("--stable=");
const previewRoot = resolveRequiredPath("--preview=");
const outputRoot = resolveRequiredPath("--output=");
const dryRun = process.argv.includes("--dry-run");

assertDirectory(stableRoot, "stable build");
assertDirectory(previewRoot, "preview build");
assertFile(path.join(stableRoot, "index.html"), "stable index");
assertFile(path.join(stableRoot, "zh", "index.html"), "stable Chinese index");
assertFile(path.join(previewRoot, "index.html"), "preview index");
assertFile(path.join(previewRoot, "zh", "index.html"), "preview Chinese index");
assertFile(path.join(stableRoot, "sitemap.xml"), "stable sitemap");
assertFile(path.join(previewRoot, "sitemap.xml"), "preview sitemap");

if (fs.existsSync(path.join(stableRoot, "next"))) {
    throw new Error("Stable build already contains a next/ route; refusing to overwrite it");
}
if (fs.existsSync(outputRoot)) {
    throw new Error(`Output path must not already exist: ${outputRoot}`);
}

if (!dryRun) {
    fs.mkdirSync(path.dirname(outputRoot), { recursive: true });
    fs.cpSync(stableRoot, outputRoot, { recursive: true, errorOnExist: true });
    fs.cpSync(previewRoot, path.join(outputRoot, "next"), {
        recursive: true,
        errorOnExist: true,
    });
    assertFile(path.join(outputRoot, "index.html"), "assembled stable index");
    assertFile(path.join(outputRoot, "next", "index.html"), "assembled preview index");
}

console.log(`${dryRun ? "Docs site assembly dry-run passed" : "Docs site assembled"}: ${outputRoot}`);

function resolveRequiredPath(prefix) {
    const argument = process.argv.find((value) => value.startsWith(prefix));
    if (!argument?.slice(prefix.length)) {
        throw new Error(`Missing required argument: ${prefix}<path>`);
    }
    return path.resolve(argument.slice(prefix.length));
}

function assertDirectory(directoryPath, label) {
    if (!fs.statSync(directoryPath, { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error(`Missing ${label}: ${directoryPath}`);
    }
}

function assertFile(filePath, label) {
    if (!fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
        throw new Error(`Missing ${label}: ${filePath}`);
    }
}
