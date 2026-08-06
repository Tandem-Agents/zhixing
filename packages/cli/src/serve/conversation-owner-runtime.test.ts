import { describe, expect, it, vi } from "vitest";
import type { AuthorityRuntimeStack } from "../setup-delivery.js";
import {
  anchorConversationOwnerRuntime,
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

    const local = localConversationOwnerRuntime(authority);
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
    await expect(local.finalizeUsage("assignment-local", {} as never)).resolves.toEqual({
      reportDigest: "sha256:" + "a".repeat(64),
      upToUsageSeq: 0,
    });
    expect(finalizeLocalAssignment).toHaveBeenCalledWith("assignment-local");
  });
});
