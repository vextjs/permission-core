import type {
    EffectivePermissionSnapshot,
    EffectiveResourcePattern,
    PermissionAction,
    PermissionActionEvaluation,
    PermissionDecisionReason,
    PermissionDecisionTrace,
    PermissionExplanation,
    PermissionSubject,
    PolicyContext,
    PolicyConditionOutcome,
    SubjectRuntimeResult,
} from "../types";
import { PermissionCoreError } from "../core/errors";
import { ResourceSchemeRegistry } from "../check/resource-schemes";
import {
    expandPermissionAction,
    matchPermissionRuleAction,
    normalizePermissionAction,
} from "../policy/action";
import {
    createContextFailureError,
    createPolicyEvaluationEnvironment,
    evaluateNormalizedRowCondition,
    type PolicyContextFailure,
} from "../policy/condition";
import { canonicalString, compareUtf8 } from "../internal/canonical";
import { deepFreeze } from "../internal/plain-data";
import {
    subjectPermissionSnapshot,
    type EffectiveAuthorizationState,
    type EffectiveRuleState,
} from "./effective";
import { DetailBudgetAllocator, assertAuthorizationResponseBudget } from "./result";

interface RuleEvaluation {
    readonly trace: PermissionDecisionTrace;
    readonly effect: "allow" | "deny";
    readonly outcome: PolicyConditionOutcome;
    readonly contextFailure?: PolicyContextFailure;
}

interface ActionDecision {
    readonly action: PermissionAction;
    readonly allowed: boolean;
    readonly reason: PermissionDecisionReason;
    readonly evaluations: readonly RuleEvaluation[];
    readonly contextFailure?: PolicyContextFailure;
}

const REASON_PRIORITY: readonly PermissionDecisionReason[] = [
    "context-missing",
    "explicit-deny",
    "policy-unknown",
    "role-disabled",
    "no-allow",
];

function ruleTrace(rule: EffectiveRuleState, outcome: PolicyConditionOutcome): PermissionDecisionTrace {
    return deepFreeze({
        effect: rule.document.effect,
        ruleAction: rule.document.action,
        ruleResource: rule.document.resource,
        sourceRoleId: rule.sourceRoleId,
        inherited: rule.inherited,
        whereOutcome: outcome,
    });
}

function decideReason(
    evaluations: readonly RuleEvaluation[],
    allRolesExcluded: boolean,
) {
    const contextFailure = evaluations.find((entry) => entry.contextFailure)?.contextFailure;
    if (contextFailure) {
        return { reason: "context-missing" as const, contextFailure };
    }
    const denies = evaluations.filter((entry) => entry.effect === "deny");
    const allows = evaluations.filter((entry) => entry.effect === "allow");
    if (denies.some((entry) => entry.outcome === "true" || entry.outcome === "not-applicable")) {
        return { reason: "explicit-deny" as const };
    }
    if (
        denies.some((entry) => entry.outcome === "unknown")
        || (
            allows.length > 0
            && !allows.some((entry) => entry.outcome === "true" || entry.outcome === "not-applicable")
            && allows.some((entry) => entry.outcome === "unknown")
        )
    ) {
        return { reason: "policy-unknown" as const };
    }
    if (allows.some((entry) => entry.outcome === "true" || entry.outcome === "not-applicable")) {
        return { reason: "allow" as const };
    }
    return { reason: allRolesExcluded ? "role-disabled" as const : "no-allow" as const };
}

function publicEvaluation(decision: ActionDecision, budget: DetailBudgetAllocator): PermissionActionEvaluation {
    const allows = decision.evaluations
        .filter((entry) => entry.effect === "allow")
        .map((entry) => entry.trace);
    const denies = decision.evaluations
        .filter((entry) => entry.effect === "deny")
        .map((entry) => entry.trace);
    return deepFreeze({
        action: decision.action,
        allowed: decision.allowed,
        reason: decision.reason,
        evaluatedAllows: budget.bounded(allows),
        evaluatedDenies: budget.bounded(denies),
    });
}

