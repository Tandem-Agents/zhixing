import { Buffer } from "node:buffer";
import type { ArtifactStore, DeviceLifecycleJournal } from "@zhixing/core/authority";
import type { DeliveryLifecycleSourcePermit } from "@zhixing/core/delivery";
import {
  canonicalize,
  protocolDigest,
  type DeviceLifecycleEvidenceRef,
  type DeviceLifecycleOperation,
  type StopHostGeneration,
  type StopStrategy,
} from "@zhixing/core/protocol";

export const HOST_STOP_ACCEPTED_WORK_OWNERS = [
  "conversation",
  "intent",
  "final",
  "assignment",
  "remote",
  "channel",
  "scheduler",
  "delivery",
  "lease",
  "permit",
] as const;

export type HostStopAcceptedWorkOwner = typeof HOST_STOP_ACCEPTED_WORK_OWNERS[number];

export interface HostStopAcceptedWorkItem {
  readonly id: string;
  readonly revision: string;
}

export interface HostStopAcceptedWorkPort {
  freeze(operationId: string): Promise<readonly HostStopAcceptedWorkItem[]>;
  settle(input: {
    readonly operationId: string;
    readonly strategy: StopStrategy;
    readonly timeoutMs: number;
    readonly frozen: readonly HostStopAcceptedWorkItem[];
  }): Promise<void>;
  readBack(input: {
    readonly operationId: string;
    readonly strategy: StopStrategy;
    readonly frozen: readonly HostStopAcceptedWorkItem[];
  }): Promise<void>;
}

export type HostStopAcceptedWorkPorts = Readonly<
  Record<HostStopAcceptedWorkOwner, HostStopAcceptedWorkPort>
>;

export interface HostStopAcceptedWorkSnapshot {
  readonly v: 1;
  readonly operationId: string;
  readonly owners: Readonly<Record<HostStopAcceptedWorkOwner, readonly HostStopAcceptedWorkItem[]>>;
}

export interface HostStopRuntime {
  closeAdmission(operationId: string): Promise<void>;
  settleImmediate(timeoutMs: number): Promise<void>;
  drainAcceptedWork(timeoutMs: number): Promise<void>;
  cancelAcceptedWork(timeoutMs: number): Promise<void>;
  flushDurableState(): Promise<readonly DeviceLifecycleEvidenceRef[]>;
  settlePhysicalSteps(): Promise<void>;
}

export interface HostStopCoordinatorOptions {
  readonly journal: DeviceLifecycleJournal;
  readonly homeId: string;
  readonly localDeviceId: string;
  readonly host: StopHostGeneration;
  readonly runtime: HostStopRuntime;
  readonly acceptedWork?: HostStopAcceptedWorkPorts;
  readonly artifactStore?: ArtifactStore;
  readonly onAcceptedWorkFrozen?: (
    snapshot: HostStopAcceptedWorkSnapshot,
  ) => void | Promise<void>;
  readonly isHostStopped?: (host: StopHostGeneration) => Promise<boolean>;
}

export class HostStopCoordinator {
  constructor(private readonly options: HostStopCoordinatorOptions) {}

  async prepare(input: {
    readonly requestId: string;
    readonly reason: string;
    readonly strategy: StopStrategy;
    readonly timeoutMs: number;
  }): Promise<{
    readonly requestId: string;
    readonly phase: "ready-to-stop";
    readonly strategy: StopStrategy;
  }> {
    const operationId = protocolDigest("HostStopOperation", 1, {
      requestId: input.requestId,
      homeId: this.options.homeId,
    });
    let state = await this.options.journal.accept({
      v: 1,
      kind: "stop",
      requestId: input.requestId,
      operationId,
      homeId: this.options.homeId,
      localDeviceId: this.options.localDeviceId,
      strategy: input.strategy,
      host: this.options.host,
    });
    state = await this.#resume(state, input.timeoutMs);
    if (state.phase !== "ready-to-stop") {
      throw new Error("Stop operation did not reach a durable safe point");
    }
    return { requestId: input.requestId, phase: "ready-to-stop", strategy: input.strategy };
  }

