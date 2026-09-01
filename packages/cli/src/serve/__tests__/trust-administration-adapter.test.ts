import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  worksceneConversationId,
} from "@zhixing/core";
import type { TrustAdministrationRepositoryRule } from "@zhixing/core/trust-administration";
import { createTempDir } from "@zhixing/test-utils";
import { createTrustAdministrationApplication } from "../trust-administration-adapter.js";
import { projectRuntimeConfiguration } from "../../runtime/runtime-configuration-projections.js";
import { createRuntimeConfigurationSnapshot } from "../../runtime/runtime-configuration-snapshot.js";
import { createPermissionStorageInfrastructure } from "../permission-storage-infrastructure.js";

let originalHome: string | undefined;

beforeEach(async () => {
  const tmp = await createTempDir("trust-administration");
  originalHome = process.env.ZHIXING_HOME;
  process.env.ZHIXING_HOME = tmp;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.ZHIXING_HOME;
  else process.env.ZHIXING_HOME = originalHome;
});

function makeRule(
  id: string,
  scope: TrustAdministrationRepositoryRule["scope"],
  contextId?: TrustAdministrationRepositoryRule["contextId"],
): TrustAdministrationRepositoryRule {
  return {
    id,
    scope,
    pattern: { tool: "bash", argument: `arg-${id}` },
    decision: "allow",
    createdAt: Date.now(),
    lastMatchedAt: 0,
    matchCount: 0,
    ...(contextId ? { contextId } : {}),
  };
}

function permissionStorage() {
  return createPermissionStorageInfrastructure({
    zhixingHome: process.env.ZHIXING_HOME!,
  });
}

function runtimeRepository() {
  return permissionStorage().runtime.create(
    Object.freeze({
      extractArgument: () => "",
      builtinRuleSets: Object.freeze([]),
    }),
  ).trustAdministration;
}

function workspaceConfiguration(
  configuration: Parameters<typeof createRuntimeConfigurationSnapshot>[0],
) {
  return projectRuntimeConfiguration(
    createRuntimeConfigurationSnapshot(configuration),
  ).workspace;
}

describe("Trust Administration PermissionStore adapter", () => {
  it("projects scene/global rules and preserves same-context durable revoke", async () => {
    const seed = runtimeRepository();
    seed.createExecutionRule(
      { kind: "scene", sceneId: "s1" },
      makeRule("rule-scene", "context", { kind: "scene", sceneId: "s1" }),
    );
    seed.createExecutionRule(
      { kind: "main" },
      makeRule("rule-global", "global"),
    );
    const storage = permissionStorage();
    const application = createTrustAdministrationApplication({
      configuration: workspaceConfiguration({}),
      repository: storage.management,
      workspaceIdentity: storage.workspaceIdentity,
      sessionType: "ci",
    });
    const sceneConversation = worksceneConversationId("s1", "conversation-1");

    await expect(application.query({
      kind: "list",
      conversationId: sceneConversation,
    })).resolves.toMatchObject({
      rules: [{ id: "rule-scene" }, { id: "rule-global" }],
    });
    await expect(application.execute({
      kind: "revoke",
      ruleId: "rule-scene",
      conversationId: sceneConversation,
    })).resolves.toMatchObject({ revoked: true });
    await expect(application.query({
      kind: "list",
      conversationId: sceneConversation,
    })).resolves.toMatchObject({ rules: [{ id: "rule-global" }] });
  });

  it("uses the same configured and cwd workspace projections as runtime assembly", async () => {
    const storage = permissionStorage();
    const configuredHash = storage.workspaceIdentity("/proj");
    const cwdHash = storage.workspaceIdentity(process.cwd());
    const seed = runtimeRepository();
    seed.createExecutionRule(
      { kind: "workspace", hash: configuredHash },
      makeRule("configured", "context", {
        kind: "workspace",
        hash: configuredHash,
      }),
    );
    seed.createExecutionRule(
      { kind: "workspace", hash: cwdHash },
      makeRule("cwd", "context", { kind: "workspace", hash: cwdHash }),
    );

    await expect(createTrustAdministrationApplication({
      configuration: workspaceConfiguration({ workspace: { root: "/proj" } }),
      repository: storage.management,
      workspaceIdentity: storage.workspaceIdentity,
    }).query({ kind: "list" })).resolves.toMatchObject({
      rules: [{ id: "configured" }],
    });
    await expect(createTrustAdministrationApplication({
      configuration: workspaceConfiguration({}),
      repository: storage.management,
      workspaceIdentity: storage.workspaceIdentity,
      sessionType: "interactive",
    }).query({ kind: "list" })).resolves.toMatchObject({
      rules: [{ id: "cwd" }],
    });
  });
});
