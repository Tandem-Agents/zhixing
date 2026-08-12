import type { DeviceLifecycleJournal } from "@zhixing/core/authority";
import {
  protocolDigest,
  type DeviceLifecycleEvidenceRef,
  type DeviceLifecycleOperation,
  type StopHostGeneration,
  type StopStrategy,
} from "@zhixing/core/protocol";

export interface HostStopRuntime {
  closeAdmission(): Promise<void>;
  settleImmediate(timeoutMs: number): Promise<void>;
  drainAcceptedWork(timeoutMs: number): Promise<void>;
  cancelAcceptedWork(timeoutMs: number): Promise<void>;
  flushDurableState(): Promise<readonly DeviceLifecycleEvidenceRef[]>;
  settlePhysicalSteps(): Promise<void>;
}

export interface HostStopCoordinatorOptions {
  readonly journal: DeviceLifecycleJournal;
  readonly homeId: string;
  readonly host: StopHostGeneration;
  readonly runtime: HostStopRuntime;
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
      if (canonicalHost(operation.identity.host) === canonicalHost(this.options.host)) {
        resumed.push(await this.#resume(operation, 30_000));
        continue;
      }
      if (
        operation.phase === "ready-to-stop" &&
        await this.options.isHostStopped?.(operation.identity.host)
      ) {
        resumed.push(await this.options.journal.terminal(
          operation.identity.operationId,
          "stopped",
          [{
            kind: "supervisor",
            digest: protocolDigest("StoppedHostReadBack", 1, operation.identity.host),
          }],
        ));
      }
    }
    return resumed;
  }

  async #resume(
    initial: DeviceLifecycleOperation,
    timeoutMs: number,
  ): Promise<DeviceLifecycleOperation> {
    let state = initial;
    if (state.phase === "accepted") {
      await this.options.runtime.closeAdmission();
      state = await this.options.journal.advance(state.identity.operationId, "gate-closed");
    }
    if (state.phase === "gate-closed") {
      if (state.identity.kind !== "stop") throw new Error("Stop journal identity changed");
      if (state.identity.strategy === "cancel") {
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
}

function canonicalHost(host: StopHostGeneration): string {
  return JSON.stringify(host, Object.keys(host).sort());
}
