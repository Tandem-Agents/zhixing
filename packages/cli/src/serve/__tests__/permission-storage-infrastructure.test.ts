import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PermissionRule } from "@zhixing/core";
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
    const runtime = infrastructure.runtime.create(runtimeRequest());
    const context = { kind: "main" } as const;

    runtime.trustAdministration.createExecutionRule(
      context,
      rule("durable", "global", "npm *"),
    );

    await expect(
      fs.readFile(path.join(home, "permissions", "global.json"), "utf8"),
    ).resolves.toContain('"id": "durable"');
    await expect(infrastructure.management.list(context)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "durable" })]),
    );
    expect(runtime.rulesFor(context).match(securityRequest("pwd"))).toMatchObject({
      id: "builtin",
      scope: "builtin",
    });
  });

  it("keeps session rules in one runtime binding and excludes them after re-issuance", async () => {
    const home = await createTempDir("permission-storage-session");
    cleanup.push(home);
    const infrastructure = createPermissionStorageInfrastructure({ zhixingHome: home });
    const context = { kind: "main" } as const;
    const first = infrastructure.runtime.create(runtimeRequest());
    first.trustAdministration.createExecutionRule(
      context,
      rule("session", "session", "git status"),
    );

    expect(first.rulesFor(context).match(securityRequest("git status"))).toMatchObject({
      id: "session",
      scope: "session",
    });
    const restarted = infrastructure.runtime.create(runtimeRequest());
    expect(
      restarted.rulesFor(context).match(securityRequest("git status")),
    ).toBeNull();
    await expect(infrastructure.management.list(context)).resolves.toEqual([]);
  });
});
