import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  ImmediateRootResourceLease,
  ResourceLease,
  SecretRef,
  SecretStorePort,
} from "@zhixing/core/contracts";
import {
  ConversationRepository,
  ShardedTranscriptStore,
  conversationsDir,
} from "@zhixing/core";
import {
  LocalWorkspaceProbeAdapter,
  localEnvironmentControlSubject,
  selectExecutorForEnvironment,
  type WorkspaceProbePort,
} from "@zhixing/core/environment";
import {
  createExecutionManifest,
  protocolDigest,
  type ProtocolSignatureVerifier,
} from "@zhixing/core/protocol";
import {
  createDefaultDeviceCapacityPolicy,
  DefaultDeviceCapacityArbiter,
  DefaultStorageMaintenanceGovernor,
} from "@zhixing/core/resources";
import type { SecureMeshConnection } from "@zhixing/mesh";
import { DeviceKey, enrollDeviceIdentity } from "@zhixing/mesh/device-identity";
import {
  ConversationManager,
  runTurnWithCommit,
} from "@zhixing/owner-kernel";
import type { MeshServiceClient } from "@zhixing/mesh/request-channel";
import type {
  MeshServiceDefinition,
  MeshServiceRegistry,
} from "@zhixing/mesh/service-registry";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { setupAuthorityRuntime } from "../setup-delivery.js";
import { createConversationDirectory } from "./conversation-directory.js";
import {
  ConversationProtocolRuntime,
  DurableConversationInteractionObserver,
} from "./conversation-protocol-runtime.js";
import {
  MeshExecutionSnapshotClient,
  registerExecutionSnapshotMeshService,
} from "./execution-snapshot-mesh.js";
import {
  EnvironmentProbeMeshClient,
  registerEnvironmentProbeMeshService,
} from "./environment-probe-mesh.js";
import { WorksceneSessionOwner } from "./workscene-session-owner.js";

const NOW = "2026-07-30T00:00:00.000Z";
const EXPIRY = "2099-01-01T00:00:00.000Z";
const EMPTY_PROFILE = {
  tools: [] as string[],
  mcpServers: [] as string[],
  providerIds: [] as string[],
};
const READINESS = {
  tools: [] as string[],
  mcpServers: [] as string[],
  credentialBindings: [],
  deviceScopedCredentialBindingIds: [] as string[],
  credentialGeneration: null,
};

describe("S7 environment/workscene production conformance", () => {
  it("drives the same finite chain through real in-process and mesh composition roots", async () => {
    const local = await runChain("in-process");
    const distributed = await runChain("mesh");

    expect(local).toEqual(distributed);
    expect(local).toEqual({
      bindingPublished: true,
      sceneBound: true,
      assignmentFrozen: true,
      preflight: "workspace-root",
      probe: "directory",
      pathFreeWire: true,
      ownerSession: true,
      ownerExit: true,
      runtimeActivated: true,
      queued: "workspace-unavailable",
      meshAuthorize: true,
      activityMerged: true,
    });
  }, 120_000);
});

