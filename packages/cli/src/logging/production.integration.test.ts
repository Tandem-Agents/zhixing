import { afterEach, describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { createTempDir } from "@zhixing/test-utils";
import { LogRecorder, type LogRecord } from "@zhixing/core/logging";
import { LocalLogStore } from "../../../core/src/logging/storage.js";
import { LogApplication } from "../../../core/src/logging/application.js";
import { createEventBus } from "@zhixing/core/events";
import type { AgentEventMap, ToolDefinition } from "@zhixing/core/types";
import { ConfirmationBroker } from "@zhixing/core/confirmation";
import { SecurityPipeline, BoundaryRegistry } from "@zhixing/core/security";
import { executeToolCalls } from "../../../core/src/loop/tool-executor.js";
import { createKernelLogFactory, observeKernelRun, observeProviderCall } from "../../../orchestrator/src/runtime/logging.js";
import { createSecureExecuteTool } from "../../../orchestrator/src/security/secure-executor.js";
import { runContextStorage } from "../../../orchestrator/src/runtime/run-context.js";
import { recordingFixture } from "../../../core/src/logging/__tests__/recording.js";
import { createDeviceCapacityRuntime } from "../serve/device-capacity-runtime.js";
import { LogFilesProcess } from "./files-process.js";
import { SHIPPED_LOG_SOURCES, LOCAL_LOG_OWNER } from "./access.js";
import { observeBackgroundOutput, STDIO_LOG_SOURCE } from "./stdio.js";

const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const action of close.splice(0).reverse()) await action(); });
async function fixture() {
  const home = await createTempDir("logging-production");
  const store = new LocalLogStore({ files: new LogFilesProcess(home), capacity: createDeviceCapacityRuntime(home).arbiter });
  const recorder = new LogRecorder(store);
  const ports = createKernelLogFactory(recorder.bind.bind(recorder))({ conversationId: "conversation-one", refs: [{ kind: "run", id: "run-one" }] });
  const bus = createEventBus<AgentEventMap>();
  const unobserve = observeKernelRun(bus, ports.kernel);
  close.push(async () => { unobserve(); await recorder.close(5000); });
  await recorder.start(1000);
  return { home, store, recorder, ports, bus, app: new LogApplication(store, () => LOCAL_LOG_OWNER, SHIPPED_LOG_SOURCES) };
}
const passthrough = { callLLM: () => { throw Error("not used"); }, executeTool: (tool: ToolDefinition, input: Record<string, unknown>, context: any) => tool.call(input, context) };
const tool = (name: string, call: ToolDefinition["call"]): ToolDefinition => ({ name, description: "fixture", inputSchema: { type: "object" }, call });
async function drain(generator: AsyncGenerator<any, any>) { const output = []; for (;;) { const step = await generator.next(); if (step.done) return { output, result: step.value }; output.push(step.value); } }
async function records(f: Awaited<ReturnType<typeof fixture>>): Promise<readonly LogRecord[]> { await f.recorder.flush(5000); expect(f.recorder.health().captureFailures).toBe(0); return (await f.app.search({ ref: { kind: "run", id: "run-one" } })).records; }

