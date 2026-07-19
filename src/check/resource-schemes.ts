import { types as utilTypes } from "node:util";
import type {
    ResourceSchemeDefinition,
    ResourceSchemeProbe,
} from "../types";
import { PermissionCoreError, validationError } from "../core/errors";
import {
    CANONICAL_CONTRACT_VERSION,
    compareUtf8,
    digestCanonical,
} from "../internal/canonical";
import { isWellFormedUnicode } from "../internal/unicode";
import {
    getBuiltInResourceKind,
    isValidBuiltInResource,
    matchBuiltInResource,
    type ResourceMode,
} from "./built-in-resources";

interface NormalizedCustomScheme {
    readonly scheme: string;
    readonly version: string;
    readonly probes: readonly Readonly<ResourceSchemeProbe>[];
    readonly validate: (resource: string) => boolean;
    readonly match: (pattern: string, resource: string) => boolean;
}

const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]{0,31}$/u;
const VERSION_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u;
const RESERVED_SCHEMES = new Set(["api", "db", "http", "ui"]);

function configurationError(field: string, reason: string): never {
    throw validationError("INVALID_CONFIGURATION", field, reason);
}

function resourceError(reason: string): never {
    throw validationError("INVALID_RESOURCE", "resource", reason);
}

function snapshotConfigurationArray(
    value: unknown,
    field: string,
    minimumItems: number,
    maximumItems: number,
) {
    if (!Array.isArray(value)) {
        configurationError(field, "must be an array");
    }
    if (utilTypes.isProxy(value)) {
        configurationError(field, "cannot be a Proxy");
    }
    const length = (Object.getOwnPropertyDescriptor(value, "length") as PropertyDescriptor).value as number;
    if (length < minimumItems || length > maximumItems) {
        configurationError(field, `must contain ${minimumItems}..${maximumItems} items`);
    }

    const snapshot = new Array<unknown>(length);
    let indexCount = 0;
    for (const key of Reflect.ownKeys(value)) {
        if (key === "length") {
            continue;
        }
        if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= length) {
            configurationError(field, "cannot contain non-index array properties");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
            configurationError(`${field}[${key}]`, "must be an enumerable data property");
        }
        snapshot[Number(key)] = descriptor.value;
        indexCount += 1;
    }
    if (indexCount !== length) {
        configurationError(field, "cannot be a sparse array");
    }
    return snapshot;
}

function assertExactObjectKeys(value: unknown, allowed: readonly string[], field: string) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        configurationError(field, "must be a plain object");
    }
    if (utilTypes.isProxy(value)) {
        configurationError(field, "cannot be a Proxy");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        configurationError(field, "must be a plain object");
    }
    const record = value as Record<string, unknown>;
    const allowedSet = new Set(allowed);
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || !allowedSet.has(key)) {
            configurationError(field, `contains unsupported key ${String(key)}`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !("value" in descriptor)) {
            configurationError(`${field}.${key}`, "must be an enumerable data property");
        }
    }
    return record;
}

function normalizeProbe(value: unknown, field: string): Readonly<ResourceSchemeProbe> {
    const record = assertExactObjectKeys(value, ["pattern", "resource", "expected"], field);
    if (typeof record.pattern !== "string" || !record.pattern || Buffer.byteLength(record.pattern, "utf8") > 1024) {
        configurationError(`${field}.pattern`, "must be a non-empty string of at most 1024 UTF-8 bytes");
    }
    if (!isWellFormedUnicode(record.pattern)) {
        configurationError(`${field}.pattern`, "cannot contain an unpaired UTF-16 surrogate");
    }
    if (typeof record.resource !== "string" || !record.resource || Buffer.byteLength(record.resource, "utf8") > 1024) {
        configurationError(`${field}.resource`, "must be a non-empty string of at most 1024 UTF-8 bytes");
    }
    if (!isWellFormedUnicode(record.resource)) {
        configurationError(`${field}.resource`, "cannot contain an unpaired UTF-16 surrogate");
    }
    if (typeof record.expected !== "boolean") {
        configurationError(`${field}.expected`, "must be a boolean");
    }
    return Object.freeze({
        pattern: record.pattern,
        resource: record.resource,
        expected: record.expected,
    });
}

function normalizeCustomScheme(value: ResourceSchemeDefinition, index: number): NormalizedCustomScheme {
    const field = `resourceSchemes[${index}]`;
    const record = assertExactObjectKeys(value, ["scheme", "version", "probes", "validate", "match"], field);
    if (typeof record.scheme !== "string" || !SCHEME_PATTERN.test(record.scheme)) {
        configurationError(`${field}.scheme`, "does not match the custom scheme grammar");
    }
    if (RESERVED_SCHEMES.has(record.scheme)) {
        configurationError(`${field}.scheme`, "is reserved by a built-in resource contract");
    }
    if (typeof record.version !== "string" || !VERSION_PATTERN.test(record.version)) {
        configurationError(`${field}.version`, "does not match the behavior version grammar");
    }
    const probeValues = snapshotConfigurationArray(record.probes, `${field}.probes`, 1, 16);
    if (typeof record.validate !== "function" || typeof record.match !== "function") {
        configurationError(field, "validate and match must be functions");
    }

    const probes = probeValues.map((probe, probeIndex) => normalizeProbe(probe, `${field}.probes[${probeIndex}]`));
    const probeKeys = new Set<string>();
    for (const probe of probes) {
        const key = digestCanonical(probe);
        if (probeKeys.has(key)) {
            configurationError(`${field}.probes`, "cannot contain duplicate probes");
        }
        probeKeys.add(key);
        if (!probe.pattern.startsWith(`${record.scheme}:`) || !probe.resource.startsWith(`${record.scheme}:`)) {
            configurationError(`${field}.probes`, "must stay inside the declared scheme");
        }
    }

    return Object.freeze({
        scheme: record.scheme,
        version: record.version,
        probes: Object.freeze(probes),
        validate: record.validate as (resource: string) => boolean,
        match: record.match as (pattern: string, resource: string) => boolean,
    });
}

