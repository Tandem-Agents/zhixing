import { describe, expect, it } from "vitest";
import {
  TrustAdministrationExecutionApplicationService,
  suggestTrustAdministrationPatterns,
  type TrustAdministrationContext,
  type TrustAdministrationExecutionRepository,
  type TrustAdministrationRepositoryRule,
} from "./application.js";

function createRepository(): TrustAdministrationExecutionRepository & {
  readonly rules: TrustAdministrationRepositoryRule[];
} {
  const rules: TrustAdministrationRepositoryRule[] = [];
  return {
    rules,
    workspaceIdentity(path) {
      return `hash:${path}`;
    },
    listExecutionRules(context) {
      return rules.filter((rule) => appliesTo(rule, context));
    },
    snapshotExecutionRules(context) {
      return rules.filter((rule) => appliesTo(rule, context));
    },
    createExecutionRule(_context, rule) {
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

  it("creates session/context/global rules with domain-owned identity and binding", () => {
    const repository = createRepository();
    let now = 100;
    let id = 0;
    const application = new TrustAdministrationExecutionApplicationService({
      repository,
      workspacePath: "/work",
      now: () => ++now,
      createRuleId: () => `rule-${++id}`,
    });
    const pattern = application.suggest(npmInstall("express"))[1]!;

    application.recordApproval({ kind: "allow-session", pattern });
    application.recordApproval({ kind: "allow-context", pattern });
    application.recordApproval({ kind: "allow-global", pattern });

    expect(repository.rules.map((rule) => rule.scope)).toEqual([
      "session",
      "context",
      "global",
    ]);
    expect(repository.rules[0]!.contributors).toBeUndefined();
    expect(repository.rules[1]).toMatchObject({
      id: "rule-2",
      contextId: { kind: "workspace", hash: "hash:/work" },
      contextPath: "/work",
      contributors: [{ origin: "user" }],
    });
    expect(repository.rules[2]).toMatchObject({
      id: "rule-3",
      contributors: [{ origin: "user" }],
    });
    expect(repository.rules[2]!.contextId).toBeUndefined();
  });

  it("preserves the trusted confirmation contract for empty explicit arguments", () => {
    const repository = createRepository();
    const application = new TrustAdministrationExecutionApplicationService({
      repository,
      createRuleId: () => `rule-${repository.rules.length + 1}`,
    });
    const pattern = {
      pattern: { tool: "bash", argument: "" },
      label: "exact empty argument",
    };

    application.recordApproval({ kind: "allow-session", pattern });
    application.recordApproval({ kind: "allow-context", pattern });
    application.recordApproval({ kind: "allow-global", pattern });

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
  ] as const)("sediments %s only at its threshold", (riskLevel, threshold) => {
    const repository = createRepository();
    let timestamp = 0;
    const application = new TrustAdministrationExecutionApplicationService({
      repository,
      now: () => ++timestamp,
      createRuleId: () => "sedimented",
    });
    for (let index = 1; index < threshold; index += 1) {
      expect(
        application.recordApproval({
          kind: "allow-once",
          operation: npmInstall(`pkg-${index}`),
          riskLevel,
          origin: index % 2 === 0 ? "steward" : "user",
          bypassImmune: false,
        }).kind,
      ).toBe("recorded");
    }
    const result = application.recordApproval({
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

  it("uses the current approval risk for sedimentation while observing the highest risk", () => {
    const repository = createRepository();
    let timestamp = 0;
    const application = new TrustAdministrationExecutionApplicationService({
      repository,
      now: () => ++timestamp,
      createRuleId: () => "mixed",
    });
    const approvals = [
      { riskLevel: "high", origin: "user" },
      { riskLevel: "low", origin: "steward" },
      { riskLevel: "low", origin: "user" },
    ] as const;
    const results = approvals.map((approval) =>
      application.recordApproval({
        kind: "allow-once",
        operation: npmInstall(approval.origin),
        riskLevel: approval.riskLevel,
        origin: approval.origin,
        bypassImmune: false,
      }),
    );
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

  it("never sediments critical or bypass-immune observations", () => {
    const repository = createRepository();
    const application = new TrustAdministrationExecutionApplicationService({
      repository,
    });
    for (let index = 0; index < 20; index += 1) {
      application.recordApproval({
        kind: "allow-once",
        operation: npmInstall(String(index)),
        riskLevel: "critical",
        origin: "user",
        bypassImmune: false,
      });
      application.recordApproval({
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
    });
    const snapshot = application.securitySnapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.userRules)).toBe(true);
    expect(Object.isFrozen(snapshot.userRules[0]!.pattern)).toBe(true);
    expect(snapshot.userRules[0]).not.toBe(repository.rules[0]);
  });
});
