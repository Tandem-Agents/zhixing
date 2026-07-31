import type {
  ImmediateRootResourceLease,
  ResourceLease,
  SecretRef,
  SecretStorePort,
} from "@zhixing/core/contracts";
import { localEnvironmentControlSubject } from "@zhixing/core/environment";
import {
  createExecutionManifest,
  protocolDigest,
} from "@zhixing/core/protocol";
import {
  createDefaultDeviceCapacityPolicy,
  DefaultDeviceCapacityArbiter,
  DefaultStorageMaintenanceGovernor,
} from "@zhixing/core/resources";
import { setupAuthorityRuntime } from "../setup-delivery.js";

const EMPTY_EXECUTION_PROFILE = {
  tools: [] as string[],
  mcpServers: [] as string[],
  providerIds: [] as string[],
};
const EMPTY_READINESS = {
  tools: [] as string[],
  mcpServers: [] as string[],
  credentialBindings: [],
  deviceScopedCredentialBindingIds: [] as string[],
  credentialGeneration: null,
};

export interface S7TerminalPerformancePreflight {
  run(hasWorkspace: boolean, sampleId: string): Promise<0 | 1>;
  close(): Promise<void>;
}

/**
 * Benchmark composition root for the real S7 environment preflight.
 *
 * The caller owns timing and the deterministic model. This helper owns only
 * production authority setup and the one assignment-scoped preflight point.
 */
export async function createS7TerminalPerformancePreflight(input: {
  readonly zhixingHome: string;
  readonly workspaceRoot: string;
  readonly timestamp: string;
}): Promise<S7TerminalPerformancePreflight> {
  const capacity = new DefaultDeviceCapacityArbiter({
    policy: createDefaultDeviceCapacityPolicy(),
    probe: () => ({
      cpuBusyRatio: 0,
      availableMemoryBytes: 16 * 1024 * 1024 * 1024,
      processRssBytes: 64 * 1024 * 1024,
      temporaryBytesAvailable: 16 * 1024 * 1024 * 1024,
    }),
  });
  const runtime = await setupAuthorityRuntime({
    zhixingHome: input.zhixingHome,
    secretStore: new MemorySecretStore(),
    executorReadiness: EMPTY_READINESS,
    enableAnchor: true,
    enableLocalExecutor: true,
    deviceCapacity: capacity,
    storageMaintenance: new DefaultStorageMaintenanceGovernor({
      capacity,
    }),
    clock: () => input.timestamp,
  });
  const requestId = localEnvironmentControlSubject(
    runtime.deviceId,
    "s7-terminal-performance",
  );
  const binding = await runtime.workspaceBindingAdmin!.create(
    {
      displayName: "Performance Workspace",
      absolutePath: input.workspaceRoot,
    },
    {
      requestId,
      lease: rootLease(
        runtime.identityKey,
        requestId,
        runtime.executorId,
        runtime.deviceId,
        input.timestamp,
      ),
      abort: new AbortController().signal,
    },
  );
  const noWorkspace = await runtime.prepareConversationAssignment({
    conversationId: "s7-terminal-performance",
    executionProfile: EMPTY_EXECUTION_PROFILE,
    permissionRules: [],
  });
  const workspace = await runtime.prepareConversationAssignment({
    conversationId: "s7-terminal-performance",
    executionProfile: EMPTY_EXECUTION_PROFILE,
    permissionRules: [],
    environment: {
      workspace: {
        deviceId: runtime.deviceId,
        bindingRef: binding.bindingRef,
      },
    },
  });
  const manifests = {
    noWorkspace: executionManifest(noWorkspace),
    workspace: executionManifest(workspace),
  };

  return {
    async run(hasWorkspace, sampleId) {
      const manifest = hasWorkspace
        ? manifests.workspace
        : manifests.noWorkspace;
      const assignmentId = `s7-performance:${sampleId}`;
      try {
        const result = await runtime.preflightLocalConversationEnvironment(
          manifest,
          assignmentId,
        );
        if (result.error) throw new Error(result.error.message);
        if (
          hasWorkspace
            ? result.workspaceRoot !== input.workspaceRoot
            : result.workspaceRoot !== null
        ) {
          throw new Error(
            "Production environment preflight returned an unexpected workspace",
          );
        }
        return hasWorkspace ? 1 : 0;
      } finally {
        runtime.releaseLocalConversationEnvironmentPreflight(
          manifest,
          assignmentId,
        );
      }
    },
    async close() {
      await runtime.stopStorageMaintenance();
    },
  };
}

function executionManifest(
  prepared: Awaited<
    ReturnType<
      Awaited<ReturnType<typeof setupAuthorityRuntime>>["prepareConversationAssignment"]
    >
  >,
) {
  return createExecutionManifest({
    baseRef: {
      execution: "conversation",
      conversationId: "s7-terminal-performance",
      baseRevision: 0,
    },
    protocolVersion: prepared.policy.manifestCapabilities.protocolVersion,
    requires: {
      ...prepared.policy.manifestRequires,
      permissionSnapshotVersion:
        prepared.policy.permissionSnapshot.snapshotVersion,
    },
    tools: [...prepared.policy.manifestCapabilities.tools],
    mcpServers: [...prepared.policy.manifestCapabilities.mcpServers],
    environment: prepared.environment,
    credentialBindings: [
      ...prepared.policy.manifestCapabilities.credentialBindings,
    ],
  });
}

function rootLease(
  signer: {
    sign(
      domain: string,
      version: number,
      payload: unknown,
    ): ResourceLease["signature"];
  },
  requestId: string,
  executorId: string,
  localDomainId: string,
  timestamp: string,
): ImmediateRootResourceLease {
  const payload: Omit<ResourceLease, "digest" | "signature"> = {
    v: 1,
    reservationId: `reservation:${requestId}`,
    admissionClass: "interactive",
    workload: { kind: "control", id: requestId, attempt: 1 },
    scopeBinding: { kind: "control", subject: requestId },
    audience: { executorId },
    budget: { maxCalls: 8 },
    domain: { kind: "local", localDomainId, localGovernorEpoch: 1 },
    issuedAt: timestamp,
    expiry: "2099-01-01T00:00:00.000Z",
  };
  const withDigest = {
    ...payload,
    digest: protocolDigest("ResourceLease", 1, payload),
  };
  return {
    ...withDigest,
    signature: signer.sign("ResourceLease", 1, withDigest),
  } as ImmediateRootResourceLease;
}

class MemorySecretStore implements SecretStorePort {
  readonly #entries = new Map<string, string>();

  async put(ref: SecretRef, value: string): Promise<void> {
    this.#entries.set(secretKey(ref), value);
  }

  async get(ref: SecretRef): Promise<string | null> {
    return this.#entries.get(secretKey(ref)) ?? null;
  }

  async delete(ref: SecretRef): Promise<void> {
    this.#entries.delete(secretKey(ref));
  }

  async list(prefix: string): Promise<SecretRef[]> {
    return [...this.#entries.keys()]
      .filter((value) => value.startsWith(prefix))
      .map((value) => {
        const separator = value.indexOf("/");
        return {
          kind: value.slice(0, separator) as SecretRef["kind"],
          bindingId: value.slice(separator + 1),
        };
      });
  }

  async unlockState(): Promise<"unlocked"> {
    return "unlocked";
  }
}

function secretKey(ref: SecretRef): string {
  return `${ref.kind}/${ref.bindingId}`;
}