describe("production boundaries through Recorder, native Store and public reader", () => {
  it("retains scheduler refusal and in-flight unknown outcomes without duplicating model results", async () => {
    const f = await fixture();
    const task = { ...tool("Task", async () => ({ content: "ok" })), maxCallsPerTurn: 1 };
    const batch = await drain(executeToolCalls({ toolCalls: ["first", "limited"].map(id => ({ type: "tool_use", id, name: "Task", input: {} })), tools: [task], deps: passthrough, workingDirectory: f.home, eventBus: f.bus }));
    expect(batch.output.filter(item => item.type === "tool_end")).toHaveLength(2);
    const abort = new AbortController();
    const effect = tool("effect", async () => { abort.abort(); throw Error("remote interruption; token=private-value"); });
    const interrupted = await drain(executeToolCalls({ toolCalls: ["inflight", "never-started"].map(id => ({ type: "tool_use", id, name: "effect", input: {} })), tools: [effect], deps: passthrough, workingDirectory: f.home, eventBus: f.bus, abortSignal: abort.signal }));
    expect(interrupted.output.filter(item => item.type === "tool_end")).toHaveLength(0);
    expect(interrupted.result.unexecutedToolUses).toHaveLength(2);
    const all = await records(f);
    for (const [id, result] of [["limited", "refused"], ["inflight", "unknown"], ["never-started", "cancelled"]]) {
      expect(all).toContainEqual(expect.objectContaining({ event: "toolFinished", result, refs: expect.arrayContaining([{ kind: "toolCall", id }]) }));
    }
    expect(JSON.stringify(all)).not.toContain("private-value");
  }, 15000);
  it("captures known completion before the consumer cancels and retains parallel success", async () => {
    const f = await fixture();
    const abort = new AbortController();
    const success = tool("success", async () => ({ content: "done" }));
    const generator = executeToolCalls({ toolCalls: [{ type: "tool_use", id: "consumer-cancel", name: "success", input: {} }], tools: [success], deps: passthrough, workingDirectory: f.home, eventBus: f.bus, abortSignal: abort.signal });
    for (;;) { const step = await generator.next(); if (step.done) throw Error("missing result"); if (step.value.type === "tool_end") { abort.abort(); await generator.return(undefined as never); break; } }
    const parallelAbort = new AbortController();
    let done!: () => void;
    const completed = new Promise<void>(resolve => { done = resolve; });
    const first = { ...tool("first", async () => { done(); return { content: "done" }; }), isParallelSafe: true };
    const second = { ...tool("second", async () => { await completed; await new Promise(resolve => setImmediate(resolve)); parallelAbort.abort(); throw Error("cancelled effect"); }), isParallelSafe: true };
    const parallel = await drain(executeToolCalls({ toolCalls: ["first", "second"].map(name => ({ type: "tool_use" as const, id: name, name, input: {} })), tools: [first, second], deps: passthrough, workingDirectory: f.home, eventBus: f.bus, abortSignal: parallelAbort.signal }));
    expect(parallel.result.completedResults).toHaveLength(1);
    expect(parallel.result.unexecutedToolUses).toHaveLength(1);
    const all = await records(f);
    for (const [id, result] of [["consumer-cancel", "success"], ["first", "success"], ["second", "unknown"]]) expect(all.filter(item => item.event === "toolFinished" && item.refs.some(ref => ref.kind === "toolCall" && ref.id === id))).toEqual([expect.objectContaining({ result })]);
  }, 15000);
  it.each(["deny", "cancelled", "allow-once"] as const)("records the actual broker decision %s with its call identity", async (decision) => {
    const f = await fixture();
    let invoked = 0;
    const bash = { ...tool("bash", async () => { invoked++; return { content: "done" }; }), needsPermission: true, permissionArgumentKey: "command" };
    const broker = new ConfirmationBroker();
    broker.onRequest(request => queueMicrotask(() => broker.resolve(request.id, { kind: decision } as never)));
    const execute = createSecureExecuteTool({ pipeline: new SecurityPipeline({ sessionType: "interactive", toolBoundaryRegistry: BoundaryRegistry.fromTools([bash]) }), securityApproval: { contextId: { kind: "main" }, recordApproval: () => ({ kind: "recorded" }) }, broker, originalExecute: (selected, input, context) => selected.call(input, context) });
    await runContextStorage.run({ bus: f.bus, lineage: "main", logPorts: f.ports }, async () => { try { await execute(bash, { command: "curl https://example.com" }, { workingDirectory: f.home, toolCallId: "confirmed-call" }); } catch { /* expected refusal */ } });
    expect(invoked).toBe(decision === "allow-once" ? 1 : 0);
    const all = await records(f);
    expect(all).toContainEqual(expect.objectContaining({ event: "permission", result: decision === "allow-once" ? "success" : decision === "cancelled" ? "cancelled" : "refused", refs: expect.arrayContaining([{ kind: "toolCall", id: "confirmed-call" }]) }));
  }, 15000);
  it("preserves a provider's original exception when its error projection fails", async () => {
    const logs = recordingFixture();
    const ports = createKernelLogFactory(logs.bind)({});
    const cause = new Error("original");
    Object.defineProperty(cause, "message", { get() { throw Error("bad getter"); } });
    const generator = observeProviderCall(async function* () { throw cause; }, { model: "test", messages: [] } as never, "fixture", ports.provider);
    try { await generator.next(); throw Error("should reject"); } catch (error) { expect(error).toBe(cause); }
    await logs.finish();
    expect(logs.recorder.health().captureFailures).toBe(1);
  });
  it("contains unclassified background output while preserving write callbacks and validation", async () => {
    const logs = recordingFixture(), raw: string[] = [];
    const stream = new Writable({ write(chunk, _encoding, done) { raw.push(String(chunk)); done(); } });
    const stop = observeBackgroundOutput(logs.bind(STDIO_LOG_SOURCE, { scope: "storage" }), [["stdout", stream as never]]);
    await new Promise<void>(resolve => stream.write("token=private-output", resolve));
    expect(() => stream.write({ invalid: true } as never)).toThrow();
    stop();
    await new Promise<void>(resolve => stream.write("late-private-output", resolve));
    await logs.finish();
    expect(raw.join("")).toBe("");
    expect(logs.records()).toHaveLength(1);
    expect(logs.records()[0]?.data).toMatchObject({ stream: "stdout", size: 20 });
    expect(JSON.stringify(logs.records())).not.toContain("private-output");
  });
});
