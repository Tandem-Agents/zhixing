import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { worksceneConversationId } from "@zhixing/core/conversation";
import {
  createPermissionStoreTrustAdministrationRepository,
  PermissionStore,
} from "@zhixing/core/security";
import {
  workspaceTrustIdentity,
  type TrustAdministrationRepositoryRule,
} from "@zhixing/core/trust-administration";
import { createTempDir } from "@zhixing/test-utils";
import { createTrustAdministrationApplication } from "../trust-administration-adapter.js";
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
    persistentApprovals: true,
  });
}

function seedRepository() {
  const rootDir = path.join(process.env.ZHIXING_HOME!, "permissions");
  return createPermissionStoreTrustAdministrationRepository(
    () => new PermissionStore({ rootDir }),
  );
}

describe("Trust Administration PermissionStore adapter", () => {
  it("projects scene/global rules and preserves same-context durable revoke", async () => {
    const seed = seedRepository();
    await seed.createExecutionRule(
      { kind: "scene", sceneId: "s1" },
      makeRule("rule-scene", "context", { kind: "scene", sceneId: "s1" }),
    );
    await seed.createExecutionRule(
      { kind: "main" },
      makeRule("rule-global", "global"),
    );
    const storage = permissionStorage();
    const application = createTrustAdministrationApplication({
      repository: storage.management,
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

  it("lists the main-mode context for the main conversation, the same context its execution records into", async () => {
    const storage = permissionStorage();
    const bindingHash = workspaceTrustIdentity("device-1", "binding-1");
    const seed = seedRepository();
    // 执行侧对无显式环境的主对话按 main 记录“始终允许（仅主模式生效）”
    await seed.createExecutionRule({ kind: "main" }, makeRule("main-approval", "context", { kind: "main" }));
    await seed.createExecutionRule(
      { kind: "workspace", hash: bindingHash, revision: 1 },
      makeRule("configured", "context", { kind: "workspace", hash: bindingHash, revision: 1 }),
    );
    const application = createTrustAdministrationApplication({ repository: storage.management });
    await expect(application.query({ kind: "list" })).resolves.toMatchObject({
      rules: [{ id: "main-approval" }],
    });
    await expect(application.execute({ kind: "revoke", ruleId: "main-approval" })).resolves.toMatchObject({ revoked: true });
    await expect(application.query({ kind: "list" })).resolves.toMatchObject({ rules: [] });
  });

  it("a rule recorded by one runtime is in another runtime's dispatch snapshot, and a management revoke removes it", async () => {
    const storage = permissionStorage();
    const request = Object.freeze({
      extractArgument: () => "npm test",
      builtinRuleSets: Object.freeze([]),
      workspacePath: null,
    });
    const owner = storage.runtime.bind({}).create(request);
    const executor = storage.runtime.bind({}).create(request);
    expect(owner.executionPermissionRules()).toEqual([]);
    const recorded = await executor.recordApproval({
      kind: "allow-context",
      pattern: { pattern: { tool: "bash", argument: "npm test" }, label: "npm test" },
      requestId: "request-1",
    });
    expect(recorded.kind).toBe("rule-created");
    const ruleId = recorded.kind === "recorded" ? "" : recorded.rule.id;
    expect(owner.executionPermissionRules({ kind: "main" }).map((rule) => rule.id)).toEqual([ruleId]);
    const application = createTrustAdministrationApplication({ repository: storage.management });
    await expect(application.execute({ kind: "revoke", ruleId })).resolves.toMatchObject({ revoked: true });
    expect(owner.executionPermissionRules({ kind: "main" })).toEqual([]);
  });
});
