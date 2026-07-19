import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
    diagramContracts,
    docsLocales,
    localizedDocsSource,
} from "../../scripts/docs-experience-contracts.mjs";

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = path.join(websiteRoot, "docs");
const failures = [];

// Mermaid 10's Node entry receives DOMPurify's factory, while parse() expects a
// browser instance. This isolated process only validates trusted source syntax
// and emits no HTML; browser rendering still uses the real strict sanitizer.
const domPurifyFactory = (await import("dompurify")).default;
if (typeof domPurifyFactory.sanitize !== "function") {
    domPurifyFactory.sanitize = (value) => value;
}
const mermaid = (await import("mermaid")).default;

mermaid.initialize({
    securityLevel: "strict",
    startOnLoad: false,
    flowchart: {
        htmlLabels: false,
        useMaxWidth: true,
    },
});

for (const contract of diagramContracts) {
    for (const locale of docsLocales) {
        const source = localizedDocsSource(contract.path, locale);
        const file = path.join(docsRoot, source);
        const content = fs.readFileSync(file, "utf8");
        const blocks = [...content.matchAll(/```mermaid\r?\n([\s\S]*?)```/gu)];
        if (blocks.length !== 1) {
            failures.push(`${source} expected one Mermaid block, received ${blocks.length}`);
            continue;
        }

        try {
            await mermaid.parse(blocks[0][1]);
        } catch (error) {
            failures.push(`${source} Mermaid parse failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}

if (failures.length > 0) {
    for (const failure of failures) {
        console.error(`MERMAID_CHECK_FAILED ${failure}`);
    }
    process.exitCode = 1;
} else {
    console.log(`Mermaid checks passed: ${diagramContracts.length * docsLocales.length} localized diagrams parsed`);
}
