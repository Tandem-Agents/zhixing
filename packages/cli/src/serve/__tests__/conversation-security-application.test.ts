import { describe, expect, it, vi } from "vitest";
import { workspaceTrustIdentity } from "@zhixing-ai/core/trust-administration";
import { createAnchorConversationSecurityProjectionPort } from "../conversation-security-application.js";

const baseSnapshot = {
  contextId: { kind: "main" as const },
  workspacePath: null,
  permissionRules: [],
  builtinRules: [],
  rateLimits: [],
  confirmations: [],
};

function manager() {
  return {
    inspectSecurityExisting: vi.fn(async () => ({ status: "done" as const, snapshot: baseSnapshot })),
  } as never;
}

describe("anchor conversation security projection", () => {
  it("marks the default overview when no run is executing", async () => {
    const port = createAnchorConversationSecurityProjectionPort({
      conversations: manager(),
      exists: async () => true,
      activeRun: async () => undefined,
      permissionSnapshotFor: async () => undefined,
    });
    await expect(port.inspectSecurityExisting("conversation-1")).resolves.toMatchObject({
      status: "done",
      snapshot: { contextId: { kind: "main" }, scope: { kind: "default" } },
    });
  });

  it("shows the executing run's scope from its verified manifest and its frozen snapshot", async () => {
    const snapshotFor = vi.fn(async () => ({
      v: 1, snapshotVersion: 3, generatedAt: "2026-11-01T00:00:00.000Z", digest: "sha256:x", signature: {} as never,
      rules: [{ id: "frozen-1", pattern: { tool: "bash", argument: "npm test" }, decision: "allow" as const, scope: "context" as const,
        createdAt: 1, contextId: { kind: "workspace" as const, hash: workspaceTrustIdentity("device-1", "binding-1"), revision: 2 } }],
    }));
    const port = createAnchorConversationSecurityProjectionPort({
      conversations: manager(),
      exists: async () => true,
      activeRun: async () => ({
        runId: "run-1",
        environment: { workspace: { deviceId: "device-1", bindingRef: "binding-1", workspaceBindingRevision: 2 } },
        permissionSnapshotDigest: "sha256:x",
      }),
      permissionSnapshotFor: snapshotFor,
    });
    const inspected = await port.inspectSecurityExisting("conversation-1");
    expect(snapshotFor).toHaveBeenCalledWith("sha256:x");
    expect(inspected).toMatchObject({
      snapshot: {
        // 默认概览保留，运行的实际范围单独给出
        contextId: { kind: "main" },
        scope: {
          kind: "run",
          runId: "run-1",
          contextId: { kind: "workspace", hash: workspaceTrustIdentity("device-1", "binding-1") },
          permissionRules: [{ id: "frozen-1", matchCount: 0 }],
        },
      },
    });
  });
});
