/**
 * TrustDirectory 持久层实现 —— 对话语境 → 权限上下文的派生正确性
 * (与 runtime 装配同源:场景对话 → scene、有工作区 → workspace hash、
 * 否则 main),list / revoke 同语境(列得到的才撤得到),builtin 不在列。
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createTempDir } from "@zhixing/test-utils";
import {
  PermissionStore,
  worksceneConversationId,
  type PermissionRule,
} from "@zhixing/core";
import { createTrustDirectory } from "../management-directories.js";

let originalHome: string | undefined;

beforeEach(async () => {
  const tmp = await createTempDir("trust-dir");
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
  } as PermissionRule;
}

describe("trust directory(语境派生)", () => {
  it("场景对话语境列 scene 上下文规则;main 语境列不到;revoke 同语境", async () => {
    // 沉淀一条 scene 上下文规则 + 一条 global 规则
    const seed = new PermissionStore();
    seed.create(
      { kind: "scene", sceneId: "s1" },
      makeRule("rule-scene", "context", { kind: "scene", sceneId: "s1" }),
    );
    seed.create({ kind: "main" }, makeRule("rule-global", "global"));

    const directory = createTrustDirectory({
      config: {} as never,
      sessionType: "ci",
    });
    const sceneConv = worksceneConversationId("s1", "conv_a");

    const sceneView = await directory.list(sceneConv);
    expect(sceneView.map((r) => r.id).sort()).toEqual([
      "rule-global",
      "rule-scene",
    ]);

    // main 语境(无 workspace 配置 → main 上下文):scene 规则不可见
    const mainView = await directory.list();
    expect(mainView.map((r) => r.id)).toEqual(["rule-global"]);

    // revoke 同语境:main 语境撤不到 scene 规则,场景语境可撤
    expect(await directory.revoke("rule-scene")).toBe(false);
    expect(await directory.revoke("rule-scene", sceneConv)).toBe(true);
    expect(await directory.list(sceneConv)).toHaveLength(1);
  });

  it("无配置的 interactive main 语境回退 cwd workspace,与 runtime 装配一致", async () => {
    const seed = new PermissionStore();
    const hash = PermissionStore.workspaceHashFromPath(process.cwd());
    seed.create(
      { kind: "workspace", hash },
      makeRule("rule-cwd", "context", { kind: "workspace", hash }),
    );

    const directory = createTrustDirectory({
      config: {} as never,
      sessionType: "interactive",
    });
    const view = await directory.list();
    expect(view.map((r) => r.id)).toContain("rule-cwd");
  });

  it("配置了工作区 → main 对话语境为 workspace 上下文(与装配同源派生)", async () => {
    const seed = new PermissionStore();
    const hash = PermissionStore.workspaceHashFromPath("/proj");
    seed.create(
      { kind: "workspace", hash },
      makeRule("rule-ws", "context", { kind: "workspace", hash }),
    );

    const directory = createTrustDirectory({
      config: { workspace: { root: "/proj" } } as never,
    });
    const view = await directory.list();
    expect(view.map((r) => r.id)).toContain("rule-ws");
  });
});
