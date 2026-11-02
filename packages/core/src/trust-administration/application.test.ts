import { describe, expect, it, vi } from "vitest";
import { worksceneConversationId } from "../conversation/scope-id.js";
import { ProductApiDispatcher } from "../product-api/catalog.js";
import {
  createTrustAdministrationProductApiContribution,
  TRUST_ADMINISTRATION_LIST_QUERY,
  TRUST_ADMINISTRATION_PRODUCT_API_EXACT_SET,
  TRUST_ADMINISTRATION_REVOKE_COMMAND,
  TrustAdministrationApplicationError,
  TrustAdministrationApplicationService,
  type TrustAdministrationContext,
  type TrustAdministrationRepository,
  type TrustAdministrationRepositoryRule,
} from "./application.js";

function rule(
  id: string,
  scope: TrustAdministrationRepositoryRule["scope"],
  contextId?: TrustAdministrationContext,
): TrustAdministrationRepositoryRule {
  return {
    id,
    pattern: { tool: "bash", argument: `arg-${id}` },
    decision: "allow",
    scope,
    createdAt: 1,
    lastMatchedAt: 0,
    matchCount: 0,
    ...(contextId ? { contextId } : {}),
  };
}

function repository(
  rulesByContext: Readonly<
    Record<string, readonly TrustAdministrationRepositoryRule[]>
  >,
): TrustAdministrationRepository & {
  readonly list: ReturnType<typeof vi.fn>;
  readonly revoke: ReturnType<typeof vi.fn>;
} {
  const key = (context: TrustAdministrationContext): string =>
    context.kind === "main"
      ? "main"
      : context.kind === "workspace"
        ? `workspace:${context.hash}`
        : `scene:${context.sceneId}`;
  return {
    list: vi.fn(async (context: TrustAdministrationContext) => [
      ...(rulesByContext[key(context)] ?? []),
      ...(rulesByContext.global ?? []),
    ]),
    revoke: vi.fn(async (context: TrustAdministrationContext, id: string) =>
      [...(rulesByContext[key(context)] ?? []), ...(rulesByContext.global ?? [])]
        .some((candidate) => candidate.id === id),
    ),
  };
}

