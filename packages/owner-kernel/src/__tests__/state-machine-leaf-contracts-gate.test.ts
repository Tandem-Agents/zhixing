import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { AssignmentRecord, DataPlaneTicket } from "@zhixing-ai/core/contracts";
import { protocolDigest, signCancelProof } from "@zhixing-ai/core/protocol";
import {
  CONVERSATION_PROTOCOL_OBLIGATION_OWNERS,
} from "../../../cli/src/serve/conversation-protocol/contracts.js";
import { RecoveryScheduler } from "../../../cli/src/serve/conversation-protocol/recovery-scheduler.js";
import { RuntimeObligationScope } from "../../../cli/src/serve/conversation-protocol/runtime-obligation-scope.js";
import { TerminalSettlement } from "../../../cli/src/serve/conversation-protocol/terminal-settlement.js";
import {
  EXECUTOR_RECORD_UNIT_OWNERS,
  buildLedgerProjectionCheckpointPrefix,
} from "../../../executor/src/ledger/contracts.js";
import {
  toExecutionControlFacts,
  toInteractionEffectFacts,
  toReceiptRecoveryFacts,
  toSealingEvidenceFacts,
} from "../../../executor/src/ledger/projection-history-store.js";
import {
  LEDGER_BINDING_FINGERPRINT_FNS,
  LEDGER_DECISION_FINGERPRINT_FNS,
  emptyProjection,
} from "../../../executor/src/ledger/state-replay.js";
import {
  CONVERSATION_INTERNAL_RECORD_FAMILY_OWNERS,
  CONVERSATION_RECORD_FAMILY_OWNERS,
  emptyConversationRunProjection,
  emptySubmissionGuardProjection,
} from "../conversation-journal/contracts.js";
import {
  CONVERSATION_GUARD_FINGERPRINT_FNS,
  reduceConversationSubmissionGuard,
} from "../conversation-journal/replay/guard-reducer.js";
import {
  CONVERSATION_RUN_FINGERPRINT_FNS,
} from "../conversation-journal/replay/run-reducer.js";
import {
  readConversationDecisionFacts,
} from "../conversation-journal/state/views.js";
import {
  prepareTrustRuleHitMirrorSession,
} from "../conversation-journal/submission/prepared-submission.js";
import {
  CONVERSATION_RUN_INTERNAL_RECORD_TYPES,
  CONVERSATION_RUN_RECORD_SHAPES,
} from "../conversation-run-contracts.js";
import {
  JOB_JOURNAL_RECORD_SHAPES,
  JOB_RECORD_FAMILY_OWNERS,
  createJobGuardState,
  jobSubmissionGuardView,
} from "../job-journal/contracts.js";
import {
  decideIssueDataPlaneTicket as decideJobIssueDataPlaneTicket,
} from "../job-journal/operations/channel-tickets-mirror.js";
import { JobReduction } from "../job-journal/replay/reduction.js";
import { jobMirrorClosed } from "../job-journal/state/channel-tickets-mirror.js";
import { readJobDecisionFacts } from "../job-journal/state/views.js";
import { JobStateBinding } from "../job-run-state.js";
import {
  decideIssueDataPlaneTicket as decideConversationIssueDataPlaneTicket,
} from "../conversation-journal/operations/channel-tickets.js";
import {
  buildSemanticProjectionCheckpointPrefix,
} from "../shared-protocol/contracts.js";
import {
  decideDataPlaneTicketReplayOrConflict,
  validateDataPlaneTicketIssueRequest,
  validateDataPlaneTicketSurfaceAndRenewal,
} from "../shared-protocol/data-plane-ticket-authority.js";
import {
  classifyNotStartedTermination,
} from "../shared-protocol/not-started-termination.js";

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

function extractModuleSpecifiersViaAst(fileName: string, sourceText: string): string[] {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const specifiers: string[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0]!)
    ) {
      specifiers.push(node.arguments[0]!.text);
    } else if (ts.isImportTypeNode(node)) {
      if (
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      ) {
        specifiers.push(node.argument.literal.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return specifiers;
}

function collectFacadeViolations(
  files: readonly { readonly filePath: string; readonly sourceText: string }[],
  forbiddenTargets: ReadonlySet<string>,
  forbiddenSpecifiers: ReadonlySet<string> = new Set(),
): string[] {
  const violations: string[] = [];
  for (const { filePath, sourceText } of files) {
    for (const specifier of extractModuleSpecifiersViaAst(filePath, sourceText)) {
      if (specifier.startsWith(".")) {
        const resolvedNoExt = path
          .resolve(path.dirname(filePath), specifier)
          .replace(/\.(?:js|ts)$/, "");
        if (forbiddenTargets.has(resolvedNoExt)) {
          violations.push(`${path.relative(REPO_ROOT, filePath)} -> ${specifier}`);
        }
      } else if (forbiddenSpecifiers.has(specifier)) {
        violations.push(`${path.relative(REPO_ROOT, filePath)} -> ${specifier}`);
      }
    }
  }
  return violations;
}

function extractExplicitExportsViaAst(filePath: string): {
  readonly values: string[];
  readonly types: string[];
} {
  const src = fs.readFileSync(filePath, "utf8");
  const sf = ts.createSourceFile(filePath, src, ts.ScriptTarget.Latest, true);
  const values: string[] = [];
  const types: string[] = [];
  for (const st of sf.statements) {
    const isExported = st.modifiers?.some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword,
    );
    if (
      ts.isExportDeclaration(st) &&
      st.exportClause &&
      ts.isNamedExports(st.exportClause)
    ) {
      for (const el of st.exportClause.elements) {
        (st.isTypeOnly || el.isTypeOnly ? types : values).push(el.name.text);
      }
    } else if (isExported) {
      if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) {
        types.push(st.name.text);
      } else if (
        ts.isClassDeclaration(st) ||
        ts.isFunctionDeclaration(st) ||
        ts.isEnumDeclaration(st)
      ) {
        if (st.name) values.push(st.name.text);
      } else if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name)) values.push(d.name.text);
        }
      }
    }
  }
  return {
    values: [...new Set(values)].sort(),
    types: [...new Set(types)].sort(),
  };
}

