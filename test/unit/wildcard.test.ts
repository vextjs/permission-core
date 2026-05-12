import { describe, expect, it } from "vitest";

import { matchResource } from "../../src/match";

describe("matchResource", () => {
    it("matches exact HTTP resources", () => {
        expect(matchResource("GET:/api/users", "GET:/api/users")).toBe(true);
    });

    it("matches trailing HTTP wildcards with at least one extra segment", () => {
        expect(matchResource("*:/api/users/*", "GET:/api/users/123")).toBe(true);
        expect(matchResource("*:/api/users/*", "GET:/api/users")).toBe(false);
    });

    it("matches parameterized HTTP paths", () => {
        expect(matchResource("DELETE:/api/users/:id", "DELETE:/api/users/42")).toBe(true);
    });

    it("matches field-level DB wildcards", () => {
        expect(matchResource("db:users:*", "db:users:email")).toBe(true);
        expect(matchResource("db:users:*", "db:orders:email")).toBe(false);
    });

    it("supports global wildcard resources", () => {
        expect(matchResource("*", "db:orders:status")).toBe(true);
        expect(matchResource("*", "POST:/api/orders")).toBe(true);
    });
});