import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { runInNewContext } from "node:vm";

const base = "/permission-core/";
const routes = [
    "zh/guide/core-concepts.html",
    "zh/guide/quick-start.html",
    "zh/guide/manage-roles-and-users.html",
];
const forbiddenLazyProxyTokens = [
    "docs_zh_guide_core-concepts_md_lazy-compilation-proxy",
    "docs_zh_guide_manage-roles-and-users_md_lazy-compilation-proxy",
];

let child;
let stdout = "";
let stderr = "";

async function main() {
    const port = await findFreePort();
    const origin = `http://localhost:${port}`;
    child = spawn(
        process.execPath,
        [
            "node_modules/@rspress/core/bin/rspress.js",
            "dev",
            "--port",
            String(port),
            "--host",
            "localhost",
        ],
        {
            cwd: new URL("../website/", import.meta.url),
            env: { ...process.env, BROWSER: "none" },
            stdio: ["ignore", "pipe", "pipe"],
        },
    );

    child.stdout.on("data", (chunk) => {
        stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
        stderr += chunk;
    });

    try {
        await verifyChunkRecoveryBehavior();
        await waitForServer(origin);
        await verifyNoLazyRouteProxies(origin);

        for (const route of routes) {
            const url = `${origin}${base}${route}`;
            const response = await fetch(url, {
                headers: {
                    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                },
            });
            if (!response.ok) {
                throw new Error(`${url} returned ${response.status}`);
            }

            const html = await response.text();
            const recoveryAsset = `${base}chunk-load-recovery.js`;
            if (!html.includes(`src="${recoveryAsset}"`)) {
                throw new Error(`${url} did not load the chunk recovery guard`);
            }
            const recoveryResponse = await fetch(`${origin}${recoveryAsset}`);
            if (!recoveryResponse.ok) {
                throw new Error(`${url} referenced unavailable recovery guard: ${recoveryResponse.status}`);
            }

            const assets = [...html.matchAll(/(?:src|href)="(\/permission-core\/static\/(?:js|css)\/[^"]+)"/g)]
                .map((match) => match[1]);
            if (!assets.some((asset) => asset.endsWith("/index.js"))) {
                throw new Error(`${url} did not expose the dev client entry`);
            }
            if (!assets.some((asset) => asset.endsWith("/styles.css"))) {
                throw new Error(`${url} did not expose the dev stylesheet`);
            }

            for (const asset of assets.filter((item) => item.endsWith("/index.js") || item.endsWith("/styles.css"))) {
                const assetResponse = await fetch(`${origin}${asset}`);
                if (!assetResponse.ok) {
                    throw new Error(`${url} referenced unavailable asset ${asset}: ${assetResponse.status}`);
                }
            }
        }

        await verifyBrowserSidebarNavigation(origin);

        console.log(`Docs dev deep-link checks passed: ${routes.length} routes at ${origin}${base}`);
    } finally {
        await stopProcessTree(child);
    }
}

async function verifyChunkRecoveryBehavior() {
    const source = await readFile(
        new URL("../website/docs/public/chunk-load-recovery.js", import.meta.url),
        "utf8",
    );
    const listeners = new Map();
    const storage = new Map();
    let reloads = 0;
    const window = {
        addEventListener(type, listener) {
            listeners.set(type, listener);
        },
        location: {
            reload() {
                reloads += 1;
            },
        },
        sessionStorage: {
            getItem(key) {
                return storage.get(key) ?? null;
            },
            setItem(key, value) {
                storage.set(key, value);
            },
        },
    };

    runInNewContext(source, { window });
    listeners.get("error")?.({ message: "ordinary application error" });
    if (reloads !== 0) {
        throw new Error("chunk recovery guard reloaded for an unrelated error");
    }

    const chunkFailure = {
        reason: "ChunkLoadError: Loading chunk docs_zh_guide_core-concepts_md failed.",
    };
    listeners.get("unhandledrejection")?.(chunkFailure);
    listeners.get("unhandledrejection")?.(chunkFailure);
    if (reloads !== 1) {
        throw new Error(`chunk recovery guard expected one bounded reload, received ${reloads}`);
    }

    const restrictedListeners = new Map();
    let restrictedReloads = 0;
    runInNewContext(source, {
        window: {
            addEventListener(type, listener) {
                restrictedListeners.set(type, listener);
            },
            location: {
                reload() {
                    restrictedReloads += 1;
                },
            },
            sessionStorage: {
                getItem() {
                    throw new Error("storage unavailable");
                },
            },
        },
    });
    restrictedListeners.get("unhandledrejection")?.(chunkFailure);
    if (restrictedReloads !== 0) {
        throw new Error("chunk recovery guard can loop when session storage is unavailable");
    }
}

