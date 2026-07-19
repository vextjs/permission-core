import { types as utilTypes } from "node:util";
import type {
    ApiAuthorization,
    ApiBindingCreateInput,
    ApiBindingFilter,
    ApiBindingImpactUpdateRequest,
    ApiBindingRemoveInput,
    ApiBindingReplaceInput,
    ApiBindingUpdateInput,
    ApiOwnerRelation,
    EntityStatus,
    MenuDataPermissionTemplate,
    MenuGrantIntent,
    MenuGrantSnapshotRef,
    MenuPermissionAssignment,
    MenuPermissionChange,
    MenuPermissionSelection,
    MenuManifestInput,
    MenuMoveInput,
    MenuNodeCreateInput,
    MenuNodeFilter,
    MenuNodeImpactUpdateRequest,
    MenuNodeType,
    MenuNodeUpdateInput,
    MenuRemoveInput,
    MenuReorderInput,
    SourceRewriteDecision,
    StaleRepairInput,
} from "../types";
import { ResourceSchemeRegistry } from "../check/resource-schemes";
import { PermissionCoreError, validationError } from "../core/errors";
import { canonicalByteLength, compareUtf8, digestCanonical } from "../internal/canonical";
import { clonePolicyRecord, deepFreeze } from "../internal/plain-data";
import { isWellFormedUnicode } from "../internal/unicode";
import { normalizePermissionAction } from "../policy/action";
import { normalizeRowCondition } from "../policy/condition";
import { normalizeDescription, normalizeRbacId, normalizeRoleLabel } from "../rbac/validation";
import { assertManagementInputBudget } from "../rbac/preview-inputs";

const MENU_TYPES = new Set<MenuNodeType>(["directory", "menu", "page", "button", "external", "iframe"]);
const ENTITY_STATUSES = new Set<EntityStatus>(["enabled", "disabled", "deprecated"]);
const API_PURPOSES = new Set(["entry", "lookup", "detail", "operation", "importExport", "background"] as const);
const DATA_ACTIONS = new Set(["read", "create", "update", "delete", "write", "*"] as const);
const BUTTON_CODE = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/u;
const HTTP_METHOD = /^[A-Z][A-Z0-9-]{0,31}$/u;
const DATA_RESOURCE = /^db:[A-Za-z][A-Za-z0-9._-]{0,127}(?::field:[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)?$/u;
const MAX_META_BYTES = 32 * 1024;
const MAX_WHERE_BYTES = 64 * 1024;
const MAX_MENU_SELECTION_ITEMS = 1_000;
const MAX_MENU_INVENTORY_ITEMS = 10_000;
const MAX_API_INVENTORY_ITEMS = 20_000;
const DIGEST = /^[A-Za-z0-9_-]{43}$/u;

export function exactMenuRecord(value: unknown, allowed: readonly string[], field: string) {
    if (value === null || typeof value !== "object" || Array.isArray(value) || utilTypes.isProxy(value)) {
        throw validationError("INVALID_ARGUMENT", field, "must be a plain object");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        throw validationError("INVALID_ARGUMENT", field, "must be a plain object");
    }
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || !allowed.includes(key)) {
            throw validationError("INVALID_ARGUMENT", field, `contains unsupported key ${String(key)}`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor) || descriptor.value === undefined) {
            throw validationError("INVALID_ARGUMENT", `${field}.${key}`, "must be an enumerable defined data property");
        }
        result[key] = descriptor.value;
    }
    return result;
}

export function denseMenuArray(value: unknown, field: string, maximum: number) {
    if (!Array.isArray(value) || utilTypes.isProxy(value)) {
        throw validationError("INVALID_ARGUMENT", field, "must be a dense array");
    }
    const length = (Object.getOwnPropertyDescriptor(value, "length") as PropertyDescriptor | undefined)?.value;
    if (!Number.isSafeInteger(length) || length < 0) {
        throw validationError("INVALID_ARGUMENT", field, "must be a dense array");
    }
    if (length > maximum) {
        throw new PermissionCoreError("LIMIT_EXCEEDED", `${field} exceeds its item limit.`, {
            details: {
                kind: "limit-exceeded",
                origin: "caller-input",
                limitName: `${field}-items`,
                current: length,
                max: maximum,
                unit: "items",
            },
        });
    }
    const result = new Array<unknown>(length);
    let count = 0;
    for (const key of Reflect.ownKeys(value)) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length) {
            throw validationError("INVALID_ARGUMENT", field, "cannot contain non-index properties");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor) || descriptor.value === undefined) {
            throw validationError("INVALID_ARGUMENT", `${field}[${key}]`, "must be an enumerable defined data property");
        }
        result[Number(key)] = descriptor.value;
        count += 1;
    }
    if (count !== length) {
        throw validationError("INVALID_ARGUMENT", field, "cannot be sparse");
    }
    return result;
}

function normalizedIdArray(value: unknown, field: string, maximum = MAX_MENU_SELECTION_ITEMS) {
    const values = denseMenuArray(value, field, maximum).map((entry, index) => normalizeRbacId(entry, `${field}[${index}]`));
    return Object.freeze([...new Set(values)].sort(compareUtf8));
}

function normalizedSemanticKeyArray(value: unknown, field: string) {
    const values = denseMenuArray(value, field, MAX_MENU_SELECTION_ITEMS).map((entry, index) => {
        if (typeof entry !== "string" || !DIGEST.test(entry)) {
            throw validationError("INVALID_ARGUMENT", `${field}[${index}]`, "must be a semantic key digest");
        }
        return entry;
    });
    return Object.freeze([...new Set(values)].sort(compareUtf8));
}

