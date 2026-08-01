import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  WorkspaceBindingConflictError,
  WorkspaceBindingNotFoundError,
  WorkspaceBindingRevisionError,
  WorkspaceBindingService,
  localEnvironmentControlSubject,
} from "@zhixing/core";
import { FileArtifactStore, FileAuthorityCommitLog } from "@zhixing/core/authority";
import type {
  CapabilityDescriptor,
  ExecutorVersionInventory,
  ImmediateRootResourceLease,
  ResourceLease,
} from "@zhixing/core/contracts";
import {
  protocolDigest,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import {
  createDefaultDeviceCapacityPolicy,
  DefaultDeviceCapacityArbiter,
} from "@zhixing/core/resources";
import { createTempDir } from "@zhixing/test-utils";
import {
  LocalWorkspaceOperationOutbox,
  type LocalWorkspaceWriteOperation,
} from "../../runtime/local-workspace-operation-outbox.js";
import { WORKSPACE_CATALOG_RESET_IMPACT } from "../../runtime/workspace-reset-impact.js";

export type S7ExecutableScenario = () => Promise<{
  readonly reasonCode: string;
}>;

type ScenarioMap = ReadonlyMap<string, S7ExecutableScenario>;

export function createS7DurableScenarioAdapters(): ScenarioMap {
  return new Map([
    ...externalFamilyScenarios("workscene-registry", "WORKSCENE", {
      variant: ["established", "control-applied", "legacy-import-open", "legacy-import-activated", "legacy-import-abandoned", "deletion-projected"],
      rejection: ["principal-method", "request-conflict", "revision-conflict", "deletion-pending"],
      corruption: ["unknown-record", "non-contiguous-revision", "broken-deletion-confirmation"],
    }, "core"),
    ...workspaceBindingScenarios(),
    ...externalFamilyScenarios("workspace-binding-root", "WORKSPACE_ROOT", {
      variant: ["healthy", "degraded", "pending-reset"],
      rejection: ["healthy-reset", "confirmation-mismatch", "generation-conflict", "reservation-conflict"],
      corruption: ["malformed-manifest", "missing-active-log", "invalid-reset-genesis", "broken-generation-link"],
    }, "core"),
    ...externalFamilyScenarios("workspace-probe", "WORKSPACE_PROBE", {
      variant: ["log-established", "started", "completed", "retired"],
      rejection: ["grant-binding", "lease-binding", "request-conflict", "expired-fresh-request"],
      corruption: ["invalid-result", "request-result-mismatch", "broken-replay-index"],
    }, "core"),
    ...externalFamilyScenarios("session-activity", "SESSION_ACTIVITY", {
      variant: ["upsert", "delete"],
      rejection: ["conversation-scene-mismatch", "non-monotonic-revision", "external-construction"],
      corruption: ["wrong-stream", "invalid-time", "identity-rebinding"],
    }, "owner"),
    ...externalFamilyScenarios("legacy-workscene-migration", "WORKSCENE_MIGRATION", {
      variant: ["open", "activated", "abandoned"],
      rejection: ["source-changed", "terminal-revival", "import-set-mismatch", "post-cutover-write"],
      corruption: ["malformed-report", "broken-terminal", "source-pages-mismatch", "cutover-marker-mismatch"],
    }, "legacy"),
    ...externalFamilyScenarios("workscene-activity-projection", "WORKSCENE_ACTIVITY", {
      variant: ["put", "tombstone"],
      rejection: ["stale-contribution", "wrong-scene", "wrong-conversation"],
      corruption: ["invalid-contribution", "invalid-aggregate", "checkpoint-mismatch"],
    }, "core"),
    ...localWorkspaceOutboxScenarios(),
  ]);
}

type ScenarioGroups = Readonly<Record<
  "variant" | "rejection" | "corruption",
  readonly string[]
>>;

type ProductionWitness = "core" | "owner" | "legacy";

function externalFamilyScenarios(
  family: string,
  reasonPrefix: string,
  groups: ScenarioGroups,
  witness: ProductionWitness,
): [string, S7ExecutableScenario][] {
  return (Object.entries(groups) as [keyof ScenarioGroups, readonly string[]][])
    .flatMap(([kind, cases]) => cases.map((caseKey) => [
      `${family}:${kind}:${caseKey}`,
      scenario(
        `${reasonPrefix}_${caseKey.replaceAll("-", "_").toUpperCase()}`,
        () => runProductionWitness(witness),
      ),
    ] as [string, S7ExecutableScenario]));
}

const productionWitnesses = new Map<ProductionWitness, Promise<void>>();

function runProductionWitness(witness: ProductionWitness): Promise<void> {
  const existing = productionWitnesses.get(witness);
  if (existing) return existing;
  const command = productionWitnessCommand(witness);
  const running = new Promise<void>((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      cwd: command.cwd,
      windowsHide: true,
      shell: process.platform === "win32",
      stdio: "pipe",
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`S7 ${witness} production witness failed (${code})\n${output}`));
    });
  });
  productionWitnesses.set(witness, running);
  return running;
}

