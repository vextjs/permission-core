import type {
    PermissionAction,
    PermissionSubject,
    PolicyContext,
    RowCondition,
} from "../types";
import { ResourceSchemeRegistry } from "../check/resource-schemes";
import { matchPermissionRuleAction } from "../policy/action";
import {
    createContextFailureError,
    createPolicyEvaluationEnvironment,
    evaluateNormalizedRowCondition,
    resolveNormalizedRowCondition,
} from "../policy/condition";
import type { EffectiveAuthorizationState, EffectiveRuleState } from "../rbac/effective";
import {
    compileResolvedRowCondition,
    mongoFilterCombinators,
    type MongoFilterDocument,
} from "./condition-compiler";

interface ResolvedRule {
    readonly effect: "allow" | "deny";
    readonly condition?: RowCondition;
    readonly trueFilter?: MongoFilterDocument;
    readonly falseFilter?: MongoFilterDocument;
    readonly rule: EffectiveRuleState;
}

function resolveRule(
    rule: EffectiveRuleState,
    subject: PermissionSubject,
    context: PolicyContext,
): ResolvedRule {
    if (rule.document.where === undefined) {
        return Object.freeze({ effect: rule.document.effect, rule });
    }
    const resolved = resolveNormalizedRowCondition(rule.document.where, subject, context);
    if (resolved.contextFailure) {
        throw createContextFailureError(resolved.contextFailure);
    }
    const partition = compileResolvedRowCondition(resolved.condition!);
    return Object.freeze({
        effect: rule.document.effect,
        condition: resolved.condition!,
        trueFilter: partition.trueFilter,
        falseFilter: partition.falseFilter,
        rule,
    });
}

function collectConditionFields(condition: RowCondition, output: Set<string>) {
    if ("all" in condition) {
        condition.all.forEach((child) => collectConditionFields(child, output));
    } else if ("any" in condition) {
        condition.any.forEach((child) => collectConditionFields(child, output));
    } else if ("not" in condition) {
        collectConditionFields(condition.not, output);
    } else {
        output.add(condition.field);
    }
}

function fieldRuleCollection(pattern: string) {
    const match = /^db:([^:]+):field:(.+)$/u.exec(pattern);
    return match ? { collection: match[1], field: match[2] } : undefined;
}

function evaluateRule(
    rule: ResolvedRule,
    subject: PermissionSubject,
    context: PolicyContext,
    document: Readonly<Record<string, unknown>>,
) {
    if (rule.condition === undefined) return "true" as const;
    return evaluateNormalizedRowCondition(
        rule.condition,
        createPolicyEvaluationEnvironment(subject, context, document),
    ).outcome;
}

export class DataAuthorizationPlan {
    readonly mode: "allow" | "none";
    readonly permissionFilter: MongoFilterDocument;
    readonly rowPolicyFields: readonly string[];
    readonly rbacRevision: number;
    readonly menuRevision: number;
    private readonly baseRules: readonly ResolvedRule[];
    private readonly fieldRules: readonly ResolvedRule[];
    private readonly hasFieldAllow: boolean;

    constructor(
        state: EffectiveAuthorizationState,
        private readonly schemes: ResourceSchemeRegistry,
        private readonly subject: PermissionSubject,
        private readonly context: PolicyContext,
        readonly action: PermissionAction,
        readonly resource: string,
        revisions: { readonly rbacRevision: number; readonly menuRevision: number },
    ) {
        const base = state.rules
            .filter((entry) => (
                matchPermissionRuleAction(entry.document.action, action)
                && schemes.match(entry.document.resource, resource)
            ))
            .map((entry) => resolveRule(entry, subject, context));
        const logicalCollection = resource.slice("db:".length);
        const field = state.rules
            .filter((entry) => {
                if (!matchPermissionRuleAction(entry.document.action, action)) return false;
                const parsed = fieldRuleCollection(entry.document.resource);
                return parsed !== undefined && (parsed.collection === "*" || parsed.collection === logicalCollection);
            })
            .map((entry) => resolveRule(entry, subject, context));

        this.baseRules = Object.freeze(base);
        this.fieldRules = Object.freeze(field);
        this.hasFieldAllow = field.some((entry) => entry.effect === "allow");
        this.rbacRevision = revisions.rbacRevision;
        this.menuRevision = revisions.menuRevision;

        const rowFields = new Set<string>();
        for (const rule of base) {
            if (rule.condition) collectConditionFields(rule.condition, rowFields);
        }
        this.rowPolicyFields = Object.freeze([...rowFields]);

        const allows = base.filter((entry) => entry.effect === "allow");
        const denies = base.filter((entry) => entry.effect === "deny");
        if (allows.length === 0 || denies.some((entry) => entry.condition === undefined)) {
            this.mode = "none";
            this.permissionFilter = mongoFilterCombinators.impossible();
            return;
        }
        const allowFilter = allows.some((entry) => entry.condition === undefined)
            ? {}
            : mongoFilterCombinators.or(allows.map((entry) => entry.trueFilter!));
        const denyFilters = denies.map((entry) => entry.falseFilter!);
        this.mode = "allow";
        this.permissionFilter = mongoFilterCombinators.and([allowFilter, ...denyFilters]);
    }