export function normalizeSourceRewriteDecision(value?: SourceRewriteDecision): SourceRewriteDecision {
    const input = exactMenuRecord(value ?? { mode: "reject" }, ["mode", "resolutions"], "sourceRewrite");
    if (input.mode === "reject") {
        if (Object.hasOwn(input, "resolutions")) {
            throw validationError("INVALID_ARGUMENT", "sourceRewrite.resolutions", "is not allowed in reject mode");
        }
        return deepFreeze({ mode: "reject" as const });
    }
    if (input.mode !== "apply" || !Object.hasOwn(input, "resolutions")) {
        throw validationError("INVALID_ARGUMENT", "sourceRewrite", "apply mode requires resolutions");
    }
    const rawResolutions = clonePolicyRecord(input.resolutions, "INVALID_ARGUMENT", "sourceRewrite.resolutions");
    const entries = Object.entries(rawResolutions);
    if (entries.length > MAX_MENU_SELECTION_ITEMS) {
        throw new PermissionCoreError("LIMIT_EXCEEDED", "sourceRewrite.resolutions exceeds its item limit.", {
            details: {
                kind: "limit-exceeded",
                origin: "caller-input",
                limitName: "source-rewrite-resolutions",
                current: entries.length,
                max: MAX_MENU_SELECTION_ITEMS,
                unit: "items",
            },
        });
    }
    const resolutions: Record<string, { action: "replace"; replacementSemanticKey: string } | { action: "revoke" }> = {};
    for (const [rawSourceId, rawResolution] of entries.sort(([left], [right]) => compareUtf8(left, right))) {
        const sourceId = normalizeRbacId(rawSourceId, "sourceRewrite.resolutions key");
        if (sourceId !== rawSourceId) {
            throw validationError("INVALID_ARGUMENT", "sourceRewrite.resolutions", "contains a non-canonical source ID key");
        }
        const resolution = exactMenuRecord(
            rawResolution,
            ["action", "replacementSemanticKey"],
            `sourceRewrite.resolutions.${sourceId}`,
        );
        if (resolution.action === "revoke") {
            if (Object.hasOwn(resolution, "replacementSemanticKey")) {
                throw validationError("INVALID_ARGUMENT", `sourceRewrite.resolutions.${sourceId}`, "revoke cannot define a replacement");
            }
            resolutions[sourceId] = { action: "revoke" };
            continue;
        }
        if (
            resolution.action !== "replace"
            || typeof resolution.replacementSemanticKey !== "string"
            || !DIGEST.test(resolution.replacementSemanticKey)
        ) {
            throw validationError("INVALID_ARGUMENT", `sourceRewrite.resolutions.${sourceId}`, "replace requires a semantic key digest");
        }
        resolutions[sourceId] = {
            action: "replace",
            replacementSemanticKey: resolution.replacementSemanticKey,
        };
    }
    return deepFreeze({ mode: "apply" as const, resolutions });
}

function normalizeMenuPermissionInclude(value: unknown, field: string): MenuGrantIntent["include"] {
    const input = exactMenuRecord(value, ["descendants", "buttons", "apis", "dataPermissions"], field);
    if (Object.keys(input).length !== 4) {
        throw validationError("INVALID_ARGUMENT", field, "requires descendants, buttons, apis, and dataPermissions");
    }
    if (input.apis !== "none" && input.apis !== "required" && input.apis !== "all") {
        throw validationError("INVALID_ARGUMENT", `${field}.apis`, "must be none, required, or all");
    }
    return deepFreeze({
        descendants: boolean(input.descendants, `${field}.descendants`),
        buttons: boolean(input.buttons, `${field}.buttons`),
        apis: input.apis,
        dataPermissions: boolean(input.dataPermissions, `${field}.dataPermissions`),
    });
}

function normalizeMenuApiChoices(value: unknown, field: string): MenuGrantIntent["apiChoices"] {
    const input = exactMenuRecord(value, ["bindingIds", "permissionsByBinding"], field);
    if (Object.keys(input).length !== 2) {
        throw validationError("INVALID_ARGUMENT", field, "requires bindingIds and permissionsByBinding");
    }
    const bindingIds = normalizedIdArray(input.bindingIds, `${field}.bindingIds`);
    const sourceMap = clonePolicyRecord(input.permissionsByBinding, "INVALID_ARGUMENT", `${field}.permissionsByBinding`);
    const entries = Object.entries(sourceMap);
    if (entries.length > MAX_MENU_SELECTION_ITEMS) {
        throw new PermissionCoreError("LIMIT_EXCEEDED", `${field}.permissionsByBinding exceeds its item limit.`, {
            details: {
                kind: "limit-exceeded",
                origin: "caller-input",
                limitName: "menu-permission-choice-bindings",
                current: entries.length,
                max: MAX_MENU_SELECTION_ITEMS,
                unit: "items",
            },
        });
    }
    const permissionsByBinding: Record<string, readonly string[]> = {};
    for (const [rawBindingId, semanticKeys] of entries.sort(([left], [right]) => compareUtf8(left, right))) {
        const bindingId = normalizeRbacId(rawBindingId, `${field}.permissionsByBinding key`);
        if (bindingId !== rawBindingId) {
            throw validationError("INVALID_ARGUMENT", `${field}.permissionsByBinding`, "contains a non-canonical binding ID key");
        }
        permissionsByBinding[bindingId] = normalizedSemanticKeyArray(
            semanticKeys,
            `${field}.permissionsByBinding.${bindingId}`,
        );
    }
    return deepFreeze({ bindingIds, permissionsByBinding });
}

export function normalizeMenuPermissionSelection(
    value: unknown,
    field = "selection",
): MenuPermissionSelection {
    const input = exactMenuRecord(value, ["nodeIds", "include", "apiChoices"], field);
    if (Object.keys(input).length !== 3) {
        throw validationError("INVALID_ARGUMENT", field, "requires nodeIds, include, and apiChoices");
    }
    const nodeIds = normalizedIdArray(input.nodeIds, `${field}.nodeIds`);
    if (nodeIds.length === 0) {
        throw validationError("INVALID_ARGUMENT", `${field}.nodeIds`, "must contain at least one anchor");
    }
    const include = normalizeMenuPermissionInclude(input.include, `${field}.include`);
    const apiChoices = normalizeMenuApiChoices(input.apiChoices, `${field}.apiChoices`);
    const choiceCount = apiChoices.bindingIds.length
        + Object.values(apiChoices.permissionsByBinding).reduce((total, semanticKeys) => total + semanticKeys.length, 0);
    if (choiceCount > MAX_MENU_SELECTION_ITEMS) {
        throw new PermissionCoreError("LIMIT_EXCEEDED", `${field}.apiChoices exceeds its combined choice limit.`, {
            details: {
                kind: "limit-exceeded",
                origin: "caller-input",
                limitName: "menu-permission-choice-ids",
                current: choiceCount,
                max: MAX_MENU_SELECTION_ITEMS,
                unit: "items",
            },
        });
    }
    return deepFreeze({ nodeIds, include, apiChoices });
}

function normalizeMenuPermissionAssignment(value: unknown, field: string): MenuPermissionAssignment {
    const input = exactMenuRecord(value, ["effect", "selection"], field);
    if (Object.keys(input).length !== 2 || (input.effect !== "allow" && input.effect !== "deny")) {
        throw validationError("INVALID_ARGUMENT", field, "requires effect allow or deny and selection");
    }
    return deepFreeze({
        effect: input.effect,
        selection: normalizeMenuPermissionSelection(input.selection, `${field}.selection`),
    });
}