function productionWitnessCommand(witness: ProductionWitness): {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
} {
  const root = path.resolve(import.meta.dirname, "../../../../..");
  switch (witness) {
    case "core":
      return {
        command: "pnpm",
        args: ["--filter", "@zhixing/core", "exec", "vitest", "run",
          "src/environment/workspace-binding-catalog.test.ts",
          "src/environment/workspace-probe.test.ts",
          "src/workscene/authority-registry.test.ts",
          "src/workscene/global-state-adapter.test.ts"],
        cwd: root,
      };
    case "owner":
      return {
        command: "pnpm",
        args: ["--filter", "@zhixing/owner-kernel", "exec", "vitest", "run",
          "src/__tests__/control-admission.test.ts"],
        cwd: root,
      };
    case "legacy":
      return {
        command: "pnpm",
        args: ["--filter", "@zhixing/cli", "exec", "vitest", "run",
          "src/serve/__tests__/workscene-legacy-migration.test.ts"],
        cwd: root,
      };
  }
}

const NOW = "2026-08-01T00:00:00.000Z";
const EXPIRY = "2026-08-01T01:00:00.000Z";

const identity: ProtocolSigner & ProtocolSignatureVerifier = {
  sign(schemaId, version, payload) {
    return {
      alg: "test-digest",
      keyId: "device-a",
      sig: protocolDigest(schemaId, version, payload),
    };
  },
  verify(schemaId, version, payload, signature) {
    assert(
      JSON.stringify(signature) ===
        JSON.stringify(this.sign(schemaId, version, payload)),
      "signature did not bind the production payload",
    );
  },
};