function explanationReason(decisions: readonly ActionDecision[]): PermissionDecisionReason {
    if (decisions.every((decision) => decision.allowed)) {
        return "allow";
    }
    for (const reason of REASON_PRIORITY) {
        if (decisions.some((decision) => decision.reason === reason)) {
            return reason;
        }
    }
    return "no-allow";
}

export class SubjectAuthorizationRuntime {
    private snapshotPromise?: Promise<EffectiveAuthorizationState>;
    private contextValidationPromise?: Promise<void>;

    constructor(
        private readonly loadAuthorizationState: () => Promise<EffectiveAuthorizationState>,
        private readonly resourceSchemes: ResourceSchemeRegistry,
        private readonly subject: Readonly<PermissionSubject>,
        private readonly context: PolicyContext,
    ) {}

    loadState() {
        if (!this.snapshotPromise) {
            this.snapshotPromise = this.loadAuthorizationState();
        }
        return this.snapshotPromise;
    }

    ensurePolicyContextComplete() {
        if (!this.contextValidationPromise) {
            this.contextValidationPromise = (async () => {
                const state = await this.loadState();
                const environment = createPolicyEvaluationEnvironment(this.subject, this.context, this.context);
                for (const rule of state.rules) {
                    if (rule.document.where === undefined) continue;
                    const evaluated = evaluateNormalizedRowCondition(rule.document.where, environment);
                    if (evaluated.contextFailure !== undefined) {
                        throw createContextFailureError(evaluated.contextFailure);
                    }
                }
            })();
        }
        return this.contextValidationPromise;
    }

    private async decideOne(action: PermissionAction, resource: string): Promise<ActionDecision> {
        const state = await this.loadState();
        const evaluations: RuleEvaluation[] = [];
        const environment = createPolicyEvaluationEnvironment(this.subject, this.context, this.context);
        for (const rule of state.rules) {
            if (
                !matchPermissionRuleAction(rule.document.action, action)
                || !this.resourceSchemes.match(rule.document.resource, resource)
            ) {
                continue;
            }
            if (rule.document.where === undefined) {
                evaluations.push(deepFreeze({
                    trace: ruleTrace(rule, "not-applicable"),
                    effect: rule.document.effect,
                    outcome: "not-applicable" as const,
                }));
                continue;
            }
            const evaluated = evaluateNormalizedRowCondition(rule.document.where, environment);
            evaluations.push(deepFreeze({
                trace: ruleTrace(rule, evaluated.outcome),
                effect: rule.document.effect,
                outcome: evaluated.outcome,
                ...(evaluated.contextFailure === undefined ? {} : { contextFailure: evaluated.contextFailure }),
            }));
        }
        const allRolesExcluded = state.direct.roleIds.length > 0 && !state.roles.some((role) => role.included);
        const result = decideReason(evaluations, allRolesExcluded);
        return deepFreeze({
            action,
            allowed: result.reason === "allow",
            reason: result.reason,
            evaluations,
            ...(result.contextFailure === undefined ? {} : { contextFailure: result.contextFailure }),
        });
    }

    private async decisions(actionInput: unknown, resourceInput: unknown) {
        const action = normalizePermissionAction(actionInput);
        if (typeof resourceInput !== "string") {
            this.resourceSchemes.validate(resourceInput as string, "resource");
        }
        const resource = resourceInput as string;
        this.resourceSchemes.validate(resource, "resource");
        const actions = expandPermissionAction(action);
        const decisions: ActionDecision[] = [];
        for (const expanded of actions) {
            decisions.push(await this.decideOne(expanded, resource));
        }
        return { action, resource, decisions: deepFreeze(decisions) };
    }

    async can(action: PermissionAction, resource: string) {
        const result = await this.decisions(action, resource);
        const contextFailure = result.decisions.find((decision) => decision.contextFailure)?.contextFailure;
        if (contextFailure) {
            throw createContextFailureError(contextFailure);
        }
        return result.decisions.every((decision) => decision.allowed);
    }

