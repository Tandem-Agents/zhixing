import path from "node:path";
import {
  bindPermissionRuleExecutionSource,
  createPermissionStoreTrustAdministrationRepository,
  PermissionStore,
  toPermissionContext,
  type PermissionStoreOptions,
} from "@zhixing/core/security";
import type {
  TrustAdministrationExecutionApplication,
  TrustAdministrationRepository,
  TrustAdministrationRepositoryRule,
} from "@zhixing/core/trust-administration";
import { TrustAdministrationExecutionApplicationService } from "@zhixing/core/trust-administration";
import type {
  KernelSecurityApprovalResult,
  KernelSecurityExecution,
  KernelSecurityExecutionFactory,
} from "@zhixing/orchestrator/runtime";

export type RuntimeTrustProductContext =
  | { readonly kind: "default" }
  | { readonly kind: "scene"; readonly sceneId: string };

export interface RuntimeSecurityExecutionInfrastructure {
  bind(context: RuntimeTrustProductContext): KernelSecurityExecutionFactory;
}

export interface PermissionStorageInfrastructure {
  /** Fresh read-through management role; it never shares a runtime session pool. */
  readonly management: TrustAdministrationRepository;
  /** Stable workspace identity projection used by Trust Administration. */
  readonly workspaceIdentity: (workspacePath: string) => string;
  /** Product-context binder for runtime-scoped Security execution. */
  readonly runtime: RuntimeSecurityExecutionInfrastructure;
}

/**
 * The single Host infrastructure owner for the P04 permission file mechanism.
 *
 * Runtime stores remain instance-scoped so session rules live exactly as long
 * as their AgentRuntime. Management operations use fresh read-through stores so
 * a revoke observes the latest durable file rather than another runtime's cache.
 */
export function createPermissionStorageInfrastructure(input: Readonly<{
  zhixingHome: string;
}>): PermissionStorageInfrastructure {
  const rootDir = path.join(input.zhixingHome, "permissions");
  const createStore = (
    extractArgument?: PermissionStoreOptions["extractArgument"],
  ) =>
    new PermissionStore({
      rootDir,
      ...(extractArgument ? { extractArgument } : {}),
    });

  const management = createPermissionStoreTrustAdministrationRepository(
    () => createStore(),
  );
  const runtime: RuntimeSecurityExecutionInfrastructure = Object.freeze({
    bind(context: RuntimeTrustProductContext) {
      const capturedContext = captureProductContext(context);
      return Object.freeze({
        create(request: Parameters<KernelSecurityExecutionFactory["create"]>[0]) {
          const store = createStore(request.extractArgument);
          for (const contribution of request.builtinRuleSets) {
            store.registerBuiltinRules(
              contribution.namespace,
              [...contribution.rules],
            );
          }
          const repository = createPermissionStoreTrustAdministrationRepository(
            () => store,
          );
          const application = new TrustAdministrationExecutionApplicationService({
            repository,
            ...(capturedContext.kind === "scene"
              ? { sceneId: capturedContext.sceneId }
              : {}),
            workspacePath: request.workspacePath,
          });
          return createKernelSecurityExecution(
            application,
            store,
            capturedContext.kind === "scene"
              ? Object.freeze({
                  kind: "scene" as const,
                  sceneId: capturedContext.sceneId,
                })
              : request.workspacePath !== null
                ? Object.freeze({
                    kind: "workspace" as const,
                    dir: request.workspacePath,
                  })
                : Object.freeze({ kind: "global" as const }),
          );
        },
      });
    },
  });

  return Object.freeze({
    management,
    workspaceIdentity: PermissionStore.workspaceHashFromPath,
    runtime,
  });
}

function captureProductContext(
  context: RuntimeTrustProductContext,
): RuntimeTrustProductContext {
  if (!context || typeof context !== "object") {
    throw new TypeError("Runtime Trust product context is invalid");
  }
  if (context.kind === "default") {
    return Object.freeze({ kind: "default" });
  }
  if (
    context.kind === "scene" &&
    typeof context.sceneId === "string" &&
    context.sceneId.length > 0
  ) {
    return Object.freeze({ kind: "scene", sceneId: context.sceneId });
  }
  throw new TypeError("Runtime Trust product context is invalid");
}

function createKernelSecurityExecution(
  application: TrustAdministrationExecutionApplication,
  store: PermissionStore,
  trustContext: KernelSecurityExecution["trustContext"],
): KernelSecurityExecution {
  const contextId = Object.freeze(toPermissionContext(application.context));
  const permissionRuleSource = bindPermissionRuleExecutionSource(store, contextId);
  return Object.freeze({
    contextId,
    trustContext,
    permissionRuleSource,
    recordApproval(
      approval: Parameters<KernelSecurityExecution["recordApproval"]>[0],
    ): KernelSecurityApprovalResult {
      const outcome = application.recordApproval(approval);
      if (outcome.kind === "recorded") return Object.freeze({ kind: "recorded" });
      return Object.freeze({
        kind: outcome.kind,
        rule: freezePermissionRule(outcome.rule),
      });
    },
    securitySnapshot() {
      const snapshot = application.securitySnapshot();
      return Object.freeze({
        contextId: Object.freeze(toPermissionContext(snapshot.context)),
        workspacePath: snapshot.workspacePath,
        permissionRules: Object.freeze(
          snapshot.userRules.map(freezePermissionRule),
        ),
        confirmations: Object.freeze(
          snapshot.observations.map((entry) => Object.freeze({ ...entry })),
        ),
      });
    },
    executionPermissionRules() {
      return Object.freeze(application.executionRules().map(freezePermissionRule));
    },
  });
}

function freezePermissionRule(
  rule: TrustAdministrationRepositoryRule,
): import("@zhixing/core/security").PermissionRule {
  const { contextId, contributors, ...base } = rule;
  return Object.freeze({
    ...base,
    pattern: Object.freeze({ ...rule.pattern }),
    ...(contextId
      ? { contextId: Object.freeze(toPermissionContext(contextId)) }
      : {}),
    ...(contributors
      ? {
          contributors: contributors.map((entry) => ({ ...entry })),
        }
      : {}),
  });
}