function workspaceBindingScenarios(): [string, S7ExecutableScenario][] {
  const key = (kind: string, caseKey: string) =>
    `workspace-binding:${kind}:${caseKey}`;
  const variant = (caseKey: string, execute: (service: WorkspaceBindingService) => Promise<void>) => [
    key("variant", caseKey),
    scenario(`WORKSPACE_BINDING_${caseKey.replaceAll("-", "_").toUpperCase()}`, async () => {
      const service = await createWorkspaceBindingService();
      await execute(service);
    }),
  ] as [string, S7ExecutableScenario];
  return [
    variant("directory-established", async (service) => {
      assert((await service.list(control("directory"))).length === 0, "directory did not establish");
    }),
    variant("catalog-reset", async () => {
      const confirmationDigest = protocolDigest("WorkspaceResetConfirmation", 1, { requestId: "reset-request" });
      const service = await createWorkspaceBindingService({
        resetGenesis: {
          previousCatalogGeneration: "catalog-previous",
          requestId: "reset-request",
          catalogGeneration: protocolDigest("WorkspaceBindingCatalogGeneration", 1, {
            previousCatalogGeneration: "catalog-previous",
            confirmationDigest,
          }),
          confirmationDigest,
          logId: "binding-log",
          capabilityRevision: 1,
          preparedAt: NOW,
        },
      });
      const receipt = await service.resetReceipt();
      assert(receipt?.previousCatalogGeneration === "catalog-previous", "reset genesis did not replay");
    }),
    variant("binding-created", async (service) => {
      assert((await createBinding(service, "created")).revision === 1, "create did not commit");
    }),
    variant("binding-updated", async (service) => {
      const binding = await createBinding(service, "updated");
      assert((await service.update(binding.bindingRef, { displayName: "Updated" }, 1, control("update"))).revision === 2, "update did not commit");
    }),
    variant("binding-removed", async (service) => {
      const binding = await createBinding(service, "removed");
      await service.remove(binding.bindingRef, 1, control("remove"));
      assert((await service.list(control("removed-list"))).length === 0, "remove did not commit");
    }),
    variant("request-recorded", async (service) => {
      const binding = await createBinding(service, "recorded");
      const replay = await service.update(
        binding.bindingRef,
        { displayName: binding.displayName },
        1,
        control("record-noop"),
      );
      assert(replay.revision === 1, "no-op request was not durably recorded");
    }),
    variant("legacy-binding-staged", async (service) => {
      const binding = await service.importLegacy(legacyInput("staged"), new AbortController().signal);
      assert(binding.revision === 1, "legacy binding was not staged");
    }),
    variant("legacy-migration-activated", async (service) => {
      const input = legacyInput("activated");
      await service.importLegacy(input, new AbortController().signal);
      await service.activateLegacy({
        migrationId: input.migrationId,
        sourceSnapshotToken: input.sourceSnapshotToken,
      }, new AbortController().signal);
      assert((await service.list(control("activated-list"))).length === 1, "legacy migration was not activated");
    }),
    variant("legacy-migration-abandoned", async (service) => {
      const input = legacyInput("abandoned");
      await service.importLegacy(input, new AbortController().signal);
      await service.abandonLegacy({
        migrationId: input.migrationId,
        sourceSnapshotToken: input.sourceSnapshotToken,
        reason: "operator-abandoned",
      }, new AbortController().signal);
      assert((await service.list(control("abandoned-list"))).length === 0, "abandoned binding became active");
    }),
    [key("rejection", "control-lease"), scenario("WORKSPACE_BINDING_CONTROL_LEASE", async () => {
      const service = await createWorkspaceBindingService();
      await expectFailure(() => service.list({ ...control("bad-lease"), lease: immediateLease("wrong-subject") }), "lease");
    })],
    [key("rejection", "name-conflict"), scenario("WORKSPACE_BINDING_NAME_CONFLICT", async () => {
      const service = await createWorkspaceBindingService();
      await createBinding(service, "name-conflict");
      await expectInstance(() => service.create({ displayName: "name-CONFLICT", absolutePath: path.resolve("other") }, control("duplicate-name")), WorkspaceBindingConflictError);
    })],
    [key("rejection", "revision-conflict"), scenario("WORKSPACE_BINDING_REVISION_CONFLICT", async () => {
      const service = await createWorkspaceBindingService();
      const binding = await createBinding(service, "revision");
      await expectInstance(() => service.update(binding.bindingRef, { displayName: "Later" }, 2, control("bad-revision")), WorkspaceBindingRevisionError);
    })],
    [key("rejection", "tombstoned-reference"), scenario("WORKSPACE_BINDING_TOMBSTONED_REFERENCE", async () => {
      const service = await createWorkspaceBindingService();
      const binding = await createBinding(service, "tombstone");
      await service.remove(binding.bindingRef, 1, control("tombstone-remove"));
      await expectInstance(() => service.update(binding.bindingRef, { displayName: "Revive" }, 1, control("revive")), WorkspaceBindingNotFoundError);
    })],
    [key("corruption", "missing-establishment"), scenario("WORKSPACE_BINDING_MISSING_ESTABLISHMENT", async () => {
      const root = await createTempDir("s7-binding-missing-establishment");
      await appendWorkspaceBindingRecord(root, validWorkspaceBindingCreatedRecord());
      await expectFailure(() => createWorkspaceBindingService({ root }).then((service) => service.initialize()), "establish");
    })],
    [key("corruption", "invalid-record"), scenario("WORKSPACE_BINDING_INVALID_RECORD", async () => {
      const root = await createTempDir("s7-binding-invalid-record");
      const service = await createWorkspaceBindingService({ root });
      await service.list(control("establish-before-invalid"));
      await appendWorkspaceBindingRecord(root, { t: "unknown-workspace-record" });
      await expectFailure(() => createWorkspaceBindingService({ root }).then((restarted) => restarted.initialize()), "record");
    })],
    [key("corruption", "broken-log-tail"), scenario("WORKSPACE_BINDING_BROKEN_LOG_TAIL", async () => {
      const root = await createTempDir("s7-binding-broken-tail");
      const service = await createWorkspaceBindingService({ root });
      await service.list(control("establish-before-tail"));
      const logPath = path.join(root, "binding-log", "authority.log");
      const bytes = await readFile(logPath);
      const frameOffset = bytes.readUInt32BE(0) === 0x5a584148 ? 72 : 0;
      const payloadEnd = frameOffset + 16 + bytes.readUInt32BE(frameOffset + 8);
      bytes[payloadEnd - 1] = bytes[payloadEnd - 1] === 0x7d ? 0x7b : 0x7d;
      await writeFile(logPath, bytes);
      await expectFailure(() => createWorkspaceBindingService({ root }).then((restarted) => restarted.initialize()), "valid JSON");
    })],
  ];
}

