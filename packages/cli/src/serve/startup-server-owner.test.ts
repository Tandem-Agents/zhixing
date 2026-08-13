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

  it("binds the anchor endpoint before pre-server owners and reuses that handle", async () => {
    const source = await readSource("command.ts");
    const bind = location(source, "const serverBinding = await bindServer");
    expect(bind).toBeLessThan(location(source, "await setupAssemblyUnits(assemblyUnits, ctx, \"pre-server\")"));
    expect(bind).toBeLessThan(location(source, "const stopResume = await stopCoordinator.resumeActive()"));
    const activation = source.slice(location(source, "runner = await runServer"));
    expect(activation).toContain("boundServer: serverBinding");
    expect(activation).toContain("config: { ...DEFAULT_SERVER_CONFIG, port, host }");
  });

  it("binds the executor endpoint before every effectful owner and reuses that handle", async () => {
    const source = await readSource("executor-role-runtime.ts");
    const bind = location(source, "localServerBinding = await bindServer");
    expect(bind).toBeLessThan(location(source, "await mcpHub.connectAll()"));
    expect(bind).toBeLessThan(location(source, "const interactions = new DurableConversationInteractionObserver()"));
    expect(bind).toBeLessThan(location(source, "const stopResume = await stopCoordinator.resumeActive()"));
    const activation = source.slice(location(source, "localConversationServer = await runServer"));
    expect(activation).toContain("boundServer: localServerBinding");
    expect(activation).toContain("port: localServerPort");
    expect(activation).toContain("host: localServerHost");
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
