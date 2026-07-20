import { describe, expect, it } from "vitest";
import type { ApiAuthorization, ApiOwnerRelation } from "../../src/types/menu";
import {
    evaluateApiAuthorization,
    evaluateApiBindingAvailability,
    evaluateOwnerApiAvailability,
    type ApiBindingAvailabilityDecision,
} from "../../src/menu";

const FIRST = "api:GET:/capability/first";
const SECOND = "api:GET:/capability/second";

function authorization(mode: "all" | "any"): ApiAuthorization {
    return {
        mode,
        permissions: [
            { action: "invoke", resource: FIRST },
            { action: "invoke", resource: SECOND },
        ],
    };
}

function ownerRelation(
    id: string,
    required: boolean,
    mode?: "all" | "any",
): ApiOwnerRelation {
    return {
        type: "page",
        id,
        required,
        ...(mode === undefined ? {} : { availabilityGroup: "routes", availabilityMode: mode }),
    };
}

function bindingDecision(
    id: string,
    allowed: boolean,
    relation: ApiOwnerRelation,
): ApiBindingAvailabilityDecision {
    return { binding: { id, owners: [relation] }, allowed };
}

describe("API authorization and owner availability", () => {
    it.each([
        ["all", true, true, true],
        ["all", true, false, false],
        ["all", false, false, false],
        ["any", true, true, true],
        ["any", true, false, true],
        ["any", false, false, false],
    ] as const)("evaluates route mode %s over %s/%s", async (mode, first, second, expected) => {
        const visited: string[] = [];
        const result = await evaluateApiAuthorization(authorization(mode), async (permission) => {
            visited.push(permission.resource);
            return permission.resource === FIRST ? first : second;
        });
        expect(result).toBe(expected);
        expect(visited).toEqual([FIRST, SECOND]);
    });

    it("does not short-circuit a context failure behind an allowed any branch", async () => {
        const visited: string[] = [];
        const failure = new Error("missing policy context");
        await expect(evaluateApiAuthorization(authorization("any"), async (permission) => {
            visited.push(permission.resource);
            if (permission.resource === SECOND) throw failure;
            return true;
        })).rejects.toBe(failure);
        expect(visited).toEqual([FIRST, SECOND]);
    });

    it("treats disabled and deprecated bindings as unavailable without checking permissions", async () => {
        let checks = 0;
        const check = async () => {
            checks += 1;
            return true;
        };
        await expect(evaluateApiBindingAvailability({ status: "disabled", authorization: authorization("all") }, check))
            .resolves.toBe(false);
        await expect(evaluateApiBindingAvailability({ status: "deprecated", authorization: authorization("any") }, check))
            .resolves.toBe(false);
        expect(checks).toBe(0);
    });

    it.each([
        ["all", true, true, true],
        ["all", true, false, false],
        ["any", true, false, true],
        ["any", false, false, false],
    ] as const)("evaluates owner group mode %s over %s/%s", (mode, first, second, expected) => {
        const owner = { type: "page" as const, id: "orders" };
        const result = evaluateOwnerApiAvailability(owner, [
            bindingDecision("first", first, ownerRelation(owner.id, true, mode)),
            bindingDecision("second", second, ownerRelation(owner.id, true, mode)),
        ]);
        expect(result.enabled).toBe(expected);
        expect(result.risks.map((risk) => risk.bindingId)).toEqual(["first", "second"]);
    });

    it("combines ungrouped requirements with groups while optional failures stay diagnostic", () => {
        const owner = { type: "page" as const, id: "orders" };
        const available = evaluateOwnerApiAvailability(owner, [
            bindingDecision("ungrouped", true, ownerRelation(owner.id, true)),
            bindingDecision("group-allowed", true, ownerRelation(owner.id, true, "any")),
            bindingDecision("group-denied", false, ownerRelation(owner.id, true, "any")),
            bindingDecision("optional", false, ownerRelation(owner.id, false)),
        ]);
        expect(available).toEqual({
            enabled: true,
            risks: [
                { bindingId: "group-allowed", required: true, allowed: true },
                { bindingId: "group-denied", required: true, allowed: false },
                { bindingId: "optional", required: false, allowed: false },
                { bindingId: "ungrouped", required: true, allowed: true },
            ],
        });
        const unavailable = evaluateOwnerApiAvailability(owner, [
            bindingDecision("ungrouped", false, ownerRelation(owner.id, true)),
            bindingDecision("group-allowed", true, ownerRelation(owner.id, true, "any")),
        ]);
        expect(unavailable.enabled).toBe(false);
    });

    it("keeps route any/all independent from cross-route owner any/all", async () => {
        const results = new Map([[FIRST, true], [SECOND, false]]);
        const check = async (permission: ApiAuthorization["permissions"][number]) => results.get(permission.resource)!;
        const looseRoute = await evaluateApiAuthorization(authorization("any"), check);
        const strictRoute = await evaluateApiAuthorization(authorization("all"), check);
        const anyOwner = { type: "page" as const, id: "owner-any" };
        const allOwner = { type: "page" as const, id: "owner-all" };
        expect(evaluateOwnerApiAvailability(anyOwner, [
            bindingDecision("loose", looseRoute, ownerRelation(anyOwner.id, true, "any")),
            bindingDecision("strict", strictRoute, ownerRelation(anyOwner.id, true, "any")),
        ]).enabled).toBe(true);
        expect(evaluateOwnerApiAvailability(allOwner, [
            bindingDecision("loose", looseRoute, ownerRelation(allOwner.id, true, "all")),
            bindingDecision("strict", strictRoute, ownerRelation(allOwner.id, true, "all")),
        ]).enabled).toBe(false);
    });

    it("fails closed for mixed group modes and duplicate binding decisions", () => {
        const owner = { type: "page" as const, id: "orders" };
        let mixedError: unknown;
        try {
            evaluateOwnerApiAvailability(owner, [
                bindingDecision("first", true, ownerRelation(owner.id, true, "any")),
                bindingDecision("second", true, ownerRelation(owner.id, true, "all")),
            ]);
        } catch (error) {
            mixedError = error;
        }
        expect(mixedError).toMatchObject({ code: "PERSISTED_STATE_INVALID" });

        const duplicate = bindingDecision("same", true, ownerRelation(owner.id, true));
        let duplicateError: unknown;
        try {
            evaluateOwnerApiAvailability(owner, [duplicate, duplicate]);
        } catch (error) {
            duplicateError = error;
        }
        expect(duplicateError).toMatchObject({ code: "PERSISTED_STATE_INVALID" });
    });
});