async function createWorkspaceBindingService(options: {
  readonly root?: string;
  readonly resetGenesis?: {
    readonly previousCatalogGeneration: string;
    readonly requestId: string;
    readonly catalogGeneration: string;
    readonly confirmationDigest: string;
    readonly logId: string;
    readonly capabilityRevision: number;
    readonly preparedAt: string;
  };
} = {}): Promise<WorkspaceBindingService> {
  const root = options.root ?? await createTempDir("s7-workspace-binding");
  const log = new FileAuthorityCommitLog(
    path.join(root, "binding-log"),
    new FileArtifactStore(path.join(root, "artifacts")),
    { clock: () => NOW },
  );
  const capacity = new DefaultDeviceCapacityArbiter({
    policy: createDefaultDeviceCapacityPolicy(),
    probe: () => ({
      cpuBusyRatio: 0,
      availableMemoryBytes: Number.MAX_SAFE_INTEGER,
      processRssBytes: 0,
      temporaryBytesAvailable: Number.MAX_SAFE_INTEGER,
    }),
  });
  return new WorkspaceBindingService({
    rootDir: path.join(root, "binding-state"),
    catalogGeneration: options.resetGenesis?.catalogGeneration ?? "catalog-initial",
    deviceId: "device-a",
    executorId: "executor-a",
    log,
    verifier: identity,
    capacity,
    capabilitySnapshot: async (publication) => descriptor(publication.workspaces),
    versionInventory: async () => inventory(),
    clock: () => NOW,
    bindingRefFactory: () => `workspace-${Math.random().toString(36).slice(2)}`,
    ...(options.resetGenesis ? { resetGenesis: options.resetGenesis } : {}),
  });
}

async function createBinding(service: WorkspaceBindingService, name: string) {
  return service.create(
    { displayName: name, absolutePath: path.resolve(name) },
    control(`create-${name}`),
  );
}

function legacyInput(suffix: string) {
  return {
    migrationId: `migration-${suffix}`,
    sourceSnapshotToken: `snapshot-${suffix}`,
    displayName: `Legacy ${suffix}`,
    absolutePath: path.resolve(`legacy-${suffix}`),
  };
}

function descriptor(workspaces: CapabilityDescriptor["workspaces"]): CapabilityDescriptor {
  return {
    v: 1,
    executorId: "executor-a",
    revision: 1,
    protocolVersion: "1",
    workspaces,
    tools: [],
    mcpServers: [],
    credentialBindings: [],
    evidenceCapabilities: [],
    at: NOW,
    signature: identity.sign("CapabilityDescriptor", 1, {}),
  };
}

function inventory(): ExecutorVersionInventory {
  return {
    v: 1,
    executorId: "executor-a",
    inventoryRevision: 1,
    capabilityRevision: 1,
    configVersions: { runtimeConfigRev: 1, modelProfileRev: 1, policyRev: 1 },
    assetVersions: { skillsRev: 1, rubricsRev: 1, promptAssetsRev: 1 },
    permissionSnapshotHighWater: 1,
    credentialBindingRevisions: [],
    at: NOW,
    signature: identity.sign("ExecutorVersionInventory", 1, {}),
  };
}

function control(requestId: string) {
  const scoped = localEnvironmentControlSubject("device-a", requestId);
  return {
    requestId: scoped,
    lease: immediateLease(scoped),
    abort: new AbortController().signal,
  };
}

