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
    const bind = location(source, "const serverBinding = await bindServer");
    expect(bind).toBeLessThan(location(source, "await setupAssemblyUnits(assemblyUnits, ctx, \"pre-server\")"));
    expect(bind).toBeLessThan(location(source, "const stopResume = await stopCoordinator.resumeActive()"));
    const activation = source.slice(location(source, "runner = await runServer"));
    expect(activation).toContain("boundServer: serverBinding");
    expect(activation).toContain("config: { ...DEFAULT_SERVER_CONFIG, port, host }");
    expect(activation).toContain("startTime: processStartTime");
    expect(activation).toContain("startedAt: processStartedAt");
    const gate = location(activation, "beforeActivate: async (openingRunner) =>");
    const delivery = location(activation, "ctx.deliveryStack?.activate()");
    const scheduler = location(activation, "schedulerRuntime?.activate()");
    const cleanupOwner = location(activation, "registerCoreCleanup(registry, {");
    const contribution = location(
      activation,
      'await setupAssemblyUnits(assemblyUnits, ctx, "post-server")',
    );
    const runtimeTransfer = location(
      activation,
      'lifecycleContributions.transferTo(registry, "runtime")',
    );
    const transferComplete = location(
      activation,
      "lifecycleContributions.assertTransferred()",
    );
    const cleanupCommit = location(activation, "startupRollback.commit()");
    const publish = location(activation, "publishReady: async (openingRunner) =>");
    const ready = location(activation, "await stateFile.markReady({");
    for (const prerequisite of [delivery, scheduler, cleanupOwner, contribution, cleanupCommit]) {
      expect(prerequisite).toBeGreaterThan(gate);
      expect(prerequisite).toBeLessThan(publish);
    }
    expect(runtimeTransfer).toBeGreaterThan(contribution);
    expect(transferComplete).toBeGreaterThan(runtimeTransfer);
    expect(cleanupCommit).toBeGreaterThan(transferComplete);
    expect(source).not.toContain("startupCleanups");
    expect(source).not.toContain("AssemblyStartupCleanups");
    expect(ready).toBeGreaterThan(publish);
    expect(location(source, "await runner.waitForShutdown()"))
      .toBeGreaterThan(location(source, "runner = await runServer"));
  });

  it("keeps the executor endpoint inactive through stop ownership and final admission", async () => {
    const source = await readSource("executor-role-runtime.ts");
    const bind = location(source, "localServerBinding = await bindServer");
    expect(bind).toBeLessThan(location(source, "await mcpHub.connectAll()"));
    expect(bind).toBeLessThan(location(source, "const interactions = new DurableConversationInteractionObserver()"));
    expect(bind).toBeLessThan(location(source, "const stopResume = await stopCoordinator.resumeActive()"));
    const activation = source.slice(location(source, "localConversationServer = await runServer"));
    expect(activation).toContain("boundServer: localServerBinding");
    expect(activation).toContain("port: localServerPort");
    expect(activation).toContain("host: localServerHost");
    expect(activation).toContain("startTime: processStartTime");
    expect(activation).toContain("startedAt: processStartedAt");
    const gate = location(activation, "beforeActivate: async (openingRunner) =>");
    const stopOwner = location(
      activation,
      "executorInternalStop.current = createExecutorInternalStopPort({",
    );
    const trustBinding = location(activation, "coordinateRuntimeTrustTransition = async () =>");
    const admission = location(activation, "await onTrustApplied();");
    const publish = location(activation, "publishReady: async (openingRunner) =>");
    const ready = location(activation, "await localServerState!.markReady({");
    const running = location(activation, "await localServerState!.markRunning();");
    for (const prerequisite of [stopOwner, trustBinding, admission]) {
      expect(prerequisite).toBeGreaterThan(gate);
      expect(prerequisite).toBeLessThan(publish);
    }
    expect(activation).toContain("shutdown: (reason) => openingRunner.shutdown(reason)");
    expect(activation).toContain("waitForShutdown: () => openingRunner.waitForShutdown()");
    expect(ready).toBeGreaterThan(publish);
    expect(running).toBeGreaterThan(ready);
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
    ]) {
      expect(cleanupTail).not.toContain(directCleanup);
    }
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
