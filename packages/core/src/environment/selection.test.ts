import { describe, expect, it } from "vitest";
import type {
  CapabilityDescriptor,
  EnvironmentPort,
  EnvironmentRequirement,
} from "../contracts/index.js";
import {
  deriveEnvironmentRequirement,
  executionProfileForEnvironment,
  preflightWorkspaceRequirement,
  selectExecutorForEnvironment,
} from "./selection.js";

describe("environment selection", () => {
  it("removes every workspace-dependent tool when no workspace was selected", () => {
    const profile = {
      tools: [
        "read",
        "write",
        "edit",
        "glob",
        "grep",
        "bash",
        "admit_skill",
        "memory",
        "web_fetch",
      ],
      mcpServers: ["server-a"],
      providerIds: ["provider-a"],
    };
    expect(executionProfileForEnvironment(profile, {})).toEqual({
      tools: ["memory", "web_fetch"],
      mcpServers: ["server-a"],
      providerIds: ["provider-a"],
    });
    expect(
      executionProfileForEnvironment(profile, {
        workspace: {
          deviceId: "device-a",
          bindingRef: "workspace-a",
          workspaceBindingRevision: 1,
        },
      }),
    ).toEqual(profile);
  });

  it("lets a higher-priority no-workspace workscene replace a frozen workspace", () => {
    expect(
      deriveEnvironmentRequirement({
        workscene: {},
        frozen: {
          workspace: {
            deviceId: "device-old",
            bindingRef: "workspace-old",
            workspaceBindingRevision: 3,
          },
        },
      }),
    ).toEqual({});
  });

  it("queues candidates that lack required credentials or evidence", () => {
    const requirement = {
      credentialBindings: [{ service: "provider", bindingId: "binding-a" }],
      evidenceKinds: ["artifact"] as const,
    };
    expect(
      selectExecutorForEnvironment(requirement, [
        candidate({ credentialBindings: [], evidenceCapabilities: ["artifact"] }),
      ]),
    ).toMatchObject({ kind: "queued", reason: "capability-unavailable" });
    expect(
      selectExecutorForEnvironment(requirement, [
        candidate({
          credentialBindings: [
            {
              service: "provider",
              bindingId: "binding-a",
              revision: 1,
              principalFingerprint: "fingerprint",
              verification: "user-alias",
            },
          ],
          evidenceCapabilities: ["artifact"],
        }),
      ]),
    ).toMatchObject({ kind: "selected", executorId: "executor-a" });
  });

  it("distinguishes a missing path and converts probe exceptions to fail-closed results", async () => {
    const requirement: EnvironmentRequirement = {
      workspace: {
        deviceId: "device-a",
        bindingRef: "workspace-a",
        workspaceBindingRevision: 2,
      },
    };
    const environment: EnvironmentPort = {
      resolveWorkspace: async () => ({
        absolutePath: "C:\\missing",
        workspaceBindingRevision: 2,
      }),
      probePath: async () => "missing",
      capabilitySnapshot: async () => {
        throw new Error("unused");
      },
      versionInventory: async () => {
        throw new Error("unused");
      },
    };
    await expect(
      preflightWorkspaceRequirement(environment, requirement),
    ).resolves.toEqual({
      ok: true,
      absolutePath: "C:\\missing",
      state: "missing",
    });
    await expect(
      preflightWorkspaceRequirement(
        {
          ...environment,
          probePath: async () => {
            throw new Error("I/O failed");
          },
        },
        requirement,
      ),
    ).resolves.toEqual({ ok: false, reason: "probe-error" });
  });
});

function candidate(
  overrides: Partial<CapabilityDescriptor>,
): {
  executorId: string;
  deviceId: string;
  descriptor: CapabilityDescriptor;
} {
  return {
    executorId: "executor-a",
    deviceId: "device-a",
    descriptor: {
      v: 1,
      executorId: "executor-a",
      revision: 1,
      protocolVersion: "1",
      workspaces: [],
      tools: [],
      mcpServers: [],
      credentialBindings: [],
      evidenceCapabilities: [],
      at: "2026-07-30T00:00:00.000Z",
      signature: { alg: "test", keyId: "device-a", sig: "signature" },
      ...overrides,
    },
  };
}
