import { describe, expect, it, vi } from "vitest";
import { ResourceSchemeRegistry } from "../../src/check/resource-schemes";
import { RbacPreviewService } from "../../src/rbac/preview";
import type { PermissionRepository } from "../../src/persistence/repository";
import type { SignedTokenCodec } from "../../src/internal/signed-token";
import type { RoleMutationService } from "../../src/rbac/role-mutations";
import type { RuleMutationService } from "../../src/rbac/rule-mutations";

const scope = { tenantId: "preview-routing" };

function previewService() {
    let affectedTotal = 0;
    let disposition: "safe" | "ack-required" | "blocked" = "safe";
    const executePreflight = async (...args: unknown[]) => {
        const preflight = args[4] as (context: unknown) => Promise<void>;
        await preflight({ transaction: { session: undefined }, reader: {}, now: 1 });
        return { committed: true };
    };
    const ruleMutations = {
        allow: vi.fn(executePreflight),
        deny: vi.fn(executePreflight),
        revoke: vi.fn(executePreflight),
    } as unknown as RuleMutationService;
    const service = new RbacPreviewService(
        {} as PermissionRepository,
        new ResourceSchemeRegistry(),
        {} as SignedTokenCodec,
        {} as RoleMutationService,
        ruleMutations,
    );
    (service as unknown as { prepareRuleChange: (...args: unknown[]) => Promise<unknown> }).prepareRuleChange = vi.fn(async () => ({
        plan: {
            affectedUsers: {
                total: affectedTotal,
                sampleIds: [],
                truncated: affectedTotal > 0,
                digest: "affected-digest",
            },
        },
        capacity: { disposition },
    }));
    return {
        service,
        setAssessment(total: number, nextDisposition: typeof disposition = "safe") {
            affectedTotal = total;
            disposition = nextDisposition;
        },
    };
}

describe("direct manual rule preview routing", () => {
    it.each([0, 1_000])("executes a safe allow directly for %i affected users", async (total) => {
        const fixture = previewService();
        fixture.setAssessment(total);
        await expect(fixture.service.allow(scope, "reader", {
            action: "read",
            resource: "db:orders",
        })).resolves.toMatchObject({ committed: true });
    });

    it("requires preview for 1001 affected users or an unsafe deny assessment", async () => {
        const fixture = previewService();
        fixture.setAssessment(1_001);
        await expect(fixture.service.allow(scope, "reader", {
            action: "read",
            resource: "db:orders",
        })).rejects.toMatchObject({
            code: "PREVIEW_REQUIRED",
            details: expect.objectContaining({ reason: "capacity-risk", affectedTotal: 1_001 }),
        });

        fixture.setAssessment(1_000, "ack-required");
        await expect(fixture.service.deny(scope, "reader", {
            action: "read",
            resource: "db:orders",
        })).rejects.toMatchObject({
            code: "PREVIEW_REQUIRED",
            details: expect.objectContaining({ reason: "capacity-risk", affectedTotal: 1_000 }),
        });
    });

    it("keeps allow removal direct but escalates high-impact deny removal", async () => {
        const fixture = previewService();
        fixture.setAssessment(1_001);
        await expect(fixture.service.revoke(scope, "reader", {
            effect: "allow",
            action: "read",
            resource: "db:orders",
        })).resolves.toMatchObject({ committed: true });
        await expect(fixture.service.revoke(scope, "reader", {
            effect: "deny",
            action: "read",
            resource: "db:orders",
        })).rejects.toMatchObject({
            code: "PREVIEW_REQUIRED",
            details: expect.objectContaining({ reason: "high-impact-deny-removal", affectedTotal: 1_001 }),
        });
    });
});