    async cannot(action: PermissionAction, resource: string) {
        return !(await this.can(action, resource));
    }

    async assert(action: PermissionAction, resource: string) {
        if (!(await this.can(action, resource))) {
            throw new PermissionCoreError("PERMISSION_DENIED", "The subject is not allowed to perform this operation.");
        }
    }

    async getPermissions(): Promise<SubjectRuntimeResult<EffectivePermissionSnapshot>> {
        const state = await this.loadState();
        const { snapshot, detailBudget } = subjectPermissionSnapshot(this.subject.scope, state);
        return deepFreeze({ data: snapshot, detailBudget });
    }

    async getResources(actionInput?: PermissionAction): Promise<SubjectRuntimeResult<EffectiveResourcePattern[]>> {
        const actions = actionInput === undefined
            ? undefined
            : expandPermissionAction(normalizePermissionAction(actionInput));
        const state = await this.loadState();
        const patterns = new Map<string, {
            action: EffectiveResourcePattern["action"];
            resource: string;
            where?: EffectiveResourcePattern["where"];
            sourceRoleIds: Set<string>;
        }>();
        for (const rule of state.rules) {
            if (
                rule.document.effect !== "allow"
                || (actions && !actions.some((action) => matchPermissionRuleAction(rule.document.action, action)))
            ) {
                continue;
            }
            const key = canonicalString({
                action: rule.document.action,
                resource: rule.document.resource,
                where: rule.document.where ?? null,
            });
            const existing = patterns.get(key) ?? {
                action: rule.document.action,
                resource: rule.document.resource,
                ...(rule.document.where === undefined ? {} : { where: rule.document.where }),
                sourceRoleIds: new Set<string>(),
            };
            existing.sourceRoleIds.add(rule.sourceRoleId);
            patterns.set(key, existing);
        }
        const complete = [...patterns.values()]
            .sort((left, right) => (
                compareUtf8(left.action, right.action)
                || compareUtf8(left.resource, right.resource)
                || compareUtf8(canonicalString(left.where ?? null), canonicalString(right.where ?? null))
            ));
        const budget = new DetailBudgetAllocator();
        const resources: EffectiveResourcePattern[] = complete.map((entry) => deepFreeze({
            action: entry.action,
            resource: entry.resource,
            conditional: entry.where !== undefined,
            ...(entry.where === undefined ? {} : { where: entry.where }),
            sourceRoleIds: budget.bounded([...entry.sourceRoleIds].sort(compareUtf8)),
        }));
        const detailBudget = budget.finish(complete.map((entry) => ({
            action: entry.action,
            resource: entry.resource,
            where: entry.where ?? null,
            sourceRoleIds: [...entry.sourceRoleIds].sort(compareUtf8),
        })));
        assertAuthorizationResponseBudget({ resources, detailBudget });
        return deepFreeze({ data: resources, detailBudget });
    }

    async explain(
        action: PermissionAction,
        resource: string,
    ): Promise<SubjectRuntimeResult<PermissionExplanation>> {
        const result = await this.decisions(action, resource);
        const budget = new DetailBudgetAllocator();
        const evaluations = result.decisions.map((decision) => publicEvaluation(decision, budget));
        const explanation: PermissionExplanation = deepFreeze({
            allowed: result.decisions.every((decision) => decision.allowed),
            action: result.action,
            resource: result.resource,
            reason: explanationReason(result.decisions),
            evaluations,
        });
        const completeTraces = result.decisions.map((decision) => ({
            action: decision.action,
            allows: decision.evaluations.filter((entry) => entry.effect === "allow").map((entry) => entry.trace),
            denies: decision.evaluations.filter((entry) => entry.effect === "deny").map((entry) => entry.trace),
        }));
        const detailBudget = budget.finish(completeTraces);
        assertAuthorizationResponseBudget({ explanation, detailBudget });
        return deepFreeze({ data: explanation, detailBudget });
    }
}
