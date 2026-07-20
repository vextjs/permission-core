(() => {
    const recoveryKey = "permission-core:chunk-reload-at";
    const retryWindowMs = 15_000;
    const chunkErrorPatterns = [
        /ChunkLoadError/i,
        /Loading chunk .+ failed/i,
        /Failed to fetch dynamically imported module/i,
        /Importing a module script failed/i,
    ];

    function errorMessage(value) {
        if (value instanceof Error) {
            return `${value.name}: ${value.message}`;
        }
        if (typeof value === "string") {
            return value;
        }
        if (value && typeof value === "object") {
            const nested = value.reason ?? value.error ?? value.message;
            if (nested && nested !== value) {
                return errorMessage(nested);
            }
        }
        return "";
    }

    function isAsyncScriptFailure(value) {
        const target = value && typeof value === "object" ? value.target : null;
        const source = target && typeof target.src === "string" ? target.src : "";
        return /\/static\/js\/async\/.+\.js(?:[?#]|$)/i.test(source);
    }

    function recoverFromChunkFailure(value) {
        const message = errorMessage(value);
        if (!chunkErrorPatterns.some((pattern) => pattern.test(message)) && !isAsyncScriptFailure(value)) {
            return;
        }

        const now = Date.now();
        let previousReload = 0;
        try {
            previousReload = Number(window.sessionStorage.getItem(recoveryKey) ?? 0);
            if (now - previousReload < retryWindowMs) {
                return;
            }
            window.sessionStorage.setItem(recoveryKey, String(now));
        } catch {
            return;
        }

        window.location.reload();
    }

    window.addEventListener("error", recoverFromChunkFailure, true);
    window.addEventListener("unhandledrejection", recoverFromChunkFailure);
})();