async function verifyNoLazyRouteProxies(origin) {
    const response = await fetch(`${origin}${base}rsbuild-dev-server`, {
        headers: { accept: "text/html" },
    });
    if (!response.ok) {
        throw new Error(`dev asset report returned ${response.status}`);
    }

    const assetReport = await response.text();
    for (const token of forbiddenLazyProxyTokens) {
        if (assetReport.includes(token)) {
            throw new Error(`target route still uses lazy compilation proxy: ${token}`);
        }
    }
}

async function verifyBrowserSidebarNavigation(origin) {
    const chromePath = findChromeExecutable();
    const browserPort = await findFreePort();
    const profileRoot = await mkdtemp(
        path.join(os.tmpdir(), "permission-core-docs-chrome-"),
    );
    const browser = spawn(chromePath, [
        `--remote-debugging-port=${browserPort}`,
        `--user-data-dir=${profileRoot}`,
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "about:blank",
    ], {
        stdio: "ignore",
    });

    let client;
    try {
        await waitForChrome(`http://127.0.0.1:${browserPort}`);
        const target = await fetchJson(
            `http://127.0.0.1:${browserPort}/json/new?${encodeURIComponent(
                `${origin}${base}zh/guide/quick-start.html`,
            )}`,
            { method: "PUT" },
        );
        client = await createCdpClient(target.webSocketDebuggerUrl);
        await client.send("Runtime.enable");
        await client.send("Page.enable");
        await client.send("Network.enable");
        await client.send("Log.enable");
        await setDesktopViewport(client, 956);
        await client.send("Page.reload", { ignoreCache: true });
        await waitForRenderedRoute(client, "quick-start", { tolerateInitialEvents: true });
        await verifyDocsLayoutAtViewport(client, origin, "core-concepts", 956);
        await verifyDocsLayoutAtViewport(client, origin, "core-concepts", 1280);
        await verifyDocsLayoutAtViewport(client, origin, "core-concepts", 1920);
        await verifyDocsLayoutAtViewport(client, origin, "manage-roles-and-users", 1920);
        await setDesktopViewport(client, 956);
        await navigateToGuideRoute(client, origin, "quick-start");
        await waitForRenderedRoute(client, "quick-start", { tolerateInitialEvents: true });

        client.clearEvents();
        for (const slug of [
            "core-concepts",
            "quick-start",
            "core-concepts",
            "manage-roles-and-users",
            "core-concepts",
        ]) {
            const click = await clickGuideLink(client, slug);
            if (!click.clicked) {
                throw new Error(`browser could not click ${slug}: ${JSON.stringify(click)}`);
            }
            await waitForRenderedRoute(client, slug);
        }

        const runtimeFailures = client.events().filter(isBlockingBrowserEvent);
        if (runtimeFailures.length > 0) {
            throw new Error(
                "browser sidebar navigation emitted runtime failures: "
                + JSON.stringify(runtimeFailures, null, 2),
            );
        }
    } finally {
        client?.close();
        await stopProcessTree(browser);
        await removeChromeProfile(profileRoot);
    }
}

async function verifyDocsLayoutAtViewport(client, origin, slug, width) {
    await setDesktopViewport(client, width);
    await navigateToGuideRoute(client, origin, slug);
    await waitForRenderedRoute(client, slug);
}

async function setDesktopViewport(client, width) {
    await client.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 750,
        deviceScaleFactor: 1,
        mobile: false,
    });
}

async function navigateToGuideRoute(client, origin, slug) {
    await client.send("Page.navigate", {
        url: `${origin}${base}zh/guide/${slug}.html`,
    });
}