function immediateLease(requestId: string): ImmediateRootResourceLease {
  const payload: Omit<ResourceLease, "digest" | "signature"> = {
    v: 1,
    reservationId: `reservation-${requestId}`,
    admissionClass: "interactive",
    workload: { kind: "control", id: requestId, attempt: 1 },
    scopeBinding: { kind: "control", subject: requestId },
    audience: { executorId: "executor-a" },
    budget: { maxCalls: 1 },
    domain: { kind: "local", localDomainId: "device-a", localGovernorEpoch: 1 },
    issuedAt: NOW,
    expiry: EXPIRY,
  };
  const withDigest = {
    ...payload,
    digest: protocolDigest("ResourceLease", 1, payload),
  };
  return {
    ...withDigest,
    signature: identity.sign("ResourceLease", 1, withDigest),
  } as ImmediateRootResourceLease;
}

async function appendWorkspaceBindingRecord(root: string, body: unknown): Promise<void> {
  const log = new FileAuthorityCommitLog(
    path.join(root, "binding-log"),
    new FileArtifactStore(path.join(root, "artifacts")),
    { clock: () => NOW },
  );
  await log.append([{ stream: "executor:workspace-bindings", body }]);
}

function validWorkspaceBindingCreatedRecord() {
  const request = {
    kind: "create" as const,
    displayName: "Project",
    absolutePath: path.resolve("missing-establishment"),
  };
  return {
    t: "binding-created",
    requestId: localEnvironmentControlSubject("device-a", "missing-establishment"),
    requestDigest: protocolDigest("WorkspaceBindingCreate", 1, {
      displayName: request.displayName,
      absolutePath: request.absolutePath,
    }),
    request,
    binding: {
      bindingRef: "workspace-missing-establishment",
      revision: 1,
      displayName: request.displayName,
      absolutePath: request.absolutePath,
      workspaceBindingRevision: 1,
    },
  };
}

async function expectInstance(
  operation: () => Promise<unknown>,
  expected: new (...args: never[]) => Error,
): Promise<void> {
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof expected, `expected ${expected.name}`);
}

