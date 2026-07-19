import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const projectRoot = path.resolve(import.meta.dirname, "..");
const sourceRoot = path.join(projectRoot, "src");
const thresholds = JSON.parse(fs.readFileSync(
    path.join(import.meta.dirname, "complexity-thresholds.json"),
    "utf8",
));
const failures = [];
const sourceFiles = collectSourceFiles(sourceRoot);
const fileMetrics = [];
const functionMetrics = [];

for (const file of sourceFiles) {
    const content = fs.readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const relative = path.relative(projectRoot, file).replaceAll("\\", "/");
    fileMetrics.push({ file: relative, lines: content.split(/\r?\n/u).length });
    visitFunctions(source, (node) => {
        const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const end = source.getLineAndCharacterOfPosition(node.body.end).line + 1;
        functionMetrics.push({ file: relative, start, lines: end - start + 1 });
    });
}

const actual = {
    filesOver500: fileMetrics.filter(({ lines }) => lines > 500).length,
    filesOver1000: fileMetrics.filter(({ lines }) => lines > 1000).length,
    functionsOver50: functionMetrics.filter(({ lines }) => lines > 50).length,
    maxFunctionLines: Math.max(0, ...functionMetrics.map(({ lines }) => lines)),
    maxSourceFileLines: Math.max(0, ...fileMetrics.map(({ lines }) => lines)),
};

for (const [metric, limit] of Object.entries(thresholds.totals)) {
    if (!Number.isSafeInteger(limit) || limit < 0) failures.push(`invalid complexity threshold ${metric}`);
    else if (actual[metric] > limit) failures.push(`${metric} is ${actual[metric]}; limit is ${limit}`);
}
for (const [file, limit] of Object.entries(thresholds.files)) {
    const metric = fileMetrics.find((item) => item.file === file);
    if (metric === undefined) failures.push(`complexity budget file is missing: ${file}`);
    else if (metric.lines > limit) failures.push(`${file} is ${metric.lines} lines; limit is ${limit}`);
}

if (failures.length > 0) {
    console.error(`Complexity checks failed (${failures.length}):`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
} else {
    console.log(`Complexity checks passed: ${sourceFiles.length} files; ${JSON.stringify(actual)}`);
}

function collectSourceFiles(root) {
    const files = [];
    const visit = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(file);
            else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) files.push(file);
        }
    };
    visit(root);
    return files.sort();
}

function visitFunctions(source, visitor) {
    const visit = (node) => {
        const isFunction = ts.isFunctionDeclaration(node)
            || ts.isFunctionExpression(node)
            || ts.isArrowFunction(node)
            || ts.isMethodDeclaration(node)
            || ts.isConstructorDeclaration(node)
            || ts.isGetAccessorDeclaration(node)
            || ts.isSetAccessorDeclaration(node);
        if (isFunction && node.body !== undefined) visitor(node);
        ts.forEachChild(node, visit);
    };
    visit(source);
}
