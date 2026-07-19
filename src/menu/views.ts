import type {
    ApiBinding,
    BatchMutationSummary,
    MenuNode,
} from "../types";
import type { ResourceSchemeRegistry } from "../check/resource-schemes";
import { canonicalString, compareUtf8 } from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import { assertNonNegativeSafeInteger, assertPositiveSafeInteger } from "../rbac/validation";
import {
    denseMenuArray,
    exactMenuRecord,
    normalizeApiBindingCreateInput,
    normalizeMenuNodeCreateInput,
} from "./validation";

function replayInvalid(reason: string): never {
    throw new TypeError(`Menu mutation replay is invalid: ${reason}`);
}

export function decodeMenuNodeReplay(value: unknown, schemes: ResourceSchemeRegistry): MenuNode {
    const record = exactMenuRecord(value, [
        "id", "parentId", "type", "title", "path", "name", "code", "component", "url", "icon",
        "order", "status", "hidden", "i18nKey", "meta", "permission", "dataPermissions",
        "revision", "createdAt", "updatedAt",
    ], "replay.menu");
    const order = assertNonNegativeSafeInteger(record.order, "replay.menu.order");
    const revision = assertPositiveSafeInteger(record.revision, "replay.menu.revision");
    const createdAt = assertNonNegativeSafeInteger(record.createdAt, "replay.menu.createdAt");
    const updatedAt = assertNonNegativeSafeInteger(record.updatedAt, "replay.menu.updatedAt");
    if (updatedAt < createdAt) replayInvalid("menu updatedAt precedes createdAt");
    const create = normalizeMenuNodeCreateInput(
        Object.fromEntries(Object.entries(record).filter(([key]) =>
            !["order", "revision", "createdAt", "updatedAt"].includes(key))) as never,
        schemes,
    );
    const result = deepFreeze({ ...create, order, revision, createdAt, updatedAt });
    if (canonicalString(record) !== canonicalString(result)) replayInvalid("menu fields are not canonical");
    return result;
}

export function decodeApiBindingReplay(value: unknown, schemes: ResourceSchemeRegistry): ApiBinding {
    const record = exactMenuRecord(value, [
        "id", "method", "path", "purpose", "authorization", "owners", "canonicalOwner",
        "status", "description", "revision", "createdAt", "updatedAt",
    ], "replay.apiBinding");
    const revision = assertPositiveSafeInteger(record.revision, "replay.apiBinding.revision");
    const createdAt = assertNonNegativeSafeInteger(record.createdAt, "replay.apiBinding.createdAt");
    const updatedAt = assertNonNegativeSafeInteger(record.updatedAt, "replay.apiBinding.updatedAt");
    if (updatedAt < createdAt) replayInvalid("API binding updatedAt precedes createdAt");
    const create = normalizeApiBindingCreateInput(
        Object.fromEntries(Object.entries(record).filter(([key]) =>
            !["revision", "createdAt", "updatedAt"].includes(key))) as never,
        schemes,
    );
    const result = deepFreeze({ ...create, revision, createdAt, updatedAt });
    if (canonicalString(record) !== canonicalString(result)) replayInvalid("API binding fields are not canonical");
    return result;
}

export function decodeBatchMutationSummaryReplay(value: unknown): BatchMutationSummary {
    const record = exactMenuRecord(value, ["inserted", "updated", "unchanged", "deleted", "conflicted", "samples"], "replay.summary");
    const counts = ["inserted", "updated", "unchanged", "deleted", "conflicted"] as const;
    for (const key of counts) {
        assertNonNegativeSafeInteger(record[key], `replay.summary.${key}`);
    }
    const samples = exactMenuRecord(record.samples, ["total", "items", "truncated", "digest"], "replay.summary.samples");
    const total = assertNonNegativeSafeInteger(samples.total, "replay.summary.samples.total");
    if (typeof samples.truncated !== "boolean" || typeof samples.digest !== "string") {
        replayInvalid("summary sample metadata is malformed");
    }
    const items = denseMenuArray(samples.items, "replay.summary.samples.items", 100).map((value, index) => {
        const item = exactMenuRecord(value, ["id", "outcome", "conflict"], `replay.summary.samples.items[${index}]`);
        if (
            typeof item.id !== "string"
            || !["inserted", "updated", "unchanged", "deleted", "conflicted"].includes(item.outcome as string)
        ) {
            return replayInvalid("summary sample item is malformed");
        }
        if (item.outcome !== "conflicted" && Object.hasOwn(item, "conflict")) {
            replayInvalid("only conflicted samples can include conflict details");
        }
        let conflict: { code: string; message: string; currentRevision?: number } | undefined;
        if (Object.hasOwn(item, "conflict")) {
            const raw = exactMenuRecord(item.conflict, ["code", "message", "currentRevision"], `replay.summary.samples.items[${index}].conflict`);
            if (typeof raw.code !== "string" || typeof raw.message !== "string") replayInvalid("summary conflict is malformed");
            conflict = {
                code: raw.code,
                message: raw.message,
                ...(Object.hasOwn(raw, "currentRevision")
                    ? { currentRevision: assertNonNegativeSafeInteger(raw.currentRevision, "replay.summary.conflict.currentRevision") }
                    : {}),
            };
        }
        return deepFreeze({
            id: item.id,
            outcome: item.outcome as "inserted" | "updated" | "unchanged" | "deleted" | "conflicted",
            ...(conflict === undefined ? {} : { conflict }),
        });
    });
    const sorted = [...items].sort((left, right) => compareUtf8(left.outcome, right.outcome) || compareUtf8(left.id, right.id));
    if (canonicalString(items) !== canonicalString(sorted)) replayInvalid("summary samples are not stably ordered");
    if (total < items.length || samples.truncated !== (total > items.length)) {
        replayInvalid("summary sample count and truncation disagree");
    }
    return deepFreeze({
        inserted: record.inserted as number,
        updated: record.updated as number,
        unchanged: record.unchanged as number,
        deleted: record.deleted as number,
        conflicted: record.conflicted as number,
        samples: { total, items, truncated: samples.truncated, digest: samples.digest },
    });
}
