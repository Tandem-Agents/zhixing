import type {
  TrustAdministrationContext,
  TrustAdministrationExecutionRepository,
  TrustAdministrationRepository,
  TrustAdministrationRepositoryRule,
} from "../trust-administration/application.js";
import { PermissionStore } from "./permission-store.js";
import type {
  IPermissionStore,
  PermissionContextId,
  PermissionRule,
} from "./types.js";

export interface PermissionStoreTrustAdministrationRepository
  extends TrustAdministrationRepository,
    TrustAdministrationExecutionRepository {}

/**
 * The single final adapter from Trust Administration projections to the
 * existing permission storage mechanism. A provider may return a stable store
 * for one runtime or a fresh store for management read-through.
 */
export function createPermissionStoreTrustAdministrationRepository(
  storeProvider: () => IPermissionStore,
): PermissionStoreTrustAdministrationRepository {
  return Object.freeze({
    async list(
      context: TrustAdministrationContext,
    ): Promise<readonly TrustAdministrationRepositoryRule[]> {
      return storeProvider()
        .list(toPermissionContext(context))
        .map(toTrustAdministrationRule);
    },
    async revoke(
      context: TrustAdministrationContext,
      ruleId: string,
    ): Promise<boolean> {
      const store = storeProvider();
      store.list(toPermissionContext(context));
      return store.revoke(ruleId);
    },
    workspaceIdentity(workspacePath: string): string {
      return PermissionStore.workspaceHashFromPath(workspacePath);
    },
    listExecutionRules(
      context: TrustAdministrationContext,
    ): readonly TrustAdministrationRepositoryRule[] {
      return storeProvider()
        .list(toPermissionContext(context))
        .map(toTrustAdministrationRule);
    },
    snapshotExecutionRules(
      context: TrustAdministrationContext,
    ): readonly TrustAdministrationRepositoryRule[] {
      return storeProvider()
        .snapshot(toPermissionContext(context))
        .map(toTrustAdministrationRule);
    },
    createExecutionRule(
      context: TrustAdministrationContext,
      rule: TrustAdministrationRepositoryRule,
    ): void {
      storeProvider().create(
        toPermissionContext(context),
        toPermissionRule(rule),
      );
    },
  });
}

export function toPermissionContext(
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

function toPermissionRule(rule: TrustAdministrationRepositoryRule): PermissionRule {
  return {
    id: rule.id,
    pattern: { ...rule.pattern },
    decision: rule.decision,
    scope: rule.scope,
    createdAt: rule.createdAt,
    lastMatchedAt: rule.lastMatchedAt,
    matchCount: rule.matchCount,
    ...(rule.contextId
      ? { contextId: toPermissionContext(rule.contextId) }
      : {}),
    ...(rule.contextPath === undefined ? {} : { contextPath: rule.contextPath }),
    ...(rule.contributors
      ? { contributors: rule.contributors.map((entry) => ({ ...entry })) }
      : {}),
  };
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
