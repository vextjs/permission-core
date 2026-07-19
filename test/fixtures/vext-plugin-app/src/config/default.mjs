const fixturePort = Number(process.env.VEXT_FIXTURE_PORT ?? "3000");
if (!Number.isSafeInteger(fixturePort) || fixturePort < 1 || fixturePort > 65_535) {
    throw new TypeError("VEXT_FIXTURE_PORT must be an integer in 1..65535");
}

export default {
    host: "127.0.0.1",
    port: fixturePort,
    adapter: "native",
    middlewares: ["marker"],
    logger: {
        level: "error",
        pretty: false,
    },
    openapi: {
        enabled: false,
    },
};