describe("Slice A & B leaf contracts, AST facade gate, state encapsulation & semantic fingerprint gate", () => {
  it(
    "enforces zero reverse imports (including TS ImportTypeNode) from internal clusters to the 4 public facades, with negative proof",
    { timeout: 30_000 },
    () => {
    const allFourFacades = new Set(
      [
        "packages/owner-kernel/src/conversation-assignment",
        "packages/owner-kernel/src/job-assignment",
        "packages/executor/src/assignment-ledger",
        "packages/cli/src/serve/conversation-protocol-runtime",
      ].map((rel) => path.resolve(REPO_ROOT, rel)),
    );
    const loadDir = (relDir: string) =>
      collectTypeScriptFiles(path.join(REPO_ROOT, relDir)).map((filePath) => ({
        filePath,
        sourceText: fs.readFileSync(filePath, "utf8"),
      }));

    // 1. owner-kernel internal clusters + test-support must not reverse-import owner-kernel facades
    const ownerInternalFiles = [
      ...loadDir("packages/owner-kernel/src/shared-protocol"),
      ...loadDir("packages/owner-kernel/src/conversation-journal"),
      ...loadDir("packages/owner-kernel/src/job-journal"),
      ...loadDir("packages/owner-kernel/src/test-support"),
    ];
    expect(
      collectFacadeViolations(
        ownerInternalFiles,
        allFourFacades,
        new Set([
          "@zhixing-ai/owner-kernel/conversation-assignment",
          "@zhixing-ai/owner-kernel/job-assignment",
        ]),
      ),
    ).toEqual([]);

    // 2. executor internal cluster must not reverse-import assignment-ledger facade
    expect(
      collectFacadeViolations(
        loadDir("packages/executor/src/ledger"),
        allFourFacades,
        new Set(["@zhixing-ai/executor/assignment-ledger"]),
      ),
    ).toEqual([]);

    // 3. cli internal cluster must not reverse-import conversation-protocol-runtime facade
    expect(
      collectFacadeViolations(
        loadDir("packages/cli/src/serve/conversation-protocol"),
        allFourFacades,
      ),
    ).toEqual([]);

    // 4. Same-package non-facade production modules in owner-kernel must not import conversation-assignment or job-assignment facades
    const ownerSrcRoot = path.join(REPO_ROOT, "packages/owner-kernel/src");
    const ownerRootProdFiles = fs
      .readdirSync(ownerSrcRoot, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(".ts") &&
          !entry.name.endsWith(".test.ts") &&
          entry.name !== "conversation-assignment.ts" &&
          entry.name !== "job-assignment.ts",
      )
      .map((entry) => {
        const filePath = path.join(ownerSrcRoot, entry.name);
        return { filePath, sourceText: fs.readFileSync(filePath, "utf8") };
      });
    expect(
      collectFacadeViolations(
        ownerRootProdFiles,
        new Set([
          path.resolve(REPO_ROOT, "packages/owner-kernel/src/conversation-assignment"),
          path.resolve(REPO_ROOT, "packages/owner-kernel/src/job-assignment"),
        ]),
        new Set([
          "@zhixing-ai/owner-kernel/conversation-assignment",
          "@zhixing-ai/owner-kernel/job-assignment",
        ]),
      ),
    ).toEqual([]);

    // 5. Same-package non-index non-facade production modules in executor must not import assignment-ledger facade
    const executorSrcRoot = path.join(REPO_ROOT, "packages/executor/src");
    const executorRootProdFiles = fs
      .readdirSync(executorSrcRoot, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith(".ts") &&
          !entry.name.endsWith(".test.ts") &&
          entry.name !== "index.ts" &&
          entry.name !== "assignment-ledger.ts",
      )
      .map((entry) => {
        const filePath = path.join(executorSrcRoot, entry.name);
        return { filePath, sourceText: fs.readFileSync(filePath, "utf8") };
      });
    expect(
      collectFacadeViolations(
        executorRootProdFiles,
        new Set([path.resolve(REPO_ROOT, "packages/executor/src/assignment-ledger")]),
        new Set(["@zhixing-ai/executor/assignment-ledger"]),
      ),
    ).toEqual([]);

    // Negative test: relative ImportTypeNode (`import("../conversation-assignment.js").RunProjection`) MUST fail
    const syntheticLeakFile = path.join(
      REPO_ROOT,
      "packages/owner-kernel/src/conversation-journal/leak-probe.ts",
    );
    const syntheticViolations = collectFacadeViolations(
      [
        {
          filePath: syntheticLeakFile,
          sourceText:
            'export type Leaked = import("../conversation-assignment.js").RunProjection;\n',
        },
      ],
      allFourFacades,
    );
    expect(syntheticViolations.length).toBe(1);
    expect(syntheticViolations[0]).toContain("../conversation-assignment.js");
  });

  it("preserves exact baseline public export surface on conversation-assignment.ts (34 values, 48 types, zero extra PublishDomainPlan)", () => {
    const facadePath = path.join(
      REPO_ROOT,
      "packages/owner-kernel/src/conversation-assignment.ts",
    );
    const exported = extractExplicitExportsViaAst(facadePath);
    expect(exported.types).not.toContain("PublishDomainPlan");
    expect(exported.values).toEqual([
      "ADVANCEMENT_DURABLE_CONTRACT",
      "AdvancementWriteRejectedError",
      "CONVERSATION_RUN_INTERNAL_RECORD_TYPES",
      "CONVERSATION_RUN_RECORD_SHAPES",
      "ConversationAssignmentCancelledError",
      "ConversationPendingCancellationError",
      "ConversationRunJournal",
      "InProcessConversationDispatcher",
      "SESSION_ACTIVITY_DURABLE_CONTRACT",
      "SessionActivityRejectedError",
      "assertAssignedMatchesDispatch",
      "assertConversationRunInternalRecord",
      "conversationDecisionMigrationStatus",
      "conversationDecisionPending",
      "conversationDecisionReady",
      "conversationRecoveryPage",
      "conversationRecoveryPending",
      "discoverConversationRecoveryCandidates",
      "discoverConversationRecoveryCandidatesFromLog",
      "dispatchConflictKey",
      "emptyConversationRunProjection",
      "emptySubmissionGuardProjection",
      "loadCommittedBundleBinding",
      "pendingAdvancementConversations",
      "prioritizeConversationDecisionMigration",
      "reduceConversationContainment",
      "reduceConversationRunState",
      "reduceConversationSessionFact",
      "reduceConversationSubmissionGuard",
      "reduceImportedConversationGuard",
      "rejectedNotStartedKey",
      "startConversationDecisionMigration",
      "stopConversationDecisionMigration",
      "validateImportedConversationCommit",
    ]);
    expect(exported.types).toEqual([
      "AdmittedProjection",
      "AssignedProjection",
      "AssignmentBundleSubmissionResult",
      "AssignmentSubmissionAuthorization",
      "AssignmentSubmissionAuthorizer",
      "AssignmentSubmissionIdentity",
      "AssignmentSubmissionMethod",
      "AssignmentSubmissionPreflightPort",
      "AssignmentSubmissionPreflightResult",
      "CommittedConversationResult",
      "ConversationAbortTicketAuthorizer",
      "ConversationCancelRequest",
      "ConversationCancelResult",
      "ConversationChannelFrameAdoption",
      "ConversationCommitAuthority",
      "ConversationCommitDecisionInput",
      "ConversationCommitLogRecord",
      "ConversationCommitProjection",
      "ConversationCommitProjectionInput",
      "ConversationDispatchPort",
      "ConversationFactGroup",
      "ConversationGlobalMutationDecision",
      "ConversationLifecycleProjection",
      "ConversationLifecycleProjectionInput",
      "ConversationMutationPublisher",
      "ConversationRunControlDescriptor",
      "ConversationRunInternalRecord",
      "ConversationRunJournalOptions",
      "ConversationRunJournalRecord",
      "ConversationRunRecordType",
      "ConversationRunReductionContext",
      "ConversationSubmissionGuardContext",
      "ConversationTrustSedimentPort",
      "DataPlaneTicketFacts",
      "DataPlaneTicketIssueRequest",
      "InProcessBundleSubmission",
      "InProcessCancellationSubmission",
      "InProcessConversationDispatcherOptions",
      "InProcessDispatchContextFactory",
      "PendingConversationDispatch",
      "PendingConversationFence",
      "PendingConversationInput",
      "RunProjection",
      "SubmissionGuardProjection",
      "TrustRuleHitBatchInput",
      "TrustRuleHitBatchState",
      "TrustRuleHitOrigin",
      "TrustRuleHitPort",
    ]);
  });

  it("enforces Slice B narrow state-family & decider encapsulation (zero RunProjection/SubmissionGuardProjection in operations/* and family state modules, private heap, zero approvedForWrite)", () => {
    const cjRoot = path.join(
      REPO_ROOT,
      "packages/owner-kernel/src/conversation-journal",
    );
    const familyModules = new Set([
      "state/run-queue-input.ts",
      "state/session-domain.ts",
      "state/channel-tickets.ts",
      "state/assignment-control.ts",
      "state/commit-publish.ts",
    ]);
    const fullCarrierLeaks: string[] = [];
    const heapLeaks: string[] = [];
    const approvedBooleanLeaks: string[] = [];

    for (const file of collectTypeScriptFiles(cjRoot)) {
      const rel = path.relative(cjRoot, file).replace(/\\/g, "/");
      const text = fs.readFileSync(file, "utf8");
      if (text.includes("approvedForWrite")) {
        approvedBooleanLeaks.push(rel);
      }
      if (
        text.includes("queuedPositionHeap") &&
        rel !== "contracts.ts" &&
        rel !== "state/run-queue-input.ts"
      ) {
        heapLeaks.push(rel);
      }
      if (
        (rel.startsWith("operations/") || familyModules.has(rel)) &&
        /\b(?:RunProjection|SubmissionGuardProjection)\b/.test(text)
      ) {
        fullCarrierLeaks.push(rel);
      }
    }

    expect(fullCarrierLeaks).toEqual([]);
    expect(heapLeaks).toEqual([]);
    expect(approvedBooleanLeaks).toEqual([]);
  });

  it("prevents write-through mutation via ConversationDecisionFacts readonly views", () => {
    const raw = emptyConversationRunProjection("conv-encap-1");
    raw.admittedByRun.set("run-1", {
      record: {
        ingressKey: "ing-1",
        runId: "run-1",
        ingress: {
          surfacePrincipal: "user:local",
          surfaceKind: "cli",
          receivedAt: "2026-11-16T00:00:00.000Z",
        },
        invocation: { kind: "user-turn" },
        queuedPosition: 1,
      },
      input: { text: "hello" },
      lsn: 1,
    });
    raw.assignedById.set("assign-1", {
      record: {
        t: "assigned",
        runId: "run-1",
        assignmentId: "assign-1",
        executorId: "exec-1",
        ownerEpoch: 1,
        baseRevision: 0,
        dispatchDigest: "d1",
        manifestDigest: "m1",
        dispatchRef: { digest: "r1", byteLength: 10 },
        permissionLeaseDigest: "p1",
        capIds: ["cap-1"],
        reservation: { reservationId: "res-1", attempt: 1 },
      },
      acked: false,
      lsn: 2,
    });
    raw.mirrorStateByAssignment.set("assign-1", {
      ordinal: 3,
      mirroredUpTo: 5,
      mirrorDigest: "md-1",
      requestIds: new Set(["req-1"]),
    });

    const facts = readConversationDecisionFacts(raw);
    const admittedView = facts.queueInput.getAdmitted("run-1")!;
    const assignedView = facts.assignment.getAssigned("assign-1")!;
    const mirrorView = facts.commitPublish.getMirrorState("assign-1")!;

    expect(() => {
      (admittedView as unknown as { input: unknown }).input = undefined;
    }).toThrow(TypeError);
    expect(() => {
      (assignedView as unknown as { acked: boolean }).acked = true;
    }).toThrow(TypeError);
    expect(() => {
      (mirrorView as unknown as { ordinal: number }).ordinal = 99;
    }).toThrow(TypeError);
    expect(
      "add" in (mirrorView.requestIds as unknown as Record<string, unknown>),
    ).toBe(false);
    expect(raw.admittedByRun.get("run-1")?.input).toEqual({ text: "hello" });
    expect(raw.assignedById.get("assign-1")?.acked).toBe(false);
    expect(raw.mirrorStateByAssignment.get("assign-1")?.ordinal).toBe(3);
  });

  it("captures exact pre-state for deferred checks across multi-record batch reductions and prepares trust rule hits at most once across retries", async () => {
    const guard = emptySubmissionGuardProjection();
    guard.admittedByRun.set("run-1", {
      ingressKey: "ing-1",
      queuedPosition: 1,
      ingress: {
        surfacePrincipal: "user:local",
        surfaceKind: "cli",
        receivedAt: "2026-11-16T00:00:00.000Z",
      },
    });
    guard.queuedRunByPosition.set(1, "run-1");
    guard.queuedPositionHeap.push(1);
    guard.queuedPositionHeapIndex.set(1, 0);
    guard.stateByRun.set("run-1", { state: "dispatched", statusRevision: 2 });
    guard.assignmentByRun.set("run-1", "assign-1");
    guard.activeRunId = "run-1";
    guard.assignedById.set("assign-1", {
      record: {
        t: "assigned",
        runId: "run-1",
        assignmentId: "assign-1",
        executorId: "exec-1",
        ownerEpoch: 1,
        baseRevision: 0,
        dispatchDigest: `sha256:${"a".repeat(64)}`,
        manifestDigest: `sha256:${"b".repeat(64)}`,
        dispatchRef: { digest: `sha256:${"c".repeat(64)}`, bytes: 32 },
        permissionLeaseDigest: `sha256:${"d".repeat(64)}`,
        capIds: ["cap-1"],
        reservation: { reservationId: "res-1", attempt: 1 },
      } as unknown as import("../conversation-journal/contracts.js").AssignedProjection["record"],
      capIds: new Set(["cap-1"]),
      acked: true,
    });
    const testSigner: import("@zhixing-ai/core/protocol").ProtocolSigner = {
      sign: (schemaId, version, payload) => ({
        alg: "test-sha256",
        keyId: "exec-1",
        sig: protocolDigest(schemaId, version, payload),
      }),
    };
    const testVerifier: import("@zhixing-ai/core/protocol").ProtocolSignatureVerifier = {
      verify: () => undefined,
    };
    guard.ticketsById.set("tok-abort-1", {
      v: 1,
      ticketId: "tok-abort-1",
      assignmentId: "assign-1",
      executorId: "exec-1",
      surfacePrincipal: "user:local",
      kind: "abort",
      issuedAt: "2026-11-16T00:00:00.000Z",
      expiry: "2026-11-16T00:05:00.000Z",
      signature: {
        alg: "test-sha256",
        keyId: "owner-1",
        sig: `sha256:${"e".repeat(64)}`,
      },
    } as unknown as DataPlaneTicket);

    // Verify legacyAbortTickets deferred check captures ticketIds snapshot BEFORE a subsequent ticket-issued mutates ticketIdsByAssignment
    let legacyCalls = 0;
    const checks: Array<() => void> = [];
    const fakeAbortProof = signCancelProof(
      {
        v: 1,
        assignmentId: "assign-1",
        executorId: "exec-1",
        authority: {
          execution: "conversation",
          conversationId: "conv-1",
          ownerEpoch: 1,
        },
        cause: "abort-ticket",
        surfacePrincipal: "user:local",
        ticketDigest: `sha256:${"1".repeat(64)}`,
        decision: "halted",
        lastRecordSeq: 3,
        lastEffectSeq: 0,
        ledgerDigest: `sha256:${"6".repeat(64)}`,
        usageFinal: { reportDigest: `sha256:${"2".repeat(64)}`, upToUsageSeq: 0 },
        issuedAt: "2026-11-16T00:01:00.000Z",
      },
      testSigner,
    );
    const envelope = {
      lsn: 3,
      envelopeDigest: `sha256:${"5".repeat(64)}`,
      at: "2026-11-16T00:01:00.000Z",
      entries: [
        {
          stream: "run:conv-1",
          body: {
            t: "cancel-proof-accepted" as const,
            assignmentId: "assign-1",
            proof: fakeAbortProof,
          },
        },
        {
          stream: "run:conv-1",
          body: {
            t: "capability-revoked" as const,
            assignmentId: "assign-1",
            capId: "cap-1",
          },
        },
        {
          stream: "run:conv-1",
          body: {
            t: "state" as const,
            runId: "run-1",
            assignmentId: "assign-1",
            state: "cancelled" as const,
            statusRevision: 3,
          },
        },
      ],
    };

    await reduceConversationSubmissionGuard(
      {
        conversationId: "conv-1",
        verifier: testVerifier,
        legacyAbortTickets: {
          authorize: () => {
            legacyCalls += 1;
          },
        },
        assertResourceUsageFinal: () => undefined,
        assertResourceTerminalRecords: () => undefined,
      },
      guard,
      envelope.entries[0]!,
      envelope,
      checks,
    );
    // Simulate a later mutation in the same batch adding a ticket id before checks flush
    guard.ticketIdsByAssignment.set("assign-1", new Set(["tok-abort-1"]));
    for (const check of checks) check();
    // Because pre-state had 0 ticketIds for assign-1, legacyAbortTickets.authorize MUST still be invoked!
    expect(legacyCalls).toBe(1);

    // Verify prepareTrustRuleHitMirrorSession prepares once and settles at most once
    let prepareCount = 0;
    let discardCount = 0;
    let acceptCount = 0;
    const session = await prepareTrustRuleHitMirrorSession({
      conversationId: "conv-1",
      assignmentId: "assign-1",
      batch: { entries: [] } as unknown as import("@zhixing-ai/core/protocol").ConversationInteractionMirrorBatch,
      batchDigest: "bd-1",
      hits: [{ ruleId: "rule-1" } as unknown as import("@zhixing-ai/core/contracts").TrustRuleHitMirrorEntry],
      trustRuleHits: {
        prepare: async () => {
          prepareCount += 1;
        },
        accept: async () => {
          acceptCount += 1;
        },
        discard: async () => {
          discardCount += 1;
        },
      },
      selectPrecheck: async () => ({
        prepare: true,
        environment: {},
      }),
      selectBatchCommitted: async () => false,
    });
    expect(session.prepared).toBe(true);
    expect(prepareCount).toBe(1);
    // Simulate retry loop reusing `session` without re-calling prepareTrustRuleHitMirrorSession, then failing
    await session.settleAfterError();
    await session.settleAfterError();
    expect(prepareCount).toBe(1);
    expect(discardCount).toBe(1);
    expect(acceptCount).toBe(0);
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

  it("invalidates projection checkpoint prefixes when any leaf semantic function changes and verifies real Slice B leaf sets", () => {
    expect(CONVERSATION_RUN_FINGERPRINT_FNS.length).toBeGreaterThanOrEqual(10);
    expect(CONVERSATION_GUARD_FINGERPRINT_FNS.length).toBeGreaterThanOrEqual(10);

    const runPrefixReal = buildSemanticProjectionCheckpointPrefix(
      "conversation-run-projection",
      2,
      CONVERSATION_RUN_FINGERPRINT_FNS,
    );
    const mutatedRunFns = [
      ...CONVERSATION_RUN_FINGERPRINT_FNS.slice(0, -1),
      function mutatedLeafSemanticFn() {
        return "changed";
      },
    ];
    const runPrefixMutated = buildSemanticProjectionCheckpointPrefix(
      "conversation-run-projection",
      2,
      mutatedRunFns,
    );
    expect(runPrefixReal).not.toBe(runPrefixMutated);

    const guardPrefixReal = buildSemanticProjectionCheckpointPrefix(
      "conversation-submission-projection",
      1,
      CONVERSATION_GUARD_FINGERPRINT_FNS,
    );
    const guardPrefixMutated = buildSemanticProjectionCheckpointPrefix(
      "conversation-submission-projection",
      1,
      [
        ...CONVERSATION_GUARD_FINGERPRINT_FNS.slice(0, -1),
        function mutatedGuardLeafFn() {
          return "changed";
        },
      ],
    );
    expect(guardPrefixReal).not.toBe(guardPrefixMutated);

    const leafAlphaV1 = function reduceLeafAlpha(x: number) { return x + 1; };
    const leafAlphaV2 = function reduceLeafAlpha(x: number) { return x + 2; };
    const leafBeta = function extractLeafBeta(x: number) { return x * 3; };

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

  it("preserves exact baseline public export surface on job-assignment.ts (16 values, 23 types)", () => {
    const facadePath = path.join(
      REPO_ROOT,
      "packages/owner-kernel/src/job-assignment.ts",
    );
    const exported = extractExplicitExportsViaAst(facadePath);
    expect(exported.values).toEqual([
      "InProcessJobDispatcher",
      "JOB_JOURNAL_RECORD_SHAPES",
      "JobJournal",
      "JobReduction",
      "createJobGuardState",
      "createJobMainState",
      "jobGuardStatePrefix",
      "jobMainStatePrefix",
      "jobProjectionView",
      "jobScopeOf",
      "jobSubmissionGuardView",
      "occurrenceOrderKey",
      "occurrenceSortKey",
      "preloadFailureSummaryPaths",
      "preloadJobScope",
      "registerJobJournalProjection",
    ]);
    expect(exported.types).toEqual([
      "InProcessJobBundleSubmission",
      "InProcessJobCancellationSubmission",
      "InProcessJobDispatcherOptions",
      "JobAssignmentPlan",
      "JobCancelResult",
      "JobChannelChallengePreparation",
      "JobChannelRelayAdoption",
      "JobCommitParticipant",
      "JobIngressAuthorizer",
      "JobInteractionRoute",
      "JobJournalOptions",
      "JobJournalRecordType",
      "JobLifecycleEvent",
      "JobRecoveryCandidate",
      "JobReductionOptions",
      "JobSchedulerReadView",
      "JobScope",
      "JobTrustSedimentPort",
      "PendingJobDispatch",
      "PendingJobFence",
      "SystemJobHandler",
      "SystemJobHandlerContext",
      "SystemJobResourceCoordinator",
    ]);
  });

  it("enforces Slice C narrow state-family & decider encapsulation in job-journal", () => {
    const jjRoot = path.join(
      REPO_ROOT,
      "packages/owner-kernel/src/job-journal",
    );
    const familyModules = new Set([
      "state/common.ts",
      "state/task-schedule.ts",
      "state/assignment-control.ts",
      "state/channel-tickets-mirror.ts",
    ]);
    const fullCarrierLeaks: string[] = [];
    for (const file of collectTypeScriptFiles(jjRoot)) {
      const rel = path.relative(jjRoot, file).replace(/\\/g, "/");
      const text = fs.readFileSync(file, "utf8");
      if (
        (rel.startsWith("operations/") ||
          rel.startsWith("submission/") ||
          familyModules.has(rel)) &&
        /\b(?:JobProjection|JobSubmissionGuardProjection)\b/.test(text)
      ) {
        fullCarrierLeaks.push(rel);
      }
    }
    expect(fullCarrierLeaks).toEqual([]);
  });

  it("enforces bounded O(log N) commitsAfter / O(1)-hit findCommittedByRunId and lazy frozen ticketsIterable()", () => {
    const raw = emptyConversationRunProjection("conv-cost-probe");
    const total = 16_384;
    const underlying = Array.from({ length: total }, (_, idx) => ({
      t: "committed" as const,
      runId: `run-${idx + 1}`,
      assignmentId: `assign-${idx + 1}`,
      bundle: {
        ref: { digest: `sha256:${"a".repeat(64)}`, bytes: 16 },
        manifestDigest: `sha256:${"b".repeat(64)}`,
        resultDigest: `sha256:${"c".repeat(64)}`,
      },
      commitRevision: idx + 1,
      sidecars: {
        transcriptCount: 0,
        contentCount: 0,
        globalMutationCount: 0,
      },
    })) as unknown as typeof raw.commits;

    let indexReads = 0;
    raw.commits = new Proxy(underlying, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && /^\d+$/.test(prop)) {
          indexReads += 1;
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const facts = readConversationDecisionFacts(raw);
    indexReads = 0;
    expect(facts.commitPublish.commitsAfter(total)).toEqual([]);
    expect(indexReads).toBeLessThanOrEqual(15);

    indexReads = 0;
    const first = facts.commitPublish.findCommittedByRunId("run-1");
    expect(first?.commitRevision).toBe(1);
    expect(indexReads).toBe(1);
    expect(() => {
      (first as unknown as { commitRevision: number }).commitRevision = 999;
    }).toThrow(TypeError);

    // Lazy per-item frozen ticketsIterable()
    let tailTicketRefReads = 0;
    const ticket1 = {
      $schema: "zhixing.DataPlaneTicket",
      v: 1 as const,
      ticketId: "tok-1",
      ref: {
        execution: "conversation" as const,
        runId: "run-1",
        conversationId: "conv-cost-probe",
        ownerEpoch: 1,
      },
      assignmentId: "assign-1",
      surfacePrincipal: "user:local",
      executorId: "exec-1",
      issuedAt: "2026-11-16T00:00:00.000Z",
      expiry: "2026-11-16T00:05:00.000Z",
      kind: "run-observe" as const,
      renewable: true as const,
      signature: {
        alg: "ed25519",
        keyId: "owner-1",
        sig: `sha256:${"1".repeat(64)}`,
      },
    } as unknown as DataPlaneTicket;
    const ticket2 = new Proxy(
      { ...ticket1, ticketId: "tok-2" } as DataPlaneTicket,
      {
        get(target, prop, receiver) {
          if (prop === "ref") tailTicketRefReads += 1;
          return Reflect.get(target, prop, receiver);
        },
      },
    );
    raw.ticketsById.set("tok-1", ticket1);
    raw.ticketsById.set("tok-2", ticket2);

    const iterable = facts.tickets.ticketsIterable();
    const seenFirstPass: string[] = [];
    for (const item of iterable) {
      seenFirstPass.push(item.ticketId);
      expect(() => {
        (item as unknown as { expiry: string }).expiry = "2099-01-01T00:00:00.000Z";
      }).toThrow(TypeError);
      expect(() => {
        (item.ref as unknown as { runId: string }).runId = "mutated";
      }).toThrow(TypeError);
      expect(() => {
        (item.signature as unknown as { sig: string }).sig = "mutated";
      }).toThrow(TypeError);
      break;
    }
    expect(seenFirstPass).toEqual(["tok-1"]);
    // Breaking after tok-1 must not have frozen/touched tok-2
    expect(tailTicketRefReads).toBe(0);
    // Re-iterable on a second pass over the same Iterable object
    expect([...iterable].map((t) => t.ticketId)).toEqual(["tok-1", "tok-2"]);
    expect(tailTicketRefReads).toBeGreaterThan(0);
    expect(raw.ticketsById.get("tok-1")?.expiry).toBe("2026-11-16T00:05:00.000Z");
  });

  it("verifies Slice C Gate 3 shared protocol invariants across all 6 not-started entrypoints, ticket authority, settlement fences, and guard reduction", async () => {
    const testSigner: import("@zhixing-ai/core/protocol").ProtocolSigner = {
      sign: (schemaId, version, payload) => ({
        alg: "test-sha256",
        keyId: "exec-1",
        sig: protocolDigest(schemaId, version, payload),
      }),
    };
    const cancelNotStartedProof = signCancelProof(
      {
        v: 1,
        assignmentId: "assign-1",
        executorId: "exec-1",
        authority: {
          execution: "conversation",
          conversationId: "conv-1",
          ownerEpoch: 1,
        },
        cause: "owner-fence",
        fence: { fenceSeq: 1, requestId: "req-1" },
        decision: "not-started",
        lastRecordSeq: 5,
        ledgerDigest: `sha256:${"4".repeat(64)}`,
        usageFinal: { reportDigest: `sha256:${"2".repeat(64)}`, upToUsageSeq: 0 },
        issuedAt: "2026-11-16T00:01:00.000Z",
      },
      testSigner,
    );
    const dispatchRejectionProof = {
      $schema: "zhixing.AssignmentTerminationProof",
      v: 1 as const,
      assignmentId: "assign-1",
      executorId: "exec-1",
      authority: {
        execution: "job" as const,
        taskId: "task-1",
        anchorEpoch: 1,
      },
      decision: "rejected-before-received" as const,
      dispatchDigest: `sha256:${"7".repeat(64)}`,
      lastRecordSeq: 0,
      lastEffectSeq: 0,
      ledgerDigest: `sha256:${"8".repeat(64)}`,
      issuedAt: "2026-11-16T00:01:00.000Z",
      signature: {
        alg: "test-sha256",
        keyId: "exec-1",
        sig: `sha256:${"9".repeat(64)}`,
      },
    } as unknown as import("@zhixing-ai/core/contracts").AssignmentTerminationProof;
    const supersedeProof = {
      $schema: "zhixing.AssignmentTerminationProof",
      v: 1 as const,
      assignmentId: "assign-1",
      executorId: "exec-1",
      authority: {
        execution: "job" as const,
        taskId: "task-1",
        anchorEpoch: 1,
      },
      decision: "not-started-fenced" as const,
      requestDigest: `sha256:${"a".repeat(64)}`,
      lastRecordSeq: 5,
      lastEffectSeq: 0,
      ledgerDigest: `sha256:${"b".repeat(64)}`,
      issuedAt: "2026-11-16T00:01:00.000Z",
      signature: {
        alg: "test-sha256",
        keyId: "exec-1",
        sig: `sha256:${"c".repeat(64)}`,
      },
    } as unknown as import("@zhixing-ai/core/contracts").AssignmentTerminationProof;

    // 1. 6-entrypoint matrix: contradictory-not-started after durable started across all 6 (domain x entrypoint) pairs
    const sixEntrypoints = [
      ["conversation", "dispatch-rejection", dispatchRejectionProof, "dispatch-rejection", "ledger-unknown"],
      ["conversation", "supersede", supersedeProof, "supersede", "ledger-unknown"],
      ["conversation", "cancel-proof", cancelNotStartedProof, "cancel-owner-fence", "cancel-unproven"],
      ["job", "dispatch-rejection", dispatchRejectionProof, "dispatch-rejection", "ledger-unknown"],
      ["job", "supersede", supersedeProof, "supersede", "ledger-unknown"],
      ["job", "cancel-proof", cancelNotStartedProof, "cancel-owner-fence", "job-cancel-unknown"],
    ] as const;

    for (const [domain, entrypoint, proof, proofKind, expectedCause] of sixEntrypoints) {
      const contradictory = classifyNotStartedTermination({
        domain,
        entrypoint,
        proof,
        proofKind,
        currentRunState: "cancel-requested",
        rejectionAlreadyCheckedInPriorProofs: false,
        hasDurableStartedObservation: true,
      });
      expect(contradictory).toEqual({
        kind: "contradictory-not-started",
        opensUncertain: true,
        uncertainCause: expectedCause,
      });

      const accepted = classifyNotStartedTermination({
        domain,
        entrypoint,
        proof,
        proofKind,
        currentRunState:
          entrypoint === "cancel-proof" ? "cancel-requested" : "dispatched",
        rejectionAlreadyCheckedInPriorProofs: false,
        hasDurableStartedObservation: false,
      });
      expect(accepted).toEqual({
        kind: "accepted-not-started",
        settlementRecord:
          entrypoint === "cancel-proof"
            ? "cancel-proof-accepted"
            : "assignment-superseded",
        closesOpenResolution: false,
        closesDispatchConflict: false,
      });
    }

    // Dispatch-conflict resolution rules: dispatch-rejection contradicts received, supersede with seq > received closes conflict
    expect(
      classifyNotStartedTermination({
        domain: "job",
        entrypoint: "dispatch-rejection",
        proof: dispatchRejectionProof,
        proofKind: "dispatch-rejection",
        currentRunState: "uncertain",
        rejectionAlreadyCheckedInPriorProofs: false,
        hasDurableStartedObservation: false,
        openResolution: {
          cause: "dispatch-conflict",
          isOpen: true,
          conflictReceivedRecordSeq: 2,
        },
      }),
    ).toEqual({
      kind: "contradictory-not-started",
      opensUncertain: false,
    });
    expect(
      classifyNotStartedTermination({
        domain: "job",
        entrypoint: "supersede",
        proof: supersedeProof,
        proofKind: "supersede",
        currentRunState: "uncertain",
        rejectionAlreadyCheckedInPriorProofs: false,
        hasDurableStartedObservation: false,
        openResolution: {
          cause: "dispatch-conflict",
          isOpen: true,
          conflictReceivedRecordSeq: 2,
        },
      }),
    ).toEqual({
      kind: "accepted-not-started",
      settlementRecord: "assignment-superseded",
      closesOpenResolution: true,
      closesDispatchConflict: true,
    });
    expect(
      classifyNotStartedTermination({
        domain: "job",
        entrypoint: "cancel-proof",
        proof: cancelNotStartedProof,
        proofKind: "cancel-owner-fence",
        currentRunState: "uncertain",
        rejectionAlreadyCheckedInPriorProofs: false,
        hasDurableStartedObservation: false,
        openResolution: {
          cause: "job-cancel-unknown",
          isOpen: true,
        },
      }),
    ).toEqual({
      kind: "accepted-not-started",
      settlementRecord: "assignment-superseded",
      closesOpenResolution: true,
      closesDispatchConflict: false,
    });

    // 2. Shared data-plane ticket authority across conversation & job
    expect(() =>
      validateDataPlaneTicketIssueRequest({
        ticketId: "tok-renew-same",
        assignmentId: "assign-1",
        surfacePrincipal: "user:local",
        kind: "run-observe",
        ttlMs: 30_000,
        replacesTicketId: "tok-renew-same",
      }),
    ).toThrow(/requires a new ticket id/);

    const baseTicket = {
      $schema: "zhixing.DataPlaneTicket",
      v: 1 as const,
      ticketId: "tok-shared-1",
      ref: {
        execution: "job" as const,
        jobRunId: "jr-1",
        taskId: "task-1",
        anchorEpoch: 1,
      },
      assignmentId: "assign-1",
      surfacePrincipal: "user:local",
      executorId: "exec-1",
      issuedAt: "2026-11-16T00:00:00.000Z",
      expiry: "2026-11-16T00:00:30.000Z",
      kind: "run-interact" as const,
      renewable: true as const,
      signature: {
        alg: "test-sha256",
        keyId: "owner-1",
        sig: `sha256:${"f".repeat(64)}`,
      },
    } as unknown as DataPlaneTicket;

    expect(
      decideDataPlaneTicketReplayOrConflict({
        existing: Object.freeze({ ...baseTicket }),
        existingReplacementId: undefined,
        request: {
          ticketId: "tok-shared-1",
          assignmentId: "assign-1",
          surfacePrincipal: "user:local",
          kind: "run-interact",
          ttlMs: 30_000,
        },
      })?.ticketId,
    ).toBe("tok-shared-1");

    expect(() =>
      decideDataPlaneTicketReplayOrConflict({
        existing: baseTicket,
        existingReplacementId: undefined,
        request: {
          ticketId: "tok-shared-1",
          assignmentId: "assign-1",
          surfacePrincipal: "user:other",
          kind: "run-interact",
          ttlMs: 30_000,
        },
      }),
    ).toThrow(/Ticket id already belongs to a different grant/);

    expect(() =>
      validateDataPlaneTicketSurfaceAndRenewal({
        request: {
          ticketId: "tok-shared-2",
          assignmentId: "assign-1",
          surfacePrincipal: "user:intruder",
          kind: "run-interact",
          ttlMs: 30_000,
        },
        expectedSurfacePrincipal: "user:local",
        replacedTicket: undefined,
        isReplacedTicketRevoked: false,
      }),
    ).toThrow(/Interactive tickets are restricted to the original surface/);

    // Cancelled assignment ticket rejection in conversation vs job
    const convCancelled = emptyConversationRunProjection("conv-ticket-cancel");
    convCancelled.admittedByRun.set("run-1", {
      record: {
        ingressKey: "ing-1",
        runId: "run-1",
        ingress: {
          surfacePrincipal: "user:local",
          surfaceKind: "cli",
          receivedAt: "2026-11-16T00:00:00.000Z",
        },
        invocation: { kind: "user-turn" },
        queuedPosition: 1,
      } as unknown as import("../conversation-journal/contracts.js").AdmittedProjection["record"],
      lsn: 1,
    });
    convCancelled.assignedById.set("assign-1", {
      record: {
        t: "assigned",
        runId: "run-1",
        assignmentId: "assign-1",
        executorId: "exec-1",
        ownerEpoch: 1,
        baseRevision: 0,
        dispatchDigest: "d1",
        manifestDigest: "m1",
        dispatchRef: { digest: "r1", bytes: 10 },
        permissionLeaseDigest: "p1",
        capIds: ["cap-1"],
        reservation: { reservationId: "res-1", attempt: 1 },
      } as unknown as import("../conversation-journal/contracts.js").AssignedProjection["record"],
      acked: true,
      lsn: 2,
    });
    convCancelled.assignmentByRun.set("run-1", "assign-1");
    convCancelled.stateByRun.set("run-1", {
      state: "cancel-requested",
      statusRevision: 3,
    });
    convCancelled.cancelFences.set("assign-1", {
      t: "cancel-fence",
      assignmentId: "assign-1",
    } as unknown as Extract<import("../conversation-run-contracts.js").ConversationRunJournalRecord, { t: "cancel-fence" }>);

    expect(() =>
      decideConversationIssueDataPlaneTicket({
        conversationId: "conv-ticket-cancel",
        request: {
          ticketId: "tok-cancel-1",
          assignmentId: "assign-1",
          surfacePrincipal: "user:local",
          kind: "run-observe",
          ttlMs: 30_000,
        },
        issuedAt: "2026-11-16T00:01:00.000Z",
        signer: testSigner,
        facts: readConversationDecisionFacts(convCancelled),
      }),
    ).toThrow(/cancelled/i);

    const jobMainFull = (await import("../job-journal/contracts.js")).createJobMainState(
      "task-cancel",
      true,
    );
    const jobMainView = (await import("../job-journal/contracts.js")).jobProjectionView(
      new JobStateBinding(jobMainFull),
    );
    jobMainView.assignedById.set("assign-1", {
      record: {
        t: "assigned",
        taskId: "task-cancel",
        jobRunId: "jr-1",
        assignmentId: "assign-1",
        executorId: "exec-1",
        anchorEpoch: 1,
        taskRevision: 1,
        dispatchDigest: "d1",
        manifestDigest: "m1",
        dispatchRef: { digest: "r1", bytes: 10 },
        permissionLeaseDigest: "p1",
        capIds: ["cap-1"],
        reservation: { reservationId: "res-1", attempt: 1 },
      },
      envelope: {} as unknown as import("../job-journal/contracts.js").JobEnvelope,
      commit: { lsn: 2, envelopeDigest: "e1", at: "2026-11-16T00:00:00.000Z" },
      acked: true,
    });
    jobMainView.assignmentByJob.set("jr-1", "assign-1");
    jobMainView.states.set("jr-1", { state: "cancel-requested", statusRevision: 3 });
    jobMainView.cancelFences.set("assign-1", {
      t: "cancel-fence",
      assignmentId: "assign-1",
      fence: {} as never,
    });
    expect(() =>
      decideJobIssueDataPlaneTicket({
        taskId: "task-cancel",
        request: {
          ticketId: "tok-cancel-job-1",
          assignmentId: "assign-1",
          surfacePrincipal: "user:local",
          kind: "run-observe",
          ttlMs: 30_000,
        },
        issuedAt: "2026-11-16T00:01:00.000Z",
        signer: testSigner,
        facts: readJobDecisionFacts(jobMainView),
      }),
    ).toThrow(/Ticket requires a current acknowledged assignment/);

    // 3. Job interactionSettlementFences window keeps mirror open until completedInteractionSettlements
    const settlementFences = new Map<string, unknown>([["assign-1", {}]]);
    const completedSettlements = new Map<string, unknown>();
    const mirrorSlice = {
      assignedById: new Map([["assign-1", { record: { jobRunId: "jr-1" } }]]),
      states: new Map([["jr-1", { state: "cancelled" }]]),
      assignmentByJob: new Map<string, string>(),
      cancelFences: new Map<string, unknown>(),
      interactionSettlementFences: settlementFences,
      completedInteractionSettlements: completedSettlements,
    };
    expect(jobMirrorClosed(mirrorSlice, "assign-1", true)).toBe(false);
    completedSettlements.set("assign-1", {});
    expect(jobMirrorClosed(mirrorSlice, "assign-1", true)).toBe(true);

    // 4. JobReduction.reduceSubmissionGuard never touches main-only fields
    const guardSet = createJobGuardState("task-guard-1", true);
    const guardView = jobSubmissionGuardView(new JobStateBinding(guardSet));
    const reduction = new JobReduction({
      taskId: "task-guard-1",
      anchorEpoch: 1,
      artifacts: {
        get: async () => new Uint8Array(),
        has: async () => false,
        put: async () => ({ digest: `sha256:${"0".repeat(64)}`, bytes: 0 }),
      } as unknown as import("@zhixing-ai/core/authority").ArtifactStore,
      verifier: { verify: () => undefined },
      delivery: {} as never,
    });
    const startedEnvelope = {
      lsn: 10,
      envelopeDigest: `sha256:${"e".repeat(64)}`,
      at: "2026-11-16T00:02:00.000Z",
      entries: [
        {
          stream: "job:task-guard-1",
          body: {
            t: "dispatch-acked" as const,
            assignmentId: "assign-guard-1",
          },
        },
        {
          stream: "job:task-guard-1",
          body: {
            t: "state" as const,
            jobRunId: "jr-guard-1",
            assignmentId: "assign-guard-1",
            state: "running" as const,
            statusRevision: 2,
          },
        },
      ],
    };
    guardView.latestDefinitionRevision = 1;
    guardView.latestDefinitionState = "enabled";
    guardView.definitionKinds.set(1, "user");
    guardView.occurrences.set("jr-guard-1", {
      scheduledFor: "2026-11-16T00:00:00.000Z",
      taskRevision: 1,
      deliveryPlanDigest: `sha256:${"1".repeat(64)}`,
      deliveryRequired: false,
    });
    guardView.admittedJobs.add("jr-guard-1");
    guardView.states.set("jr-guard-1", { state: "dispatched", statusRevision: 1 });
    guardView.activeJobRunId = "jr-guard-1";
    guardView.assignmentByJob.set("jr-guard-1", "assign-guard-1");
    guardView.assignedById.set("assign-guard-1", {
      record: {
        t: "assigned",
        taskId: "task-guard-1",
        jobRunId: "jr-guard-1",
        assignmentId: "assign-guard-1",
        executorId: "exec-1",
        anchorEpoch: 1,
        taskRevision: 1,
        deliveryPlanDigest: `sha256:${"1".repeat(64)}`,
        dispatchDigest: `sha256:${"2".repeat(64)}`,
        manifestDigest: `sha256:${"3".repeat(64)}`,
        dispatchRef: { digest: `sha256:${"4".repeat(64)}`, bytes: 16 },
        permissionLeaseDigest: `sha256:${"5".repeat(64)}`,
        capIds: ["cap-1"],
        reservation: { reservationId: "res-1", attempt: 1 },
      },
      commit: {
        lsn: 9,
        envelopeDigest: `sha256:${"6".repeat(64)}`,
        at: "2026-11-16T00:01:00.000Z",
      },
      capIds: new Set(["cap-1"]),
      acked: false,
    });
    await reduction.reduceSubmissionGuard(
      guardView,
      startedEnvelope.entries[0]!,
      startedEnvelope,
    );
    await reduction.reduceSubmissionGuard(
      guardView,
      startedEnvelope.entries[1]!,
      startedEnvelope,
    );
    expect(guardView.durableStarted.has("assign-guard-1")).toBe(true);
    expect(guardView.states.get("jr-guard-1")?.state).toBe("running");
  });

  it("preserves exact baseline public export surface on assignment-ledger.ts (7 values, 27 types)", () => {
    const facadePath = path.join(
      REPO_ROOT,
      "packages/executor/src/assignment-ledger.ts",
    );
    const exported = extractExplicitExportsViaAst(facadePath);
    expect(exported.values).toEqual([
      "AssignmentExecutionResourceRetiredError",
      "AssignmentLedger",
      "AssignmentStartCancelledError",
      "ConversationAssignmentLedger",
      "DATA_PLANE_BINDING_BATCH_LIMIT",
      "InProcessAssignmentSubmission",
      "registerExecutorJobRecoveryProjection",
    ]);
    expect(exported.types).toEqual([
      "AssignmentLedgerOptions",
      "AssignmentSubmissionPort",
      "ChannelInteractionAnswerPreparation",
      "ConversationDispatchPort",
      "ConversationSealInput",
      "ConversationSubmissionPort",
      "DurableInteractionStreamEvent",
      "InProcessAssignmentSubmissionOptions",
      "InteractionMirrorReceipt",
      "InteractionOutcome",
      "InteractionRecoveryResult",
      "InteractionRequestDisposition",
      "InteractionRequestInput",
      "InteractionStreamProjectionReceipt",
      "JobRecoveryObligation",
      "JobRecoveryObligationPage",
      "JobSealInput",
      "OwnerControlAuthorizer",
      "OwnerControlPreflightPort",
      "OwnerControlRequest",
      "PendingAssignmentInteraction",
      "SideEffectInput",
      "StagedConversationMutationInput",
      "StagedJobMutationInput",
      "SurfaceAbortDisposition",
      "SurfaceAbortInput",
      "SurfaceInteractionAnswerPreparation",
    ]);
  });

  it("enforces Slice D narrow readonly fact encapsulation (zero LedgerProjection in 4 operation units) and single protocol phase source in state-replay.ts", () => {
    const countIdentifier = (fileName: string, sourceText: string, ident: string): number => {
      const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
      let hits = 0;
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && node.text === ident) hits++;
        ts.forEachChild(node, visit);
      };
      visit(sf);
      return hits;
    };

    const unitFiles = [
      "packages/executor/src/ledger/execution-control.ts",
      "packages/executor/src/ledger/interaction-effect.ts",
      "packages/executor/src/ledger/sealing-evidence.ts",
      "packages/executor/src/ledger/receipt-recovery.ts",
    ];
    for (const rel of unitFiles) {
      const fullPath = path.join(REPO_ROOT, rel);
      const src = fs.readFileSync(fullPath, "utf8");
      expect(countIdentifier(fullPath, src, "LedgerProjection"), rel).toBe(0);
    }

    // Negative proof: an accidental LedgerProjection reference is caught by AST identifier scan
    expect(
      countIdentifier(
        "synthetic-unit.ts",
        'import type { LedgerProjection } from "./contracts.js";\nexport type Bad = LedgerProjection;\n',
        "LedgerProjection",
      ),
    ).toBe(2);

    // Single protocol stage source: state-replay.ts derives state.phase from state.validation.phase (zero string-literal assignments to state.phase)
    const stateReplayPath = path.join(
      REPO_ROOT,
      "packages/executor/src/ledger/state-replay.ts",
    );
    const stateReplaySrc = fs.readFileSync(stateReplayPath, "utf8");
    const stateReplaySf = ts.createSourceFile(
      stateReplayPath,
      stateReplaySrc,
      ts.ScriptTarget.Latest,
      true,
    );
    let validationPhaseAssignments = 0;
    const literalStatePhaseAssignments: string[] = [];
    const visitReplay = (node: ts.Node): void => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) &&
        ts.isIdentifier(node.left.expression) &&
        node.left.expression.text === "state" &&
        node.left.name.text === "phase"
      ) {
        if (ts.isStringLiteral(node.right)) {
          literalStatePhaseAssignments.push(node.right.text);
        } else if (
          ts.isPropertyAccessExpression(node.right) &&
          ts.isPropertyAccessExpression(node.right.expression) &&
          ts.isIdentifier(node.right.expression.expression) &&
          node.right.expression.expression.text === "state" &&
          node.right.expression.name.text === "validation" &&
          node.right.name.text === "phase"
        ) {
          validationPhaseAssignments++;
        }
      }
      ts.forEachChild(node, visitReplay);
    };
    visitReplay(stateReplaySf);
    expect(literalStatePhaseAssignments).toEqual([]);
    expect(validationPhaseAssignments).toBeGreaterThanOrEqual(1);
  });

  it("binds Slice D ledger decision & binding checkpoint prefixes to real leaf reducer functions (sensitive to leaf body edits)", () => {
    expect(LEDGER_DECISION_FINGERPRINT_FNS.length).toBeGreaterThanOrEqual(5);
    expect(LEDGER_BINDING_FINGERPRINT_FNS.length).toBeGreaterThanOrEqual(4);

    const decisionPrefixA = buildLedgerProjectionCheckpointPrefix(
      "executor-assignment-ledger-decision",
      2,
      LEDGER_DECISION_FINGERPRINT_FNS,
    );
    const mutatedDecisionLeaf = [
      ...LEDGER_DECISION_FINGERPRINT_FNS.slice(0, -1),
      function restoreDecisionStateMutated() {
        return "mutated-decision-leaf";
      },
    ];
    const decisionPrefixB = buildLedgerProjectionCheckpointPrefix(
      "executor-assignment-ledger-decision",
      2,
      mutatedDecisionLeaf,
    );
    expect(decisionPrefixB).not.toBe(decisionPrefixA);

    const bindingPrefixA = buildLedgerProjectionCheckpointPrefix(
      "executor-assignment-ledger-binding",
      1,
      LEDGER_BINDING_FINGERPRINT_FNS,
    );
    const mutatedBindingLeaf = [
      ...LEDGER_BINDING_FINGERPRINT_FNS.slice(0, -1),
      function emptyProjectionMutated() {
        return "mutated-binding-leaf";
      },
    ];
    const bindingPrefixB = buildLedgerProjectionCheckpointPrefix(
      "executor-assignment-ledger-binding",
      1,
      mutatedBindingLeaf,
    );
    expect(bindingPrefixB).not.toBe(bindingPrefixA);
  });

  it("seals Slice D fact views against live collection exposure and uncast state mutation", () => {
    const contractsPath = path.join(
      REPO_ROOT,
      "packages/executor/src/ledger/contracts.ts",
    );
    const contractsSrc = fs.readFileSync(contractsPath, "utf8");
    const contractsSf = ts.createSourceFile(
      contractsPath,
      contractsSrc,
      ts.ScriptTarget.Latest,
      true,
    );
    const factInterfaceNames = new Set([
      "ExecutionControlFacts",
      "InteractionEffectFacts",
      "SealingEvidenceFacts",
      "ReceiptRecoveryFacts",
    ]);
    const forbiddenTypeRefs = new Set(["Map", "ReadonlyMap", "Set", "ReadonlySet"]);
    const exposedCollections: string[] = [];
    for (const stmt of contractsSf.statements) {
      if (ts.isInterfaceDeclaration(stmt) && factInterfaceNames.has(stmt.name.text)) {
        const ifaceName = stmt.name.text;
        const walk = (node: ts.Node): void => {
          if (
            ts.isTypeReferenceNode(node) &&
            ts.isIdentifier(node.typeName) &&
            forbiddenTypeRefs.has(node.typeName.text)
          ) {
            exposedCollections.push(`${ifaceName}:${node.typeName.text}`);
          }
          if (
            ts.isIndexedAccessTypeNode(node) &&
            node.getText(contractsSf).includes('["aborts"]')
          ) {
            exposedCollections.push(`${ifaceName}:${node.getText(contractsSf)}`);
          }
          ts.forEachChild(node, walk);
        };
        walk(stmt);
      }
    }
    expect(exposedCollections).toEqual([]);

    const state = emptyProjection("assign-facts-probe");
    const ticketDigest = `sha256:${"7".repeat(64)}`;
    state.validation.aborts.set(`abort-ticket:${ticketDigest}`, {
      via: "abort-ticket",
      refId: ticketDigest,
      surfacePrincipal: "surface:user-1",
      recordSeq: 4,
      ledgerDigest: `sha256:${"8".repeat(64)}`,
    });
    state.aborts.push({
      v: 1,
      t: "abort-requested",
      via: "abort-ticket",
      refId: ticketDigest,
      surfacePrincipal: "surface:user-1",
    });
    state.received = {
      body: {
        v: 1,
        t: "received",
        envelope: { ref: { digest: `sha256:${"1".repeat(64)}`, byteLength: 64 } },
        activation: {
          v: 1,
          ref: {
            execution: "conversation",
            runId: "run-1",
            conversationId: "conv-1",
            ownerEpoch: 1,
          },
          dispatchDigest: `sha256:${"2".repeat(64)}`,
          manifestDigest: `sha256:${"3".repeat(64)}`,
          permissionLeaseDigest: `sha256:${"4".repeat(64)}`,
          commit: { lsn: 1, envelopeDigest: `sha256:${"5".repeat(64)}` },
          issuedAt: "2026-11-16T00:00:00.000Z",
          signature: { alg: "test", keyId: "owner-1", sig: "sig" },
        },
      },
      recordSeq: 1,
      ledgerDigest: `sha256:${"6".repeat(64)}`,
      permission: {
        controlLeaseId: "ctl-1",
        validForMs: 60_000,
        acceptedAt: "2026-11-16T00:00:00.000Z",
      },
    };
    const reqRecord: Extract<AssignmentRecord, { t: "interaction-requested" }> = {
      v: 1,
      t: "interaction-requested",
      requestId: "req-1",
      kind: "allow-once",
      toolName: "bash",
      display: { title: "Allow?", lines: ["ls"] },
      issuedAt: "2026-11-16T00:00:00.000Z",
      ttlMs: 30_000,
      expiresAt: "2026-11-16T00:00:30.000Z",
    };
    state.requested.set("req-1", { body: reqRecord, recordSeq: 2 });
    state.pendingRequests.set("req-1", { body: reqRecord, recordSeq: 2 });
    state.sideEffects.set(1, {
      started: {
        v: 1,
        t: "side-effect-started",
        effectSeq: 1,
        kind: "tool-mutation",
        toolName: "write_file",
        summary: "write",
        target: "workspace-file",
      },
    });
    const stagedRecord: Extract<AssignmentRecord, { t: "staged-mutation" }> = {
      v: 1,
      t: "staged-mutation",
      seq: 1,
      domain: "session",
      requestId: "mut-1",
      mutation: { kind: "session-title", title: "Title" } as unknown as Extract<
        AssignmentRecord,
        { t: "staged-mutation" }
      >["mutation"],
    };
    state.stagedMutations.push(stagedRecord);
    state.mutationRequestIds.add("mut-1");
    state.stagedMutationByRequestId.set("mut-1", stagedRecord);

    const execFacts = toExecutionControlFacts(state);
    const intFacts = toInteractionEffectFacts(state);
    const sealFacts = toSealingEvidenceFacts(state);
    const recFacts = toReceiptRecoveryFacts(state);

    if (false) {
      // @ts-expect-error ReadonlyLedgerReceivedState forbids mutating permission
      execFacts.received!.permission = undefined;
      // @ts-expect-error nested permission is readonly
      execFacts.received!.permission!.validForMs = 0;
      // @ts-expect-error snapshot array is readonly
      intFacts.pendingRequestsSnapshot().push({ body: reqRecord, recordSeq: 9 });
      // @ts-expect-error snapshot array is readonly
      sealFacts.stagedMutationsSnapshot().push(stagedRecord);
    }

    expect(Object.isFrozen(execFacts)).toBe(true);
    expect(Object.isFrozen(intFacts)).toBe(true);
    expect(Object.isFrozen(sealFacts)).toBe(true);
    expect(Object.isFrozen(recFacts)).toBe(true);
    expect(Object.isFrozen(intFacts.received)).toBe(true);
    expect(Object.isFrozen(intFacts.received?.permission)).toBe(true);
    expect("validationAborts" in (intFacts as Record<string, unknown>)).toBe(false);
    expect("validationAborts" in (recFacts as Record<string, unknown>)).toBe(false);

    const ticketAbort = intFacts.firstValidationTicketAbort();
    expect(ticketAbort).toEqual({
      refId: ticketDigest,
      recordSeq: 4,
      ledgerDigest: `sha256:${"8".repeat(64)}`,
    });
    expect(Object.isFrozen(ticketAbort)).toBe(true);
    expect(() => {
      (ticketAbort as { refId: string }).refId = "tampered";
    }).toThrow(TypeError);
    expect(() => {
      (intFacts.sideEffectBySeq(1) as { completed?: unknown }).completed = {};
    }).toThrow(TypeError);
    expect(() => {
      (intFacts.pendingRequestsSnapshot() as unknown[]).pop();
    }).toThrow(TypeError);
    expect(() => {
      (sealFacts.stagedMutationsSnapshot() as unknown[]).pop();
    }).toThrow(TypeError);

    expect(state.validation.aborts.size).toBe(1);
    expect(state.pendingRequests.size).toBe(1);
    expect(state.stagedMutations.length).toBe(1);
  });

  it(
    "enforces Slice D DeepReadonly compile-time TS2540 diagnostics via ts.createProgram and runtime O(1) non-aliasing detach",
    { timeout: 30_000 },
    () => {
      const executorTsconfigPath = path.join(REPO_ROOT, "packages/executor/tsconfig.json");
      const readResult = ts.readConfigFile(executorTsconfigPath, ts.sys.readFile);
      expect(readResult.error).toBeUndefined();
      const parsedConfig = ts.parseJsonConfigFileContent(
        readResult.config,
        ts.sys,
        path.dirname(executorTsconfigPath),
      );
      const probeFilePath = path
        .join(REPO_ROOT, "packages/executor/src/ledger/__deep_readonly_probe__.ts")
        .replaceAll("\\", "/");

      const probeBody = `import type {
  ExecutionControlFacts,
  InteractionEffectFacts,
  ReceiptRecoveryFacts,
  SealingEvidenceFacts,
} from "./contracts.js";

export function validReads(
  exec: ExecutionControlFacts,
  int: InteractionEffectFacts,
  seal: SealingEvidenceFacts,
  rec: ReceiptRecoveryFacts,
): unknown[] {
  const display = int.requestedById("r1")?.body.display;
  const firstLine = display && "lines" in display ? display.lines[0] : undefined;
  return [
    int.latestAbort()?.refId,
    exec.hasAbortMatching((r) => r.via === "abort-ticket"),
    int.requestedById("r1")?.body.requestId,
    firstLine,
    exec.received?.body.envelope.ref.digest,
    seal.stagedMutationForRequestId("m1")?.requestId,
    seal.sealed?.t,
    rec.firstValidationTicketAbort()?.refId,
    rec.finishedAt(0)?.recordSeq,
  ];
}

export function mutableControl(plain: { latestAbort(): { refId: string } | undefined }): void {
  plain.latestAbort()!.refId = "mutated";
}

export function illegalMutations(
  exec: ExecutionControlFacts,
  int: InteractionEffectFacts,
  seal: SealingEvidenceFacts,
  rec: ReceiptRecoveryFacts,
): void {
  int.latestAbort()!.refId = "x"; // MUT_1
  exec.hasAbortMatching((r) => { r.refId = "x"; return false; }); // MUT_2
  int.requestedById("r1")!.body.requestId = "x"; // MUT_3
  exec.received!.body.envelope.ref.digest = "x"; // MUT_4
  seal.stagedMutationForRequestId("m1")!.requestId = "x"; // MUT_5
  rec.firstValidationTicketAbort()!.refId = "x"; // MUT_6
  rec.finishedAt(0)!.recordSeq = 99; // MUT_7
}
`;

      const baseHost = ts.createCompilerHost(parsedConfig.options, true);
      const sourceFile = ts.createSourceFile(
        probeFilePath,
        probeBody,
        parsedConfig.options.target ?? ts.ScriptTarget.ES2022,
        true,
      );
      const customHost: ts.CompilerHost = {
        ...baseHost,
        fileExists: (fileName) =>
          fileName.replaceAll("\\", "/") === probeFilePath || baseHost.fileExists(fileName),
        readFile: (fileName) =>
          fileName.replaceAll("\\", "/") === probeFilePath
            ? probeBody
            : baseHost.readFile(fileName),
        getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
          fileName.replaceAll("\\", "/") === probeFilePath
            ? sourceFile
            : baseHost.getSourceFile(
                fileName,
                languageVersion,
                onError,
                shouldCreateNewSourceFile,
              ),
      };
      const program = ts.createProgram(
        [...parsedConfig.fileNames, probeFilePath],
        { ...parsedConfig.options, noEmit: true },
        customHost,
      );
      const diagnostics = [
        ...program.getSyntacticDiagnostics(sourceFile),
        ...program.getSemanticDiagnostics(sourceFile),
      ];
      const probeLines = probeBody.split("\n");
      const diagSummary = diagnostics.map((d) => ({
        code: d.code,
        line:
          d.start !== undefined
            ? sourceFile.getLineAndCharacterOfPosition(d.start).line + 1
            : -1,
      }));

      // Valid reads and mutable control lines must produce 0 diagnostics
      const mutStartLine = probeLines.findIndex((l) => l.includes("function illegalMutations")) + 1;
      expect(diagSummary.filter((d) => d.line < mutStartLine)).toEqual([]);

      // Every single MUT_1..MUT_7 line must produce TS2540 (read-only property)
      for (const marker of ["MUT_1", "MUT_2", "MUT_3", "MUT_4", "MUT_5", "MUT_6", "MUT_7"]) {
        const expectedLine = probeLines.findIndex((l) => l.includes(marker)) + 1;
        expect(expectedLine, marker).toBeGreaterThan(0);
        expect(
          diagSummary.some((d) => d.line === expectedLine && d.code === 2540),
          `${marker} at line ${expectedLine} -> ${JSON.stringify(diagSummary)}`,
        ).toBe(true);
      }

      // 4. Runtime deep freeze detach + non-freezing of underlying LedgerProjection + O(1) Map lookup
      const state = emptyProjection("assign-o1-probe");
      state.aborts.push({
        v: 1,
        t: "abort-requested",
        via: "abort-ticket",
        refId: "ref-orig",
        surfacePrincipal: "surface:1",
      });
      state.received = {
        body: {
          v: 1,
          t: "received",
          envelope: { ref: { digest: `sha256:${"a".repeat(64)}`, byteLength: 64 } },
          activation: {
            v: 1,
            ref: {
              execution: "conversation",
              runId: "run-1",
              conversationId: "conv-1",
              ownerEpoch: 1,
            },
            dispatchDigest: `sha256:${"b".repeat(64)}`,
            manifestDigest: `sha256:${"c".repeat(64)}`,
            permissionLeaseDigest: `sha256:${"d".repeat(64)}`,
            commit: { lsn: 1, envelopeDigest: `sha256:${"e".repeat(64)}` },
            issuedAt: "2026-11-16T00:00:00.000Z",
            signature: { alg: "test", keyId: "owner-1", sig: "sig" },
          },
        },
        recordSeq: 1,
        ledgerDigest: `sha256:${"f".repeat(64)}`,
      };
      for (let i = 0; i < 1_000; i++) {
        const reqId = `req-${i}`;
        const reqBody: Extract<AssignmentRecord, { t: "interaction-requested" }> = {
          v: 1,
          t: "interaction-requested",
          requestId: reqId,
          kind: "allow-once",
          toolName: "bash",
          display: { title: `Allow ${i}`, lines: [`cmd-${i}`] },
          issuedAt: "2026-11-16T00:00:00.000Z",
          ttlMs: 30_000,
          expiresAt: "2026-11-16T00:00:30.000Z",
        };
        state.requested.set(reqId, { body: reqBody, recordSeq: i + 2 });
        state.sideEffects.set(i + 1, {
          started: {
            v: 1,
            t: "side-effect-started",
            effectSeq: i + 1,
            kind: "tool-mutation",
            toolName: "write_file",
            summary: `write-${i}`,
            target: "workspace-file",
          },
        });
        const mutRecord: Extract<AssignmentRecord, { t: "staged-mutation" }> = {
          v: 1,
          t: "staged-mutation",
          seq: i + 1,
          domain: "session",
          requestId: `mut-${i}`,
          mutation: { kind: "session-title", title: `Title-${i}` } as unknown as Extract<
            AssignmentRecord,
            { t: "staged-mutation" }
          >["mutation"],
        };
        state.stagedMutationByRequestId.set(`mut-${i}`, mutRecord);
      }

      const execFacts = toExecutionControlFacts(state);
      const intFacts = toInteractionEffectFacts(state);
      const sealFacts = toSealingEvidenceFacts(state);

      let requestedGets = 0;
      const origRequestedGet = state.requested.get.bind(state.requested);
      state.requested.get = ((key: string) => {
        requestedGets += 1;
        return origRequestedGet(key);
      }) as typeof state.requested.get;

      let sideEffectGets = 0;
      const origSideEffectGet = state.sideEffects.get.bind(state.sideEffects);
      state.sideEffects.get = ((key: number) => {
        sideEffectGets += 1;
        return origSideEffectGet(key);
      }) as typeof state.sideEffects.get;

      let stagedMutationGets = 0;
      const origStagedGet = state.stagedMutationByRequestId.get.bind(
        state.stagedMutationByRequestId,
      );
      state.stagedMutationByRequestId.get = ((key: string) => {
        stagedMutationGets += 1;
        return origStagedGet(key);
      }) as typeof state.stagedMutationByRequestId.get;

      const req500 = intFacts.requestedById("req-500");
      const se500 = intFacts.sideEffectBySeq(500);
      const mut500 = sealFacts.stagedMutationForRequestId("mut-500");
      expect(requestedGets).toBe(1);
      expect(sideEffectGets).toBe(1);
      expect(stagedMutationGets).toBe(1);

      expect(() => {
        (intFacts.latestAbort() as { refId: string }).refId = "tampered";
      }).toThrow(TypeError);
      expect(() => {
        execFacts.hasAbortMatching((r) => {
          (r as { refId: string }).refId = "tampered";
          return false;
        });
      }).toThrow(TypeError);
      expect(() => {
        (req500 as { body: { requestId: string } }).body.requestId = "tampered";
      }).toThrow(TypeError);
      expect(() => {
        (req500 as { body: { display: { lines: string[] } } }).body.display.lines.push("x");
      }).toThrow(TypeError);
      expect(() => {
        (se500 as { started: { summary: string } }).started.summary = "tampered";
      }).toThrow(TypeError);
      expect(() => {
        (execFacts.received as { body: { envelope: { ref: { digest: string } } } }).body
          .envelope.ref.digest = "tampered";
      }).toThrow(TypeError);
      expect(() => {
        (mut500 as { requestId: string }).requestId = "tampered";
      }).toThrow(TypeError);

      // Underlying LedgerProjection records remain mutable for state-replay / append
      expect(Object.isFrozen(state.aborts[0])).toBe(false);
      expect(Object.isFrozen(state.received.body.envelope.ref)).toBe(false);
      expect(Object.isFrozen(origRequestedGet("req-500")!.body)).toBe(false);
      expect(state.aborts[0]!.refId).toBe("ref-orig");
    },
  );

  it(
    "enforces Slice E thin facade parity, 8-obligation owner table, and Gate 5 multi-lifetime isolation invariants",
    { timeout: 30_000 },
    async () => {
      const cliFacadePath = path.join(
        REPO_ROOT,
        "packages/cli/src/serve/conversation-protocol-runtime.ts",
      );
      const cliFacadeSrc = fs.readFileSync(cliFacadePath, "utf8");
      expect(cliFacadeSrc.trim().split("\n").length).toBeLessThanOrEqual(30);
      const cliExported = extractExplicitExportsViaAst(cliFacadePath);
      expect(cliExported.values).toEqual([
        "ConversationProtocolRuntime",
        "DurableConversationInteractionObserver",
        "createConversationAuxiliaryRecoveryAssemblyHandle",
        "createConversationCommittedTurnListenerAssemblyHandle",
        "createConversationManagerAssemblyHandle",
      ]);
      expect(cliExported.types).toEqual([
        "CommittedConversationTransferPort",
        "ConversationAdvancementExecutionPort",
        "ConversationLosslessDataPlanePort",
        "ConversationLosslessDataPlaneTopology",
        "ConversationProtocolRuntimeOptions",
      ]);

      expect(Object.keys(CONVERSATION_PROTOCOL_OBLIGATION_OWNERS).sort()).toEqual([
        "activeRunClaimRegistry",
        "authorityScopeGeneration",
        "deferFirstSendRecovery",
        "executorPlanAndForegroundLease",
        "firstTouchAdoptionInstall",
        "monotonicRecoveryMarkSeq",
        "preparedAdmissionMap",
        "settledRouteRevisions",
      ]);
      for (const ownerUnit of Object.values(CONVERSATION_PROTOCOL_OBLIGATION_OWNERS)) {
        expect(
          fs.existsSync(
            path.join(
              REPO_ROOT,
              "packages/cli/src/serve/conversation-protocol",
              `${ownerUnit}.ts`,
            ),
          ),
          ownerUnit,
        ).toBe(true);
      }

    const removedArtifacts: string[] = [];
    const releasedInteractions: string[] = [];
    const artifactAuthority = {
      install() {},
      remove(id: string) {
        removedArtifacts.push(id);
      },
    } as never;
    const interactions = {
      releaseAssignment(id: string) {
        releasedInteractions.push(id);
      },
    } as never;

    const scope = new RuntimeObligationScope();
    const initialScope = scope.current;
    expect(initialScope.scope.scopeId).toBe(1);

    // 1. releaseConversationCache drops ONLY journals & sessionIdentities for target conversation, never incrementing scopeId
    initialScope.journals.set("conv-1", {} as never);
    initialScope.journals.set("conv-2", {} as never);
    initialScope.sessionIdentities.set("conv-1", Promise.resolve());
    const token1 = Symbol("run-1");
    initialScope.scheduledRuns.set("run-1", token1);
    const seqBeforeRelease = scope.markRecoveryInScope(initialScope, "conv-1");
    scope.releaseConversationCache("conv-1");
    expect(scope.current).toBe(initialScope);
    expect(scope.current.scope.scopeId).toBe(1);
    expect(initialScope.journals.has("conv-1")).toBe(false);
    expect(initialScope.sessionIdentities.has("conv-1")).toBe(false);
    expect(initialScope.journals.has("conv-2")).toBe(true);
    expect(initialScope.scheduledRuns.get("run-1")).toBe(token1);
    expect(initialScope.recoveryConversations.get("conv-1")).toBe(seqBeforeRelease);

    // 2. stopRecoveryLoop clears firstSendWindows without replacing AuthorityScope or incrementing scopeId
    initialScope.firstSendWindows.set("conv-1", {
      runId: "run-1",
      claimToken: token1,
      deferred: false,
    });
    const settlement = new TerminalSettlement({
      authority: {} as never,
      scope,
      access: {
        createDefaultDispatchContexts: () => ({}),
        journal: () => ({ assignmentsAwaitingRecovery: async () => [] }),
      } as never,
      admission: {} as never,
      host: { scheduleResolvedRetry: async () => {} },
      requiredManager: () => ({}) as never,
      clock: () => "2026-11-16T00:00:00.000Z",
      executorDispatch: {} as never,
      assignmentArtifactAuthority: artifactAuthority,
      interactions,
      observeFailure: () => {},
    });
    const recovery = new RecoveryScheduler({
      authority: {} as never,
      scope,
      access: { createDefaultDispatchContexts: () => ({}) } as never,
      admission: {} as never,
      settlement,
      host: {
        recover: async () => 0,
        publishPendingFinals: async () => 0,
        listSessions: async () => [],
        isWorksceneContinuationCurrent: async () => false,
        run: (async function* () {
          return {} as never;
        }) as never,
        installCommittedConversationTransfer: async () => {},
      },
      requiredManager: () => ({}) as never,
      executorDispatch: {} as never,
      assignmentArtifactAuthority: artifactAuthority,
      interactions,
      losslessDataPlane: { kind: "absent", reason: "executor-only" },
      recoverAuxiliary: async () => {},
      observeFailure: () => {},
    });
    await recovery.stopRecoveryLoop();
    expect(initialScope.firstSendWindows.size).toBe(0);
    expect(scope.current).toBe(initialScope);
    expect(scope.current.scope.scopeId).toBe(1);
    expect(initialScope.scope.retired).toBe(false);

    // 3 & 4. swapAuthorityScope + cross-generation cleanupRunAttempt with throwing handle close
    let unadoptedForegroundClosed = 0;
    let inFlightForegroundClosed = 0;
    let planDisposed = 0;
    let executionScopeClosed = 0;
    initialScope.preparedAdmissions.set("adm-unadopted", {
      admissionId: "adm-unadopted",
      conversationId: "conv-1",
      admission: { runId: "run-unadopted" } as never,
      claimToken: Symbol("unadopted"),
      foreground: {
        pause() {},
        resume() {},
        close() {
          unadoptedForegroundClosed += 1;
        },
      },
    });

    const staleToken = Symbol("stale-attempt");
    initialScope.schedulingRuns.set("run-dup", staleToken);
    initialScope.scheduledRuns.set("run-dup", staleToken);
    scope.claimAssignmentInScope(initialScope, "assign-dup", "run-dup", staleToken);
    initialScope.assignmentRoutes.set("assign-dup", {
      conversationId: "conv-1",
      routeRevision: 1,
    });

    const newScope = scope.swapAuthorityScope(artifactAuthority, interactions);
    expect(initialScope.scope.retired).toBe(true);
    expect(newScope.scope.scopeId).toBe(2);
    expect(unadoptedForegroundClosed).toBe(1);
    expect(inFlightForegroundClosed).toBe(0);
    expect(removedArtifacts).toContain("assign-dup");
    expect(releasedInteractions).toContain("assign-dup");

    // Register identical runId and assignmentId in newScope
    const freshToken = Symbol("fresh-attempt");
    newScope.schedulingRuns.set("run-dup", freshToken);
    newScope.scheduledRuns.set("run-dup", freshToken);
    scope.claimAssignmentInScope(newScope, "assign-dup", "run-dup", freshToken);
    newScope.assignmentRoutes.set("assign-dup", {
      conversationId: "conv-1",
      routeRevision: 2,
    });

    await expect(
      settlement.cleanupRunAttempt({
        attempt: {
          scope: initialScope.scope,
          scopeState: initialScope,
          conversationId: "conv-1",
          runId: "run-dup",
          claimToken: staleToken,
          capturedJournal: {
            assignmentsAwaitingRecovery: async () => [],
          } as never,
          attemptForeground: {
            pause() {},
            resume() {},
            close() {
              inFlightForegroundClosed += 1;
            },
          },
        },
        assignmentId: "assign-dup",
        getChannelSession: () =>
          ({
            close() {
              throw new Error("channel-close-boom");
            },
          }) as never,
        getFirstPartyStreamFinalSeq: () => undefined,
        drainFirstPartyProjection: () => {},
        getFirstPartyFinalitySession: () => undefined,
        getFirstPartySurfaceSession: () => undefined,
        getExecutorPlan: () =>
          ({
            dispose() {
              planDisposed += 1;
            },
          }) as never,
        getExecutionScope: () => ({
          close() {
            executionScopeClosed += 1;
          },
        }),
        runFailed: false,
        runError: undefined,
      }),
    ).rejects.toThrow("channel-close-boom");

    // Subsequent handle closes still executed despite channelSession.close() throwing!
    expect(planDisposed).toBe(1);
    expect(inFlightForegroundClosed).toBe(1);
    expect(executionScopeClosed).toBe(1);
    // Stale scope claims cleared, newScope claims & routes 100% untouched!
    expect(initialScope.schedulingRuns.has("run-dup")).toBe(false);
    expect(initialScope.activeAssignmentClaims.has("assign-dup")).toBe(false);
    expect(newScope.schedulingRuns.get("run-dup")).toBe(freshToken);
    expect(newScope.scheduledRuns.get("run-dup")).toBe(freshToken);
    expect(newScope.activeAssignmentClaims.get("assign-dup")?.claimToken).toBe(freshToken);
    expect(newScope.assignmentRoutes.get("assign-dup")?.routeRevision).toBe(2);

    // 5. markSeq compare-and-clear preserves newer concurrent mark during recovery await
    const claimedMarkSeq = scope.markRecoveryInScope(newScope, "conv-race", "run-a");
    const concurrentMarkSeq = scope.markRecoveryInScope(newScope, "conv-race", "run-b");
    expect(concurrentMarkSeq).toBeGreaterThan(claimedMarkSeq);
    if (newScope.recoveryConversations.get("conv-race") === claimedMarkSeq) {
      newScope.recoveryConversations.delete("conv-race");
      newScope.recoveryMarkLedger.delete("conv-race");
    }
    expect(newScope.recoveryConversations.get("conv-race")).toBe(concurrentMarkSeq);
    expect(newScope.recoveryMarkLedger.has("conv-race")).toBe(true);

    // 6. routeRevision prevents stale retireSettledAssignments from forgetting a concurrently rebound route
    const revBeforeAwait = scope.rememberAssignmentInScope(
      newScope,
      {
        assignmentId: "assign-rebound",
        capabilities: [{ id: "cap-1" }],
        work: { conversationId: "conv-rebound", ingress: {} },
      } as never,
      {} as never,
      artifactAuthority,
    )!;
    let releaseAwaiting!: (items: readonly { assignmentId: string }[]) => void;
    const awaitingPromise = new Promise<readonly { assignmentId: string }[]>((resolve) => {
      releaseAwaiting = resolve;
    });
    const retirePromise = settlement.retireSettledAssignments(
      "conv-rebound",
      { assignmentsAwaitingRecovery: () => awaitingPromise } as never,
      newScope,
    );
    // Rebind while assignmentsAwaitingRecovery() is suspended
    const revDuringAwait = scope.rememberAssignmentInScope(
      newScope,
      {
        assignmentId: "assign-rebound",
        capabilities: [{ id: "cap-2" }],
        work: { conversationId: "conv-rebound", ingress: {} },
      } as never,
      {} as never,
      artifactAuthority,
    )!;
    expect(revDuringAwait).toBeGreaterThan(revBeforeAwait);
    const removedCountBeforeResolve = removedArtifacts.length;
    releaseAwaiting([]);
    await retirePromise;
    expect(newScope.assignmentRoutes.get("assign-rebound")?.routeRevision).toBe(
      revDuringAwait,
    );
    expect(removedArtifacts.length).toBe(removedCountBeforeResolve);

    // 7. Background first-party tail drain isolates finality.close() throw so surface.close() always runs and errors are observed
    const tailObservedErrors: string[] = [];
    const tailSettlement = new TerminalSettlement({
      authority: {} as never,
      scope,
      access: {
        createDefaultDispatchContexts: () => ({}),
        journal: () => ({ assignmentsAwaitingRecovery: async () => [] }),
      } as never,
      admission: {} as never,
      host: { scheduleResolvedRetry: async () => {} },
      requiredManager: () => ({}) as never,
      clock: () => "2026-11-16T00:00:00.000Z",
      executorDispatch: {} as never,
      assignmentArtifactAuthority: artifactAuthority,
      interactions,
      observeFailure: (err) => {
        tailObservedErrors.push((err as Error).message);
      },
    });
    let tailFinalityCloses = 0;
    let tailSurfaceCloses = 0;
    newScope.pendingFirstPartyFinals.add("final-id-1");
    newScope.ownerPublishedFirstPartyFinals.add("final-id-1");
    await tailSettlement.drainFirstPartyProjection({
      capturedScope: newScope,
      conversationId: "conv-tail",
      runId: "run-tail",
      finalSeq: 7,
      finalIdentity: "final-id-1",
      finality: {
        close() {
          tailFinalityCloses += 1;
          throw new Error("finality-unsubscribe-boom");
        },
      } as never,
      surface: {
        async waitForSeq() {},
        async close() {
          tailSurfaceCloses += 1;
        },
      } as never,
    });
    expect(tailFinalityCloses).toBe(1);
    expect(tailSurfaceCloses).toBe(1);
    expect(newScope.pendingFirstPartyFinals.has("final-id-1")).toBe(false);
    expect(newScope.ownerPublishedFirstPartyFinals.has("final-id-1")).toBe(false);
    expect(tailObservedErrors).toEqual(["finality-unsubscribe-boom"]);

    // Also when waitForSeq rejects AND finality.close() throws AND surface.close() throws, all 3 run & report
    const tripleObservedErrors: string[] = [];
    const tripleSettlement = new TerminalSettlement({
      authority: {} as never,
      scope,
      access: {
        createDefaultDispatchContexts: () => ({}),
        journal: () => ({ assignmentsAwaitingRecovery: async () => [] }),
      } as never,
      admission: {} as never,
      host: { scheduleResolvedRetry: async () => {} },
      requiredManager: () => ({}) as never,
      clock: () => "2026-11-16T00:00:00.000Z",
      executorDispatch: {} as never,
      assignmentArtifactAuthority: artifactAuthority,
      interactions,
      observeFailure: (err) => {
        tripleObservedErrors.push((err as Error).message);
      },
    });
    let tripleFinalityCloses = 0;
    let tripleSurfaceCloses = 0;
    await tripleSettlement.drainFirstPartyProjection({
      capturedScope: newScope,
      conversationId: "conv-tail-2",
      runId: "run-tail-2",
      finalSeq: 8,
      finality: {
        close() {
          tripleFinalityCloses += 1;
          throw new Error("finality-close-boom");
        },
      } as never,
      surface: {
        async waitForSeq() {
          throw new Error("wait-seq-timeout");
        },
        async close() {
          tripleSurfaceCloses += 1;
          throw new Error("surface-close-boom");
        },
      } as never,
    });
    expect(tripleFinalityCloses).toBe(1);
    expect(tripleSurfaceCloses).toBe(1);
    expect(tripleObservedErrors).toEqual([
      "wait-seq-timeout",
      "finality-close-boom",
      "surface-close-boom",
    ]);
  });
});
