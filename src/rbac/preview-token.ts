import type { PolicyValue } from "../types";
import { PermissionCoreError } from "../core/errors";
import { canonicalString } from "../internal/canonical";
import type { SignedTokenCodec } from "../internal/signed-token";
import type { NormalizedPreviewExecutionOptions } from "./preview-inputs";

export const PREVIEW_TTL_MS = 5 * 60 * 1000;
export const PREVIEW_TOKEN_MAX_BYTES = 16 * 1024;

export interface PreviewTokenEnvelope {
    readonly inputHash: string;
    readonly planHash: string;
    readonly capacityDigest: string;
    readonly expectedRevisions: Readonly<Record<string, PolicyValue>>;
}

function previewStale(owner: string, expected: unknown, current: unknown): never {
    throw new PermissionCoreError("PREVIEW_STALE", "The preview no longer matches this execution.", {
        details: {
            kind: "preview-stale",
            owner,
            expected: typeof expected === "string" || typeof expected === "number" ? expected : canonicalString(expected),
            current: typeof current === "string" || typeof current === "number" ? current : canonicalString(current),
        },
    });
}

function revisionConflict(owner: string, expected: unknown, current: unknown): never {
    throw new PermissionCoreError("REVISION_CONFLICT", `${owner} changed after preview.`, {
        details: {
            kind: "revision-conflict",
            owner,
            expected: canonicalString(expected),
            current: canonicalString(current),
        },
    });
}

function exactPreviewPayload(record: Readonly<Record<string, PolicyValue>>) {
    const allowed = new Set([
        "version", "purpose", "coreNamespaceHash", "method", "actorId", "scopeKey",
        "inputHash", "planHash", "capacityDigest", "expectedRevisions", "issuedAt", "expiresAt",
    ]);
    if (Object.keys(record).length !== allowed.size || Object.keys(record).some((key) => !allowed.has(key))) {
        previewStale("preview-token-shape", "exact-v2-shape", "invalid-shape");
    }
    if (
        typeof record.method !== "string"
        || typeof record.actorId !== "string"
        || typeof record.scopeKey !== "string"
        || typeof record.inputHash !== "string"
        || typeof record.planHash !== "string"
        || typeof record.capacityDigest !== "string"
        || record.expectedRevisions === null
        || typeof record.expectedRevisions !== "object"
        || Array.isArray(record.expectedRevisions)
        || !Number.isSafeInteger(record.issuedAt)
        || !Number.isSafeInteger(record.expiresAt)
        || (record.issuedAt as number) < 0
        || (record.expiresAt as number) <= (record.issuedAt as number)
    ) {
        previewStale("preview-token-fields", "valid-fields", "invalid-fields");
    }
    return record as typeof record & {
        method: string;
        actorId: string;
        scopeKey: string;
        inputHash: string;
        planHash: string;
        capacityDigest: string;
        expectedRevisions: Readonly<Record<string, PolicyValue>>;
        issuedAt: number;
        expiresAt: number;
    };
}

export function issuePreviewToken(input: {
    readonly tokens: SignedTokenCodec;
    readonly method: string;
    readonly actorId: string;
    readonly scopeKey: string;
    readonly envelope: PreviewTokenEnvelope;
    readonly issuedAt: number;
}) {
    return input.tokens.encode("pc:v2:preview", {
        method: input.method,
        actorId: input.actorId,
        scopeKey: input.scopeKey,
        inputHash: input.envelope.inputHash,
        planHash: input.envelope.planHash,
        capacityDigest: input.envelope.capacityDigest,
        expectedRevisions: input.envelope.expectedRevisions,
        issuedAt: input.issuedAt,
        expiresAt: input.issuedAt + PREVIEW_TTL_MS,
    });
}

export function validatePreviewExecution(input: {
    readonly tokens: SignedTokenCodec;
    readonly method: string;
    readonly scopeKey: string;
    readonly envelope: PreviewTokenEnvelope;
    readonly options: NormalizedPreviewExecutionOptions;
    readonly now: number;
    readonly capacityDisposition: "safe" | "ack-required" | "blocked";
}) {
    const payload = exactPreviewPayload(input.tokens.decode(
        input.options.previewToken,
        "pc:v2:preview",
        "PREVIEW_STALE",
        PREVIEW_TOKEN_MAX_BYTES,
    ));
    if (
        payload.expiresAt - payload.issuedAt !== PREVIEW_TTL_MS
        || payload.expiresAt <= input.now
        || payload.issuedAt > input.now
    ) {
        previewStale("preview-expiry", payload.expiresAt, input.now);
    }
    if (payload.method !== input.method) previewStale("preview-method", payload.method, input.method);
    if (payload.actorId !== input.options.actorId) previewStale("preview-actor", payload.actorId, input.options.actorId);
    if (payload.scopeKey !== input.scopeKey) previewStale("preview-scope", payload.scopeKey, input.scopeKey);
    if (payload.inputHash !== input.envelope.inputHash) {
        previewStale("preview-input", payload.inputHash, input.envelope.inputHash);
    }
    if (canonicalString(payload.expectedRevisions) !== canonicalString(input.options.expectedRevisions)) {
        previewStale("preview-expected-vector", payload.expectedRevisions, input.options.expectedRevisions);
    }
    if (canonicalString(input.options.expectedRevisions) !== canonicalString(input.envelope.expectedRevisions)) {
        revisionConflict("authorization-revision-vector", input.options.expectedRevisions, input.envelope.expectedRevisions);
    }
    if (payload.planHash !== input.envelope.planHash) {
        previewStale("preview-plan", payload.planHash, input.envelope.planHash);
    }
    if (payload.capacityDigest !== input.envelope.capacityDigest) {
        previewStale("preview-capacity", payload.capacityDigest, input.envelope.capacityDigest);
    }
    if (input.capacityDisposition === "blocked") {
        previewStale("preview-executable", "executable", "blocked");
    }
    if (input.capacityDisposition === "ack-required" && input.options.acknowledgeCapacityRisk !== true) {
        throw new PermissionCoreError("INVALID_ARGUMENT", "Capacity risk acknowledgement is required.", {
            details: { kind: "capacity-risk-ack-required", assessmentDigest: input.envelope.capacityDigest },
        });
    }
    if (input.capacityDisposition !== "ack-required" && input.options.acknowledgeCapacityRisk === true) {
        throw new PermissionCoreError("INVALID_ARGUMENT", "Capacity risk acknowledgement is not valid for this preview.", {
            details: {
                kind: "validation",
                field: "acknowledgeCapacityRisk",
                reason: `preview ${input.envelope.capacityDigest} does not require acknowledgement`,
            },
        });
    }
}
