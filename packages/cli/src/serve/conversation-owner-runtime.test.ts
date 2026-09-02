import { describe, expect, it, vi } from "vitest";
import type { AuthorityRuntimeStack } from "../setup-delivery.js";
import {
  anchorConversationOwnerRuntime,
  createConversationResourceRecoveryPort,
  localConversationOwnerRuntime,
} from "./conversation-owner-runtime.js";

describe("conversation owner domain composition", () => {
  it("isolates local identities, logs, resources, and global capabilities by construction", async () => {
    const finalizeLocalAssignment = vi.fn(async () => ({
      reportDigest: "sha256:" + "a".repeat(64),
      upToUsageSeq: 0,
    }));
    const authority = {
      anchorEpoch: 9,
      localDomainId: "local:device-abcdef",
      localOwnerEpoch: 3,
      localGovernorEpoch: 4,
      deviceId: "device-abcdef",
      executorId: "executor-1",
      localExecutorEnabled: true,
      signer: {},
      verifier: {},
      authorityLog: { id: "anchor-log" },
      executorLog: { id: "executor-log" },
      artifacts: {},
      controlAdmission: { id: "anchor-control" },
      localControlAdmission: { id: "local-control" },
      executorCapabilities: {},
      resourceGovernor: {},
      executorResourceGovernor: {
        assignmentDomain: vi.fn(async () => undefined),
        finalizeLocalAssignment,
      },
      surfaceAssets: {},
      participant: {},
      globalState: {},
      permissionSnapshotFor: vi.fn(),
      prepareConversationAssignment: vi.fn(),
      prepareLocalConversationAssignment: vi.fn(),
      validateConversationRuntimeBinding: vi.fn(),
      preflightLocalConversationEnvironment: vi.fn(),
      releaseLocalConversationEnvironmentPreflight: vi.fn(),
      validateLocalConversationManifest: vi.fn(),
    } as unknown as AuthorityRuntimeStack;

    const executorResources = authority.executorResourceGovernor;
    const local = localConversationOwnerRuntime({
      ...authority,
      resources: executorResources,
      executionResources: executorResources,
      assignmentResources: executorResources,
      resourceRecovery: createConversationResourceRecoveryPort({
        primary: executorResources,
        acceptedWork: executorResources,
      }),
      finalizeUsage: (assignmentId) =>
        executorResources.finalizeLocalAssignment(assignmentId),
    });
    const anchor = anchorConversationOwnerRuntime(authority);
    const localId = "local-device-a-01ARZ3NDEKTSV4RRFFQ69G5FAV";

    expect(local.log).toBe(authority.executorLog);
    expect(local.executorLog).toBe(authority.executorLog);
    expect(anchor.log).toBe(authority.authorityLog);
    expect(anchor.executorLog).toBe(authority.executorLog);
    expect(local.controlAdmission).toBe(authority.localControlAdmission);
    expect(local.domain).toEqual({
      kind: "local",
      localDomainId: "local:device-abcdef",
      localOwnerEpoch: 3,
      localGovernorEpoch: 4,
    });
    expect(local.acceptsConversationId(localId)).toBe(true);
    expect(local.acceptsConversationId("local-another--01ARZ3NDEKTSV4RRFFQ69G5FAV")).toBe(false);
    expect(local.acceptsConversationId("conversation-anchor")).toBe(false);
    expect(anchor.acceptsConversationId(localId)).toBe(false);
    expect(anchor.acceptsConversationId("conversation-anchor")).toBe(true);
    expect(local.globalState).toBeUndefined();
    expect(local.surfaceAssets).toBeUndefined();
    expect(local.delivery).toBeUndefined();
    expect(local.participant).toBeUndefined();
    expect("resourceGovernor" in local).toBe(false);
    expect("executorResources" in local).toBe(false);
    expect("executorResourceGovernor" in local).toBe(false);
    expect(local.executionResources).toBe(executorResources);
    expect(local.assignmentResources).toBe(executorResources);
    await expect(local.finalizeUsage("assignment-local", {} as never)).resolves.toEqual({
      reportDigest: "sha256:" + "a".repeat(64),
      upToUsageSeq: 0,
    });
    expect(finalizeLocalAssignment).toHaveBeenCalledWith("assignment-local");
  });

  it("does not evaluate executor-only capabilities for an anchor-only topology", () => {
    const authority = {
      anchorEpoch: 9,
      localExecutorEnabled: false,
      deviceId: "device-anchor",
      executorId: "executor-remote",
      signer: {},
      verifier: {},
      authorityLog: {},
      artifacts: {},
      controlAdmission: {},
      executorCapabilities: {},
      resourceGovernor: {},
      surfaceAssets: {},
      participant: {},
      permissionSnapshotFor: vi.fn(),
      prepareConversationAssignment: vi.fn(),
      validateConversationRuntimeBinding: vi.fn(),
      preflightLocalConversationEnvironment: vi.fn(),
      releaseLocalConversationEnvironmentPreflight: vi.fn(),
      validateLocalConversationManifest: vi.fn(),
      get executorLog() {
        throw new Error("executor log was evaluated");
      },
      get executorResourceGovernor() {
        throw new Error("executor resources were evaluated");
      },
    } as unknown as AuthorityRuntimeStack;

    expect(() => anchorConversationOwnerRuntime(authority)).not.toThrow();
    const runtime = anchorConversationOwnerRuntime(authority);
    expect(runtime.executorLog).toBeUndefined();
    expect(runtime.executionResources).toBeUndefined();
    expect(runtime.assignmentResources).toBeUndefined();
  });

  it("projects recovery and accepted-work leases without exposing governor state", async () => {
    const primaryReclaim = vi.fn(async () => 2);
    const executionReclaim = vi.fn(async () => 3);
    const executionSnapshot = vi.fn(async () => ({
      reservations: new Map([
        [
          "reservation-active",
          {
            state: "active",
            lease: {
              scopeBinding: {
                kind: "conversation",
                conversationId: "conversation-1",
                ownerEpoch: 7,
              },
            },
          },
        ],
        [
          "reservation-job",
          {
            state: "active",
            lease: { scopeBinding: { kind: "job", taskId: "task-1" } },
          },
        ],
      ]),
    }));
    const recovery = createConversationResourceRecoveryPort({
      primary: {
        reclaimExpired: primaryReclaim,
        snapshot: vi.fn(() => {
          throw new Error("anchor snapshot must not drive executor accepted work");
        }),
      },
      additionalRecovery: {
        reclaimExpired: executionReclaim,
      },
      acceptedWork: {
        snapshot: executionSnapshot,
      },
    } as never);

    await expect(recovery.reclaimExpired()).resolves.toBe(5);
    await expect(recovery.activeConversationReservations()).resolves.toEqual([
      {
        reservationId: "reservation-active",
        conversationId: "conversation-1",
        ownerEpoch: 7,
        revision: expect.stringMatching(/^sha256:/u),
      },
    ]);
    expect(primaryReclaim).toHaveBeenCalledTimes(1);
    expect(executionReclaim).toHaveBeenCalledTimes(1);
    expect(executionSnapshot).toHaveBeenCalledTimes(1);
    expect("snapshot" in recovery).toBe(false);

    const localReclaim = vi.fn(async () => 1);
    const localRecovery = {
      reclaimExpired: localReclaim,
    };
    const local = createConversationResourceRecoveryPort({
      primary: localRecovery,
      additionalRecovery: localRecovery,
      acceptedWork: {
        snapshot: vi.fn(async () => ({ reservations: new Map() })),
      },
    } as never);
    await expect(local.reclaimExpired()).resolves.toBe(1);
    expect(localReclaim).toHaveBeenCalledTimes(1);

    const anchorOnly = createConversationResourceRecoveryPort({
      primary: {
        reclaimExpired: vi.fn(async () => 0),
      },
    });
    await expect(anchorOnly.activeConversationReservations()).resolves.toEqual([]);
  });
});
