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
        expect(matchResource("db:users:field:*", "db:users:field:email")).toBe(true);
        expect(matchResource("db:users:field:*", "db:orders:field:email")).toBe(false);
    });

    it("supports global wildcard resources", () => {
        expect(matchResource("*", "db:orders:field:status")).toBe(true);
        expect(matchResource("*", "POST:/api/orders")).toBe(true);
    });

    it("matches API and UI resources within their own schemes", () => {
        expect(matchResource("api:*:/api/users", "api:GET:/api/users")).toBe(true);
        expect(matchResource("api:GET:/api/users/:id", "api:GET:/api/users/42")).toBe(true);
        expect(matchResource("ui:menu:*", "ui:menu:system.user")).toBe(true);
        expect(matchResource("ui:*", "ui:button:system.user.create")).toBe(true);
    });

    it("does not match resources across schemes", () => {
        expect(matchResource("api:*:/api/users", "GET:/api/users")).toBe(false);
        expect(matchResource("ui:*", "api:GET:/api/users")).toBe(false);
        expect(matchResource("db:*", "ui:menu:orders")).toBe(false);
        expect(matchResource("db:users:*", "db:users:field:email")).toBe(false);
    });
});
