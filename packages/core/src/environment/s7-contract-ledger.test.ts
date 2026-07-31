import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  runInMaintenanceContext,
  storageMaintenanceRequest,
} from "../resources/index.js";
import { S7_DURABLE_CONTRACT_LEDGER } from "./s7-contract-ledger.js";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

describe("S7 durable contract ledger", () => {
  it("is a finite one-owner inventory with executable recovery classifications", () => {
    const expected = [
      "legacy-workscene-migration",
      "session-activity",
      "workscene-activity-projection",
      "workscene-registry",
      "workspace-binding",
      "workspace-binding-root",
      "workspace-probe",
    ];
    expect(
      S7_DURABLE_CONTRACT_LEDGER.map(({ recordFamily }) => recordFamily).sort(),
    ).toEqual(expected);
    for (const entry of S7_DURABLE_CONTRACT_LEDGER) {
      expect(entry.producer).not.toBe("");
      expect(entry.recoveryOwner).not.toBe("");
      expect(entry.resourceIdentity).not.toBe("");
      expect(entry.variants.length).toBeGreaterThan(0);
      expect(entry.rejectionBranches.length).toBeGreaterThan(0);
      expect(entry.corruptionVectors.length).toBeGreaterThan(0);
    }
    expect(
      S7_DURABLE_CONTRACT_LEDGER.filter(
        ({ recordFamily }) => recordFamily === "workspace-binding-root",
      ),
    ).toHaveLength(1);
  });

  it("binds every family to a real producer, recovery entry and behavior test", async () => {
    for (const entry of S7_DURABLE_CONTRACT_LEDGER) {
      const evidence = entry.executableEvidence;
      const [producer, recovery, behaviorTest] = await Promise.all([
        readFile(path.join(repositoryRoot, evidence.producerModule), "utf8"),
        readFile(path.join(repositoryRoot, evidence.recoveryModule), "utf8"),
        readFile(
          path.join(repositoryRoot, evidence.behaviorTestModule),
          "utf8",
        ),
      ]);
      expect(
        declaredSymbols(producer, evidence.producerModule),
        `${entry.recordFamily} producer`,
      ).toContain(evidence.producerSymbol);
      expect(
        declaredSymbols(recovery, evidence.recoveryModule),
        `${entry.recordFamily} recovery owner`,
      ).toContain(evidence.recoverySymbol);
      expect(
        testTitles(behaviorTest, evidence.behaviorTestModule),
        `${entry.recordFamily} executable behavior`,
      ).toContain(evidence.behaviorTest);
    }
  });

  it("keeps rejection and corruption coverage mutation-sensitive", () => {
    expect(
      Object.fromEntries(
        S7_DURABLE_CONTRACT_LEDGER.map((entry) => [
          entry.recordFamily,
          {
            variants: entry.variants,
            rejectionBranches: entry.rejectionBranches,
            corruptionVectors: entry.corruptionVectors,
          },
        ]),
      ),
    ).toEqual({
      "workscene-registry": {
        variants: [
          "established",
          "control-applied",
          "legacy-import-open",
          "legacy-import-activated",
          "legacy-import-abandoned",
          "deletion-projected",
        ],
        rejectionBranches: [
          "principal-method",
          "request-conflict",
          "revision-conflict",
          "deletion-pending",
        ],
        corruptionVectors: [
          "unknown-record",
          "non-contiguous-revision",
          "broken-deletion-confirmation",
        ],
      },
      "workspace-binding": {
        variants: [
          "directory-established",
          "catalog-reset",
          "binding-created",
          "binding-updated",
          "binding-removed",
          "request-recorded",
          "legacy-binding-staged",
          "legacy-migration-activated",
          "legacy-migration-abandoned",
        ],
        rejectionBranches: [
          "control-lease",
          "name-conflict",
          "revision-conflict",
          "tombstoned-reference",
        ],
        corruptionVectors: [
          "missing-establishment",
          "invalid-record",
          "broken-log-tail",
        ],
      },
      "workspace-binding-root": {
        variants: ["healthy", "degraded", "pending-reset"],
        rejectionBranches: [
          "healthy-reset",
          "confirmation-mismatch",
          "generation-conflict",
          "reservation-conflict",
        ],
        corruptionVectors: [
          "malformed-manifest",
          "missing-active-log",
          "invalid-reset-genesis",
          "broken-generation-link",
        ],
      },
      "workspace-probe": {
        variants: ["log-established", "started", "completed", "retired"],
        rejectionBranches: [
          "grant-binding",
          "lease-binding",
          "request-conflict",
          "expired-fresh-request",
        ],
        corruptionVectors: [
          "invalid-result",
          "request-result-mismatch",
          "broken-replay-index",
        ],
      },
      "session-activity": {
        variants: ["upsert", "delete"],
        rejectionBranches: [
          "conversation-scene-mismatch",
          "non-monotonic-revision",
          "external-construction",
        ],
        corruptionVectors: [
          "wrong-stream",
          "invalid-time",
          "identity-rebinding",
        ],
      },
      "legacy-workscene-migration": {
        variants: ["open", "activated", "abandoned"],
        rejectionBranches: [
          "source-changed",
          "terminal-revival",
          "import-set-mismatch",
          "post-cutover-write",
        ],
        corruptionVectors: [
          "malformed-report",
          "broken-terminal",
          "source-pages-mismatch",
          "cutover-marker-mismatch",
        ],
      },
      "workscene-activity-projection": {
        variants: ["put", "tombstone"],
        rejectionBranches: [
          "stale-contribution",
          "wrong-scene",
          "wrong-conversation",
        ],
        corruptionVectors: [
          "invalid-contribution",
          "invalid-aggregate",
          "checkpoint-mismatch",
        ],
      },
    });
  });

  it("binds catalog reset to its dedicated committed storage class", () => {
    const request = runInMaintenanceContext("foreground", () =>
      storageMaintenanceRequest(
        "workspace-catalog-reset",
        "device-root",
        {
          previousCatalogGeneration: "catalog-a",
          catalogGeneration: "catalog-b",
        },
        { obligation: "committed" },
      ),
    );
    expect(request).toMatchObject({
      kind: "workspace-catalog-reset",
      obligation: "committed",
      urgency: "foreground",
    });
  });

  it("freezes every reset and activity state that must remain mutation-sensitive", () => {
    const byFamily = new Map(
      S7_DURABLE_CONTRACT_LEDGER.map((entry) => [entry.recordFamily, entry]),
    );
    expect(byFamily.get("workspace-binding")?.variants).toContain(
      "catalog-reset",
    );
    expect(byFamily.get("workspace-binding-root")?.variants).toEqual([
      "healthy",
      "degraded",
      "pending-reset",
    ]);
    expect(byFamily.get("session-activity")?.variants).toEqual([
      "upsert",
      "delete",
    ]);
    expect(byFamily.get("legacy-workscene-migration")?.variants).toEqual([
      "open",
      "activated",
      "abandoned",
    ]);
    expect(byFamily.get("workscene-activity-projection")?.variants).toEqual([
      "put",
      "tombstone",
    ]);
    expect(byFamily.get("session-activity")?.producer).toBe(
      "ConversationRunJournal",
    );
  });
});

function declaredSymbols(source: string, file: string): readonly string[] {
  const tree = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const result = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      (ts.isClassDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node)) &&
      node.name
    ) {
      result.add(node.name.text);
    }
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      result.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return [...result];
}

function testTitles(source: string, file: string): readonly string[] {
  const tree = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const result: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      isTestCall(node.expression) &&
      node.arguments[0] &&
      (ts.isStringLiteral(node.arguments[0]) ||
        ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))
    ) {
      result.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return result;
}

function isTestCall(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) {
    return expression.text === "it" || expression.text === "test";
  }
  return (
    ts.isPropertyAccessExpression(expression) &&
    (expression.name.text === "it" || expression.name.text === "test")
  );
}
