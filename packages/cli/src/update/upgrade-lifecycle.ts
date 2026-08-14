import type { ArtifactStore, DeviceLifecycleJournal } from "@zhixing/core/authority";
import {
  compareReleaseSemver,
  protocolDigest,
  validateProgramUpdateReceipt,
  type DeviceLifecycleEvidenceRef,
  type DeviceLifecycleOperation,
  type ProtocolSignatureVerifier,
  type StopHostGeneration,
} from "@zhixing/core/protocol";
import {
  freezeHostStopAcceptedWork,
  loadHostStopAcceptedWork,
  settleHostStopAcceptedWork,
  type HostStopAcceptedWorkPorts,
} from "../serve/host-stop-lifecycle.js";
import { ProgramStore } from "./program-store.js";
import { commitInstallationReceipt } from "./installation-receipt.js";

export interface ProgramUpgradeRuntime {
  closeAdmission(operationId: string): Promise<void>;
  flushDurableState(): Promise<readonly DeviceLifecycleEvidenceRef[]>;
  settlePhysicalSteps(): Promise<void>;
}

export interface ProgramUpgradeCoordinatorOptions {
  readonly journal: DeviceLifecycleJournal;
  readonly store: ProgramStore;
  readonly verifier: ProtocolSignatureVerifier;
  readonly artifactStore: ArtifactStore;
  readonly acceptedWork: HostStopAcceptedWorkPorts;
  readonly onAcceptedWorkFrozen?: (
    snapshot: Awaited<ReturnType<typeof loadHostStopAcceptedWork>>,
  ) => void | Promise<void>;
  readonly runtime: ProgramUpgradeRuntime;
  readonly homeId: string;
  readonly localDeviceId: string;
  readonly host: StopHostGeneration;
  readonly isHostStopped: (host: StopHostGeneration) => Promise<boolean>;
  readonly installationReceiptPath?: string;
  readonly onStateChanged?: () => void;
}

export type ProgramUpgradeResumeAction =
  | { readonly kind: "none" }
  | { readonly kind: "stop-current"; readonly operationId: string }
  | { readonly kind: "restart-target"; readonly operationId: string }
  | { readonly kind: "verify-current"; readonly operationId: string; readonly currentManifestDigest: string };

export class ProgramUpgradeCoordinator {
  constructor(private readonly options: ProgramUpgradeCoordinatorOptions) {}