    allowsDocument(document: Readonly<Record<string, unknown>>) {
        if (this.mode === "none") return false;
        const denied = this.baseRules
            .filter((entry) => entry.effect === "deny")
            .some((entry) => {
                const outcome = evaluateRule(entry, this.subject, this.context, document);
                return outcome === "true" || outcome === "unknown";
            });
        if (denied) return false;
        return this.baseRules
            .filter((entry) => entry.effect === "allow")
            .some((entry) => evaluateRule(entry, this.subject, this.context, document) === "true");
    }

    private matchingFieldRules(path: string) {
        const target = `${this.resource}:field:${path}`;
        return this.fieldRules.filter((entry) => this.schemes.match(entry.rule.document.resource, target));
    }

    private descendantFieldRules(path: string) {
        return this.fieldRules.filter((entry) => {
            const parsed = fieldRuleCollection(entry.rule.document.resource);
            if (!parsed || parsed.field === "*") return false;
            if (parsed.field.endsWith(".*")) {
                const prefix = parsed.field.slice(0, -2);
                return prefix === path || prefix.startsWith(`${path}.`);
            }
            return parsed.field.startsWith(`${path}.`);
        });
    }

    canReadField(path: string, document: Readonly<Record<string, unknown>>) {
        const matching = this.matchingFieldRules(path);
        const denied = matching
            .filter((entry) => entry.effect === "deny")
            .some((entry) => {
                const outcome = evaluateRule(entry, this.subject, this.context, document);
                return outcome === "true" || outcome === "unknown";
            });
        if (denied) return false;
        if (!this.hasFieldAllow) return true;
        return matching
            .filter((entry) => entry.effect === "allow")
            .some((entry) => evaluateRule(entry, this.subject, this.context, document) === "true");
    }

    canUseFieldInQuery(path: string) {
        const matching = this.matchingFieldRules(path);
        if (matching.some((entry) => entry.effect === "deny")) return false;
        const descendants = this.descendantFieldRules(path);
        if (descendants.some((entry) => entry.effect === "deny" || entry.condition !== undefined)) return false;
        if (!this.hasFieldAllow) return true;
        return matching.some((entry) => entry.effect === "allow" && entry.condition === undefined);
    }

    canRequestField(path: string) {
        const matching = this.matchingFieldRules(path);
        if (matching.some((entry) => entry.effect === "deny" && entry.condition === undefined)) return false;
        if (!this.hasFieldAllow) return true;
        return matching.some((entry) => entry.effect === "allow");
    }

    canWriteField(path: string, document: Readonly<Record<string, unknown>>) {
        const descendants = this.descendantFieldRules(path);
        if (descendants.some((entry) => entry.effect === "deny" || entry.condition !== undefined)) return false;
        return this.canReadField(path, document);
    }

    isFieldWriteUnconditional(path: string) {
        const matching = this.matchingFieldRules(path);
        if (matching.some((entry) => entry.effect === "deny")) return false;
        const descendants = this.descendantFieldRules(path);
        if (descendants.some((entry) => entry.effect === "deny" || entry.condition !== undefined)) return false;
        if (!this.hasFieldAllow) return true;
        return matching.some((entry) => entry.effect === "allow" && entry.condition === undefined);
    }
}