export function normalizeMenuPermissionChange(value: unknown): MenuPermissionChange {
    const input = exactMenuRecord(value, ["operation", "selection", "grantIds", "assignments"], "change");
    const operation = input.operation;
    if (operation === "grant" || operation === "deny") {
        if (!Object.hasOwn(input, "selection") || Object.keys(input).length !== 2) {
            throw validationError("INVALID_ARGUMENT", "change", "grant and deny require only selection");
        }
        const normalized: Extract<MenuPermissionChange, { operation: "grant" | "deny" }> = deepFreeze({
            operation,
            selection: normalizeMenuPermissionSelection(input.selection),
        });
        assertManagementInputBudget(normalized);
        return normalized;
    }
    if (input.operation === "revoke") {
        if (!Object.hasOwn(input, "grantIds") || Object.keys(input).length !== 2) {
            throw validationError("INVALID_ARGUMENT", "change", "revoke requires only grantIds");
        }
        const normalized = deepFreeze({
            operation: "revoke" as const,
            grantIds: normalizedIdArray(input.grantIds, "change.grantIds"),
        });
        assertManagementInputBudget(normalized);
        return normalized;
    }
    if (input.operation === "set") {
        if (!Object.hasOwn(input, "assignments") || Object.keys(input).length !== 2) {
            throw validationError("INVALID_ARGUMENT", "change", "set requires only assignments");
        }
        const assignments = denseMenuArray(input.assignments, "change.assignments", MAX_MENU_SELECTION_ITEMS)
            .map((assignment, index) => normalizeMenuPermissionAssignment(assignment, `change.assignments[${index}]`));
        const anchorCount = assignments.reduce((total, assignment) => total + assignment.selection.nodeIds.length, 0);
        if (anchorCount > MAX_MENU_SELECTION_ITEMS) {
            throw new PermissionCoreError("LIMIT_EXCEEDED", "change.assignments exceeds its combined anchor limit.", {
                details: {
                    kind: "limit-exceeded",
                    origin: "caller-input",
                    limitName: "menu-permission-anchors",
                    current: anchorCount,
                    max: MAX_MENU_SELECTION_ITEMS,
                    unit: "items",
                },
            });
        }
        const normalized = deepFreeze({ operation: "set" as const, assignments: Object.freeze(assignments) });
        assertManagementInputBudget(normalized);
        return normalized;
    }
    throw validationError("INVALID_ARGUMENT", "change.operation", "must be grant, deny, revoke, or set");
}

export function normalizeMenuGrantIntent(value: unknown): MenuGrantIntent {
    const input = exactMenuRecord(value, ["anchorId", "include", "apiChoices"], "menuGrant.intent");
    if (Object.keys(input).length !== 3) {
        throw validationError("INVALID_ARGUMENT", "menuGrant.intent", "requires anchorId, include, and apiChoices");
    }
    return deepFreeze({
        anchorId: normalizeRbacId(input.anchorId, "menuGrant.intent.anchorId"),
        include: normalizeMenuPermissionInclude(input.include, "menuGrant.intent.include"),
        apiChoices: normalizeMenuApiChoices(input.apiChoices, "menuGrant.intent.apiChoices"),
    });
}

export function normalizePersistedMenuGrantSnapshot(value: unknown): MenuGrantSnapshotRef & {
    readonly contributingAssetIds: readonly string[];
    readonly contributingBindingIds: readonly string[];
} {
    const input = exactMenuRecord(value, [
        "contributionContractDigest",
        "contributionDigest",
        "contributingAssetCount",
        "contributingBindingCount",
        "contributingAssetIds",
        "contributingBindingIds",
    ], "menuGrant.snapshot");
    if (Object.keys(input).length !== 6) {
        throw validationError("INVALID_ARGUMENT", "menuGrant.snapshot", "is incomplete");
    }
    for (const key of ["contributionContractDigest", "contributionDigest"] as const) {
        if (typeof input[key] !== "string" || !DIGEST.test(input[key] as string)) {
            throw validationError("INVALID_ARGUMENT", `menuGrant.snapshot.${key}`, "must be a canonical digest");
        }
    }
    for (const key of ["contributingAssetCount", "contributingBindingCount"] as const) {
        if (!Number.isSafeInteger(input[key]) || (input[key] as number) < 0) {
            throw validationError("INVALID_ARGUMENT", `menuGrant.snapshot.${key}`, "must be a non-negative safe integer");
        }
    }
    const contributingAssetIds = normalizedIdArray(input.contributingAssetIds, "menuGrant.snapshot.contributingAssetIds");
    const contributingBindingIds = normalizedIdArray(input.contributingBindingIds, "menuGrant.snapshot.contributingBindingIds");
    if (input.contributingAssetCount !== contributingAssetIds.length || input.contributingBindingCount !== contributingBindingIds.length) {
        throw validationError("INVALID_ARGUMENT", "menuGrant.snapshot", "counts do not match contributing identities");
    }
    return deepFreeze({
        contributionContractDigest: input.contributionContractDigest as string,
        contributionDigest: input.contributionDigest as string,
        contributingAssetCount: input.contributingAssetCount as number,
        contributingBindingCount: input.contributingBindingCount as number,
        contributingAssetIds,
        contributingBindingIds,
    });
}

function boundedString(value: unknown, field: string, maximumBytes: number, trim = false) {
    if (typeof value !== "string" || !isWellFormedUnicode(value)) {
        throw validationError("INVALID_ARGUMENT", field, "must be a well-formed string");
    }
    const normalized = trim ? value.trim() : value;
    const bytes = Buffer.byteLength(normalized, "utf8");
    if (bytes < 1) {
        throw validationError("INVALID_ARGUMENT", field, "cannot be empty");
    }
    if (bytes > maximumBytes) {
        throw new PermissionCoreError("LIMIT_EXCEEDED", `${field} exceeds its byte limit.`, {
            details: {
                kind: "limit-exceeded",
                origin: "caller-input",
                limitName: `${field}-bytes`,
                current: bytes,
                max: maximumBytes,
                unit: "bytes",
            },
        });
    }
    return normalized;
}

function normalizeHttpMethod(value: unknown, field: string) {
    const method = boundedString(value, field, 32, true).toUpperCase();
    if (!HTTP_METHOD.test(method)) {
        throw validationError("INVALID_ARGUMENT", field, "does not match the HTTP method grammar");
    }
    return method;
}

export function normalizeMenuEntityStatus(value: unknown, field: string): EntityStatus {
    if (!ENTITY_STATUSES.has(value as EntityStatus)) {
        throw validationError("INVALID_ARGUMENT", field, "must be enabled, disabled, or deprecated");
    }
    return value as EntityStatus;
}

function boolean(value: unknown, field: string) {
    if (typeof value !== "boolean") {
        throw validationError("INVALID_ARGUMENT", field, "must be a boolean");
    }
    return value;
}

function optionalText(input: Readonly<Record<string, unknown>>, key: string, field: string, max = 4096) {
    return Object.hasOwn(input, key) ? boundedString(input[key], field, max) : undefined;
}

function structuredDepth(value: unknown, depth = 0): number {
    if (value === null || typeof value !== "object") return depth;
    return Object.values(value as Record<string, unknown>).reduce<number>(
        (maximum, entry) => Math.max(maximum, structuredDepth(entry, depth + 1)),
        depth,
    );
}

function normalizeMeta(value: unknown, field: string) {
    const cloned = clonePolicyRecord(value, "INVALID_ARGUMENT", field);
    if (structuredDepth(cloned) > 8) {
        throw validationError("INVALID_ARGUMENT", field, "exceeds maximum depth 8");
    }
    try {
        canonicalByteLength(cloned, MAX_META_BYTES);
    } catch {
        throw new PermissionCoreError("LIMIT_EXCEEDED", `${field} exceeds ${MAX_META_BYTES} canonical bytes.`, {
            details: {
                kind: "limit-exceeded",
                origin: "caller-input",
                limitName: "menu-meta-bytes",
                current: canonicalByteLength(cloned),
                max: MAX_META_BYTES,
                unit: "bytes",
            },
        });
    }
    return cloned;
}