describe("TrustAdministrationApplicationService", () => {
  it("owns main/workspace/scene context resolution, global merge, and builtin/session exclusion", async () => {
    const repo = repository({
      "workspace:workspace-1": [
        rule("workspace", "context", { kind: "workspace", hash: "workspace-1" }),
        rule("builtin", "builtin"),
        rule("session", "session"),
      ],
      "scene:scene-one": [
        rule("scene", "context", { kind: "scene", sceneId: "scene-one" }),
      ],
      global: [rule("global", "global")],
    });
    const application = new TrustAdministrationApplicationService({
      repository: repo,
      defaultContext: () => ({ kind: "workspace", hash: "workspace-1" }),
    });

    await expect(application.query({ kind: "list" })).resolves.toEqual({
      rules: [
        rule("workspace", "context", { kind: "workspace", hash: "workspace-1" }),
        rule("global", "global"),
      ],
    });
    await expect(application.query({
      kind: "list",
      conversationId: worksceneConversationId("scene-one", "conversation-1"),
    })).resolves.toEqual({
      rules: [
        rule("scene", "context", { kind: "scene", sceneId: "scene-one" }),
        rule("global", "global"),
      ],
    });
    expect(repo.list).toHaveBeenNthCalledWith(1, {
      kind: "workspace",
      hash: "workspace-1",
    });
    expect(repo.list).toHaveBeenNthCalledWith(2, {
      kind: "scene",
      sceneId: "scene-one",
    });
  });

  it("revokes only a currently visible user rule and emits a fact after repository success", async () => {
    const repo = repository({
      main: [rule("main-rule", "context", { kind: "main" })],
      "scene:scene-one": [
        rule("scene-rule", "context", { kind: "scene", sceneId: "scene-one" }),
      ],
      global: [rule("global-rule", "global")],
    });
    const application = new TrustAdministrationApplicationService({
      repository: repo,
      defaultContext: () => ({ kind: "main" }),
    });

    await expect(application.execute({
      kind: "revoke",
      ruleId: "global-rule",
    })).resolves.toEqual({
      revoked: true,
      fact: {
        kind: "trust-administration-rule-revoked",
        ruleId: "global-rule",
      },
    });
    expect(repo.revoke).toHaveBeenCalledWith({ kind: "main" }, "global-rule");

    await expect(application.execute({
      kind: "revoke",
      ruleId: "scene-rule",
    })).rejects.toEqual(
      new TrustAdministrationApplicationError(
        "not-found",
        "Trust rule not found: scene-rule",
      ),
    );
    expect(repo.revoke).toHaveBeenCalledTimes(1);
  });

  it("does not emit a fact when the visible rule disappears before repository commit", async () => {
    const repo = repository({ main: [rule("rule-1", "global")] });
    repo.revoke.mockResolvedValueOnce(false);
    const application = new TrustAdministrationApplicationService({
      repository: repo,
      defaultContext: () => ({ kind: "main" }),
    });
    await expect(application.execute({
      kind: "revoke",
      ruleId: "rule-1",
    })).rejects.toMatchObject({ code: "not-found" });
  });

  it("contributes the sealed Query/Command/Fact exact-set to one dispatcher", async () => {
    const application = new TrustAdministrationApplicationService({
      repository: repository({ main: [rule("rule-1", "global")] }),
      defaultContext: () => ({ kind: "main" }),
    });
    const dispatcher = new ProductApiDispatcher(
      TRUST_ADMINISTRATION_PRODUCT_API_EXACT_SET,
      [createTrustAdministrationProductApiContribution(application)],
    );

    await expect(dispatcher.query(TRUST_ADMINISTRATION_LIST_QUERY, {
      kind: "list",
    })).resolves.toEqual({ rules: [rule("rule-1", "global")] });
    await expect(dispatcher.command(TRUST_ADMINISTRATION_REVOKE_COMMAND, {
      kind: "revoke",
      ruleId: "rule-1",
    })).resolves.toEqual({
      result: {
        revoked: true,
        fact: {
          kind: "trust-administration-rule-revoked",
          ruleId: "rule-1",
        },
      },
      facts: [{ kind: "trust-administration-rule-revoked", ruleId: "rule-1" }],
    });
  });

  it("lists other scopes by page beside the current scope, described by the host, and revokes only what that scope shows", async () => {
    const workspaceA = { kind: "workspace", hash: "hash-a" } as const;
    const workspaceB = { kind: "workspace", hash: "hash-b" } as const;
    const base = repository({
      main: [rule("main-rule", "context", { kind: "main" })],
      "workspace:hash-a": [rule("a-rule", "context", { ...workspaceA, revision: 2 })],
      "workspace:hash-b": [rule("b-rule", "context", { ...workspaceB, revision: 1 })],
      global: [rule("global-rule", "global")],
    });
    const scopes = [
      { cursor: "k-main", context: { kind: "main" } as const, rules: [rule("main-rule", "context", { kind: "main" })] },
      { cursor: "k-a", context: workspaceA, rules: [rule("a-rule", "context", { ...workspaceA, revision: 2 }), rule("builtin", "builtin")] },
      { cursor: "k-b", context: workspaceB, rules: [rule("b-rule", "context", { ...workspaceB, revision: 1 })] },
    ];
    const listScopes = vi.fn(async (input: { after?: string; limit: number }) => {
      const remaining = scopes.filter((scope) => input.after === undefined || scope.cursor > input.after);
      const page = remaining.slice(0, input.limit);
      return { scopes: page, ...(remaining.length > input.limit ? { next: page.at(-1)!.cursor } : {}) };
    });
    const application = new TrustAdministrationApplicationService({
      repository: { ...base, listScopes },
      defaultContext: () => ({ kind: "main" }),
      describeScope: async (context) => context.kind === "workspace" && context.hash === "hash-b"
        ? { label: "工作区「B」", effective: false, note: "目录已变更" }
        : { label: context.kind === "workspace" ? "工作区「A」" : "主模式", effective: true },
    });

    // 当前范围（主模式）不重复出现在其他范围里；内置规则不进管理视图
    const first = await application.query({ kind: "list", otherScopes: { limit: 2 } });
    expect(first.rules.map((entry) => entry.id)).toEqual(["main-rule", "global-rule"]);
    expect(first.otherScopes).toMatchObject({
      groups: [{ label: "工作区「A」", effective: true, rules: [{ id: "a-rule" }] }],
      next: "k-a",
    });
    const second = await application.query({ kind: "list", otherScopes: { after: first.otherScopes!.next } });
    expect(second.otherScopes).toEqual({
      groups: [expect.objectContaining({ label: "工作区「B」", effective: false, note: "目录已变更" })],
    });
    // 不传 otherScopes 的旧调用方结果不变
    expect(await application.query({ kind: "list" })).not.toHaveProperty("otherScopes");

    await expect(application.execute({ kind: "revoke", ruleId: "b-rule", context: workspaceB }))
      .resolves.toMatchObject({ revoked: true });
    expect(base.revoke).toHaveBeenLastCalledWith(workspaceB, "b-rule");
    // 规则不在所给范围可见：拒绝，不扩大可撤销的规则
    await expect(application.execute({ kind: "revoke", ruleId: "b-rule", context: workspaceA }))
      .rejects.toMatchObject({ code: "not-found" });
  });
});