function findChromeExecutable() {
    const candidates = [
        process.env.CHROME_PATH,
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
    ].filter(Boolean);

    const found = candidates.find((candidate) => existsSync(candidate));
    if (!found) {
        throw new Error(
            "Chrome is required for docs dev sidebar navigation checks. Set CHROME_PATH to a Chrome executable.",
        );
    }
    return found;
}

async function waitForChrome(browserOrigin) {
    const deadline = Date.now() + 15_000;
    let lastError;
    while (Date.now() < deadline) {
        try {
            await fetchJson(`${browserOrigin}/json/version`);
            return;
        } catch (error) {
            lastError = error;
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }
    throw lastError ?? new Error("timed out waiting for Chrome");
}

async function fetchJson(url, init) {
    const response = await fetch(url, init);
    if (!response.ok) {
        throw new Error(`${url} returned ${response.status}`);
    }
    return response.json();
}

async function createCdpClient(webSocketDebuggerUrl) {
    const socket = new CdpWebSocket(webSocketDebuggerUrl);
    await socket.connect();
    const pending = new Map();
    const browserEvents = [];
    let nextId = 1;

    socket.on("message", (text) => {
        const payload = JSON.parse(text);
        if (payload.id && pending.has(payload.id)) {
            const request = pending.get(payload.id);
            pending.delete(payload.id);
            if (payload.error) {
                request.reject(new Error(`${request.method}: ${payload.error.message}`));
            } else {
                request.resolve(payload.result ?? {});
            }
            return;
        }

        if ([
            "Runtime.exceptionThrown",
            "Log.entryAdded",
            "Network.loadingFailed",
        ].includes(payload.method)) {
            browserEvents.push(summarizeBrowserEvent(payload));
        }
    });
    socket.on("error", (error) => {
        browserEvents.push({ method: "WebSocket.error", message: error.message });
    });

    return {
        send(method, params = {}) {
            const id = nextId++;
            socket.send(JSON.stringify({ id, method, params }));
            return new Promise((resolve, reject) => {
                pending.set(id, { resolve, reject, method });
                setTimeout(() => {
                    if (!pending.has(id)) return;
                    pending.delete(id);
                    reject(new Error(`CDP timeout: ${method}`));
                }, 10_000);
            });
        },
        async evaluate(expression) {
            const result = await this.send("Runtime.evaluate", {
                expression,
                returnByValue: true,
                userGesture: true,
            });
            if (result.exceptionDetails) {
                throw new Error(JSON.stringify(result.exceptionDetails));
            }
            return result.result?.value;
        },
        events() {
            return browserEvents.slice();
        },
        clearEvents() {
            browserEvents.length = 0;
        },
        close() {
            socket.close();
        },
    };
}

async function clickGuideLink(client, slug) {
    const raw = await client.evaluate(`(() => {
        const links = [...document.querySelectorAll('a[href]')];
        const target = links.find((link) => {
            const href = link.getAttribute('href') || '';
            return href.includes('/zh/guide/${slug}.html') || href.includes('/zh/guide/${slug}');
        });
        if (!target) {
            return JSON.stringify({
                clicked: false,
                slug: ${JSON.stringify(slug)},
                links: links
                    .map((link) => [link.textContent.trim(), link.getAttribute('href')])
                    .filter((entry) => String(entry[1]).includes('/zh/guide/'))
                    .slice(0, 80),
            });
        }
        target.scrollIntoView({ block: 'center' });
        target.click();
        return JSON.stringify({
            clicked: true,
            text: target.textContent.trim(),
            href: target.getAttribute('href'),
        });
    })()`);
    return JSON.parse(raw);
}

async function waitForRenderedRoute(client, slug, options = {}) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const deadline = Date.now() + 12_000;
    let latestState;
    while (Date.now() < deadline) {
        latestState = await getBrowserState(client);
        if (
            latestState.url.includes(`/zh/guide/${slug}`)
            && latestState.h1
            && latestState.mainTextLength > 100
        ) {
            assertStableDocsLayout(latestState, slug);
            return latestState;
        }
        await new Promise((resolve) => setTimeout(resolve, 350));
    }

    const failures = options.tolerateInitialEvents
        ? []
        : client.events().filter(isBlockingBrowserEvent);
    throw new Error(
        `browser did not render ${slug}: ${JSON.stringify({ latestState, failures }, null, 2)}`,
    );
}