export function normalizeDeclaredPath(value: unknown, field: string) {
    let path = boundedString(value, field, 2048, true);
    path = path.split(/[?#]/u, 1)[0]!.replace(/\/{2,}/gu, "/");
    if (!path.startsWith("/")) {
        throw validationError("INVALID_ARGUMENT", field, "must start with /");
    }
    if (path.length > 1) path = path.replace(/\/+$/u, "");
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(path)) {
        throw validationError("INVALID_ARGUMENT", field, "cannot contain control characters");
    }
    return path;
}

export function normalizeHttpUrl(value: unknown, field: string) {
    const raw = boundedString(value, field, 4096, true);
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        throw validationError("INVALID_ARGUMENT", field, "must be an absolute HTTP(S) URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw validationError("INVALID_ARGUMENT", field, "must use http or https");
    }
    return parsed.toString();
}

function normalizePermission(value: unknown, schemes: ResourceSchemeRegistry, field: string) {
    const input = exactMenuRecord(value, ["action", "resource"], field);
    if (!Object.hasOwn(input, "action") || !Object.hasOwn(input, "resource")) {
        throw validationError("INVALID_ARGUMENT", field, "requires action and resource");
    }
    const action = normalizePermissionAction(input.action);
    schemes.validate(input.resource as string, "pattern");
    return deepFreeze({ action, resource: input.resource as string });
}

function normalizeDataPermission(value: unknown, schemes: ResourceSchemeRegistry, field: string): MenuDataPermissionTemplate {
    const input = exactMenuRecord(value, ["action", "resource", "where", "label"], field);
    if (!Object.hasOwn(input, "action") || !Object.hasOwn(input, "resource")) {
        throw validationError("INVALID_ARGUMENT", field, "requires action and resource");
    }
    if (!DATA_ACTIONS.has(input.action as never)) {
        throw validationError("INVALID_ARGUMENT", `${field}.action`, "must be a built-in database action");
    }
    if (typeof input.resource !== "string" || !DATA_RESOURCE.test(input.resource)) {
        throw validationError("INVALID_RESOURCE", `${field}.resource`, "must be db:<logical> or db:<logical>:field:<safe-path>");
    }
    schemes.validate(input.resource, "pattern");
    const where = Object.hasOwn(input, "where") ? normalizeRowCondition(input.where) : undefined;
    if (where !== undefined && canonicalByteLength(where) > MAX_WHERE_BYTES) {
        throw new PermissionCoreError("LIMIT_EXCEEDED", `${field}.where exceeds its byte limit.`, {
            details: {
                kind: "limit-exceeded",
                origin: "caller-input",
                limitName: "menu-data-where-bytes",
                current: canonicalByteLength(where),
                max: MAX_WHERE_BYTES,
                unit: "bytes",
            },
        });
    }
    return deepFreeze({
        action: input.action as MenuDataPermissionTemplate["action"],
        resource: input.resource as MenuDataPermissionTemplate["resource"],
        ...(where === undefined ? {} : { where }),
        ...(Object.hasOwn(input, "label") ? { label: boundedString(input.label, `${field}.label`, 512, true) } : {}),
    });
}

function assertNodeTypeShape(input: Readonly<Record<string, unknown>>, type: MenuNodeType, field: string) {
    const present = (key: string) => Object.hasOwn(input, key);
    const requireKeys = (keys: readonly string[]) => {
        const missing = keys.find((key) => !present(key));
        if (missing) throw validationError("INVALID_ARGUMENT", `${field}.${missing}`, `is required for ${type}`);
    };
    const forbidKeys = (keys: readonly string[]) => {
        const unexpected = keys.find(present);
        if (unexpected) throw validationError("INVALID_ARGUMENT", `${field}.${unexpected}`, `is not valid for ${type}`);
    };
    if (type === "directory") forbidKeys(["path", "code", "component", "url"]);
    if (type === "menu") {
        requireKeys(["path", "name", "permission"]);
        forbidKeys(["code", "url"]);
    }
    if (type === "page") {
        requireKeys(["path", "name", "component", "permission"]);
        forbidKeys(["code", "url"]);
    }
    if (type === "button") {
        requireKeys(["code", "permission"]);
        forbidKeys(["path", "name", "component", "url"]);
    }
    if (type === "external") {
        requireKeys(["url", "permission"]);
        forbidKeys(["code", "component"]);
    }
    if (type === "iframe") {
        requireKeys(["url", "path", "name", "permission"]);
        forbidKeys(["code", "component"]);
    }
}

export function normalizeMenuNodeCreateInput(value: MenuNodeCreateInput, schemes: ResourceSchemeRegistry) {
    const input = exactMenuRecord(value, [
        "id", "parentId", "type", "title", "path", "name", "code", "component", "url", "icon",
        "status", "hidden", "i18nKey", "meta", "permission", "dataPermissions",
    ], "menu");
    if (!Object.hasOwn(input, "id") || !Object.hasOwn(input, "type") || !Object.hasOwn(input, "title")) {
        throw validationError("INVALID_ARGUMENT", "menu", "requires id, type, and title");
    }
    if (!MENU_TYPES.has(input.type as MenuNodeType)) {
        throw validationError("INVALID_ARGUMENT", "menu.type", "is not a supported menu node type");
    }
    const type = input.type as MenuNodeType;
    assertNodeTypeShape(input, type, "menu");
    const code = Object.hasOwn(input, "code") ? normalizeRbacId(input.code, "menu.code") : undefined;
    if (code !== undefined && !BUTTON_CODE.test(code)) {
        throw validationError("INVALID_ARGUMENT", "menu.code", "does not match the safe button code grammar");
    }
    const dataPermissions = Object.hasOwn(input, "dataPermissions")
        ? denseMenuArray(input.dataPermissions, "menu.dataPermissions", 128)
            .map((entry, index) => normalizeDataPermission(entry, schemes, `menu.dataPermissions[${index}]`))
        : undefined;
    return deepFreeze({
        id: normalizeRbacId(input.id, "menu.id"),
        parentId: Object.hasOwn(input, "parentId")
            ? (input.parentId === null ? null : normalizeRbacId(input.parentId, "menu.parentId"))
            : null,
        type,
        title: normalizeRoleLabel(input.title, "menu.title"),
        ...(Object.hasOwn(input, "path") ? { path: normalizeDeclaredPath(input.path, "menu.path") } : {}),
        ...(Object.hasOwn(input, "name") ? { name: normalizeRbacId(input.name, "menu.name") } : {}),
        ...(code === undefined ? {} : { code }),
        ...(Object.hasOwn(input, "component") ? { component: boundedString(input.component, "menu.component", 2048, true) } : {}),
        ...(Object.hasOwn(input, "url") ? { url: normalizeHttpUrl(input.url, "menu.url") } : {}),
        ...(Object.hasOwn(input, "icon") ? { icon: boundedString(input.icon, "menu.icon", 512, true) } : {}),
        status: Object.hasOwn(input, "status") ? normalizeMenuEntityStatus(input.status, "menu.status") : "enabled",
        hidden: Object.hasOwn(input, "hidden") ? boolean(input.hidden, "menu.hidden") : false,
        ...(Object.hasOwn(input, "i18nKey") ? { i18nKey: boundedString(input.i18nKey, "menu.i18nKey", 512, true) } : {}),
        ...(Object.hasOwn(input, "meta") ? { meta: normalizeMeta(input.meta, "menu.meta") } : {}),
        ...(Object.hasOwn(input, "permission") ? { permission: normalizePermission(input.permission, schemes, "menu.permission") } : {}),
        ...(dataPermissions === undefined ? {} : { dataPermissions: Object.freeze(dataPermissions) }),
    });
}

export function normalizeMenuNodeUpdateInput(value: MenuNodeUpdateInput) {
    const input = exactMenuRecord(value, ["title", "component", "icon", "hidden", "i18nKey", "meta"], "patch");
    if (Object.keys(input).length === 0) {
        throw validationError("INVALID_ARGUMENT", "patch", "must contain at least one metadata field");
    }
    const normalized = deepFreeze({
        ...(Object.hasOwn(input, "title") ? { title: normalizeRoleLabel(input.title, "patch.title") } : {}),
        ...(Object.hasOwn(input, "component")
            ? { component: input.component === null ? null : boundedString(input.component, "patch.component", 2048, true) }
            : {}),
        ...(Object.hasOwn(input, "icon")
            ? { icon: input.icon === null ? null : boundedString(input.icon, "patch.icon", 512, true) }
            : {}),
        ...(Object.hasOwn(input, "hidden") ? { hidden: boolean(input.hidden, "patch.hidden") } : {}),
        ...(Object.hasOwn(input, "i18nKey")
            ? { i18nKey: input.i18nKey === null ? null : boundedString(input.i18nKey, "patch.i18nKey", 512, true) }
            : {}),
        ...(Object.hasOwn(input, "meta")
            ? { meta: input.meta === null ? null : normalizeMeta(input.meta, "patch.meta") }
            : {}),
    });
    assertManagementInputBudget(normalized);
    return normalized;
}

function normalizeMenuNodeImpactPatch(value: unknown, schemes: ResourceSchemeRegistry) {
    const input = exactMenuRecord(value, [
        "title", "component", "icon", "hidden", "i18nKey", "meta",
        "path", "name", "code", "url", "permission", "dataPermissions",
    ], "request.patch");
    if (Object.keys(input).length === 0) {
        throw validationError("INVALID_ARGUMENT", "request.patch", "must contain at least one field");
    }
    let code: string | null | undefined;
    if (Object.hasOwn(input, "code")) {
        code = input.code === null ? null : normalizeRbacId(input.code, "request.patch.code");
        if (code !== null && !BUTTON_CODE.test(code)) {
            throw validationError("INVALID_ARGUMENT", "request.patch.code", "does not match the safe button code grammar");
        }
    }
    const dataPermissions = Object.hasOwn(input, "dataPermissions")
        ? (input.dataPermissions === null
            ? null
            : denseMenuArray(input.dataPermissions, "request.patch.dataPermissions", 128)
                .map((entry, index) => normalizeDataPermission(entry, schemes, `request.patch.dataPermissions[${index}]`)))
        : undefined;
    return deepFreeze({
        ...(Object.hasOwn(input, "title") ? { title: normalizeRoleLabel(input.title, "request.patch.title") } : {}),
        ...(Object.hasOwn(input, "component")
            ? { component: input.component === null ? null : boundedString(input.component, "request.patch.component", 2048, true) }
            : {}),
        ...(Object.hasOwn(input, "icon")
            ? { icon: input.icon === null ? null : boundedString(input.icon, "request.patch.icon", 512, true) }
            : {}),
        ...(Object.hasOwn(input, "hidden") ? { hidden: boolean(input.hidden, "request.patch.hidden") } : {}),
        ...(Object.hasOwn(input, "i18nKey")
            ? { i18nKey: input.i18nKey === null ? null : boundedString(input.i18nKey, "request.patch.i18nKey", 512, true) }
            : {}),
        ...(Object.hasOwn(input, "meta")
            ? { meta: input.meta === null ? null : normalizeMeta(input.meta, "request.patch.meta") }
            : {}),
        ...(Object.hasOwn(input, "path")
            ? { path: input.path === null ? null : normalizeDeclaredPath(input.path, "request.patch.path") }
            : {}),
        ...(Object.hasOwn(input, "name")
            ? { name: input.name === null ? null : normalizeRbacId(input.name, "request.patch.name") }
            : {}),
        ...(code === undefined ? {} : { code }),
        ...(Object.hasOwn(input, "url")
            ? { url: input.url === null ? null : normalizeHttpUrl(input.url, "request.patch.url") }
            : {}),
        ...(Object.hasOwn(input, "permission")
            ? { permission: input.permission === null ? null : normalizePermission(input.permission, schemes, "request.patch.permission") }
            : {}),
        ...(dataPermissions === undefined ? {} : { dataPermissions: dataPermissions === null ? null : Object.freeze(dataPermissions) }),
    });
}

export function normalizeMenuNodeImpactUpdateRequest(
    value: MenuNodeImpactUpdateRequest,
    schemes: ResourceSchemeRegistry,
) {
    const input = exactMenuRecord(value, ["patch", "sourceRewrite"], "request");
    if (!Object.hasOwn(input, "patch")) {
        throw validationError("INVALID_ARGUMENT", "request.patch", "is required");
    }
    const normalized = deepFreeze({
        patch: normalizeMenuNodeImpactPatch(input.patch, schemes),
        sourceRewrite: normalizeSourceRewriteDecision(input.sourceRewrite as SourceRewriteDecision | undefined),
    });
    assertManagementInputBudget(normalized);
    return normalized;
}

export function normalizeMenuMoveInput(value: MenuMoveInput) {
    const input = exactMenuRecord(value, ["nodeId", "parentId", "beforeId", "afterId"], "move");
    if (!Object.hasOwn(input, "nodeId") || !Object.hasOwn(input, "parentId")) {
        throw validationError("INVALID_ARGUMENT", "move", "requires nodeId and parentId");
    }
    if (Object.hasOwn(input, "beforeId") && Object.hasOwn(input, "afterId")) {
        throw validationError("INVALID_ARGUMENT", "move", "accepts at most one of beforeId and afterId");
    }
    const nodeId = normalizeRbacId(input.nodeId, "move.nodeId");
    const normalized = deepFreeze({
        nodeId,
        parentId: input.parentId === null ? null : normalizeRbacId(input.parentId, "move.parentId"),
        ...(Object.hasOwn(input, "beforeId") ? { beforeId: normalizeRbacId(input.beforeId, "move.beforeId") } : {}),
        ...(Object.hasOwn(input, "afterId") ? { afterId: normalizeRbacId(input.afterId, "move.afterId") } : {}),
    });
    if (normalized.parentId === nodeId || normalized.beforeId === nodeId || normalized.afterId === nodeId) {
        throw validationError("INVALID_ARGUMENT", "move", "cannot reference the moving node as its parent or anchor");
    }
    assertManagementInputBudget(normalized);
    return normalized;
}

export function normalizeMenuReorderInput(value: MenuReorderInput) {
    const input = exactMenuRecord(value, ["parentId", "orderedNodeIds"], "reorder");
    if (!Object.hasOwn(input, "parentId") || !Object.hasOwn(input, "orderedNodeIds")) {
        throw validationError("INVALID_ARGUMENT", "reorder", "requires parentId and orderedNodeIds");
    }
    const orderedNodeIds = denseMenuArray(input.orderedNodeIds, "reorder.orderedNodeIds", MAX_MENU_INVENTORY_ITEMS)
        .map((entry, index) => normalizeRbacId(entry, `reorder.orderedNodeIds[${index}]`));
    if (new Set(orderedNodeIds).size !== orderedNodeIds.length) {
        throw validationError("INVALID_ARGUMENT", "reorder.orderedNodeIds", "cannot contain duplicates");
    }
    const normalized = deepFreeze({
        parentId: input.parentId === null ? null : normalizeRbacId(input.parentId, "reorder.parentId"),
        orderedNodeIds: Object.freeze(orderedNodeIds),
    });
    assertManagementInputBudget(normalized);
    return normalized;
}

export function normalizeMenuRemoveInput(value: MenuRemoveInput) {
    const input = exactMenuRecord(value, ["cascade", "sourceRewrite"], "remove");
    if (!Object.hasOwn(input, "cascade")) {
        throw validationError("INVALID_ARGUMENT", "remove.cascade", "is required");
    }
    const normalized = deepFreeze({
        cascade: boolean(input.cascade, "remove.cascade"),
        sourceRewrite: normalizeSourceRewriteDecision(input.sourceRewrite as SourceRewriteDecision | undefined),
    });
    assertManagementInputBudget(normalized);
    return normalized;
}

export function normalizeStaleRepairInput(value: StaleRepairInput) {
    const input = exactMenuRecord(value, ["referenceIds", "resolutions"], "repair");
    if (!Object.hasOwn(input, "referenceIds") || !Object.hasOwn(input, "resolutions")) {
        throw validationError("INVALID_ARGUMENT", "repair", "requires referenceIds and resolutions");
    }
    const referenceIds = normalizedIdArray(input.referenceIds, "repair.referenceIds");
    const rawResolutions = clonePolicyRecord(input.resolutions, "INVALID_ARGUMENT", "repair.resolutions");
    const resolutionKeys = Object.keys(rawResolutions).sort(compareUtf8);
    if (resolutionKeys.length !== referenceIds.length || resolutionKeys.some((key, index) => key !== referenceIds[index])) {
        throw validationError("INVALID_ARGUMENT", "repair.resolutions", "keys must exactly match referenceIds");
    }
    const resolutions: Record<string, { action: "remove" } | { action: "rebind"; replacementId: string }> = {};
    for (const referenceId of referenceIds) {
        const resolution = exactMenuRecord(rawResolutions[referenceId], ["action", "replacementId"], `repair.resolutions.${referenceId}`);
        if (resolution.action === "remove") {
            if (Object.hasOwn(resolution, "replacementId")) {
                throw validationError("INVALID_ARGUMENT", `repair.resolutions.${referenceId}`, "remove cannot define replacementId");
            }
            resolutions[referenceId] = { action: "remove" };
        } else if (resolution.action === "rebind" && Object.hasOwn(resolution, "replacementId")) {
            resolutions[referenceId] = {
                action: "rebind",
                replacementId: normalizeRbacId(resolution.replacementId, `repair.resolutions.${referenceId}.replacementId`),
            };
        } else {
            throw validationError("INVALID_ARGUMENT", `repair.resolutions.${referenceId}`, "must be remove or rebind with replacementId");
        }
    }
    const normalized = deepFreeze({ referenceIds, resolutions });
    assertManagementInputBudget(normalized);
    return normalized;
}

export function normalizeMenuNodeFilter(value?: MenuNodeFilter) {
    const input = exactMenuRecord(value ?? {}, ["parentId", "type", "status", "hidden", "search"], "filter");
    let type: MenuNodeType | readonly MenuNodeType[] | undefined;
    if (Object.hasOwn(input, "type")) {
        if (Array.isArray(input.type)) {
            const values = denseMenuArray(input.type, "filter.type", MENU_TYPES.size).map((entry, index) => {
                if (!MENU_TYPES.has(entry as MenuNodeType)) {
                    throw validationError("INVALID_ARGUMENT", `filter.type[${index}]`, "is not a supported menu node type");
                }
                return entry as MenuNodeType;
            });
            if (new Set(values).size !== values.length) {
                throw validationError("INVALID_ARGUMENT", "filter.type", "cannot contain duplicates");
            }
            type = Object.freeze(values.sort(compareUtf8));
        } else if (MENU_TYPES.has(input.type as MenuNodeType)) {
            type = input.type as MenuNodeType;
        } else {
            throw validationError("INVALID_ARGUMENT", "filter.type", "is not a supported menu node type");
        }
    }
    return deepFreeze({
        ...(Object.hasOwn(input, "parentId") ? { parentId: input.parentId === null ? null : normalizeRbacId(input.parentId, "filter.parentId") } : {}),
        ...(type === undefined ? {} : { type }),
        ...(Object.hasOwn(input, "status") ? { status: normalizeMenuEntityStatus(input.status, "filter.status") } : {}),
        ...(Object.hasOwn(input, "hidden") ? { hidden: boolean(input.hidden, "filter.hidden") } : {}),
        ...(Object.hasOwn(input, "search") ? { search: boundedString(input.search, "filter.search", 256, true) } : {}),
    });
}

function normalizeAuthorization(value: unknown, schemes: ResourceSchemeRegistry, field: string): ApiAuthorization {
    const input = exactMenuRecord(value, ["mode", "permissions"], field);
    if ((input.mode !== "all" && input.mode !== "any") || !Object.hasOwn(input, "permissions")) {
        throw validationError("INVALID_ARGUMENT", field, "requires mode all/any and permissions");
    }
    const permissions = denseMenuArray(input.permissions, `${field}.permissions`, 32).map((entry, index) =>
        normalizePermission(entry, schemes, `${field}.permissions[${index}]`));
    if (permissions.length === 0) {
        throw validationError("INVALID_ARGUMENT", `${field}.permissions`, "must contain at least one permission");
    }
    const unique = new Map(permissions.map((entry) => [digestCanonical(entry), entry]));
    return deepFreeze({
        mode: input.mode,
        permissions: Object.freeze([...unique.entries()].sort(([left], [right]) => compareUtf8(left, right)).map(([, entry]) => entry)),
    });
}

function normalizeOwner(value: unknown, field: string): ApiOwnerRelation {
    const input = exactMenuRecord(value, ["type", "id", "required", "availabilityGroup", "availabilityMode"], field);
    if (!(["menu", "page", "button"] as unknown[]).includes(input.type) || typeof input.required !== "boolean") {
        throw validationError("INVALID_ARGUMENT", field, "requires a menu/page/button type, id, and required boolean");
    }
    const hasGroup = Object.hasOwn(input, "availabilityGroup");
    const hasMode = Object.hasOwn(input, "availabilityMode");
    if (hasGroup !== hasMode) {
        throw validationError("INVALID_ARGUMENT", field, "availabilityGroup and availabilityMode must be provided together");
    }
    if (!input.required && hasGroup) {
        throw validationError("INVALID_ARGUMENT", field, "optional owners cannot define availability groups");
    }
    if (hasMode && input.availabilityMode !== "all" && input.availabilityMode !== "any") {
        throw validationError("INVALID_ARGUMENT", `${field}.availabilityMode`, "must be all or any");
    }
    return deepFreeze({
        type: input.type as ApiOwnerRelation["type"],
        id: normalizeRbacId(input.id, `${field}.id`),
        required: input.required,
        ...(hasGroup ? { availabilityGroup: normalizeRbacId(input.availabilityGroup, `${field}.availabilityGroup`) } : {}),
        ...(hasMode ? { availabilityMode: input.availabilityMode as "all" | "any" } : {}),
    });
}

function normalizeOwners(value: unknown, field: string) {
    const owners = denseMenuArray(value, field, 128)
        .map((entry, index) => normalizeOwner(entry, `${field}[${index}]`));
    const ownerKeys = owners.map((owner) => `${owner.type}\u0000${owner.id}`);
    if (new Set(ownerKeys).size !== ownerKeys.length) {
        throw validationError("INVALID_ARGUMENT", field, "cannot contain duplicate owner relations");
    }
    return Object.freeze(owners.sort((left, right) =>
        compareUtf8(`${left.type}\u0000${left.id}`, `${right.type}\u0000${right.id}`)));
}

function normalizeCanonicalOwner(value: unknown) {
    const input = exactMenuRecord(value, ["type", "id"], "apiBinding.canonicalOwner");
    if (!Object.hasOwn(input, "type") || !Object.hasOwn(input, "id")) {
        throw validationError("INVALID_ARGUMENT", "apiBinding.canonicalOwner", "requires type and id");
    }
    const owner = normalizeOwner({ type: input.type, id: input.id, required: true }, "apiBinding.canonicalOwner");
    return deepFreeze({ type: owner.type, id: owner.id });
}

export function normalizeApiBindingCreateInput(value: ApiBindingCreateInput, schemes: ResourceSchemeRegistry) {
    const input = exactMenuRecord(value, [
        "id", "method", "path", "purpose", "authorization", "owners", "canonicalOwner", "status", "description",
    ], "apiBinding");
    for (const key of ["id", "method", "path", "purpose", "authorization"]) {
        if (!Object.hasOwn(input, key)) {
            throw validationError("INVALID_ARGUMENT", "apiBinding", `requires ${key}`);
        }
    }
    const method = normalizeHttpMethod(input.method, "apiBinding.method");
    if (!API_PURPOSES.has(input.purpose as never)) {
        throw validationError("INVALID_ARGUMENT", "apiBinding.purpose", "is not a supported API purpose");
    }
    const owners = Object.hasOwn(input, "owners")
        ? normalizeOwners(input.owners, "apiBinding.owners")
        : Object.freeze([] as ApiOwnerRelation[]);
    const ownerKeys = owners.map((owner) => `${owner.type}\u0000${owner.id}`);
    if (new Set(ownerKeys).size !== ownerKeys.length) {
        throw validationError("INVALID_ARGUMENT", "apiBinding.owners", "cannot contain duplicate owner relations");
    }
    const canonicalOwner = Object.hasOwn(input, "canonicalOwner")
        ? normalizeCanonicalOwner(input.canonicalOwner)
        : undefined;
    if (canonicalOwner && !ownerKeys.includes(`${canonicalOwner.type}\u0000${canonicalOwner.id}`)) {
        throw validationError("INVALID_ARGUMENT", "apiBinding.canonicalOwner", "must also appear in owners");
    }
    return deepFreeze({
        id: normalizeRbacId(input.id, "apiBinding.id"),
        method,
        path: normalizeDeclaredPath(input.path, "apiBinding.path"),
        purpose: input.purpose as ApiBindingCreateInput["purpose"],
        authorization: normalizeAuthorization(input.authorization, schemes, "apiBinding.authorization"),
        owners,
        ...(canonicalOwner === undefined ? {} : { canonicalOwner: { type: canonicalOwner.type, id: canonicalOwner.id } }),
        status: Object.hasOwn(input, "status") ? normalizeMenuEntityStatus(input.status, "apiBinding.status") : "enabled",
        ...(Object.hasOwn(input, "description") ? { description: normalizeDescription(input.description, "apiBinding.description") } : {}),
    });
}

export function normalizeApiBindingUpdateInput(value: ApiBindingUpdateInput) {
    const input = exactMenuRecord(value, ["purpose", "description"], "patch");
    if (Object.keys(input).length === 0) {
        throw validationError("INVALID_ARGUMENT", "patch", "must contain purpose or description");
    }
    if (Object.hasOwn(input, "purpose") && !API_PURPOSES.has(input.purpose as never)) {
        throw validationError("INVALID_ARGUMENT", "patch.purpose", "is not a supported API purpose");
    }
    return deepFreeze({
        ...(Object.hasOwn(input, "purpose") ? { purpose: input.purpose as ApiBindingUpdateInput["purpose"] } : {}),
        ...(Object.hasOwn(input, "description")
            ? { description: input.description === null ? null : normalizeDescription(input.description, "patch.description") }
            : {}),
    });
}

export function normalizeApiBindingImpactUpdateRequest(
    value: ApiBindingImpactUpdateRequest,
    schemes: ResourceSchemeRegistry,
) {
    const input = exactMenuRecord(value, ["patch", "sourceRewrite"], "request");
    if (!Object.hasOwn(input, "patch")) {
        throw validationError("INVALID_ARGUMENT", "request.patch", "is required");
    }
    const patch = exactMenuRecord(input.patch, [
        "purpose", "description", "method", "path", "authorization", "owners", "canonicalOwner",
    ], "request.patch");
    if (Object.keys(patch).length === 0) {
        throw validationError("INVALID_ARGUMENT", "request.patch", "must contain at least one field");
    }
    if (Object.hasOwn(patch, "purpose") && !API_PURPOSES.has(patch.purpose as never)) {
        throw validationError("INVALID_ARGUMENT", "request.patch.purpose", "is not a supported API purpose");
    }
    const owners = Object.hasOwn(patch, "owners")
        ? normalizeOwners(patch.owners, "request.patch.owners")
        : undefined;
    const canonicalOwner = Object.hasOwn(patch, "canonicalOwner")
        ? (patch.canonicalOwner === null ? null : normalizeCanonicalOwner(patch.canonicalOwner))
        : undefined;
    if (
        owners !== undefined
        && canonicalOwner !== undefined
        && canonicalOwner !== null
        && !owners.some((owner) => owner.type === canonicalOwner.type && owner.id === canonicalOwner.id)
    ) {
        throw validationError("INVALID_ARGUMENT", "request.patch.canonicalOwner", "must also appear in owners");
    }
    const normalized = deepFreeze({
        patch: deepFreeze({
            ...(Object.hasOwn(patch, "purpose") ? { purpose: patch.purpose as ApiBindingCreateInput["purpose"] } : {}),
            ...(Object.hasOwn(patch, "description")
                ? { description: patch.description === null ? null : normalizeDescription(patch.description, "request.patch.description") }
                : {}),
            ...(Object.hasOwn(patch, "method") ? { method: normalizeHttpMethod(patch.method, "request.patch.method") } : {}),
            ...(Object.hasOwn(patch, "path") ? { path: normalizeDeclaredPath(patch.path, "request.patch.path") } : {}),
            ...(Object.hasOwn(patch, "authorization")
                ? { authorization: normalizeAuthorization(patch.authorization, schemes, "request.patch.authorization") }
                : {}),
            ...(owners === undefined ? {} : { owners }),
            ...(canonicalOwner === undefined ? {} : { canonicalOwner }),
        }),
        sourceRewrite: normalizeSourceRewriteDecision(input.sourceRewrite as SourceRewriteDecision | undefined),
    });
    assertManagementInputBudget(normalized);
    return normalized;
}

export function normalizeApiBindingRemoveInput(value: ApiBindingRemoveInput) {
    const input = exactMenuRecord(value, ["sourceRewrite"], "remove");
    const normalized = deepFreeze({
        sourceRewrite: normalizeSourceRewriteDecision(input.sourceRewrite as SourceRewriteDecision | undefined),
    });
    assertManagementInputBudget(normalized);
    return normalized;
}

export function normalizeApiBindingReplaceInput(
    value: ApiBindingReplaceInput,
    schemes: ResourceSchemeRegistry,
) {
    const input = exactMenuRecord(value, ["bindings", "sourceRewrite"], "replace");
    if (!Object.hasOwn(input, "bindings")) {
        throw validationError("INVALID_ARGUMENT", "replace.bindings", "is required");
    }
    const bindings = denseMenuArray(input.bindings, "replace.bindings", MAX_API_INVENTORY_ITEMS)
        .map((entry, index) => normalizeApiBindingCreateInput(entry as ApiBindingCreateInput, schemes));
    bindings.sort((left, right) => compareUtf8(left.id, right.id));
    const normalized = deepFreeze({
        bindings: Object.freeze(bindings),
        sourceRewrite: normalizeSourceRewriteDecision(input.sourceRewrite as SourceRewriteDecision | undefined),
    });
    assertManagementInputBudget(normalized);
    return normalized;
}

export function normalizeMenuManifestInput(value: MenuManifestInput, schemes: ResourceSchemeRegistry) {
    const input = exactMenuRecord(value, ["schemaVersion", "mode", "nodes", "apiBindings", "sourceRewrite"], "manifest");
    for (const key of ["schemaVersion", "mode", "nodes", "apiBindings"]) {
        if (!Object.hasOwn(input, key)) {
            throw validationError("INVALID_ARGUMENT", "manifest", `requires ${key}`);
        }
    }
    if (input.schemaVersion !== 2) {
        throw validationError("INVALID_ARGUMENT", "manifest.schemaVersion", "must be literal 2");
    }
    if (input.mode !== "merge" && input.mode !== "replace") {
        throw validationError("INVALID_ARGUMENT", "manifest.mode", "must be merge or replace");
    }
    const nodes = denseMenuArray(input.nodes, "manifest.nodes", MAX_MENU_INVENTORY_ITEMS).map((entry, index) => {
        const record = exactMenuRecord(entry, [
            "id", "parentId", "type", "title", "path", "name", "code", "component", "url", "icon",
            "status", "hidden", "i18nKey", "meta", "permission", "dataPermissions", "order",
        ], `manifest.nodes[${index}]`);
        if (!Object.hasOwn(record, "order") || !Number.isSafeInteger(record.order) || (record.order as number) < 0) {
            throw validationError("INVALID_ARGUMENT", `manifest.nodes[${index}].order`, "must be a non-negative safe integer");
        }
        const create = normalizeMenuNodeCreateInput(
            Object.fromEntries(Object.entries(record).filter(([key]) => key !== "order")) as unknown as MenuNodeCreateInput,
            schemes,
        );
        return deepFreeze({ ...create, order: record.order as number });
    });
    nodes.sort((left, right) => compareUtf8(left.id, right.id));
    const apiBindings = denseMenuArray(input.apiBindings, "manifest.apiBindings", MAX_API_INVENTORY_ITEMS)
        .map((entry) => normalizeApiBindingCreateInput(entry as ApiBindingCreateInput, schemes));
    apiBindings.sort((left, right) => compareUtf8(left.id, right.id));
    const sourceRewrite = normalizeSourceRewriteDecision(input.sourceRewrite as SourceRewriteDecision | undefined);
    const normalized = deepFreeze({
        schemaVersion: 2 as const,
        mode: input.mode,
        nodes: Object.freeze(nodes),
        apiBindings: Object.freeze(apiBindings),
        sourceRewrite,
    });
    assertManagementInputBudget({
        schemaVersion: normalized.schemaVersion,
        mode: normalized.mode,
        nodes: normalized.nodes,
        apiBindings: normalized.apiBindings,
        ...(Object.hasOwn(input, "sourceRewrite") ? { sourceRewrite } : {}),
    });
    return normalized;
}

export function normalizeApiBindingFilter(value?: ApiBindingFilter) {
    const input = exactMenuRecord(value ?? {}, ["method", "path", "status", "purpose", "ownerId"], "filter");
    if (Object.hasOwn(input, "purpose") && !API_PURPOSES.has(input.purpose as never)) {
        throw validationError("INVALID_ARGUMENT", "filter.purpose", "is not a supported API purpose");
    }
    return deepFreeze({
        ...(Object.hasOwn(input, "method") ? { method: normalizeHttpMethod(input.method, "filter.method") } : {}),
        ...(Object.hasOwn(input, "path") ? { path: normalizeDeclaredPath(input.path, "filter.path") } : {}),
        ...(Object.hasOwn(input, "status") ? { status: normalizeMenuEntityStatus(input.status, "filter.status") } : {}),
        ...(Object.hasOwn(input, "purpose") ? { purpose: input.purpose as ApiBindingFilter["purpose"] } : {}),
        ...(Object.hasOwn(input, "ownerId") ? { ownerId: normalizeRbacId(input.ownerId, "filter.ownerId") } : {}),
    });
}