  async resumeActive(): Promise<readonly DeviceLifecycleOperation[]> {
    const operations = await this.options.journal.active();
    const resumed: DeviceLifecycleOperation[] = [];
    for (const operation of operations) {
      if (operation.identity.kind !== "stop") continue;
      if (operation.identity.homeId !== this.options.homeId) continue;
      if (operation.identity.localDeviceId !== this.options.localDeviceId) continue;
      if (canonicalHost(operation.identity.host) === canonicalHost(this.options.host)) {
        resumed.push(await this.#resume(operation, 30_000));
        continue;
      }
      if (!await this.options.isHostStopped?.(operation.identity.host)) continue;
      const ready = await this.#resume(operation, 30_000);
      if (ready.phase !== "ready-to-stop") {
        throw new Error("Recovered stop operation did not reach a durable safe point");
      }
      resumed.push(await this.options.journal.terminal(
        operation.identity.operationId,
        "stopped",
        [{
          kind: "supervisor",
          digest: protocolDigest("StoppedHostReadBack", 1, operation.identity.host),
        }],
      ));
    }
    return resumed;
  }

  async #resume(
    initial: DeviceLifecycleOperation,
    timeoutMs: number,
  ): Promise<DeviceLifecycleOperation> {
    let state = initial;
    if (state.phase === "accepted") {
      await this.options.runtime.closeAdmission(state.identity.operationId);
      const evidence = this.options.acceptedWork
        ? [await this.#freezeAcceptedWork(state.identity.operationId)]
        : [];
      state = await this.options.journal.advance(state.identity.operationId, "gate-closed", evidence);
    }
    if (state.phase === "gate-closed") {
      if (state.identity.kind !== "stop") throw new Error("Stop journal identity changed");
      if (this.options.acceptedWork) {
        if (!this.options.artifactStore) {
          throw new Error("Accepted-work closure requires the lifecycle artifact store");
        }
        const snapshot = await loadHostStopAcceptedWork(
          state,
          this.options.artifactStore,
        );
        await this.options.onAcceptedWorkFrozen?.(snapshot);
        await settleHostStopAcceptedWork({
          operationId: state.identity.operationId,
          strategy: state.identity.strategy,
          timeoutMs,
          snapshot,
          ports: this.options.acceptedWork,
        });
      } else if (state.identity.strategy === "cancel") {
        await this.options.runtime.cancelAcceptedWork(timeoutMs);
        await this.options.runtime.drainAcceptedWork(timeoutMs);
      } else if (state.identity.strategy === "drain") {
        await this.options.runtime.drainAcceptedWork(timeoutMs);
      } else {
        await this.options.runtime.settleImmediate(timeoutMs);
      }
      state = await this.options.journal.advance(state.identity.operationId, "work-settled", [{
        kind: "accepted-work",
        digest: protocolDigest("HostStopAcceptedWork", 1, {
          operationId: state.identity.operationId,
          strategy: state.identity.strategy,
          snapshot: state.evidence.find((item) => item.kind === "accepted-work")?.digest ?? null,
        }),
      }]);
    }
    if (state.phase === "work-settled") {
      const evidence = await this.options.runtime.flushDurableState();
      state = await this.options.journal.advance(state.identity.operationId, "flushed", evidence);
    }
    if (state.phase === "flushed") {
      await this.options.runtime.settlePhysicalSteps();
      state = await this.options.journal.advance(state.identity.operationId, "ready-to-stop");
    }
    return state;
  }

  async #freezeAcceptedWork(operationId: string): Promise<DeviceLifecycleEvidenceRef> {
    if (!this.options.acceptedWork || !this.options.artifactStore) {
      throw new Error("Accepted-work closure requires the lifecycle artifact store");
    }
    const frozen = await freezeHostStopAcceptedWork(
      operationId,
      this.options.acceptedWork,
      this.options.artifactStore,
    );
    return frozen.evidence;
  }
}

export function hostStopAlreadySettled(
  phase: DeviceLifecycleOperation["phase"],
): boolean {
  return phase === "work-settled" || phase === "flushed" || phase === "ready-to-stop";
}

export function hostStopDeliveryLifecycleSources(
  snapshot: HostStopAcceptedWorkSnapshot,
): readonly DeliveryLifecycleSourcePermit[] {
  const sources = new Map<string, DeliveryLifecycleSourcePermit>();
  for (const [owner, items] of Object.entries(snapshot.owners)) {
    for (const item of items) {
      const source = owner === "conversation"
        ? {
            owner: "conversation" as const,
            id: item.id,
            revision: protocolDigest("ConversationDeliveryLifecycleSource", 1, {
              conversationId: item.id,
            }),
          }
        : owner === "final"
          ? { owner: "conversation" as const, id: item.id, revision: item.revision }
          : owner === "assignment" ||
              (owner === "remote" && (item.id.startsWith("relay:") || item.id.startsWith("local:")))
            ? { owner: "assignment" as const, id: item.id, revision: item.revision }
            : owner === "scheduler"
              ? { owner: "scheduler" as const, id: item.id, revision: item.revision }
              : undefined;
      if (!source) continue;
      const key = `${source.owner}\u0000${source.id}`;
      const previous = sources.get(key);
      if (previous && previous.revision !== source.revision) {
        throw new Error("Lifecycle accepted-work contains conflicting delivery source revisions");
      }
      sources.set(key, Object.freeze(source));
    }
  }
  return Object.freeze([...sources.values()].sort((left, right) =>
    `${left.owner}:${left.id}`.localeCompare(`${right.owner}:${right.id}`, "en-US")));
}

export async function freezeHostStopAcceptedWork(
  operationId: string,
  ports: HostStopAcceptedWorkPorts,
  artifactStore: ArtifactStore,
): Promise<{
  readonly snapshot: HostStopAcceptedWorkSnapshot;
  readonly evidence: DeviceLifecycleEvidenceRef;
}> {
  const owners = {} as Record<HostStopAcceptedWorkOwner, readonly HostStopAcceptedWorkItem[]>;
  for (const owner of HOST_STOP_ACCEPTED_WORK_OWNERS) {
    const items = [...await ports[owner].freeze(operationId)]
      .sort((left, right) => left.id.localeCompare(right.id));
    assertAcceptedWorkItems(owner, items);
    owners[owner] = Object.freeze(items);
  }
  const snapshot: HostStopAcceptedWorkSnapshot = Object.freeze({
    v: 1,
    operationId,
    owners: Object.freeze(owners),
  });
  const artifact = await artifactStore.put(Buffer.from(canonicalize(snapshot), "utf8"));
  return Object.freeze({
    snapshot,
    evidence: { kind: "accepted-work", digest: artifact.digest, artifact },
  });
}