function assertStableDocsLayout(state, slug) {
    const layout = state.layout;
    if (!layout) {
        throw new Error(`browser did not expose layout metrics for ${slug}`);
    }

    if (layout.bodyScrollWidth > layout.viewportWidth + 1) {
        throw new Error(
            `${slug} creates page-level horizontal overflow: `
            + JSON.stringify(layout, null, 2),
        );
    }

    if (layout.viewportWidth > 768) {
        if (!layout.sidebar || !layout.h1) {
            throw new Error(
                `${slug} is missing sidebar or heading geometry: `
                + JSON.stringify(layout, null, 2),
            );
        }
        if (layout.h1.left < layout.sidebar.right + 24) {
            throw new Error(
                `${slug} content is too close to or under the sidebar: `
                + JSON.stringify(layout, null, 2),
            );
        }
        if (layout.doc && layout.doc.left < layout.sidebar.right - 1) {
            throw new Error(
                `${slug} document column overlaps the sidebar: `
                + JSON.stringify(layout, null, 2),
            );
        }
        if (layout.sidebarBackgroundTransparent) {
            throw new Error(
                `${slug} sidebar is not an opaque layer: `
                + JSON.stringify(layout, null, 2),
            );
        }
        if (layout.sidebarStyle?.position !== "fixed") {
            throw new Error(
                `${slug} sidebar must stay in the fixed desktop layer: `
                + JSON.stringify(layout, null, 2),
            );
        }
    }

    if (
        layout.viewportWidth >= 1280
        && layout.outline
        && layout.doc
        && layout.outline.left < layout.doc.right - 1
    ) {
        throw new Error(
            `${slug} outline overlaps the document column: `
            + JSON.stringify(layout, null, 2),
        );
    }

    if (layout.panelLeaks.length > 0) {
        throw new Error(
            `${slug} has content panels escaping the document column: `
            + JSON.stringify(layout.panelLeaks, null, 2),
        );
    }
}

async function getBrowserState(client) {
    const raw = await client.evaluate(`(() => JSON.stringify({
        url: location.href,
        title: document.title,
        lang: document.documentElement.lang,
        h1: document.querySelector('h1')?.textContent?.trim() || null,
        mainTextLength: (() => {
            const main = document.querySelector('main');
            return main?.innerText?.trim().length ?? 0;
        })(),
        bodyTextLength: document.body?.innerText?.trim().length ?? 0,
        recoveryLoaded: [...document.scripts].some((script) => script.src.includes('chunk-load-recovery.js')),
        guideLinkCount: [...document.querySelectorAll('a[href]')]
            .filter((link) => String(link.getAttribute('href')).includes('/zh/guide/')).length,
        layout: (() => {
            const rect = (selector) => {
                const element = document.querySelector(selector);
                if (!element) return null;
                const value = element.getBoundingClientRect();
                return {
                    left: Math.round(value.left),
                    right: Math.round(value.right),
                    top: Math.round(value.top),
                    width: Math.round(value.width),
                    height: Math.round(value.height),
                };
            };
            const style = (selector) => {
                const element = document.querySelector(selector);
                if (!element) return null;
                const value = getComputedStyle(element);
                return {
                    backgroundColor: value.backgroundColor,
                    zIndex: value.zIndex,
                    position: value.position,
                };
            };
            const transparentBackground = (color) => (
                !color
                || color === "transparent"
                || color === "rgba(0, 0, 0, 0)"
            );
            const docContainer = rect(".rp-doc-layout__doc-container");
            const panelLeaks = docContainer
                ? [...document.querySelectorAll(".rp-codeblock, .rp-table-scroll-container, .pc-mermaid")]
                    .map((element) => {
                        const value = element.getBoundingClientRect();
                        return {
                            tag: element.tagName.toLowerCase(),
                            className: typeof element.className === "string"
                                ? element.className
                                : String(element.className?.baseVal || ""),
                            left: Math.round(value.left),
                            right: Math.round(value.right),
                            text: (element.textContent || "").trim().slice(0, 80),
                        };
                    })
                    .filter((item) => (
                        item.left < docContainer.left - 1
                        || item.right > docContainer.right + 1
                    ))
                : [];
            const sidebarStyle = style(".rp-doc-layout__sidebar");
            return {
                viewportWidth: window.innerWidth,
                bodyScrollWidth: document.body?.scrollWidth
                    ?? document.documentElement?.scrollWidth
                    ?? 0,
                sidebar: rect(".rp-doc-layout__sidebar"),
                doc: rect(".rp-doc-layout__doc"),
                docContainer,
                outline: rect(".rp-doc-layout__outline"),
                h1: rect("h1"),
                sidebarStyle,
                sidebarBackgroundTransparent: transparentBackground(sidebarStyle?.backgroundColor),
                panelLeaks,
            };
        })(),
    }))()`);
    return JSON.parse(raw);
}