export class ResourceSchemeRegistry {
    readonly schemeContractDigest: string;
    private readonly customSchemes: ReadonlyMap<string, NormalizedCustomScheme>;

    constructor(definitions: readonly ResourceSchemeDefinition[] = []) {
        const definitionValues = snapshotConfigurationArray(definitions, "resourceSchemes", 0, 32);
        const customSchemes = new Map<string, NormalizedCustomScheme>();
        definitionValues.forEach((definition, index) => {
            const normalized = normalizeCustomScheme(definition as ResourceSchemeDefinition, index);
            if (customSchemes.has(normalized.scheme)) {
                configurationError(`resourceSchemes[${index}].scheme`, "must be unique");
            }
            customSchemes.set(normalized.scheme, normalized);
        });
        this.customSchemes = customSchemes;

        const customContract = [...customSchemes.values()]
            .sort((left, right) => compareUtf8(left.scheme, right.scheme))
            .map((definition) => ({
                scheme: definition.scheme,
                version: definition.version,
                probes: [...definition.probes].sort((left, right) => compareUtf8(
                    `${left.pattern}\u0000${left.resource}\u0000${left.expected}`,
                    `${right.pattern}\u0000${right.resource}\u0000${right.expected}`,
                )),
            }));
        this.schemeContractDigest = digestCanonical({
            canonicalContractVersion: CANONICAL_CONTRACT_VERSION,
            builtIns: ["global@2", "http@2", "api@2", "db@2", "ui@2"],
            custom: customContract,
        });
    }

    verifyProbes() {
        for (const definition of this.customSchemes.values()) {
            for (const probe of definition.probes) {
                try {
                    const validationOne = definition.validate(probe.resource);
                    const validationTwo = definition.validate(probe.resource);
                    const matchOne = definition.match(probe.pattern, probe.resource);
                    const matchTwo = definition.match(probe.pattern, probe.resource);
                    if (
                        typeof validationOne !== "boolean"
                        || typeof validationTwo !== "boolean"
                        || typeof matchOne !== "boolean"
                        || typeof matchTwo !== "boolean"
                        || validationOne !== validationTwo
                        || matchOne !== matchTwo
                        || !validationOne
                        || matchOne !== probe.expected
                    ) {
                        configurationError(`resourceSchemes.${definition.scheme}.probes`, "callback contract is invalid or non-deterministic");
                    }
                } catch (error) {
                    if (error instanceof PermissionCoreError) {
                        throw error;
                    }
                    configurationError(`resourceSchemes.${definition.scheme}.probes`, "callback threw during deterministic verification");
                }
            }
        }
    }

    validate(value: string, mode: ResourceMode) {
        if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > 1024 || !isWellFormedUnicode(value)) {
            resourceError("must be a non-empty string of at most 1024 UTF-8 bytes");
        }
        if (value === "*") {
            if (mode !== "pattern") {
                resourceError("global wildcard is only valid in a rule pattern");
            }
            return;
        }

        const kind = getBuiltInResourceKind(value);
        if (kind && isValidBuiltInResource(value, mode, kind)) {
            return;
        }
        if (kind) {
            resourceError(`violates the built-in ${kind} resource grammar`);
        }

        const scheme = value.match(/^([a-z][a-z0-9+.-]{0,31}):/u)?.[1];
        const definition = scheme ? this.customSchemes.get(scheme) : undefined;
        if (!definition) {
            resourceError("uses an unknown resource scheme");
        }
        if (mode === "resource") {
            try {
                if (definition.validate(value) !== true) {
                    resourceError(`was rejected by custom scheme ${scheme}`);
                }
            } catch (error) {
                if (error instanceof PermissionCoreError) {
                    throw error;
                }
                resourceError(`custom scheme ${scheme} threw while validating`);
            }
        }
    }

    match(pattern: string, resource: string) {
        this.validate(pattern, "pattern");
        this.validate(resource, "resource");
        if (pattern === "*") {
            return true;
        }

        const patternKind = getBuiltInResourceKind(pattern);
        const resourceKind = getBuiltInResourceKind(resource);
        if (patternKind || resourceKind) {
            return matchBuiltInResource(pattern, resource);
        }

        const scheme = pattern.match(/^([a-z][a-z0-9+.-]{0,31}):/u)?.[1];
        const resourceScheme = resource.match(/^([a-z][a-z0-9+.-]{0,31}):/u)?.[1];
        if (!scheme || scheme !== resourceScheme) {
            return false;
        }
        const definition = this.customSchemes.get(scheme)!;
        try {
            const result = definition.match(pattern, resource);
            if (typeof result !== "boolean") {
                resourceError(`custom scheme ${scheme} returned a non-boolean match result`);
            }
            return result;
        } catch (error) {
            if (error instanceof PermissionCoreError) {
                throw error;
            }
            resourceError(`custom scheme ${scheme} threw while matching`);
        }
    }
}