export async function loadHostStopAcceptedWork(
  state: DeviceLifecycleOperation,
  artifactStore: ArtifactStore,
): Promise<HostStopAcceptedWorkSnapshot> {
  const evidence = state.evidence.filter((item) => item.kind === "accepted-work" && item.artifact);
  if (evidence.length !== 1 || !evidence[0]?.artifact) {
    throw new Error("Stop operation is missing its frozen accepted-work snapshot");
  }
  const bytes = await artifactStore.get(evidence[0].artifact);
  let parsed: unknown;
  try {
    const text = Buffer.from(bytes).toString("utf8");
    parsed = JSON.parse(text);
    if (canonicalize(parsed) !== text) throw new TypeError("snapshot is not canonical");
  } catch (error) {
    throw new Error("Stop accepted-work snapshot is corrupt", { cause: error });
  }
  return validateAcceptedWorkSnapshot(parsed, state.identity.operationId);
}

export async function settleHostStopAcceptedWork(input: {
  readonly operationId: string;
  readonly strategy: StopStrategy;
  readonly timeoutMs: number;
  readonly snapshot: HostStopAcceptedWorkSnapshot;
  readonly ports: HostStopAcceptedWorkPorts;
}): Promise<void> {
  for (const owner of HOST_STOP_ACCEPTED_WORK_OWNERS) {
    const port = input.ports[owner];
    const frozen = input.snapshot.owners[owner];
    await port.settle({
      operationId: input.operationId,
      strategy: input.strategy,
      timeoutMs: input.timeoutMs,
      frozen,
    });
    await port.readBack({
      operationId: input.operationId,
      strategy: input.strategy,
      frozen,
    });
  }
}

function canonicalHost(host: StopHostGeneration): string {
  return canonicalize(host);
}

function validateAcceptedWorkSnapshot(
  input: unknown,
  operationId: string,
): HostStopAcceptedWorkSnapshot {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Stop accepted-work snapshot must be an object");
  }
  const value = input as Record<string, unknown>;
  if (canonicalize(Object.keys(value).sort()) !== canonicalize(["operationId", "owners", "v"])) {
    throw new TypeError("Stop accepted-work snapshot fields are invalid");
  }
  if (value.v !== 1 || value.operationId !== operationId || !value.owners || typeof value.owners !== "object" || Array.isArray(value.owners)) {
    throw new TypeError("Stop accepted-work snapshot identity is invalid");
  }
  const rawOwners = value.owners as Record<string, unknown>;
  if (canonicalize(Object.keys(rawOwners).sort()) !== canonicalize([...HOST_STOP_ACCEPTED_WORK_OWNERS].sort())) {
    throw new TypeError("Stop accepted-work owner exact-set is invalid");
  }
  const owners = {} as Record<HostStopAcceptedWorkOwner, readonly HostStopAcceptedWorkItem[]>;
  for (const owner of HOST_STOP_ACCEPTED_WORK_OWNERS) {
    const raw = rawOwners[owner];
    if (!Array.isArray(raw)) throw new TypeError(`Stop accepted-work ${owner} must be an array`);
    const items = raw.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new TypeError(`Stop accepted-work ${owner} item must be an object`);
      }
      const entry = item as Record<string, unknown>;
      if (canonicalize(Object.keys(entry).sort()) !== canonicalize(["id", "revision"])) {
        throw new TypeError(`Stop accepted-work ${owner} item fields are invalid`);
      }
      return { id: entry.id, revision: entry.revision } as HostStopAcceptedWorkItem;
    });
    assertAcceptedWorkItems(owner, items);
    owners[owner] = Object.freeze(items);
  }
  return Object.freeze({ v: 1, operationId, owners: Object.freeze(owners) });
}

function assertAcceptedWorkItems(
  owner: HostStopAcceptedWorkOwner,
  items: readonly HostStopAcceptedWorkItem[],
): void {
  if (items.length > 10_000) throw new TypeError(`Stop accepted-work ${owner} exceeds the bounded snapshot`);
  const seen = new Set<string>();
  for (const item of items) {
    if (typeof item.id !== "string" || item.id.length === 0 || item.id.length > 512) {
      throw new TypeError(`Stop accepted-work ${owner} id is invalid`);
    }
    if (typeof item.revision !== "string" || item.revision.length === 0 || item.revision.length > 512) {
      throw new TypeError(`Stop accepted-work ${owner} revision is invalid`);
    }
    if (seen.has(item.id)) throw new TypeError(`Stop accepted-work ${owner} contains a duplicate id`);
    seen.add(item.id);
  }
}
