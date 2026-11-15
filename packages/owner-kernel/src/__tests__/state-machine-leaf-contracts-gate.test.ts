import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONVERSATION_PROTOCOL_OBLIGATION_OWNERS,
} from "../../../cli/src/serve/conversation-protocol/contracts.js";
import {
  EXECUTOR_RECORD_UNIT_OWNERS,
  buildLedgerProjectionCheckpointPrefix,
} from "../../../executor/src/ledger/contracts.js";
import {
  CONVERSATION_INTERNAL_RECORD_FAMILY_OWNERS,
  CONVERSATION_RECORD_FAMILY_OWNERS,
} from "../conversation-journal/contracts.js";
import {
  CONVERSATION_RUN_INTERNAL_RECORD_TYPES,
  CONVERSATION_RUN_RECORD_SHAPES,
} from "../conversation-run-contracts.js";
import {
  JOB_JOURNAL_RECORD_SHAPES,
  JOB_RECORD_FAMILY_OWNERS,
} from "../job-journal/contracts.js";
import {
  buildSemanticProjectionCheckpointPrefix,
} from "../shared-protocol/contracts.js";
import type { AssignmentRecord } from "@zhixing-ai/core/contracts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");

function collectTypeScriptFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectTypeScriptFiles(full));
    } else if (entry.isFile() && full.endsWith(".ts")) {
      results.push(full);
    }
  }
  return results;
}

describe("Slice A leaf contracts, facade zero-reverse-import & semantic checkpoint fingerprint gate", () => {
  it("enforces zero reverse imports from internal sub-modules to the 4 public facades", () => {
    const internalDirs = [
      path.join(REPO_ROOT, "packages/owner-kernel/src/shared-protocol"),
      path.join(REPO_ROOT, "packages/owner-kernel/src/conversation-journal"),
      path.join(REPO_ROOT, "packages/owner-kernel/src/job-journal"),
      path.join(REPO_ROOT, "packages/executor/src/ledger"),
      path.join(REPO_ROOT, "packages/cli/src/serve/conversation-protocol"),
    ];
    const forbiddenFacadeBasenames = [
      "conversation-assignment.js",
      "conversation-assignment.ts",
      "job-assignment.js",
      "job-assignment.ts",
      "assignment-ledger.js",
      "assignment-ledger.ts",
      "conversation-protocol-runtime.js",
      "conversation-protocol-runtime.ts",
    ];

    const violations: string[] = [];
    for (const dir of internalDirs) {
      for (const file of collectTypeScriptFiles(dir)) {
        const text = fs.readFileSync(file, "utf8");
        const importMatches = text.matchAll(
          /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g,
        );
        for (const match of importMatches) {
          const specifier = match[1]!;
          if (forbiddenFacadeBasenames.some((name) => specifier.endsWith(`/${name}`) || specifier === `./${name}` || specifier === `../${name}`)) {
            violations.push(`${path.relative(REPO_ROOT, file)} -> ${specifier}`);
          }
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("covers 100% of durable record discriminants across conversation, job, and executor ownership maps", () => {
    expect(Object.keys(CONVERSATION_RECORD_FAMILY_OWNERS).sort()).toEqual(
      Object.keys(CONVERSATION_RUN_RECORD_SHAPES).sort(),
    );
    expect(Object.keys(CONVERSATION_INTERNAL_RECORD_FAMILY_OWNERS).sort()).toEqual(
      [...CONVERSATION_RUN_INTERNAL_RECORD_TYPES].sort(),
    );
    expect(Object.keys(JOB_RECORD_FAMILY_OWNERS).sort()).toEqual(
      Object.keys(JOB_JOURNAL_RECORD_SHAPES).sort(),
    );
    const expectedAssignmentDiscriminants: Record<AssignmentRecord["t"], true> = {
      received: true,
      "dispatch-rejected": true,
      "control-lease-renewed": true,
      started: true,
      "supersede-fenced": true,
      "abort-requested": true,
      halted: true,
      "cancel-proof-owner-accepted": true,
      "interaction-requested": true,
      "interaction-finished": true,
      "interaction-stream-projection-enabled": true,
      "interaction-stream-projected": true,
      "interaction-settlement-owner-accepted": true,
      mirrored: true,
      "trust-sediment": true,
      "trust-rule-hit": true,
      "side-effect-started": true,
      "side-effect-completed": true,
      "staged-mutation": true,
      "execution-failed": true,
      bundle_sealed: true,
      acked: true,
    };
    expect(Object.keys(EXECUTOR_RECORD_UNIT_OWNERS).sort()).toEqual(
      Object.keys(expectedAssignmentDiscriminants).sort(),
    );
    expect(Object.keys(CONVERSATION_PROTOCOL_OBLIGATION_OWNERS).length).toBeGreaterThanOrEqual(6);
  });

  it("invalidates projection checkpoint prefixes when any leaf semantic function changes and rejects empty leaf sets", () => {
    const leafAlphaV1 = function reduceLeafAlpha(x: number) { return x + 1; };
    const leafAlphaV2 = function reduceLeafAlpha(x: number) { return x + 2; };
    const leafBeta = function extractLeafBeta(x: number) { return x * 3; };

    const keyV1 = buildSemanticProjectionCheckpointPrefix("test-proj", 1, [leafAlphaV1, leafBeta]);
    const keyV2 = buildSemanticProjectionCheckpointPrefix("test-proj", 1, [leafAlphaV2, leafBeta]);
    expect(keyV1).not.toBe(keyV2);

    const ledgerV1 = buildLedgerProjectionCheckpointPrefix("executor-assignment-decision", 1, [leafAlphaV1, leafBeta]);
    const ledgerV2 = buildLedgerProjectionCheckpointPrefix("executor-assignment-decision", 1, [leafAlphaV2, leafBeta]);
    expect(ledgerV1).not.toBe(ledgerV2);

    expect(() => buildSemanticProjectionCheckpointPrefix("test-proj", 1, [])).toThrow(
      /requires at least one leaf reducer function/,
    );
    expect(() => buildLedgerProjectionCheckpointPrefix("executor-assignment-decision", 1, [])).toThrow(
      /requires at least one leaf reducer function/,
    );
  });
});
