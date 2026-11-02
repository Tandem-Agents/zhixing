import { describe, expect, it } from "vitest";
import {
  TrustAdministrationExecutionApplicationService,
  suggestTrustAdministrationPatterns,
  type TrustAdministrationContext,
  type TrustAdministrationExecutionRepository,
  type TrustAdministrationRepositoryRule,
} from "./application.js";

const MAIN: TrustAdministrationContext = { kind: "main" };
const WORKSPACE: TrustAdministrationContext = {
  kind: "workspace",
  hash: "binding-hash",
  revision: 3,
};

function createRepository(): TrustAdministrationExecutionRepository & {
  readonly rules: TrustAdministrationRepositoryRule[];
} {
  const rules: TrustAdministrationRepositoryRule[] = [];
  return {
    rules,
    listExecutionRules(context) {
      return rules.filter((rule) => appliesTo(rule, context));
    },
    snapshotExecutionRules(context) {
      return rules.filter((rule) => appliesTo(rule, context));
    },
    async createExecutionRule(_context, rule) {
      rules.push(rule);
    },
  };
}

function appliesTo(
  rule: TrustAdministrationRepositoryRule,
  context: TrustAdministrationContext,
): boolean {
  if (rule.scope === "global" || rule.scope === "session") return true;
  return JSON.stringify(rule.contextId) === JSON.stringify(context);
}

const npmInstall = (packageName: string) => ({
  tool: "bash",
  arguments: { command: `npm install ${packageName}` },
});