function isBlockingBrowserEvent(event) {
    if (event.method === "Network.loadingFailed") {
        return event.errorText && event.errorText !== "net::ERR_ABORTED";
    }
    if (event.method === "Log.entryAdded") {
        return event.level === "error";
    }
    return event.method === "Runtime.exceptionThrown" || event.method === "WebSocket.error";
}

function summarizeBrowserEvent(payload) {
    if (payload.method === "Runtime.exceptionThrown") {
        const details = payload.params?.exceptionDetails;
        return {
            method: payload.method,
            text: details?.text,
            url: details?.url,
            lineNumber: details?.lineNumber,
            columnNumber: details?.columnNumber,
            exception: details?.exception?.description
                ?? details?.exception?.value
                ?? details?.exception?.className,
        };
    }
    if (payload.method === "Log.entryAdded") {
        const entry = payload.params?.entry ?? {};
        return {
            method: payload.method,
            level: entry.level,
            text: entry.text,
            url: entry.url,
        };
    }
    if (payload.method === "Network.loadingFailed") {
        const params = payload.params ?? {};
        return {
            method: payload.method,
            errorText: params.errorText,
            blockedReason: params.blockedReason,
            type: params.type,
        };
    }
    return { method: payload.method };
}

async function removeChromeProfile(profileRoot) {
    const normalized = path.resolve(profileRoot);
    const expectedPrefix = path.resolve(os.tmpdir(), "permission-core-docs-chrome-");
    if (!normalized.startsWith(expectedPrefix)) {
        throw new Error(`refusing to remove unexpected Chrome profile path: ${profileRoot}`);
    }
    await rm(profileRoot, { recursive: true, force: true });
}

class CdpWebSocket extends EventEmitter {
    constructor(url) {
        super();
        this.url = new URL(url);
        this.buffer = Buffer.alloc(0);
        this.socket = null;
        this.opened = false;
    }

    async connect() {
        await new Promise((resolve, reject) => {
            const key = randomBytes(16).toString("base64");
            this.socket = net.createConnection({
                host: this.url.hostname,
                port: Number(this.url.port),
            }, () => {
                const resource = `${this.url.pathname}${this.url.search}`;
                this.socket.write([
                    `GET ${resource} HTTP/1.1`,
                    `Host: ${this.url.host}`,
                    "Upgrade: websocket",
                    "Connection: Upgrade",
                    `Sec-WebSocket-Key: ${key}`,
                    "Sec-WebSocket-Version: 13",
                    "\r\n",
                ].join("\r\n"));
            });
            this.socket.on("error", reject);
            this.socket.on("data", (chunk) => {
                this.buffer = Buffer.concat([this.buffer, chunk]);
                if (!this.opened) {
                    const headerEnd = this.buffer.indexOf("\r\n\r\n");
                    if (headerEnd === -1) return;

                    const header = this.buffer.subarray(0, headerEnd).toString("utf8");
                    if (!header.includes("101")) {
                        reject(new Error(header));
                        return;
                    }
                    this.buffer = this.buffer.subarray(headerEnd + 4);
                    this.opened = true;
                    this.socket.removeAllListeners("error");
                    this.socket.on("error", (error) => this.emit("error", error));
                    resolve();
                }
                this.readFrames();
            });
        });
    }

