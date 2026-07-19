import { defineMiddleware } from "vextjs";

const METRICS = Symbol.for("permission-core.vext.integration.metrics");

function metrics() {
    globalThis[METRICS] ??= { middleware: 0, handler: 0 };
    return globalThis[METRICS];
}

export default defineMiddleware(async (_req, _res, next) => {
    metrics().middleware += 1;
    await next();
});
