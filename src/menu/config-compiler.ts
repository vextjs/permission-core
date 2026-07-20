import type {
    ApiBindingCreateInput,
    ApiResource,
    MenuActionResource,
    MenuConfigInput,
    MenuConfigMenuSnapshot,
    MenuConfigSnapshot,
    MenuLoadSnapshot,
    MenuManifestInput,
    MenuManifestNodeInput,
    MenuResponseFieldSnapshot,
    MenuViewSnapshot,
    PolicyValue,
    ResponseProjectionConfigInput,
    ResponseProjectionInput,
} from "../types";
import { ResourceSchemeRegistry } from "../check/resource-schemes";
import { PermissionCoreError, validationError } from "../core/errors";
import { canonicalByteLength, canonicalString, compareUtf8, digestCanonical } from "../internal/canonical";
import { clonePolicyRecord, deepFreeze } from "../internal/plain-data";
import { assertMenuConfigBudget } from "../persistence/documents";
import { normalizeRbacId, normalizeRoleLabel } from "../rbac/validation";
import {
    denseMenuArray,
    exactMenuRecord,
    normalizeDeclaredPath,
    normalizeHttpUrl,
    normalizeMenuManifestInput,
} from "./validation";

export const MENU_CONFIG_CODEC_VERSION = "pc-menu-config-v1";
const AUX_PATH_PREFIX = "/_permission-core/aux";
const MAX_CONFIG_MENUS = 1_000;
const MAX_CONFIG_VIEWS = 5_000;
const MAX_CONFIG_ACTIONS = 10_000;
const MAX_CONFIG_DEPTH = 8;
const SAFE_FIELD_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const HTTP_METHOD = /^[A-Z][A-Z0-9-]{0,31}$/u;

type ResponseOwnerSource = "load" | "action";
type CompiledApiOwnerRelation = NonNullable<ApiBindingCreateInput["owners"]>[number];
type NormalizedResponse = {
    readonly target?: string;
    readonly preserve: readonly string[];
    readonly fields: readonly MenuResponseFieldSnapshot[];
};

export interface CompiledResponseOwner {
    readonly configId: string;
    readonly viewId: string;
    readonly source: ResponseOwnerSource;
}

export interface CompiledResponseDefinition {
    readonly apiResource: ApiResource;
    readonly target?: string;
    readonly targetDigest: string;
    readonly preserve: readonly string[];
    readonly fields: readonly (MenuResponseFieldSnapshot & {
        readonly owners: readonly CompiledResponseOwner[];
    })[];
    readonly owners: readonly CompiledResponseOwner[];
    readonly definitionDigest: string;
}

export interface CompiledApiOwner {
    readonly apiResource: ApiResource;
    readonly method: string;
    readonly path: string;
    readonly owner: CompiledApiOwnerRelation;
    readonly purpose: ApiBindingCreateInput["purpose"];
}

export interface CompiledViewRef {
    readonly configId: string;
    readonly menuId: string;
    readonly viewId: string;
    readonly nodeId: string;
    readonly apiOwnerNodeId: string;
}

export interface CompiledMenuRef {
    readonly configId: string;
    readonly menuId: string;
    readonly nodeId: string;
}

export interface CompiledActionRef {
    readonly configId: string;
    readonly viewId: string;
    readonly actionId: string;
    readonly resource: ApiResource | MenuActionResource;
    readonly nodeId: string;
    readonly opens?: string;
}

export interface CompiledConfigIndex {
    readonly menuIds: readonly string[];
    readonly viewIds: readonly string[];
    readonly actionResources: readonly (ApiResource | MenuActionResource)[];
    readonly apiResources: readonly ApiResource[];
}

export interface CompiledMenuConfig {
    readonly configId: string;
    readonly title?: string;
    readonly snapshot: MenuConfigSnapshot;
    readonly configDigest: string;
    readonly nodes: readonly MenuManifestNodeInput[];
    readonly apiOwners: readonly CompiledApiOwner[];
    readonly responseDefinitions: readonly CompiledResponseDefinition[];
    readonly menuIndex: ReadonlyMap<string, CompiledMenuRef>;
    readonly viewIndex: ReadonlyMap<string, CompiledViewRef>;
    readonly actionIndex: ReadonlyMap<string, CompiledActionRef>;
    readonly index: CompiledConfigIndex;
    readonly metrics: {
        readonly menuCount: number;
        readonly viewCount: number;
        readonly actionCount: number;
        readonly apiCount: number;
        readonly responseFieldCount: number;
        readonly responseFieldOwnerCount: number;
        readonly configBytes: number;
    };
}

export interface MenuConfigSnapshotOptions {
    readonly revision?: number;
    readonly createdAt?: number;
    readonly updatedAt?: number;
}