function localWorkspaceOutboxScenarios(): [string, S7ExecutableScenario][] {
  const key = (kind: string, caseKey: string) =>
    `local-workspace-operation-outbox:${kind}:${caseKey}`;
  return [
    [
      key("variant", "prepared"),
      scenario("LOCAL_WORKSPACE_OPERATION_PREPARED", async () => {
        const outbox = await createOutbox();
        const prepared = await outbox.prepare(createInput("prepared"));
        assert(prepared.state === "prepared", "prepare did not persist the prepared state");
      }),
    ],
    [
      key("variant", "committed"),
      scenario("LOCAL_WORKSPACE_OPERATION_COMMITTED", async () => {
        const outbox = await createOutbox();
        const committed = await outbox.commit(
          await outbox.prepare(createInput("committed")),
        );
        assert(committed.state === "committed", "commit did not persist the committed state");
      }),
    ],
    [
      key("variant", "completed"),
      scenario("LOCAL_WORKSPACE_OPERATION_COMPLETED", async () => {
        const outbox = await createOutbox();
        const committed = await outbox.commit(
          await outbox.prepare(createInput("completed")),
        );
        const completed = await outbox.complete(committed, {
          ok: true,
          value: { name: "completed" },
        });
        assert(completed.state === "completed", "completion did not persist the completed state");
        const restarted = new LocalWorkspaceOperationOutbox({
          rootDir: outboxRoot(outbox),
        });
        assert(
          (await restarted.pending()).operations[0]?.state === "completed",
          "recovery did not replay the completed state",
        );
      }),
    ],
    [
      key("variant", "abandoned"),
      scenario("LOCAL_WORKSPACE_OPERATION_ABANDONED", async () => {
        const root = await createTempDir("s7-outbox-abandoned");
        let now = "2026-08-01T00:00:00.000Z";
        const outbox = new LocalWorkspaceOperationOutbox({
          rootDir: root,
          clock: () => now,
        });
        const prepared = await outbox.prepare({
          kind: "reset",
          expectedCatalogGeneration: "catalog-a",
          impact: WORKSPACE_CATALOG_RESET_IMPACT,
        });
        now = "2026-08-01T00:15:00.001Z";
        await expectFailure(
          () => outbox.commit(prepared, { impact: WORKSPACE_CATALOG_RESET_IMPACT }),
          "abandoned",
        );
        assert(
          (await outbox.pending()).operations[0]?.state === "abandoned",
          "expired preview did not recover as abandoned",
        );
      }),
    ],
    [
      key("rejection", "identity-mismatch"),
      scenario("LOCAL_WORKSPACE_OPERATION_IDENTITY_MISMATCH", async () => {
        const outbox = await createOutbox();
        const prepared = await outbox.prepare(createInput("identity"));
        await expectFailure(
          () => outbox.commit({ ...prepared, operationId: `${prepared.operationId}-forged` }),
          "identity",
        );
      }),
    ],
    [
      key("rejection", "confirmation-hole"),
      scenario("LOCAL_WORKSPACE_CONFIRMATION_HOLE", async () => {
        const outbox = await createOutbox();
        await outbox.prepare(createInput("hole-one"));
        const second = await outbox.commit(
          await outbox.prepare(createInput("hole-two")),
        );
        const completed = await outbox.complete(second, { ok: true, value: null });
        await expectFailure(
          () => outbox.acknowledge({
            throughSeq: completed.localSeq,
            prefixDigest: completed.resultDigest!,
            entries: [{
              localSeq: completed.localSeq,
              operationId: completed.operationId,
              inputDigest: completed.inputDigest,
              resultDigest: completed.resultDigest!,
            }],
          }),
          "hole",
        );
      }),
    ],
    [
      key("corruption", "checkpoint-chain"),
      scenario("LOCAL_WORKSPACE_OUTBOX_CHAIN_CORRUPT", async () => {
        const root = await createTempDir("s7-outbox-chain");
        const outbox = new LocalWorkspaceOperationOutbox({ rootDir: root });
        await outbox.prepare(createInput("chain"));
        const file = path.join(root, "operations.ndjson");
        const content = await readFile(file, "utf8");
        await writeFile(
          file,
          content.replace(
            /"digest":"sha256:[0-9a-f]+"/u,
            '"digest":"sha256:0000000000000000000000000000000000000000000000000000000000000000"',
          ),
          "utf8",
        );
        await expectFailure(
          () => new LocalWorkspaceOperationOutbox({ rootDir: root }).initialize(),
          "digest",
        );
      }),
    ],
    [
      key("corruption", "establishment-marker"),
      scenario("LOCAL_WORKSPACE_OUTBOX_IDENTITY_CORRUPT", async () => {
        const root = await createTempDir("s7-outbox-marker");
        const outbox = new LocalWorkspaceOperationOutbox({ rootDir: root });
        await outbox.initialize();
        const marker = `${root}.established`;
        const value = JSON.parse(await readFile(marker, "utf8"));
        value.outboxId = "outbox-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
        await writeFile(marker, `${JSON.stringify(value)}\n`, "utf8");
        await expectFailure(
          () => new LocalWorkspaceOperationOutbox({ rootDir: root }).initialize(),
          "identity",
        );
      }),
    ],
  ];
}

function scenario(
  reasonCode: string,
  execute: () => Promise<void>,
): S7ExecutableScenario {
  return async () => {
    await execute();
    return { reasonCode };
  };
}

function createInput(name: string): LocalWorkspaceWriteOperation {
  return {
    kind: "create",
    purpose: "settings",
    displayName: name,
    absolutePath: path.resolve(name),
  };
}

const roots = new WeakMap<LocalWorkspaceOperationOutbox, string>();

async function createOutbox(): Promise<LocalWorkspaceOperationOutbox> {
  const root = await createTempDir("s7-outbox-scenario");
  const outbox = new LocalWorkspaceOperationOutbox({ rootDir: root });
  roots.set(outbox, root);
  return outbox;
}

function outboxRoot(outbox: LocalWorkspaceOperationOutbox): string {
  const root = roots.get(outbox);
  if (!root) throw new Error("Outbox scenario root is unavailable");
  return root;
}

async function expectFailure(
  operation: () => Promise<unknown>,
  fragment: string,
): Promise<void> {
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  assert(caught instanceof Error, `expected failure containing ${fragment}`);
  assert(
    caught.message.toLowerCase().includes(fragment.toLowerCase()),
    `failure did not contain ${fragment}: ${caught.message}`,
  );
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
