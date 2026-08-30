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
});