function stableId(prefix: string, ...parts: readonly string[]) {
    return `${prefix}-${digestCanonical(parts)}`;
}

function optionalMeta(value: unknown, field: string) {
    if (value === undefined) return undefined;
    const meta = clonePolicyRecord(value, "INVALID_ARGUMENT", field);
    if (canonicalByteLength(meta) > 32 * 1024) {
        throw new PermissionCoreError("LIMIT_EXCEEDED", `${field} exceeds its byte limit.`, {
            details: {
                kind: "limit-exceeded",
                origin: "caller-input",
                limitName: "menu-config-meta-bytes",
                current: canonicalByteLength(meta),
                max: 32 * 1024,
                unit: "bytes",
            },
        });
    }
    return meta;
}

function optionalBoolean(input: Readonly<Record<string, unknown>>, key: string, field: string, fallback: boolean) {
    if (!Object.hasOwn(input, key)) return fallback;
    if (typeof input[key] !== "boolean") {
        throw validationError("INVALID_ARGUMENT", field, "must be a boolean");
    }
    return input[key] as boolean;
}

function boundedString(value: unknown, field: string, maximumBytes: number) {
    if (typeof value !== "string") {
        throw validationError("INVALID_ARGUMENT", field, "must be a string");
    }
    const normalized = value.trim();
    if (normalized.length === 0) {
        throw validationError("INVALID_ARGUMENT", field, "cannot be empty");
    }
    const bytes = Buffer.byteLength(normalized, "utf8");
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

function normalizeSafePath(value: unknown, field: string) {
    if (typeof value !== "string") {
        throw validationError("INVALID_ARGUMENT", field, "must be a safe dot path");
    }
    const normalized = value.trim();
    const segments = normalized.split(".");
    if (
        normalized.length === 0
        || Buffer.byteLength(normalized, "utf8") > 512
        || segments.length > 32
        || segments.some((segment) => !SAFE_FIELD_SEGMENT.test(segment))
    ) {
        throw validationError("INVALID_ARGUMENT", field, "must be a safe dot path without indexes, wildcards, or expressions");
    }
    return normalized;
}

function normalizePreserve(value: unknown, field: string) {
    if (value === undefined) return Object.freeze([] as string[]);
    const paths = denseMenuArray(value, field, 128)
        .map((entry, index) => normalizeSafePath(entry, `${field}[${index}]`));
    return Object.freeze([...new Set(paths)].sort(compareUtf8));
}

function normalizeResponseFields(value: unknown, field: string, target: string | undefined) {
    const fields = denseMenuArray(value, field, 256).map((entry, index) => {
        const input = exactMenuRecord(entry, ["field", "title", "i18nKey", "meta"], `${field}[${index}]`);
        if (!Object.hasOwn(input, "field") || !Object.hasOwn(input, "title")) {
            throw validationError("INVALID_ARGUMENT", `${field}[${index}]`, "requires field and title");
        }
        const normalizedField = normalizeSafePath(input.field, `${field}[${index}].field`);
        const fieldId = stableId("mc-field", target ?? "", normalizedField);
        return deepFreeze({
            field: normalizedField,
            title: normalizeRoleLabel(input.title, `${field}[${index}].title`),
            fieldId,
            ...(Object.hasOwn(input, "i18nKey")
                ? { i18nKey: boundedString(input.i18nKey, `${field}[${index}].i18nKey`, 512) }
                : {}),
            ...(Object.hasOwn(input, "meta") ? { meta: optionalMeta(input.meta, `${field}[${index}].meta`) } : {}),
        }) satisfies MenuResponseFieldSnapshot;
    });
    if (fields.length === 0) {
        throw validationError("INVALID_ARGUMENT", field, "must contain at least one response field");
    }
    const seen = new Set<string>();
    for (const item of fields) {
        if (seen.has(item.field)) {
            throw validationError("INVALID_ARGUMENT", field, `contains duplicate response field ${item.field}`);
        }
        seen.add(item.field);
    }
    return Object.freeze(fields);
}

function normalizeResponse(value: ResponseProjectionInput | undefined, field: string): NormalizedResponse | undefined {
    if (value === undefined) return undefined;
    if (Array.isArray(value)) {
        return deepFreeze({
            preserve: Object.freeze([] as string[]),
            fields: normalizeResponseFields(value, field, undefined),
        });
    }
    const input = exactMenuRecord(value, ["target", "preserve", "fields"], field);
    if (!Object.hasOwn(input, "fields")) {
        throw validationError("INVALID_ARGUMENT", `${field}.fields`, "is required");
    }
    const target = Object.hasOwn(input, "target") ? normalizeSafePath(input.target, `${field}.target`) : undefined;
    return deepFreeze({
        ...(target === undefined ? {} : { target }),
        preserve: normalizePreserve(input.preserve, `${field}.preserve`),
        fields: normalizeResponseFields(input.fields, `${field}.fields`, target),
    });
}

function parseApiResource(value: unknown, field: string) {
    if (typeof value !== "string" || !value.startsWith("api:")) {
        throw validationError("INVALID_RESOURCE", field, "must be api:METHOD:/path");
    }
    const body = value.slice(4);
    const separator = body.indexOf(":");
    if (separator <= 0) {
        throw validationError("INVALID_RESOURCE", field, "must be api:METHOD:/path");
    }
    const method = body.slice(0, separator).trim().toUpperCase();
    const path = normalizeDeclaredPath(body.slice(separator + 1), field);
    if (!HTTP_METHOD.test(method)) {
        throw validationError("INVALID_RESOURCE", field, "contains an invalid HTTP method");
    }
    const resource = `api:${method}:${path}` as ApiResource;
    return { method, path, resource };
}

function normalizeActionResource(value: unknown, field: string) {
    if (typeof value !== "string") {
        throw validationError("INVALID_RESOURCE", field, "must be api:METHOD:/path or ui:button:<id>");
    }
    if (value.startsWith("api:")) return parseApiResource(value, field);
    if (!value.startsWith("ui:button:")) {
        throw validationError("INVALID_RESOURCE", field, "must be api:METHOD:/path or ui:button:<id>");
    }
    const id = normalizeRbacId(value.slice("ui:button:".length), field);
    const resource = `ui:button:${id}` as MenuActionResource;
    return { resource };
}

function compileResponseDefinition(
    apiResource: ApiResource,
    response: NormalizedResponse,
    owner: CompiledResponseOwner,
): CompiledResponseDefinition {
    const targetDigest = digestCanonical({ target: response.target ?? "" });
    const fields = response.fields.map((field) => deepFreeze({
        ...field,
        owners: Object.freeze([owner]),
    }));
    const owners = Object.freeze([owner]);
    const definitionDigest = digestCanonical({
        codecVersion: MENU_CONFIG_CODEC_VERSION,
        apiResource,
        target: response.target ?? "",
        preserve: response.preserve,
        fields: fields.map(({ owners: _owners, ...item }) => item),
        owners,
    });
    return deepFreeze({
        apiResource,
        ...(response.target === undefined ? {} : { target: response.target }),
        targetDigest,
        preserve: response.preserve,
        fields: Object.freeze(fields),
        owners,
        definitionDigest,
    });
}

function normalizeLoad(value: unknown, field: string, configId: string, viewId: string): MenuLoadSnapshot {
    const input = exactMenuRecord(value, ["resource", "response", "meta"], field);
    if (!Object.hasOwn(input, "resource")) {
        throw validationError("INVALID_ARGUMENT", `${field}.resource`, "is required");
    }
    const api = parseApiResource(input.resource, `${field}.resource`);
    return deepFreeze({
        loadId: stableId("mc-load", configId, viewId, api.resource),
        resource: api.resource,
        ...(Object.hasOwn(input, "response")
            ? { response: normalizeResponse(input.response as ResponseProjectionInput, `${field}.response`) }
            : {}),
        ...(Object.hasOwn(input, "meta") ? { meta: optionalMeta(input.meta, `${field}.meta`) } : {}),
    });
}

function normalizeAction(value: unknown, field: string, configId: string, viewId: string) {
    const input = exactMenuRecord(value, ["id", "title", "resource", "opens", "response", "enabled", "i18nKey", "meta"], field);
    if (!Object.hasOwn(input, "title") || !Object.hasOwn(input, "resource")) {
        throw validationError("INVALID_ARGUMENT", field, "requires title and resource");
    }
    const parsed = normalizeActionResource(input.resource, `${field}.resource`);
    const actionId = Object.hasOwn(input, "id")
        ? normalizeRbacId(input.id, `${field}.id`)
        : stableId("mc-action", configId, viewId, parsed.resource);
    if (!parsed.resource.startsWith("api:") && Object.hasOwn(input, "response")) {
        throw validationError("INVALID_ARGUMENT", `${field}.response`, "is only valid for api actions");
    }
    return deepFreeze({
        actionId,
        ...(Object.hasOwn(input, "id") ? { id: actionId } : {}),
        title: normalizeRoleLabel(input.title, `${field}.title`),
        resource: parsed.resource,
        ...(parsed.resource.startsWith("api:") && Object.hasOwn(input, "response")
            ? { response: normalizeResponse(input.response as ResponseProjectionInput, `${field}.response`) }
            : {}),
        enabled: optionalBoolean(input, "enabled", `${field}.enabled`, true),
        ...(Object.hasOwn(input, "opens") ? { opens: normalizeRbacId(input.opens, `${field}.opens`) } : {}),
        ...(Object.hasOwn(input, "i18nKey") ? { i18nKey: boundedString(input.i18nKey, `${field}.i18nKey`, 512) } : {}),
        ...(Object.hasOwn(input, "meta") ? { meta: optionalMeta(input.meta, `${field}.meta`) } : {}),
    });
}

interface NormalizeContext {
    readonly configId: string;
    readonly menuIds: Set<string>;
    readonly viewIds: Set<string>;
    readonly actionKeys: Set<string>;
    viewCount: number;
    actionCount: number;
}

function normalizeView(value: unknown, field: string, menuId: string, context: NormalizeContext): MenuViewSnapshot {
    const input = exactMenuRecord(value, [
        "id", "type", "title", "path", "component", "url", "navigation", "enabled", "i18nKey", "load", "actions", "meta",
    ], field);
    for (const key of ["id", "type", "title"] as const) {
        if (!Object.hasOwn(input, key)) throw validationError("INVALID_ARGUMENT", `${field}.${key}`, "is required");
    }
    const viewId = normalizeRbacId(input.id, `${field}.id`);
    if (context.viewIds.has(viewId)) throw validationError("INVALID_ARGUMENT", `${field}.id`, `contains duplicate view id ${viewId}`);
    context.viewIds.add(viewId);
    context.viewCount += 1;
    if (context.viewCount > MAX_CONFIG_VIEWS) {
        throw new PermissionCoreError("LIMIT_EXCEEDED", "menu config view count exceeds its limit.", {
            details: { kind: "limit-exceeded", origin: "caller-input", limitName: "menu-config-views", current: context.viewCount, max: MAX_CONFIG_VIEWS, unit: "items" },
        });
    }
    if (!["page", "tab", "dialog", "drawer", "external", "iframe"].includes(input.type as string)) {
        throw validationError("INVALID_ARGUMENT", `${field}.type`, "is not a supported view type");
    }
    const type = input.type as MenuViewSnapshot["type"];
    const auxiliary = type === "tab" || type === "dialog" || type === "drawer";
    if (auxiliary && Object.hasOwn(input, "navigation")) {
        throw validationError("INVALID_ARGUMENT", `${field}.navigation`, "is fixed to false for auxiliary views");
    }
    if ((type === "page" || type === "tab" || type === "dialog" || type === "drawer") && !Object.hasOwn(input, "component")) {
        throw validationError("INVALID_ARGUMENT", `${field}.component`, `is required for ${type}`);
    }
    if (type === "page" && !Object.hasOwn(input, "path")) {
        throw validationError("INVALID_ARGUMENT", `${field}.path`, "is required for page");
    }
    if ((type === "external" || type === "iframe") && !Object.hasOwn(input, "url")) {
        throw validationError("INVALID_ARGUMENT", `${field}.url`, `is required for ${type}`);
    }
    if (type === "iframe" && !Object.hasOwn(input, "path")) {
        throw validationError("INVALID_ARGUMENT", `${field}.path`, "is required for iframe");
    }
    if ((type === "external" || type === "iframe") && Object.hasOwn(input, "component")) {
        throw validationError("INVALID_ARGUMENT", `${field}.component`, `is not valid for ${type}`);
    }
    if (type !== "external" && type !== "iframe" && Object.hasOwn(input, "url")) {
        throw validationError("INVALID_ARGUMENT", `${field}.url`, `is not valid for ${type}`);
    }
    if (auxiliary && Object.hasOwn(input, "path")) {
        throw validationError("INVALID_ARGUMENT", `${field}.path`, `is not valid for ${type}`);
    }
    const load = Object.hasOwn(input, "load")
        ? denseMenuArray(input.load, `${field}.load`, 64).map((entry, index) =>
            normalizeLoad(entry, `${field}.load[${index}]`, context.configId, viewId))
        : [];
    const actions = Object.hasOwn(input, "actions")
        ? denseMenuArray(input.actions, `${field}.actions`, 128).map((entry, index) => {
            const action = normalizeAction(entry, `${field}.actions[${index}]`, context.configId, viewId);
            context.actionCount += 1;
            if (context.actionCount > MAX_CONFIG_ACTIONS) {
                throw new PermissionCoreError("LIMIT_EXCEEDED", "menu config action count exceeds its limit.", {
                    details: { kind: "limit-exceeded", origin: "caller-input", limitName: "menu-config-actions", current: context.actionCount, max: MAX_CONFIG_ACTIONS, unit: "items" },
                });
            }
            return action;
        })
        : [];
    const resourcesInView = new Set<string>();
    for (const loadItem of load) {
        if (resourcesInView.has(loadItem.resource)) throw validationError("INVALID_ARGUMENT", `${field}.load`, `contains duplicate resource ${loadItem.resource}`);
        resourcesInView.add(loadItem.resource);
    }
    for (const action of actions) {
        const key = canonicalString([viewId, action.resource]);
        if (context.actionKeys.has(key)) throw validationError("INVALID_ARGUMENT", `${field}.actions`, `contains duplicate action resource ${action.resource}`);
        context.actionKeys.add(key);
        if (resourcesInView.has(action.resource)) throw validationError("INVALID_ARGUMENT", `${field}.actions`, `contains duplicate resource ${action.resource}`);
        resourcesInView.add(action.resource);
    }
    const snapshot = deepFreeze({
        id: viewId,
        type,
        title: normalizeRoleLabel(input.title, `${field}.title`),
        ...(Object.hasOwn(input, "path") ? { path: normalizeDeclaredPath(input.path, `${field}.path`) } : {}),
        ...(Object.hasOwn(input, "component") ? { component: boundedString(input.component, `${field}.component`, 2048) } : {}),
        ...(Object.hasOwn(input, "url") ? { url: normalizeHttpUrl(input.url, `${field}.url`) } : {}),
        navigation: auxiliary ? false : optionalBoolean(input, "navigation", `${field}.navigation`, true),
        enabled: optionalBoolean(input, "enabled", `${field}.enabled`, true),
        load: Object.freeze(load),
        actions: Object.freeze(actions),
        ...(Object.hasOwn(input, "i18nKey") ? { i18nKey: boundedString(input.i18nKey, `${field}.i18nKey`, 512) } : {}),
        ...(Object.hasOwn(input, "meta") ? { meta: optionalMeta(input.meta, `${field}.meta`) } : {}),
    }) satisfies MenuViewSnapshot;
    for (const action of snapshot.actions) {
        if (action.opens !== undefined && action.opens === viewId) {
            throw validationError("INVALID_ARGUMENT", `${field}.actions.opens`, "cannot reference the owning view");
        }
    }
    return snapshot;
}

function normalizeMenu(value: unknown, field: string, depth: number, context: NormalizeContext): MenuConfigMenuSnapshot {
    if (depth > MAX_CONFIG_DEPTH) {
        throw validationError("INVALID_ARGUMENT", field, `exceeds maximum menu depth ${MAX_CONFIG_DEPTH}`);
    }
    const input = exactMenuRecord(value, [
        "id", "title", "children", "views", "navigation", "enabled", "icon", "i18nKey", "meta",
    ], field);
    if (!Object.hasOwn(input, "id") || !Object.hasOwn(input, "title")) {
        throw validationError("INVALID_ARGUMENT", field, "requires id and title");
    }
    const menuId = normalizeRbacId(input.id, `${field}.id`);
    if (context.menuIds.has(menuId)) throw validationError("INVALID_ARGUMENT", `${field}.id`, `contains duplicate menu id ${menuId}`);
    context.menuIds.add(menuId);
    const hasChildren = Object.hasOwn(input, "children");
    const hasViews = Object.hasOwn(input, "views");
    if (hasChildren === hasViews) {
        throw validationError("INVALID_ARGUMENT", field, "must define exactly one of children or views");
    }
    const children = hasChildren
        ? denseMenuArray(input.children, `${field}.children`, MAX_CONFIG_MENUS)
            .map((entry, index) => normalizeMenu(entry, `${field}.children[${index}]`, depth + 1, context))
        : [];
    const views = hasViews
        ? denseMenuArray(input.views, `${field}.views`, MAX_CONFIG_VIEWS)
            .map((entry, index) => normalizeView(entry, `${field}.views[${index}]`, menuId, context))
        : [];
    if ((hasChildren && children.length === 0) || (hasViews && views.length === 0)) {
        throw validationError("INVALID_ARGUMENT", field, "children or views must be non-empty");
    }
    return deepFreeze({
        id: menuId,
        title: normalizeRoleLabel(input.title, `${field}.title`),
        children: Object.freeze(children),
        views: Object.freeze(views),
        navigation: optionalBoolean(input, "navigation", `${field}.navigation`, true),
        enabled: optionalBoolean(input, "enabled", `${field}.enabled`, true),
        ...(Object.hasOwn(input, "icon") ? { icon: boundedString(input.icon, `${field}.icon`, 512) } : {}),
        ...(Object.hasOwn(input, "i18nKey") ? { i18nKey: boundedString(input.i18nKey, `${field}.i18nKey`, 512) } : {}),
        ...(Object.hasOwn(input, "meta") ? { meta: optionalMeta(input.meta, `${field}.meta`) } : {}),
    }) satisfies MenuConfigMenuSnapshot;
}

function snapshotDigest(snapshot: Omit<MenuConfigSnapshot, "aggregateDigest">) {
    const { revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, ...content } = snapshot;
    return digestCanonical({ codecVersion: MENU_CONFIG_CODEC_VERSION, content });
}

function assertOpenTargets(menus: readonly MenuConfigMenuSnapshot[], viewIds: ReadonlySet<string>) {
    const visit = (menu: MenuConfigMenuSnapshot) => {
        for (const view of menu.views) {
            for (const action of view.actions) {
                if (action.opens !== undefined && !viewIds.has(action.opens)) {
                    throw validationError("INVALID_ARGUMENT", "config.menus.views.actions.opens", `references unknown view ${action.opens}`);
                }
            }
        }
        for (const child of menu.children) visit(child);
    };
    for (const menu of menus) visit(menu);
}

export function normalizeMenuConfigInput(
    value: MenuConfigInput,
    options: MenuConfigSnapshotOptions = {},
): MenuConfigSnapshot {
    const input = exactMenuRecord(value, ["configId", "title", "menus", "meta"], "config");
    if (!Object.hasOwn(input, "configId") || !Object.hasOwn(input, "menus")) {
        throw validationError("INVALID_ARGUMENT", "config", "requires configId and menus");
    }
    const configId = normalizeRbacId(input.configId, "config.configId");
    const context: NormalizeContext = {
        configId,
        menuIds: new Set(),
        viewIds: new Set(),
        actionKeys: new Set(),
        viewCount: 0,
        actionCount: 0,
    };
    const menus = denseMenuArray(input.menus, "config.menus", MAX_CONFIG_MENUS)
        .map((entry, index) => normalizeMenu(entry, `config.menus[${index}]`, 1, context));
    if (menus.length === 0) {
        throw validationError("INVALID_ARGUMENT", "config.menus", "must contain at least one menu");
    }
    assertOpenTargets(menus, context.viewIds);
    const revision = options.revision ?? 1;
    const createdAt = options.createdAt ?? 0;
    const updatedAt = options.updatedAt ?? createdAt;
    for (const [field, current] of Object.entries({ revision, createdAt, updatedAt })) {
        if (!Number.isSafeInteger(current) || current < 0) {
            throw validationError("INVALID_ARGUMENT", `options.${field}`, "must be a non-negative safe integer");
        }
    }
    if (updatedAt < createdAt) {
        throw validationError("INVALID_ARGUMENT", "options.updatedAt", "cannot precede createdAt");
    }
    const base = deepFreeze({
        configId,
        ...(Object.hasOwn(input, "title") ? { title: normalizeRoleLabel(input.title, "config.title") } : {}),
        menus: Object.freeze(menus),
        revision,
        createdAt,
        updatedAt,
        ...(Object.hasOwn(input, "meta") ? { meta: optionalMeta(input.meta, "config.meta") } : {}),
    });
    const snapshot = deepFreeze({
        ...base,
        aggregateDigest: snapshotDigest(base),
    }) satisfies MenuConfigSnapshot;
    assertMenuConfigBudget(snapshot);
    return snapshot;
}

function nodePermission(kind: "menu" | "view", configId: string, id: string) {
    return { action: "invoke" as const, resource: `ui:${kind}:${digestCanonical([configId, id])}` };
}

function status(enabled: boolean) {
    return enabled ? "enabled" as const : "disabled" as const;
}

function pushMenuNode(
    nodes: MenuManifestNodeInput[],
    configId: string,
    menu: MenuConfigMenuSnapshot,
    parentId: string | null,
    order: number,
) {
    const nodeId = stableId("mc-m", configId, menu.id);
    nodes.push({
        id: nodeId,
        parentId,
        type: "directory",
        title: menu.title,
        order,
        status: status(menu.enabled),
        hidden: !menu.navigation,
        permission: nodePermission("menu", configId, menu.id),
        ...(menu.icon === undefined ? {} : { icon: menu.icon }),
        ...(menu.i18nKey === undefined ? {} : { i18nKey: menu.i18nKey }),
        ...(menu.meta === undefined ? {} : { meta: menu.meta }),
    });
    return nodeId;
}

function viewNodeInput(configId: string, view: MenuViewSnapshot, parentId: string, order: number): MenuManifestNodeInput {
    const nodeId = stableId("mc-v", configId, view.id);
    const name = stableId("mc-name", configId, view.id);
    const auxiliary = view.type === "tab" || view.type === "dialog" || view.type === "drawer";
    const common = {
        id: nodeId,
        parentId,
        title: view.title,
        order,
        status: status(view.enabled),
        hidden: !view.navigation || auxiliary,
        permission: nodePermission("view", configId, view.id),
        ...(view.i18nKey === undefined ? {} : { i18nKey: view.i18nKey }),
        ...(view.meta === undefined ? {} : { meta: view.meta }),
    };
    if (view.type === "external") {
        return { ...common, type: "external", url: view.url! };
    }
    if (view.type === "iframe") {
        return { ...common, type: "iframe", path: view.path!, name, url: view.url! };
    }
    return {
        ...common,
        type: "page",
        path: auxiliary ? `${AUX_PATH_PREFIX}/${digestCanonical([configId, view.id])}` : view.path!,
        name,
        component: view.component!,
        meta: deepFreeze({
            ...(view.meta ?? {}),
            permissionCoreViewType: view.type,
        }) as Readonly<Record<string, PolicyValue>>,
    };
}

function apiOwnerNodeInput(configId: string, view: MenuViewSnapshot, parentId: string, order: number): MenuManifestNodeInput {
    return {
        id: stableId("mc-v-api", configId, view.id),
        parentId,
        type: "page",
        title: `${view.title} API`,
        path: `${AUX_PATH_PREFIX}/${digestCanonical([configId, view.id, "api-owner"])}`,
        name: stableId("mc-name-api", configId, view.id),
        component: "PermissionCoreApiOwner",
        order,
        status: status(view.enabled),
        hidden: true,
        permission: nodePermission("view", configId, view.id),
        meta: { permissionCoreViewType: view.type, permissionCoreApiOwner: true },
    };
}

function actionNodeInput(configId: string, view: MenuViewSnapshot, action: MenuViewSnapshot["actions"][number], parentId: string, order: number): MenuManifestNodeInput {
    const nodeId = stableId("mc-a", configId, view.id, action.resource);
    return {
        id: nodeId,
        parentId,
        type: "button",
        title: action.title,
        code: stableId("mc-code", configId, view.id, action.resource),
        order,
        status: status(action.enabled ?? true),
        hidden: false,
        permission: { action: "invoke", resource: action.resource },
        ...(action.i18nKey === undefined ? {} : { i18nKey: action.i18nKey }),
        ...(action.meta === undefined ? {} : { meta: action.meta }),
    };
}

function responseOwner(configId: string, viewId: string, source: ResponseOwnerSource): CompiledResponseOwner {
    return deepFreeze({ configId, viewId, source });
}

function addResponseDefinition(
    definitions: Map<string, CompiledResponseDefinition>,
    apiResource: ApiResource,
    response: NormalizedResponse | undefined,
    owner: CompiledResponseOwner,
) {
    if (response === undefined) return;
    definitions.set(
        canonicalString([apiResource, owner.configId, owner.viewId, owner.source]),
        compileResponseDefinition(apiResource, response, owner),
    );
}

function compileView(
    configId: string,
    menuId: string,
    view: MenuViewSnapshot,
    parentNodeId: string,
    order: number,
    output: {
        nodes: MenuManifestNodeInput[];
        apiOwners: CompiledApiOwner[];
        responses: Map<string, CompiledResponseDefinition>;
        viewIndex: Map<string, CompiledViewRef>;
        actionIndex: Map<string, CompiledActionRef>;
    },
) {
    const viewNode = viewNodeInput(configId, view, parentNodeId, order);
    output.nodes.push(viewNode);
    const requiresSyntheticApiOwner = (view.type === "external" || view.type === "iframe") && view.load.length > 0;
    if (requiresSyntheticApiOwner) {
        output.nodes.push(apiOwnerNodeInput(configId, view, viewNode.id, view.actions.length + 1));
    }
    const apiOwnerNodeId = requiresSyntheticApiOwner ? stableId("mc-v-api", configId, view.id) : viewNode.id;
    output.viewIndex.set(view.id, deepFreeze({ configId, menuId, viewId: view.id, nodeId: viewNode.id, apiOwnerNodeId }));
    for (const load of view.load) {
        const parsed = parseApiResource(load.resource, "load.resource");
        output.apiOwners.push(deepFreeze({
            apiResource: parsed.resource,
            method: parsed.method,
            path: parsed.path,
            purpose: "entry",
            owner: {
                type: "page",
                id: apiOwnerNodeId,
                required: true,
                availabilityGroup: stableId("mc-ag", configId, view.id),
                availabilityMode: "all",
            },
        }));
        addResponseDefinition(output.responses, parsed.resource, load.response as NormalizedResponse | undefined, responseOwner(configId, view.id, "load"));
    }
    view.actions.forEach((action, actionIndex) => {
        const node = actionNodeInput(configId, view, action, viewNode.id, actionIndex);
        output.nodes.push(node);
        output.actionIndex.set(canonicalString([view.id, action.resource]), deepFreeze({
            configId,
            viewId: view.id,
            actionId: action.actionId,
            resource: action.resource,
            nodeId: node.id,
            ...(action.opens === undefined ? {} : { opens: action.opens }),
        }));
        if (!action.resource.startsWith("api:")) return;
        const parsed = parseApiResource(action.resource, "action.resource");
        output.apiOwners.push(deepFreeze({
            apiResource: parsed.resource,
            method: parsed.method,
            path: parsed.path,
            purpose: "operation",
            owner: { type: "button", id: node.id, required: true },
        }));
        addResponseDefinition(output.responses, parsed.resource, action.response as NormalizedResponse | undefined, responseOwner(configId, view.id, "action"));
    });
}

function compileMenu(
    configId: string,
    menu: MenuConfigMenuSnapshot,
    parentNodeId: string | null,
    order: number,
    output: {
        nodes: MenuManifestNodeInput[];
        apiOwners: CompiledApiOwner[];
        responses: Map<string, CompiledResponseDefinition>;
        menuIndex: Map<string, CompiledMenuRef>;
        viewIndex: Map<string, CompiledViewRef>;
        actionIndex: Map<string, CompiledActionRef>;
    },
) {
    const nodeId = pushMenuNode(output.nodes, configId, menu, parentNodeId, order);
    output.menuIndex.set(menu.id, deepFreeze({ configId, menuId: menu.id, nodeId }));
    menu.children.forEach((child, index) => compileMenu(configId, child, nodeId, index, output));
    menu.views.forEach((view, index) => compileView(configId, menu.id, view, nodeId, index, output));
}

export function compileMenuConfigSnapshot(snapshot: MenuConfigSnapshot, schemes = new ResourceSchemeRegistry()): CompiledMenuConfig {
    const nodes: MenuManifestNodeInput[] = [];
    const apiOwners: CompiledApiOwner[] = [];
    const responses = new Map<string, CompiledResponseDefinition>();
    const menuIndex = new Map<string, CompiledMenuRef>();
    const viewIndex = new Map<string, CompiledViewRef>();
    const actionIndex = new Map<string, CompiledActionRef>();
    snapshot.menus.forEach((menu, index) => compileMenu(snapshot.configId, menu, null, index, {
        nodes,
        apiOwners,
        responses,
        menuIndex,
        viewIndex,
        actionIndex,
    }));
    const manifest: MenuManifestInput = {
        schemaVersion: 2,
        mode: "replace",
        nodes,
        apiBindings: [],
    };
    normalizeMenuManifestInput(manifest, schemes);
    const apiResources = [...new Set(apiOwners.map((owner) => owner.apiResource))].sort(compareUtf8);
    const actionResources = [...new Set([...actionIndex.values()].map((action) => action.resource))].sort(compareUtf8);
    const responseDefinitions = [...responses.values()].sort((left, right) =>
        compareUtf8(canonicalString([left.apiResource, left.owners]), canonicalString([right.apiResource, right.owners])));
    const configBytes = canonicalByteLength(snapshot);
    const responseFieldKeys = new Set(responseDefinitions.flatMap((response) =>
        response.fields.map((field) => canonicalString([response.apiResource, response.targetDigest, field.field]))));
    return deepFreeze({
        configId: snapshot.configId,
        ...(snapshot.title === undefined ? {} : { title: snapshot.title }),
        snapshot,
        configDigest: snapshot.aggregateDigest,
        nodes: Object.freeze(nodes),
        apiOwners: Object.freeze(apiOwners.sort((left, right) =>
            compareUtf8(canonicalString([left.apiResource, left.owner]), canonicalString([right.apiResource, right.owner])))),
        responseDefinitions: Object.freeze(responseDefinitions),
        menuIndex,
        viewIndex,
        actionIndex,
        index: {
            menuIds: Object.freeze([...collectMenuIds(snapshot.menus)].sort(compareUtf8)),
            viewIds: Object.freeze([...viewIndex.keys()].sort(compareUtf8)),
            actionResources: Object.freeze(actionResources),
            apiResources: Object.freeze(apiResources),
        },
        metrics: {
            menuCount: collectMenuIds(snapshot.menus).size,
            viewCount: viewIndex.size,
            actionCount: actionIndex.size,
            apiCount: apiResources.length,
            responseFieldCount: responseFieldKeys.size,
            responseFieldOwnerCount: responseDefinitions.reduce(
                (total, response) => total + response.fields.reduce((fieldTotal, field) => fieldTotal + field.owners.length, 0),
                0,
            ),
            configBytes,
        },
    });
}

function collectMenuIds(menus: readonly MenuConfigMenuSnapshot[], output = new Set<string>()) {
    for (const menu of menus) {
        output.add(menu.id);
        collectMenuIds(menu.children, output);
    }
    return output;
}

export function compileMenuConfigInput(
    value: MenuConfigInput,
    options: MenuConfigSnapshotOptions = {},
    schemes = new ResourceSchemeRegistry(),
) {
    return compileMenuConfigSnapshot(normalizeMenuConfigInput(value, options), schemes);
}
