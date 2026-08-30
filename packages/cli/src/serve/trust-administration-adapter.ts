import {
  PermissionStore,
  type PermissionContextId,
  type PermissionRule,
} from "@zhixing/core";
import {
  TrustAdministrationApplicationService,
  type TrustAdministrationApplication,
  type TrustAdministrationContext,
  type TrustAdministrationRepository,
  type TrustAdministrationRepositoryRule,
} from "@zhixing/core/trust-administration";
import {
  resolveWorkspace,
  resolveWorkspaceSessionType,
  type WorkspaceSessionType,
  type ZhixingConfig,
} from "@zhixing/providers";

/**
 * A5-TRUST-STORE-01: the only temporary adapter between Trust Administration
 * and the existing Security persistence mechanism.
 */
export function createTrustAdministrationRepository(): TrustAdministrationRepository {
  return {
    async list(context) {
      return new PermissionStore()
        .list(toPermissionContext(context))
        .map(toTrustAdministrationRule);
    },
    async revoke(context, ruleId) {
      const store = new PermissionStore();
      // PermissionStore lazily loads the selected context and global files.
      store.list(toPermissionContext(context));
      return store.revoke(ruleId);
    },
  };
}

/** Host composition of the one Trust Administration application. */
export function createTrustAdministrationApplication(deps: {
  readonly config: ZhixingConfig;
  readonly sessionType?: WorkspaceSessionType;
}): TrustAdministrationApplication {
  return new TrustAdministrationApplicationService({
    repository: createTrustAdministrationRepository(),
    defaultContext: () => {
      const sessionType = deps.sessionType ?? resolveWorkspaceSessionType();
      const workspace = resolveWorkspace(deps.config, { sessionType });
      return workspace.path
        ? {
            kind: "workspace",
            hash: PermissionStore.workspaceHashFromPath(workspace.path),
          }
        : { kind: "main" };
    },
  });
}

function toPermissionContext(
  context: TrustAdministrationContext,
): PermissionContextId {
  switch (context.kind) {
    case "main":
      return { kind: "main" };
    case "workspace":
      return { kind: "workspace", hash: context.hash };
    case "scene":
      return { kind: "scene", sceneId: context.sceneId };
  }
}

function toTrustAdministrationRule(
  rule: PermissionRule,
): TrustAdministrationRepositoryRule {
  return {
    id: rule.id,
    pattern: { ...rule.pattern },
    decision: rule.decision,
    scope: rule.scope,
    createdAt: rule.createdAt,
    lastMatchedAt: rule.lastMatchedAt,
    matchCount: rule.matchCount,
    ...(rule.contextId
      ? { contextId: toTrustAdministrationContext(rule.contextId) }
      : {}),
    ...(rule.contextPath === undefined ? {} : { contextPath: rule.contextPath }),
    ...(rule.contributors
      ? { contributors: rule.contributors.map((entry) => ({ ...entry })) }
      : {}),
  };
}

function toTrustAdministrationContext(
  context: PermissionContextId,
): TrustAdministrationContext {
  switch (context.kind) {
    case "main":
      return { kind: "main" };
    case "workspace":
      return { kind: "workspace", hash: context.hash };
    case "scene":
      return { kind: "scene", sceneId: context.sceneId };
  }
}