async function runChain(topology: "in-process" | "mesh") {
  const root = await createTempDir(`s7-${topology}`);
  const anchorHome = resolve(root, "anchor");
  const executorHome =
    topology === "in-process" ? anchorHome : resolve(root, "executor");
  const anchorKey = await DeviceKey.generate();
  const executorKey =
    topology === "in-process" ? anchorKey : await DeviceKey.generate();
  const anchorIdentity = enrollDeviceIdentity(anchorKey, {
    displayName: "Anchor",
    platform: "headless",
    enrolledAt: NOW,
  });
  const executorIdentity =
    topology === "in-process"
      ? anchorIdentity
      : enrollDeviceIdentity(executorKey, {
          displayName: "Executor",
          platform: "headless",
          enrolledAt: NOW,
        });
  const arbiter = new DefaultDeviceCapacityArbiter({
    policy: createDefaultDeviceCapacityPolicy(),
    probe: () => ({
      cpuBusyRatio: 0,
      availableMemoryBytes: 16 * 1024 * 1024 * 1024,
      processRssBytes: 64 * 1024 * 1024,
      temporaryBytesAvailable: 16 * 1024 * 1024 * 1024,
    }),
  });
  const capacity = {
    arbiter,
    storage: new DefaultStorageMaintenanceGovernor({ capacity: arbiter }),
  };
  const previousHome = process.env.ZHIXING_HOME;
  process.env.ZHIXING_HOME = anchorHome;
  let anchor: Awaited<ReturnType<typeof setupAuthorityRuntime>> | undefined;
  let executor: Awaited<ReturnType<typeof setupAuthorityRuntime>> | undefined;
  try {
    executor = await setupAuthorityRuntime({
      zhixingHome: executorHome,
      secretStore: new MemorySecretStore(),
      deviceKey: executorKey,
      trustedIdentities:
        topology === "mesh" ? [anchorIdentity] : [],
      authorizedDeviceIds:
        topology === "mesh" ? [anchorIdentity.deviceId] : [],
      executorReadiness: READINESS,
      enableAnchor: topology === "in-process",
      enableLocalExecutor: true,
      deviceCapacity: capacity.arbiter,
      storageMaintenance: capacity.storage,
      clock: () => NOW,
    });
    anchor =
      topology === "in-process"
        ? executor
        : await setupAuthorityRuntime({
            zhixingHome: anchorHome,
            secretStore: new MemorySecretStore(),
            deviceKey: anchorKey,
            trustedIdentities: [executorIdentity],
            authorizedDeviceIds: [executorIdentity.deviceId],
            executorReadiness: READINESS,
            enableAnchor: true,
            enableLocalExecutor: false,
            clock: () => NOW,
          });

    const workspaceRoot = resolve(root, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    const adminRequest = localEnvironmentControlSubject(
      executor.deviceId,
      `s7-${topology}`,
    );
    const binding = await executor.workspaceBindingAdmin!.create(
      { displayName: "Project", absolutePath: workspaceRoot },
      {
        requestId: adminRequest,
        lease: rootLease(
          executorKey,
          adminRequest,
          executor.executorId,
          executor.deviceId,
        ),
        abort: new AbortController().signal,
      },
    );

    const mesh =
      topology === "mesh"
        ? createMeshEnvironmentAdapters({
            probe: executor.workspaceProbe!,
            publisher: {
              currentCapability: executor.currentExecutorSnapshot,
              installPermission: executor.installPermissionSnapshot,
            },
            executorVerifier: executor.verifier,
            ownerVerifier: anchor.verifier,
            ownerDeviceId: anchor.deviceId,
          })
        : undefined;
    if (topology === "mesh") {
      await anchor.acceptExecutorSnapshot(
        await mesh!.snapshots.currentCapability(),
      );
    }
    const created = await anchor.globalState!.mutate(
      {
        kind: "workscene-create",
        name: "Project Scene",
        workspace: {
          deviceId: executor.deviceId,
          bindingRef: binding.bindingRef,
        },
      },
      {
        principal: { kind: "host", component: "s7-conformance" },
        requestId: `scene-${topology}`,
        authority: { domain: "global", anchorEpoch: anchor.anchorEpoch },
        deadlineAt: EXPIRY,
      },
    );
    if (created.kind !== "workscene-applied") {
      throw new Error("Workscene create did not return an applied result");
    }

    const conversationId = `ws:${created.scene.id}:conv_main`;
    const prepared = await anchor.prepareConversationAssignment({
      conversationId,
      executionProfile: EMPTY_PROFILE,
      permissionRules: [],
      environment: {
        workspace: {
          deviceId: executor.deviceId,
          bindingRef: binding.bindingRef,
        },
      },
      ...(topology === "mesh"
        ? {
            targets: [
              {
                executorId: executor.executorId,
                deviceId: executor.deviceId,
                synchronizePermission: (snapshot) =>
                  mesh!.snapshots.installPermission(snapshot),
              },
            ],
          }
        : {}),
    });
    const manifest = createExecutionManifest({
      baseRef: {
        execution: "conversation",
        conversationId,
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
    const preflight =
      await executor.preflightLocalConversationEnvironment(manifest);

    const probeLease = rootLease(
      anchorKey,
      `probe-${topology}`,
      executor.executorId,
      anchor.deviceId,
    );
    const probeRequest = anchor.environmentProbeOwner!.issue({
      requestId: `probe-${topology}`,
      deviceId: executor.deviceId,
      bindingRef: binding.bindingRef,
      executorId: executor.executorId,
      resourceLease: probeLease,
    });
    const probePort =
      topology === "in-process"
        ? new LocalWorkspaceProbeAdapter(executor.workspaceProbe!)
        : mesh!.probe;
    const probe = anchor.environmentProbeOwner!.accept(
      probeRequest,
      await probePort.probe(probeRequest),
      executor.executorId,
    );
    let unauthorizedProbeRejected = topology === "in-process";
    if (mesh) {
      try {
        await mesh.unauthorizedProbe.probe(probeRequest);
      } catch {
        unauthorizedProbeRejected = true;
      }
    }
    let runtimeCreates = 0;
    const conversationManager = new ConversationManager(
      {
        async create(sessionId) {
          runtimeCreates += 1;
          return {
            sessionId,
            async *run(messages) {
              yield { type: "text_delta" as const, text: "ready" };
              yield { type: "text_delta" as const, text: "." };
              const assistant = {
                role: "assistant" as const,
                content: [{ type: "text" as const, text: "ready." }],
              };
              return {
                agentResult: {
                  reason: "completed" as const,
                  message: assistant,
                  usage: { inputTokens: 1, outputTokens: 1 },
                },
                runRecord: {
                  timestamp: NOW,
                  messages: [messages.at(-1)!, assistant],
                  usage: { inputTokens: 1, outputTokens: 1 },
                  source: "interactive" as const,
                },
                newMessages: [assistant],
                durationMs: 1,
              };
            },
            abort() {
              return false;
            },
            async dispose() {},
          };
        },
      },
      {
        idleCheckIntervalMs: 60_000,
        graceTimeoutMs: 60_000,
        idleTimeoutMs: 60_000,
      },
    );
    const conversationProtocol = new ConversationProtocolRuntime({
      authority: anchor,
      manager: () => conversationManager,
      interactions: new DurableConversationInteractionObserver(),
      clock: () => NOW,
    });
    const conversationDirectory = createConversationDirectory({
      repo: new ConversationRepository({ kind: "user" }),
      transcript: new ShardedTranscriptStore(
        conversationsDir({ kind: "user" }),
      ),
    });
    const sessionOwner = new WorksceneSessionOwner({
      conversations: () => conversationManager,
      directory: conversationDirectory,
      authority: () => conversationProtocol,
      runCleanupStep: (_resourceIdentity, operation) => operation(),
    });
    const ownerConversationId = await sessionOwner.enter(
      created.scene.id,
      `surface-${topology}`,
      {
        requestId: `enter-${topology}`,
        recordActivity: false,
      },
    );
    let runtimeFrames = 0;
    for await (const _frame of runTurnWithCommit(
      conversationManager,
      ownerConversationId,
      "conformance",
    )) {
      runtimeFrames += 1;
    }
    await sessionOwner.exit(
      created.scene.id,
      ownerConversationId,
      `surface-${topology}`,
      `exit-${topology}`,
      new Date().toISOString(),
    );
    let scene: typeof created.scene | null = null;
    await expect
      .poll(
        async () => {
          const sceneResult = await anchor.globalState!.read(
            { kind: "workscene-get", sceneId: created.scene.id },
            {
              principal: { kind: "host", component: "s7-conformance" },
              requestId: `read-${topology}`,
              authority: {
                domain: "global",
                anchorEpoch: anchor.anchorEpoch,
              },
              deadlineAt: EXPIRY,
            },
          );
          scene =
            sceneResult.kind === "workscene-get"
              ? sceneResult.scene
              : null;
          return (
            !!scene &&
            Date.parse(scene.lastActiveAt) >
              Date.parse(created.scene.createdAt)
          );
        },
        { interval: 25, timeout: 10_000 },
      )
      .toBe(true);
    const snapshot = await executor.currentExecutorSnapshot();
    const queued = selectExecutorForEnvironment(
      {
        workspace: {
          deviceId: executor.deviceId,
          bindingRef: "workspace:missing",
        },
      },
      [
        {
          executorId: executor.executorId,
          deviceId: executor.deviceId,
          descriptor: snapshot.descriptor,
        },
      ],
    );
    await conversationManager.disposeAll();

    return {
      bindingPublished: snapshot.descriptor.workspaces.some(
        (entry) =>
          entry.bindingRef === binding.bindingRef &&
          entry.workspaceBindingRevision ===
            binding.workspaceBindingRevision,
      ),
      sceneBound:
        scene?.workspace?.deviceId === executor.deviceId &&
        scene.workspace.bindingRef === binding.bindingRef,
      assignmentFrozen:
        prepared.environment.workspace?.workspaceBindingRevision ===
        binding.workspaceBindingRevision,
      preflight:
        preflight.workspaceRoot === workspaceRoot
          ? "workspace-root"
          : preflight.error?.code ?? "missing",
      probe: probe.probe,
      pathFreeWire:
        !JSON.stringify({
          scene,
          environment: prepared.environment,
          probeRequest,
          probe,
        }).includes(workspaceRoot),
      ownerSession: ownerConversationId.startsWith(`ws:${created.scene.id}:`),
      ownerExit:
        conversationManager.getObserverCount(ownerConversationId) === 0,
      runtimeActivated: runtimeCreates === 1 && runtimeFrames === 2,
      queued: queued.kind === "queued" ? queued.reason : queued.kind,
      meshAuthorize:
        topology === "in-process" ||
        (mesh!.calls.get("environment.probe") === 2 &&
          mesh!.calls.get("execution.snapshot") === 2 &&
          mesh!.authorizationChecks === 4 &&
          unauthorizedProbeRejected),
      activityMerged:
        !!scene &&
        Date.parse(scene.lastActiveAt) > Date.parse(created.scene.createdAt),
    };
  } finally {
    executor?.stopStorageMaintenance();
    if (anchor && anchor !== executor) anchor.stopStorageMaintenance();
    if (previousHome === undefined) delete process.env.ZHIXING_HOME;
    else process.env.ZHIXING_HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  }
}

function createMeshEnvironmentAdapters(input: {
  probe: WorkspaceProbePort;
  publisher: {
    currentCapability(): ReturnType<
      Awaited<ReturnType<typeof setupAuthorityRuntime>>["currentExecutorSnapshot"]
    >;
    installPermission(
      snapshot: Parameters<
        Awaited<ReturnType<typeof setupAuthorityRuntime>>["installPermissionSnapshot"]
      >[0],
    ): ReturnType<
      Awaited<ReturnType<typeof setupAuthorityRuntime>>["installPermissionSnapshot"]
    >;
  };
  executorVerifier: ProtocolSignatureVerifier,
  ownerVerifier: ProtocolSignatureVerifier,
  ownerDeviceId: string,
}) {
  const definitions = new Map<string, MeshServiceDefinition>();
  const calls = new Map<string, number>();
  let authorizationChecks = 0;
  const registry = {
    register(serviceId: string, definition: MeshServiceDefinition) {
      definitions.set(serviceId, definition);
      return () => definitions.delete(serviceId);
    },
  } as MeshServiceRegistry;
  registerEnvironmentProbeMeshService(
    registry,
    input.probe,
    input.executorVerifier,
    (deviceId) => deviceId === input.ownerDeviceId,
  );
  registerExecutionSnapshotMeshService(
    registry,
    input.publisher,
    (deviceId) => deviceId === input.ownerDeviceId,
    input.executorVerifier,
  );
  const clientFor = (peerDeviceId: string): MeshServiceClient => {
    const connection = {
      peer: { deviceId: peerDeviceId, publicKey: "test-public-key" },
    } as unknown as SecureMeshConnection;
    return {
      request(serviceId, payload, signal) {
        const definition = definitions.get(serviceId);
        if (!definition) {
          throw new Error(`S7 mesh service is unavailable: ${serviceId}`);
        }
        calls.set(serviceId, (calls.get(serviceId) ?? 0) + 1);
        authorizationChecks += 1;
        if (definition.authorize && !definition.authorize(connection)) {
          throw new Error(`S7 mesh service rejected the owner: ${serviceId}`);
        }
        return definition.handler(
          payload,
          connection,
          signal ?? new AbortController().signal,
        );
      },
    };
  };
  const client = clientFor(input.ownerDeviceId);
  return {
    probe: new EnvironmentProbeMeshClient(client, input.ownerVerifier),
    unauthorizedProbe: new EnvironmentProbeMeshClient(
      clientFor("device:unauthorized"),
      input.ownerVerifier,
    ),
    snapshots: new MeshExecutionSnapshotClient(client, input.ownerVerifier),
    calls,
    get authorizationChecks() {
      return authorizationChecks;
    },
  };
}

function rootLease(
  signer: DeviceKey,
  requestId: string,
  executorId: string,
  localDomainId: string,
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
    issuedAt: NOW,
    expiry: EXPIRY,
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

  async put(ref: SecretRef, value: string) {
    this.#entries.set(secretKey(ref), value);
  }

  async get(ref: SecretRef) {
    return this.#entries.get(secretKey(ref)) ?? null;
  }

  async delete(ref: SecretRef) {
    this.#entries.delete(secretKey(ref));
  }

  async list(prefix: string) {
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

  async unlockState() {
    return "unlocked" as const;
  }
}

function secretKey(ref: SecretRef): string {
  return `${ref.kind}/${ref.bindingId}`;
}