describe("TrustAdministrationExecutionApplicationService", () => {
  it("owns ordered suggestions for commands, files, and generic tools", () => {
    expect(
      suggestTrustAdministrationPatterns(npmInstall("express")).map(
        (entry) => entry.pattern.argument,
      ),
    ).toEqual(["npm install express", "npm install *", "npm *"]);
    expect(
      suggestTrustAdministrationPatterns({
        tool: "write",
        arguments: { path: "src/foo/bar.ts" },
      }).map((entry) => entry.pattern.argument),
    ).toEqual(["src/foo/bar.ts", "src/foo/**"]);
    expect(
      suggestTrustAdministrationPatterns({ tool: "wechat", arguments: {} }),
    ).toMatchObject([{ pattern: { tool: "wechat", argument: "*" } }]);
  });

  it("creates session/context/global rules bound to the explicit run scope", async () => {
    const repository = createRepository();
    let now = 100;
    let id = 0;
    const application = new TrustAdministrationExecutionApplicationService({
      repository,
      context: WORKSPACE,
      workspacePath: "/work",
      now: () => ++now,
      createRuleId: () => `rule-${++id}`,
    });
    const pattern = application.suggest(npmInstall("express"))[1]!;

    await application.recordApproval({ kind: "allow-session", pattern });
    await application.recordApproval({ kind: "allow-context", pattern });
    await application.recordApproval({ kind: "allow-global", pattern });

    expect(repository.rules.map((rule) => rule.scope)).toEqual([
      "session",
      "context",
      "global",
    ]);
    expect(repository.rules[0]!.contributors).toBeUndefined();
    expect(repository.rules[1]).toMatchObject({
      id: "rule-2",
      contextId: { kind: "workspace", hash: "binding-hash", revision: 3 },
      contextPath: "/work",
      contributors: [{ origin: "user" }],
    });
    expect(repository.rules[2]).toMatchObject({
      id: "rule-3",
      contributors: [{ origin: "user" }],
    });
    expect(repository.rules[2]!.contextId).toBeUndefined();
  });

  it("rejects the approval when the durable write fails", async () => {
    const repository = createRepository();
    const application = new TrustAdministrationExecutionApplicationService({
      repository: {
        ...repository,
        async createExecutionRule() {
          throw new Error("disk full");
        },
      },
      context: MAIN,
    });
    const pattern = application.suggest(npmInstall("express"))[0]!;
    await expect(
      application.recordApproval({ kind: "allow-global", pattern }),
    ).rejects.toThrow("disk full");
    expect(repository.rules).toEqual([]);
  });

  it("preserves the trusted confirmation contract for empty explicit arguments", async () => {
    const repository = createRepository();
    const application = new TrustAdministrationExecutionApplicationService({
      repository,
      context: MAIN,
      createRuleId: () => `rule-${repository.rules.length + 1}`,
    });
    const pattern = {
      pattern: { tool: "bash", argument: "" },
      label: "exact empty argument",
    };

    await application.recordApproval({ kind: "allow-session", pattern });
    await application.recordApproval({ kind: "allow-context", pattern });
    await application.recordApproval({ kind: "allow-global", pattern });

    expect(repository.rules.map((rule) => rule.pattern.argument)).toEqual([
      "",
      "",
      "",
    ]);
    expect(repository.rules.map((rule) => rule.scope)).toEqual([
      "session",
      "context",
      "global",
    ]);
  });

  it.each([
    ["low", 3],
    ["medium", 3],
    ["high", 10],
  ] as const)("sediments %s only at its threshold", async (riskLevel, threshold) => {
    const repository = createRepository();
    let timestamp = 0;
    const application = new TrustAdministrationExecutionApplicationService({
      repository,
      context: MAIN,
      now: () => ++timestamp,
      createRuleId: () => "sedimented",
    });
    for (let index = 1; index < threshold; index += 1) {
      const recorded = await application.recordApproval({
        kind: "allow-once",
        operation: npmInstall(`pkg-${index}`),
        riskLevel,
        origin: index % 2 === 0 ? "steward" : "user",
        bypassImmune: false,
      });
      expect(recorded.kind).toBe("recorded");
    }
    const result = await application.recordApproval({
      kind: "allow-once",
      operation: npmInstall("final"),
      riskLevel,
      origin: "steward",
      bypassImmune: false,
    });
    expect(result.kind).toBe("rule-sedimented");
    expect(repository.rules).toHaveLength(1);
    expect(repository.rules[0]).toMatchObject({
      pattern: { tool: "bash", argument: "npm install *" },
      scope: "context",
      contextId: { kind: "main" },
    });
    expect(repository.rules[0]!.contributors).toHaveLength(threshold);
  });

  it("uses the current approval risk for sedimentation while observing the highest risk", async () => {
    const repository = createRepository();
    let timestamp = 0;
    const application = new TrustAdministrationExecutionApplicationService({
      repository,
      context: MAIN,
      now: () => ++timestamp,
      createRuleId: () => "mixed",
    });
    const approvals = [
      { riskLevel: "high", origin: "user" },
      { riskLevel: "low", origin: "steward" },
      { riskLevel: "low", origin: "user" },
    ] as const;
    const results = [];
    for (const approval of approvals) {
      results.push(await application.recordApproval({
        kind: "allow-once",
        operation: npmInstall(approval.origin),
        riskLevel: approval.riskLevel,
        origin: approval.origin,
        bypassImmune: false,
      }));
    }
    expect(results.map((entry) => entry.kind)).toEqual([
      "recorded",
      "recorded",
      "rule-sedimented",
    ]);
    expect(repository.rules).toHaveLength(1);
    expect(repository.rules[0]!.contributors).toEqual([
      { origin: "user", timestamp: 1 },
      { origin: "steward", timestamp: 2 },
      { origin: "user", timestamp: 3 },
    ]);
    expect(application.securitySnapshot().observations).toEqual([
      { key: "bash::npm install *", count: 3, highestRisk: "high" },
    ]);
  });

  it("never sediments critical or bypass-immune observations", async () => {
    const repository = createRepository();
    const application = new TrustAdministrationExecutionApplicationService({
      repository,
      context: MAIN,
    });
    for (let index = 0; index < 20; index += 1) {
      await application.recordApproval({
        kind: "allow-once",
        operation: npmInstall(String(index)),
        riskLevel: "critical",
        origin: "user",
        bypassImmune: false,
      });
      await application.recordApproval({
        kind: "allow-once",
        operation: { tool: "write", arguments: { path: `/secret/${index}` } },
        riskLevel: "low",
        origin: "steward",
        bypassImmune: true,
      });
    }
    expect(repository.rules).toEqual([]);
    expect(application.securitySnapshot().observations).toEqual([
      { key: "bash::npm install *", count: 20, highestRisk: "critical" },
    ]);
  });

  it("returns frozen snapshots instead of the repository's mutable objects", () => {
    const repository = createRepository();
    repository.rules.push({
      id: "rule",
      pattern: { tool: "bash", argument: "npm *" },
      decision: "allow",
      scope: "global",
      createdAt: 1,
      lastMatchedAt: 0,
      matchCount: 0,
    });
    const application = new TrustAdministrationExecutionApplicationService({
      repository,
      context: MAIN,
    });
    const snapshot = application.securitySnapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.userRules)).toBe(true);
    expect(Object.isFrozen(snapshot.userRules[0]!.pattern)).toBe(true);
    expect(snapshot.userRules[0]).not.toBe(repository.rules[0]);
  });
});
