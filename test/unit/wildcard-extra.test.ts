import { describe, expect, it } from "vitest";

import { matchAction, matchResource } from "../../src/check/wildcard";

describe("wildcard matching additional paths", () => {
    it("rejects invalid HTTP patterns and non-greedy middle wildcards", () => {
        expect(matchResource("*", "GET:/api/orders")).toBe(true);
        expect(matchResource("GET", "GET:/api/orders")).toBe(false);
        expect(matchResource("GET:*", "GET:/api/orders")).toBe(true);
        expect(matchResource("GET:/orders", "GET:*")).toBe(false);
        expect(matchResource("GET:/api/*/items", "GET:/api/v1/items")).toBe(false);
        expect(matchResource("GET:/api/*", "GET:/api")).toBe(false);
        expect(matchResource("GET:/api/:id", "GET:/api")).toBe(false);
        expect(matchResource("POST:/api/orders", "GET:/api/orders")).toBe(false);
        expect(matchResource("GET:/api/*", "GET:/api/\ud800")).toBe(false);
    });

    it("supports parameterized HTTP paths and db wildcards", () => {
        expect(matchResource("GET:/api/:id", "GET:/api/42")).toBe(true);
        expect(matchResource("db:*", "db:orders")).toBe(true);
        expect(matchResource("db:orders", "db:orders")).toBe(true);
        expect(matchResource("db:orders:field:*", "db:orders:field:status")).toBe(true);
        expect(matchResource("db:orders", "db:users")).toBe(false);
        expect(matchResource("db:orders", "db:orders:field:status:extra")).toBe(false);
        expect(matchResource("db:orders", "db:orders:field:status")).toBe(false);
        expect(matchResource("db:orders:field:status", "db:orders")).toBe(false);
        expect(matchResource("db:orders:status", "db:orders:field:status")).toBe(false);
        expect(matchResource("db:orders", "GET:/api/orders")).toBe(false);
    });

    it("covers remaining action matching branches", () => {
        expect(matchAction("*", "delete")).toBe(true);
        expect(matchAction("write", "delete")).toBe(false);
        expect(matchAction("invoke", "invoke")).toBe(true);
        expect(matchAction("invoke", "read")).toBe(false);
    });
});
