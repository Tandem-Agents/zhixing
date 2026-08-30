import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PermissionStore,
  worksceneConversationId,
  type PermissionRule,
} from "@zhixing/core";
import { createTempDir } from "@zhixing/test-utils";
import { createTrustAdministrationApplication } from "../trust-administration-adapter.js";

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
  scope: PermissionRule["scope"],
  contextId?: PermissionRule["contextId"],
): PermissionRule {
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

describe("Trust Administration PermissionStore adapter", () => {
  it("projects scene/global rules and preserves same-context durable revoke", async () => {
    const seed = new PermissionStore();
    seed.create(
      { kind: "scene", sceneId: "s1" },
      makeRule("rule-scene", "context", { kind: "scene", sceneId: "s1" }),
    );
    seed.create({ kind: "main" }, makeRule("rule-global", "global"));
    const application = createTrustAdministrationApplication({
      config: {} as never,
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
    const configuredHash = PermissionStore.workspaceHashFromPath("/proj");
    const cwdHash = PermissionStore.workspaceHashFromPath(process.cwd());
    const seed = new PermissionStore();
    seed.create(
      { kind: "workspace", hash: configuredHash },
      makeRule("configured", "context", {
        kind: "workspace",
        hash: configuredHash,
      }),
    );
    seed.create(
      { kind: "workspace", hash: cwdHash },
      makeRule("cwd", "context", { kind: "workspace", hash: cwdHash }),
    );

    await expect(createTrustAdministrationApplication({
      config: { workspace: { root: "/proj" } } as never,
    }).query({ kind: "list" })).resolves.toMatchObject({
      rules: [{ id: "configured" }],
    });
    await expect(createTrustAdministrationApplication({
      config: {} as never,
      sessionType: "interactive",
    }).query({ kind: "list" })).resolves.toMatchObject({
      rules: [{ id: "cwd" }],
    });
  });
});