    send(text) {
        const payload = Buffer.from(text, "utf8");
        const header = createClientFrameHeader(payload.length);
        const mask = randomBytes(4);
        const maskedPayload = Buffer.from(payload);
        for (let index = 0; index < maskedPayload.length; index += 1) {
            maskedPayload[index] ^= mask[index % 4];
        }
        this.socket.write(Buffer.concat([header, mask, maskedPayload]));
    }

    readFrames() {
        while (this.buffer.length >= 2) {
            const opcode = this.buffer[0] & 0x0f;
            const second = this.buffer[1];
            const masked = Boolean(second & 0x80);
            let length = second & 0x7f;
            let offset = 2;

            if (length === 126) {
                if (this.buffer.length < offset + 2) return;
                length = this.buffer.readUInt16BE(offset);
                offset += 2;
            } else if (length === 127) {
                if (this.buffer.length < offset + 8) return;
                const bigLength = this.buffer.readBigUInt64BE(offset);
                offset += 8;
                if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
                    throw new Error("CDP frame is too large");
                }
                length = Number(bigLength);
            }

            let mask;
            if (masked) {
                if (this.buffer.length < offset + 4) return;
                mask = this.buffer.subarray(offset, offset + 4);
                offset += 4;
            }

            if (this.buffer.length < offset + length) return;
            let payload = Buffer.from(this.buffer.subarray(offset, offset + length));
            this.buffer = this.buffer.subarray(offset + length);
            if (masked) {
                for (let index = 0; index < payload.length; index += 1) {
                    payload[index] ^= mask[index % 4];
                }
            }

            if (opcode === 1) {
                this.emit("message", payload.toString("utf8"));
            } else if (opcode === 8) {
                this.close();
            }
        }
    }

    close() {
        this.socket?.end();
    }
}

function createClientFrameHeader(payloadLength) {
    if (payloadLength < 126) {
        const header = Buffer.alloc(2);
        header[0] = 0x81;
        header[1] = payloadLength | 0x80;
        return header;
    }
    if (payloadLength < 65_536) {
        const header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126 | 0x80;
        header.writeUInt16BE(payloadLength, 2);
        return header;
    }

    const header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127 | 0x80;
    header.writeBigUInt64BE(BigInt(payloadLength), 2);
    return header;
}

await main();

async function findFreePort() {
    const server = net.createServer();
    server.listen(0, "localhost");
    await once(server, "listening");
    const address = server.address();
    const selectedPort = typeof address === "object" && address ? address.port : 0;
    server.close();
    await once(server, "close");
    return selectedPort;
}

async function waitForServer(origin) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`docs dev server exited early with ${child.exitCode}\n${stdout}\n${stderr}`);
        }

        try {
            const response = await fetch(`${origin}${base}`, {
                headers: { accept: "text/html" },
            });
            if (response.ok) {
                return;
            }
        } catch {
            // Keep polling until the dev server has finished compiling.
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(`timed out waiting for docs dev server\n${stdout}\n${stderr}`);
}

async function stopProcessTree(processHandle) {
    if (processHandle.exitCode !== null) {
        return;
    }

    if (process.platform === "win32") {
        try {
            execFileSync("taskkill", ["/PID", String(processHandle.pid), "/T", "/F"], {
                stdio: "ignore",
            });
        } catch (error) {
            processHandle.kill("SIGTERM");
            await waitForProcessExit(processHandle, 1_000);
            if (processHandle.exitCode === null && isWinProcessAlive(processHandle.pid)) {
                throw error;
            }
        }
    } else {
        processHandle.kill("SIGTERM");
    }

    await waitForProcessExit(processHandle, 5_000);
}

async function waitForProcessExit(processHandle, timeoutMs) {
    await Promise.race([
        once(processHandle, "exit"),
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
}

function isWinProcessAlive(pid) {
    try {
        const output = execFileSync("tasklist", [
            "/FI",
            `PID eq ${pid}`,
            "/NH",
        ], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        });
        return output.includes(String(pid));
    } catch {
        return false;
    }
}
