import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PermissionRule } from "@zhixing/core/security";
import { createTempDir } from "@zhixing/test-utils";
import { createPermissionStorageInfrastructure } from "../permission-storage-infrastructure.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

function rule(
  id: string,
  scope: PermissionRule["scope"],
  argument: string,
): PermissionRule {
  return {
    id,
    scope,
    pattern: { tool: "bash", argument },
    decision: "allow",
    createdAt: 1,
    lastMatchedAt: 0,
    matchCount: 0,
    ...(scope === "context" ? { contextId: { kind: "main" } } : {}),
  };
}

function runtimeRequest() {
  return Object.freeze({
    extractArgument: (request: { readonly arguments: Readonly<Record<string, unknown>> }) =>
      String(request.arguments.command ?? ""),
    builtinRuleSets: Object.freeze([
      Object.freeze({
        namespace: "shell-defaults",
        rules: Object.freeze([rule("builtin", "builtin", "pwd")]),
      }),
    ]),
    workspacePath: null,
  });
}

function securityRequest(command: string) {
  return {
    tool: "bash",
    arguments: { command },
    context: {
      cwd: process.cwd(),
      trust: { kind: "global" as const },
      sessionType: "interactive" as const,
    },
  };
}

describe("Host permission storage infrastructure", () => {
  it("owns the one P04 root while exposing separate runtime and management roles", async () => {
    const home = await createTempDir("permission-storage-infrastructure");
    cleanup.push(home);
    const infrastructure = createPermissionStorageInfrastructure({ zhixingHome: home });
    const runtime = infrastructure.runtime
      .bind(Object.freeze({ kind: "default" }))
      .create(runtimeRequest());
    const context = { kind: "main" } as const;

    runtime.recordApproval({
      kind: "allow-global",
      pattern: {
        pattern: { tool: "bash", argument: "npm *" },
        label: "npm commands",
      },
    });

    await expect(
      fs.readFile(path.join(home, "permissions", "global.json"), "utf8"),
    ).resolves.toContain('"argument": "npm *"');
    await expect(infrastructure.management.list(context)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: "global", pattern: { tool: "bash", argument: "npm *" } }),
      ]),
    );
    expect(runtime.permissionRuleSource.match(securityRequest("pwd"))).toMatchObject({
      id: "builtin",
      scope: "builtin",
    });
  });

  it("keeps session rules in one runtime binding and excludes them after re-issuance", async () => {
    const home = await createTempDir("permission-storage-session");
    cleanup.push(home);
    const infrastructure = createPermissionStorageInfrastructure({ zhixingHome: home });
    const context = { kind: "main" } as const;
    const factory = infrastructure.runtime.bind(Object.freeze({ kind: "default" }));
    const first = factory.create(runtimeRequest());
    first.recordApproval({
      kind: "allow-session",
      pattern: {
        pattern: { tool: "bash", argument: "git status" },
        label: "git status",
      },
    });

    expect(first.permissionRuleSource.match(securityRequest("git status"))).toMatchObject({
      scope: "session",
    });
    const restarted = factory.create(runtimeRequest());
    expect(
      restarted.permissionRuleSource.match(securityRequest("git status")),
    ).toBeNull();
    await expect(infrastructure.management.list(context)).resolves.toEqual([]);
  });

  it("binds scene identity independently from workspace and defaults to workspace/global", async () => {
    const home = await createTempDir("permission-storage-context");
    cleanup.push(home);
    const infrastructure = createPermissionStorageInfrastructure({ zhixingHome: home });
    const workspacePath = path.join(home, "workspace");
    const requestWithWorkspace = Object.freeze({
      ...runtimeRequest(),
      workspacePath,
    });

    const scene = infrastructure.runtime
      .bind(Object.freeze({ kind: "scene", sceneId: "scene-1" }))
      .create(requestWithWorkspace);
    const workspace = infrastructure.runtime
      .bind(Object.freeze({ kind: "default" }))
      .create(requestWithWorkspace);
    const global = infrastructure.runtime
      .bind(Object.freeze({ kind: "default" }))
      .create(runtimeRequest());

    expect(scene.contextId).toEqual({ kind: "scene", sceneId: "scene-1" });
    expect(scene.trustContext).toEqual({ kind: "scene", sceneId: "scene-1" });
    expect(scene.securitySnapshot().workspacePath).toBeNull();
    expect(workspace.contextId.kind).toBe("workspace");
    expect(workspace.trustContext).toEqual({ kind: "workspace", dir: workspacePath });
    expect(global.contextId).toEqual({ kind: "main" });
    expect(global.trustContext).toEqual({ kind: "global" });
  });
});
