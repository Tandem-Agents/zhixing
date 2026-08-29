import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ownsCurrentSuccessorEndpoint } from "./startup-server-owner.js";

describe("production startup server ownership", () => {
  it("requires PID, old port, current port and the live handle to agree", () => {
    const owner = { ownsEndpoint: (port: number) => port === 3210 };
    const current = endpoint(41, 3210);

    expect(ownsCurrentSuccessorEndpoint(owner, endpoint(41, 3210), current, 41)).toBe(true);
    expect(ownsCurrentSuccessorEndpoint(owner, endpoint(41, 3211), current, 41)).toBe(false);
    expect(ownsCurrentSuccessorEndpoint(owner, endpoint(42, 3210), current, 41)).toBe(false);
    expect(ownsCurrentSuccessorEndpoint({ ownsEndpoint: () => false }, current, current, 41))
      .toBe(false);
  });

  it("keeps the anchor endpoint inactive until every open prerequisite has one cleanup owner", async () => {
    const source = await readSource("command.ts");
    const surfaces = await readSource("access-surfaces.ts");
    const bind = location(source, "const serverBinding = await bindServer");
    expect(bind).toBeLessThan(location(source, "await setupAssemblyUnits(assemblyUnits, ctx, \"pre-server\")"));
    expect(bind).toBeLessThan(location(source, "const stopResume = await stopCoordinator.resumeActive()"));
    const activation = source.slice(location(source, "runner = await runServer"));
    expect(activation).toContain("boundServer: serverBinding");
    expect(activation).toContain("config: { ...DEFAULT_SERVER_CONFIG, port, host }");
    expect(activation).toContain("lifecycleOwner: hostShellLifecycle");
    const shell = source.slice(
      location(source, "const hostShellLifecycle = new AnchorHostShellLifecycle({"),
      location(source, "const serverLogLifecycle = isBackground"),
    );
    expect(shell).toContain("startTime: processStartTime");
    expect(shell).toContain("startedAt: processStartedAt");
    const gate = location(activation, "beforeActivate: async (openingRunner) =>");
    const shellOwner = location(
      activation,
      "hostShellLifecycle.assertActivationOwnership({",
    );
    const delivery = location(activation, "ctx.deliveryStack?.activate()");
    const scheduler = location(activation, "schedulerRuntime?.activate()");
    const foundationTransfer = location(
      activation,
      'lifecycleContributions.transferTo(registry, "foundation")',
    );
    const surfaceTransfer = location(
      activation,
      'lifecycleContributions.transferTo(registry, "surface")',
    );
    const contribution = location(
      activation,
      'await setupAssemblyUnits(assemblyUnits, ctx, "post-server")',
    );
    const postServerTransfer = location(
      activation,
      'lifecycleContributions.transferExactTo(\n        registry,\n        "post-server",',
    );
    const runtimeTransfer = location(
      activation,
      'lifecycleContributions.transferTo(registry, "runtime")',
    );
    const activationTransfer = location(
      activation,
      'lifecycleContributions.transferExactTo(registry, "activation", [',
    );
    const transferComplete = location(
      activation,
      "lifecycleContributions.assertTransferred()",
    );
    const cleanupCommit = location(activation, "startupRollback.commit()");
    const activeEndpoint = location(
      activation,
      "hostShellLifecycle.assertActiveEndpoint(openingServer)",
    );
    const publish = location(activation, "publishReady: async (openingRunner) =>");
    const ready = location(activation, "await hostShellLifecycle.markReady({");
    for (const prerequisite of [
      shellOwner,
      delivery,
      scheduler,
      foundationTransfer,
      surfaceTransfer,
      contribution,
      cleanupCommit,
    ]) {
      expect(prerequisite).toBeGreaterThan(gate);
      expect(prerequisite).toBeLessThan(publish);
    }
    expect(foundationTransfer).toBeLessThan(surfaceTransfer);
    expect(activeEndpoint).toBeGreaterThan(cleanupCommit);
    expect(activeEndpoint).toBeLessThan(publish);
    expect(postServerTransfer).toBeGreaterThan(contribution);
    expect(runtimeTransfer).toBeGreaterThan(postServerTransfer);
    expect(activationTransfer).toBeGreaterThan(runtimeTransfer);
    expect(transferComplete).toBeGreaterThan(activationTransfer);
    expect(cleanupCommit).toBeGreaterThan(transferComplete);
    expect(source).not.toContain("startupCleanups");
    expect(source).not.toContain("AssemblyStartupCleanups");
    expect(source).not.toContain("cleanup: registry");
    expect(source).not.toContain("registerCoreCleanup");
    expect(source).not.toContain("registerTailCleanup");
    expect(source).not.toContain("shutdown-chain.js");
    for (const directOwner of [
      'id: "serverLogLifecycle.stop"',
      'id: "authorityCheckpointOwner.stop"',
      'id: "server.close"',
      'id: "stateFile.markStopping"',
      'id: "stateFile.markStopped"',
      'id: "releaseLock"',
    ]) {
      expect(source).not.toContain(directOwner);
    }
    for (const identity of [
      "execution.abortAllAndWait",
      "conversationProtocol.stopRecovery",
      "scheduler.stop",
      "inboundRouter.refuseNew",
      "evidenceHandler.stopAccepting",
    ]) {
      expect(source).not.toContain(`id: "${identity}"`);
    }
    expect(surfaces).not.toContain("registerCleanup(");
    expect(location(surfaces, '"evidenceHandler.stopAccepting",'))
      .toBeGreaterThan(location(surfaces, "const evidenceHandler = new ExecutorEvidenceHandler({"));
    expect(location(surfaces, '"execution.abortAllAndWait",'))
      .toBeGreaterThan(location(surfaces, "manager = new ConversationManager("));
    expect(location(surfaces, '"inboundRouter.refuseNew",'))
      .toBeGreaterThan(location(surfaces, "const router = result.router;"));
    expect(location(surfaces, '"confirmationBridge.dispose",'))
      .toBeGreaterThan(location(surfaces, "const confirmationBridge = createConfirmationBridge({"));
    expect(location(surfaces, '"conversationProtocol.stopRecovery",'))
      .toBeLessThan(location(surfaces, "protocol.startRecoveryLoop();"));
    const schedulerHandle = location(source, "schedulerCleanup = startupRollback.register(");
    const schedulerContribution = location(
      source,
      'lifecycleContributions.contribute("scheduler.stop", schedulerCleanup)',
    );
    expect(schedulerContribution).toBeGreaterThan(schedulerHandle);
    expect(schedulerContribution).toBeLessThan(
      location(source, "await installSchedulerGeneration(schedulerRuntime, false)"),
    );
    expect(ready).toBeGreaterThan(publish);
    expect(location(source, "await runner.waitForShutdown()"))
      .toBeGreaterThan(location(source, "runner = await runServer"));
  });

  it("keeps the executor endpoint inactive through stop ownership and final admission", async () => {
    const source = await readSource("executor-role-runtime.ts");
    const bind = location(source, "const localServerBinding = await bindServer");
    const bindingOwner = location(
      source,
      "executorServerLifecycle.acquireBinding(localServerBinding)",
    );
    expect(bindingOwner).toBeGreaterThan(bind);
    expect(bind).toBeLessThan(location(source, "await mcpHub.connectAll()"));
    expect(bind).toBeLessThan(location(source, "const interactions = new DurableConversationInteractionObserver()"));
    expect(bind).toBeLessThan(location(source, "const stopResume = await stopCoordinator.resumeActive()"));
    const activation = source.slice(location(source, "const localConversationServer = await runServer"));
    expect(activation).toContain("boundServer: localServerBinding");
    expect(activation).toContain("port: localServerPort");
    expect(activation).toContain("host: localServerHost");
    expect(activation).toContain("startTime: processStartTime");
    expect(activation).toContain("startedAt: processStartedAt");
    const gate = location(activation, "beforeActivate: async (openingRunner) =>");
    const endpointTransfer = location(
      activation,
      "executorServerLifecycle.transferToRunningServer(openingRunner)",
    );
    const stopOwner = location(
      activation,
      "executorInternalStop.current = createExecutorInternalStopPort({",
    );
    const trustBinding = location(activation, "coordinateRuntimeTrustTransition = async () =>");
    const admission = location(activation, "await onTrustApplied();");
    const publish = location(activation, "publishReady: async (openingRunner) =>");
    const ready = location(activation, "await executorServerLifecycle.markReady({");
    const running = location(activation, "await executorServerLifecycle.markRunning();");
    for (const prerequisite of [endpointTransfer, stopOwner, trustBinding, admission]) {
      expect(prerequisite).toBeGreaterThan(gate);
      expect(prerequisite).toBeLessThan(publish);
    }
    expect(endpointTransfer).toBeLessThan(stopOwner);
    expect(activation).toContain("shutdown: (reason) => openingRunner.shutdown(reason)");
    expect(activation).toContain("waitForShutdown: () => openingRunner.waitForShutdown()");
    expect(ready).toBeGreaterThan(publish);
    expect(running).toBeGreaterThan(ready);
    expect(location(activation, "executorServerLifecycle.assertRunningServer(localConversationServer)"))
      .toBeGreaterThan(running);
    expect(location(activation, "executorServerLifecycle.startHeartbeat()"))
      .toBeGreaterThan(running);
    expect(source.indexOf("executorInternalStop.current = createExecutorInternalStopPort({"))
      .toBe(source.lastIndexOf("executorInternalStop.current = createExecutorInternalStopPort({"));
    expect(source.indexOf("await onTrustApplied();")).toBe(source.lastIndexOf("await onTrustApplied();"));
    expect(source.match(/executorRoleLifecycle\.acquire\(/gu)).toHaveLength(6);
    expect(source.match(/executorRoleLifecycle\.authorityStartupRollback\(\)/gu))
      .toHaveLength(1);
    expect(source.match(/executorRoleLifecycle\.adoptAuthority\(/gu)).toHaveLength(1);
    expect(source.match(/executorRoleLifecycle\.seal\(\)/gu)).toHaveLength(1);
    expect(source.match(/await executorRoleLifecycle\.close\(\)/gu)).toHaveLength(1);
    expect(location(source, 'executorRoleLifecycle.acquire("mcpHub.dispose"'))
      .toBeLessThan(location(source, "await mcpHub.connectAll()"));
    const meshConstruction = location(source, "mesh = new MeshRuntimeAssembly({");
    const jobLifecycleConstruction = location(
      source,
      "const jobOwnerLifecycle = new ExecutorJobOwnerLifecycle(",
    );
    const jobLifecycleContribution = location(
      source,
      'executorRoleLifecycle.acquire(\n      "executorJobOwnerLifecycle.close",',
    );
    const firstAwaitAfterMesh = source.indexOf("await ", meshConstruction);
    expect(jobLifecycleConstruction).toBeGreaterThan(meshConstruction);
    expect(jobLifecycleContribution).toBeGreaterThan(jobLifecycleConstruction);
    expect(jobLifecycleContribution).toBeLessThan(firstAwaitAfterMesh);
    expect(firstAwaitAfterMesh).toBe(location(source, "await mesh.bindDeviceRemovalLifecycle({"));
    const cleanupTail = source.slice(location(source, "const cleanupFailures: unknown[] = []"));
    for (const directCleanup of [
      "await localConversationOwner?.close()",
      "evidenceHandler?.stopAccepting()",
      "await localWorkspaceHost?.close()",
      "await jobOwnerLifecycle.close()",
      "await jobOwnerAssembly?.close()",
      "await mesh?.stop()",
      "await dataPlane?.close()",
      "await authority?.stopStorageMaintenance()",
      "await mcpHub.dispose()",
      "await localServerState?.markStopping",
      "await localConversationServer?.shutdown",
      "await localServerBinding?.close",
      "await localServerState?.markStopped",
      "await localServerState?.cleanup",
    ]) {
      expect(cleanupTail).not.toContain(directCleanup);
    }
    const serverStop = location(cleanupTail, "await executorServerLifecycle.stop()");
    const roleStop = location(cleanupTail, "await executorRoleLifecycle.close()");
    const stateCleanup = location(cleanupTail, "await executorServerLifecycle.cleanupState()");
    expect(serverStop).toBeLessThan(roleStop);
    expect(roleStop).toBeLessThan(stateCleanup);
  });

  it("keeps mesh startup recovery behind the closed lifecycle release", async () => {
    const source = await readSource("mesh-runtime-assembly.ts");
    const start = source.slice(
      location(source, "async start(options:"),
      location(source, "async stop():"),
    );
    const deferredRecovery = location(start, "if (options.recoverAcceptedWork !== false)");
    expect(deferredRecovery).toBeLessThan(
      location(start, "await this.#recoverStartupState(options.lifecycleAdmissionClosed === true)"),
    );
    expect(start).not.toContain("restoreLocalAdmissionGate()");

    const resume = source.slice(location(source, "async recoverAcceptedWorkForLifecycle()"));
    expect(resume).toContain("await this.#recoverStartupState(true)");
    expect(resume).toContain("await this.#startControl()");
  });
});

async function readSource(name: string): Promise<string> {
  return readFile(new URL(`./${name}`, import.meta.url), "utf8");
}

function location(source: string, needle: string): number {
  const index = source.indexOf(needle);
  expect(index, `missing production startup marker: ${needle}`).toBeGreaterThanOrEqual(0);
  return index;
}

function endpoint(pid: number, port: number) {
  return {
    pid,
    port,
    startTime: 1,
    startedAt: "2026-08-13T00:00:00.000Z",
  };
}