  async prepare(input: {
    readonly requestId: string;
    readonly candidateManifestDigest: string;
    readonly timeoutMs: number;
  }): Promise<{ readonly operationId: string; readonly phase: "flushed" }> {
    const replayedOperationId = await this.#completeTerminalReceiptReplay(
      input.candidateManifestDigest,
    );
    if (replayedOperationId) {
      return { operationId: replayedOperationId, phase: "flushed" };
    }
    const joinedOperationId = await this.#joinActivePrepare(
      input.candidateManifestDigest,
      input.timeoutMs,
    );
    if (joinedOperationId) {
      return { operationId: joinedOperationId, phase: "flushed" };
    }
    const pointer = await this.options.store.loadPointer();
    if (!pointer) throw new Error("Current verified program pointer is missing");
    const current = await this.options.store.loadCurrentManifest(this.options.verifier);
    if (!current) throw new Error("Current verified release manifest is missing");
    const candidate = await this.options.store.loadStagedManifest(
      input.candidateManifestDigest,
      this.options.verifier,
    );
    const operationId = protocolDigest("ProgramUpgradeOperation", 1, {
      requestId: input.requestId,
      homeId: this.options.homeId,
      fromManifestDigest: current.digest,
      targetManifestDigest: candidate.digest,
      pointerGeneration: pointer.generation,
    });
    let operation = await this.options.journal.accept({
      v: 1,
      kind: "upgrade",
      requestId: input.requestId,
      operationId,
      homeId: this.options.homeId,
      localDeviceId: this.options.localDeviceId,
      fromReleaseVersion: current.manifest.releaseVersion,
      fromManifestDigest: current.digest,
      targetReleaseVersion: candidate.manifest.releaseVersion,
      targetManifestDigest: candidate.digest,
      stageDigest: candidate.manifest.artifact.digest,
      pointerGeneration: pointer.generation,
      host: this.options.host,
    });
    this.options.onStateChanged?.();
    operation = await this.#settle(operation, input.timeoutMs);
    if (operation.phase !== "flushed") throw new Error("Program upgrade did not reach its durable handoff");
    await this.options.store.writeReceipt(validateProgramUpdateReceipt({
      v: 1,
      currentManifestDigest: current.digest,
      target: this.options.store.target,
      candidateManifestDigest: candidate.digest,
      phase: "handed-off",
      operationId,
      notice: "none",
    }));
    return { operationId, phase: "flushed" };
  }

  async resumeBeforeStartup(timeoutMs = 30_000): Promise<ProgramUpgradeResumeAction> {
    const active = (await this.options.journal.active()).filter((operation) =>
      operation.identity.kind === "upgrade" &&
      operation.identity.homeId === this.options.homeId &&
      operation.identity.localDeviceId === this.options.localDeviceId);
    if (active.length === 0) {
      await this.#completeTerminalReceiptReplay();
      return { kind: "none" };
    }
    if (active.length !== 1) throw new Error("More than one local program upgrade is active");
    let operation = active[0]!;
    if (operation.identity.kind !== "upgrade") throw new Error("Program upgrade identity changed");
    const identity = operation.identity;
    if (operation.phase === "accepted" || operation.phase === "gate-closed" || operation.phase === "work-settled") {
      if (!sameHost(identity.host, this.options.host) && !await this.options.isHostStopped(identity.host)) {
        throw new Error("Previous program host has not stopped");
      }
      operation = await this.#settle(operation, timeoutMs);
      return { kind: "stop-current", operationId: operation.identity.operationId };
    }
    if (operation.phase === "flushed") {
      if (!sameHost(identity.host, this.options.host) && !await this.options.isHostStopped(identity.host)) {
        throw new Error("Previous program host has not stopped");
      }
      operation = await this.options.journal.advance(operation.identity.operationId, "old-host-stopped", [{
        kind: "supervisor",
        digest: protocolDigest("ProgramUpgradeOldHostStopped", 1, identity.host),
      }]);
      this.options.onStateChanged?.();
    }
    if (operation.phase === "old-host-stopped") {
      const staged = await this.options.store.loadAcceptedManifest(identity.targetManifestDigest, this.options.verifier);
      await this.options.store.activateStaged(staged.manifest, staged.digest, {
        sourceManifestDigest: identity.fromManifestDigest,
        pointerGeneration: identity.pointerGeneration,
      });
      operation = await this.options.journal.advance(operation.identity.operationId, "pointer-switched", [{
        kind: "release",
        digest: identity.targetManifestDigest,
      }]);
      this.options.onStateChanged?.();
      return { kind: "restart-target", operationId: operation.identity.operationId };
    }
    if (operation.phase === "pointer-switched") {
      const pointer = await this.options.store.loadPointer();
      const currentManifestDigest = pointer?.current.manifestDigest;
      if (currentManifestDigest !== identity.targetManifestDigest &&
          currentManifestDigest !== identity.fromManifestDigest) {
        throw new Error("Program pointer does not match the accepted upgrade or recovery");
      }
      return {
        kind: "verify-current",
        operationId: operation.identity.operationId,
        currentManifestDigest,
      };
    }
    if (operation.phase === "health-verified") {
      const pointer = await this.options.store.loadPointer();
      const outcome = pointer?.current.manifestDigest === identity.fromManifestDigest
        ? "rolled-back"
        : terminalOutcome(operation);
      await this.options.journal.terminal(
        operation.identity.operationId,
        outcome,
        operation.evidence.filter((item) => item.kind === "health"),
      );
      this.options.onStateChanged?.();
      await this.#writeTerminalReceipt(operation, outcome);
      return { kind: "none" };
    }
    return { kind: "none" };
  }

  async advanceAfterCurrentHostStopped(endpointInactive: boolean): Promise<boolean> {
    if (!endpointInactive) throw new Error("Current program host endpoint is still active");
    const active = (await this.options.journal.active()).filter((operation) =>
      operation.identity.kind === "upgrade" &&
      operation.identity.homeId === this.options.homeId &&
      operation.identity.localDeviceId === this.options.localDeviceId);
    if (active.length === 0) return false;
    if (active.length !== 1 || active[0]!.phase !== "flushed") return false;
    let action: ProgramUpgradeResumeAction;
    try {
      action = await this.resumeBeforeStartup();
    } catch (error) {
      const readBack = (await this.options.journal.active()).find((operation) =>
        operation.identity.kind === "upgrade" &&
        operation.identity.operationId === active[0]!.identity.operationId);
      if (!readBack || readBack.phase === "flushed") throw error;
      action = await this.resumeBeforeStartup();
    }
    if (action.kind !== "restart-target" && action.kind !== "verify-current") {
      throw new Error("Stopped program host did not advance its accepted upgrade");
    }
    return true;
  }

  async completeHealthy(
    operationId: string,
    manifestDigest: string,
    healthDigest = protocolDigest("ProgramUpdateHealthSnapshot", 1, { manifestDigest }),
  ): Promise<void> {
    const operation = await this.options.journal.state(operationId);
    if (!operation || operation.identity.kind !== "upgrade" || operation.phase !== "pointer-switched") {
      throw new Error("Program upgrade is not waiting for health verification");
    }
    const pointer = await this.options.store.loadPointer();
    if (pointer?.current.manifestDigest !== manifestDigest ||
        (manifestDigest !== operation.identity.targetManifestDigest &&
          manifestDigest !== operation.identity.fromManifestDigest)) {
      throw new Error("Running release does not match the accepted upgrade or recovery");
    }
    const healthy = await this.options.journal.advance(operationId, "health-verified", [{
      kind: "health",
      digest: protocolDigest("ProgramUpgradeHealth", 1, {
        operationId,
        manifestDigest,
        healthDigest,
      }),
    }]);
    this.options.onStateChanged?.();
    const outcome = manifestDigest === operation.identity.fromManifestDigest
      ? "rolled-back"
      : terminalOutcome(healthy);
    await this.options.journal.terminal(
      operationId,
      outcome,
      healthy.evidence.filter((item) => item.kind === "health"),
    );
    this.options.onStateChanged?.();
    await this.#writeTerminalReceipt(healthy, outcome);
    await this.options.store.cleanup();
  }

  async restoreCompatiblePrevious(operationId: string): Promise<void> {
    const operation = await this.options.journal.state(operationId);
    if (!operation || operation.identity.kind !== "upgrade" || operation.phase !== "pointer-switched") {
      throw new Error("Program upgrade is not eligible for compatibility recovery");
    }
    const pointer = await this.options.store.restorePrevious({
      failedManifestDigest: operation.identity.targetManifestDigest,
      sourceManifestDigest: operation.identity.fromManifestDigest,
    });
    if (pointer.current.manifestDigest !== operation.identity.fromManifestDigest) {
      throw new Error("Previous verified release does not match the upgrade source");
    }
    await this.options.store.writeReceipt(validateProgramUpdateReceipt({
      v: 1,
      currentManifestDigest: pointer.current.manifestDigest,
      target: pointer.target,
      candidateManifestDigest: operation.identity.targetManifestDigest,
      phase: "handed-off",
      operationId,
      notice: "none",
    }));
  }

  async #settle(initial: DeviceLifecycleOperation, timeoutMs: number): Promise<DeviceLifecycleOperation> {
    let operation = initial;
    if (operation.phase === "accepted") {
      await this.options.runtime.closeAdmission(operation.identity.operationId);
      const frozen = await freezeHostStopAcceptedWork(
        operation.identity.operationId,
        this.options.acceptedWork,
        this.options.artifactStore,
      );
      operation = await this.options.journal.advance(operation.identity.operationId, "gate-closed", [frozen.evidence]);
      this.options.onStateChanged?.();
    }
    if (operation.phase === "gate-closed") {
      const snapshot = await loadHostStopAcceptedWork(operation, this.options.artifactStore);
      await this.options.onAcceptedWorkFrozen?.(snapshot);
      await settleHostStopAcceptedWork({
        operationId: operation.identity.operationId,
        strategy: "drain",
        timeoutMs,
        snapshot,
        ports: this.options.acceptedWork,
      });
      operation = await this.options.journal.advance(operation.identity.operationId, "work-settled", [{
        kind: "accepted-work",
        digest: protocolDigest("ProgramUpgradeAcceptedWorkSettled", 1, snapshot),
      }]);
      this.options.onStateChanged?.();
    }
    if (operation.phase === "work-settled") {
      const evidence = await this.options.runtime.flushDurableState();
      await this.options.runtime.settlePhysicalSteps();
      operation = await this.options.journal.advance(operation.identity.operationId, "flushed", evidence);
      this.options.onStateChanged?.();
    }
    return operation;
  }

  async #writeTerminalReceipt(
    operation: DeviceLifecycleOperation,
    outcome: "upgraded" | "rolled-back",
  ): Promise<void> {
    if (operation.identity.kind !== "upgrade") throw new Error("Program upgrade identity changed");
    const current = await this.options.store.loadCurrentManifest(this.options.verifier);
    if (!current || (
      current.digest !== operation.identity.targetManifestDigest &&
      current.digest !== operation.identity.fromManifestDigest
    )) {
      throw new Error("Verified current program does not match the terminal upgrade");
    }
    if (outcome === "upgraded") {
      await commitInstallationReceipt(
        current.manifest,
        current.digest,
        this.options.installationReceiptPath,
      );
    }
    await this.options.store.writeReceipt(validateProgramUpdateReceipt({
      v: 1,
      currentManifestDigest: current.digest,
      target: this.options.store.target,
      phase: "idle",
      notice: outcome === "upgraded" ? "updated" : "restored",
    }));
  }

  async #completeTerminalReceiptReplay(
    expectedTargetManifestDigest?: string,
  ): Promise<string | undefined> {
    const receipt = await this.options.store.loadReceipt();
    let operation = receipt?.phase === "handed-off" && receipt.operationId
      ? await this.options.journal.state(receipt.operationId)
      : undefined;
    if (!operation && expectedTargetManifestDigest) {
      operation = [...await this.options.journal.operations()].reverse().find((candidate) =>
        candidate.identity.kind === "upgrade" &&
        candidate.identity.homeId === this.options.homeId &&
        candidate.identity.localDeviceId === this.options.localDeviceId &&
        candidate.identity.targetManifestDigest === expectedTargetManifestDigest &&
        candidate.phase === "terminal" &&
        candidate.terminalOutcome === "upgraded");
    }
    if (!operation || operation.identity.kind !== "upgrade" || operation.phase !== "terminal") return undefined;
    const pointer = await this.options.store.loadPointer();
    if (!pointer) throw new Error("Program pointer is missing after terminal upgrade");
    if (operation.terminalOutcome === "upgraded") {
      if (pointer.current.manifestDigest !== operation.identity.targetManifestDigest) {
        throw new Error("Terminal upgrade pointer does not match its target");
      }
      await this.#writeTerminalReceipt(operation, "upgraded");
      await this.options.store.cleanup();
      return expectedTargetManifestDigest === operation.identity.targetManifestDigest
        ? operation.identity.operationId
        : undefined;
    }
    if (operation.terminalOutcome === "rolled-back") {
      if (pointer.current.manifestDigest !== operation.identity.targetManifestDigest &&
          pointer.current.manifestDigest !== operation.identity.fromManifestDigest) {
        throw new Error("Terminal recovery pointer does not match its verified release");
      }
      await this.#writeTerminalReceipt(operation, "rolled-back");
      await this.options.store.cleanup();
    }
    return undefined;
  }

  async #joinActivePrepare(
    targetManifestDigest: string,
    timeoutMs: number,
  ): Promise<string | undefined> {
    const active = (await this.options.journal.active()).filter((operation) =>
      operation.identity.kind === "upgrade" &&
      operation.identity.homeId === this.options.homeId &&
      operation.identity.localDeviceId === this.options.localDeviceId);
    if (active.length === 0) return undefined;
    if (active.length !== 1 || active[0]!.identity.kind !== "upgrade") {
      throw new Error("More than one local program upgrade is active");
    }
    let operation = active[0]!;
    if (operation.identity.kind !== "upgrade" ||
        operation.identity.targetManifestDigest !== targetManifestDigest) {
      throw new Error("Another program update is already active");
    }
    const identity = operation.identity;
    if (operation.phase === "accepted" || operation.phase === "gate-closed" || operation.phase === "work-settled") {
      if (!sameHost(identity.host, this.options.host)) {
        throw new Error("Previous program host recovery is not complete");
      }
      operation = await this.#settle(operation, timeoutMs);
    }
    if (operation.phase === "accepted" || operation.phase === "gate-closed" || operation.phase === "work-settled") {
      throw new Error("Program upgrade did not reach its durable handoff");
    }
    await this.options.store.writeReceipt(validateProgramUpdateReceipt({
      v: 1,
      currentManifestDigest: identity.fromManifestDigest,
      target: this.options.store.target,
      candidateManifestDigest: identity.targetManifestDigest,
      phase: "handed-off",
      operationId: identity.operationId,
      notice: "none",
    }));
    return identity.operationId;
  }
}

function sameHost(left: StopHostGeneration, right: StopHostGeneration): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function terminalOutcome(
  operation: DeviceLifecycleOperation,
): "upgraded" | "rolled-back" {
  if (operation.identity.kind !== "upgrade") {
    throw new Error("Program upgrade identity changed");
  }
  return compareReleaseSemver(
    operation.identity.targetReleaseVersion,
    operation.identity.fromReleaseVersion,
  ) < 0
    ? "rolled-back"
    : "upgraded";
}
