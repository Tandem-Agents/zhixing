import {
  CommandDispatcher,
  DefaultCommandRegistry,
} from "@zhixing/core/typeahead";
import {
  registerConfigCommands,
  type ConfigCommandsDeps,
} from "../commands/config-commands.js";
import { FEATURE_CHROME } from "../commands/command-visibility.js";
import { RpcManagementFacade } from "../runtime/rpc-management-facade.js";
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import {
  DEFAULT_LOG_POLICY,
  type LogPolicy,
  type LogReadContext,
} from "@zhixing/core/logging";
import {
  LogApplication,
  LOG_APPLY_POLICY,
  LOG_SEARCH,
  LOG_READ,
  LOG_STATUS,
  createLogQueryTools,
  restrictLogQueryTools,
  formatLogAddress,
} from "@zhixing/core/logging/application";
import { LocalLogStore } from "@zhixing/core/logging/storage";
import {
  bindLogSource,
  captureLog,
} from "../../../core/src/logging/capture.js";
import { createRuntimeToolProjection } from "@zhixing/runtime-host/conversation-runtime-projection";
import { RpcDispatcher } from "../../../server/src/rpc/dispatcher.js";
import { buildBuiltinRegistry } from "../../../server/src/rpc/methods/index.js";
import type { RpcConnection } from "../../../server/src/rpc/connection.js";
import type { ServerContext } from "../../../server/src/context.js";
import { LogRpcClient } from "@zhixing/rpc";
import { LogFilesProcess } from "./files-process.js";
import { createDeviceCapacityRuntime } from "../serve/device-capacity-runtime.js";
import {
  createLogAccess,
  createLocalLogProductApi,
  LOCAL_LOG_OWNER,
} from "./access.js";
import { configureLogs } from "./configuration.js";
import { createTaskTool } from "../../../orchestrator/src/tools/task.js";
import { runContextStorage } from "../../../orchestrator/src/runtime/run-context.js";
import { createSecureExecuteTool } from "../../../orchestrator/src/security/secure-executor.js";
import {
  BoundaryRegistry,
  SecurityPipeline,
  restrictToolExecution,
} from "@zhixing/core/security";
import { ConfirmationBroker } from "@zhixing/core/confirmation";
import { createEventBus } from "@zhixing/core/events";
import { MockLLMProvider } from "@zhixing/core/loop";
import type { AgentEventMap, ToolDefinition } from "@zhixing/core/types";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture(overrides: Partial<LogPolicy> = {}) {
  const home = await createTempDir("log-unit2");
  const capacity = createDeviceCapacityRuntime(home, {
    createDirectory: false,
  });
  const policy = { ...DEFAULT_LOG_POLICY, queryRecords: 1, ...overrides };
  const store = new LocalLogStore({
    files: new LogFilesProcess(home),
    capacity: capacity.arbiter,
    initialPolicy: policy,
  });
  cleanups.push(() => store.close());
  const owner = createLogAccess(home, capacity.arbiter);
  const access = { ...owner, api: createLocalLogProductApi(owner) };
  cleanups.push(() => access.close());
  await store.initialize();
  const source = bindLogSource({
    id: "runtime",
    version: 1,
    events: {
      event: {
        message: "运行证据",
        level: "error",
        tier: "critical",
        fields: { text: "text" },
      },
    },
  });
  let seq = 0;
  const capture = (scope: string, text = "evidence") =>
    captureLog(
      source,
      { scope },
      {
        event: "event",
        data: { text },
        refs: [{ kind: "run", id: "run-one" }],
      },
      policy,
      "fixture",
      ++seq,
    );
  const records = [
    capture("conversation:a"),
    capture("conversation:b", "hidden"),
    capture("conversation:a", "z".repeat(50_000)),
  ];
  await store.append(records);
  const manager = new LogApplication(store, () => LOCAL_LOG_OWNER);
  const status = await manager.status();
  const address = (id: string, storeId = status.storeId) =>
    formatLogAddress({ storeId, kind: "record", id });
  const hashes = async () => {
    const root = path.join(home, "logs", "runtime");
    return Promise.all(
      (await readdir(root))
        .sort()
        .map(async (name) => [
          name,
          (await readFile(path.join(root, name))).toString("base64"),
        ]),
    );
  };
  const scoped = (): LogReadContext => ({
    subject: "reader-a",
    revision: "1",
    manageStorage: false,
    scopes: ["conversation:a"],
  });
  return {
    home,
    store,
    capacity,
    access,
    manager,
    status,
    address,
    records,
    capture,
    hashes,
    scoped,
  };
}
function wire(
  api: ReturnType<typeof createLocalLogProductApi>,
  loopback = true,
) {
  let result: unknown, failure: unknown;
  const connection = {
    id: 1,
    authenticated: false,
    loopback,
    closed: false,
    surfaceGeneration: 1,
    sendSuccess: (_id: unknown, value: unknown) => {
      result = value;
    },
    sendError: (_id: unknown, value: unknown) => {
      failure = value;
    },
    notify() {},
    close() {},
    onClose: () => () => {},
  } as RpcConnection;
  const dispatcher = new RpcDispatcher({
    registry: buildBuiltinRegistry(),
    server: { token: "fixture-only", productApi: api } as ServerContext,
  });
  const request = async <T>(method: string, params?: unknown): Promise<T> => {
    result = failure = undefined;
    await dispatcher.handleMessage(
      connection,
      JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    );
    if (failure) throw failure;
    return result as T;
  };
  return {
    request,
    connection,
    client: new LogRpcClient({ getClient: async () => ({ request }) }),
  };
}

describe("unified native log access", () => {
  it("closes a blocked inventory after a finite drain and joins the physical owner and resource release", async () => {
    const f = await fixture(),
      native = new LogFilesProcess(f.home);
    const entered = Promise.withResolvers<void>(),
      gate = Promise.withResolvers<void>();
    let statCalls = 0,
      closed = false;
    const files = new Proxy(native, {
      get(target, key) {
        if (key === "stat")
          return async (...args: Parameters<typeof native.stat>) => {
            statCalls++;
            entered.resolve();
            await gate.promise;
            return target.stat(...args);
          };
        if (key === "close")
          return async () => {
            await target.close();
            closed = true;
            gate.resolve();
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const owner = createLogAccess(f.home, f.capacity.arbiter, files);
    const access = { ...owner, api: createLocalLogProductApi(owner) };
    cleanups.push(() => access.close());
    const request = access.api
      .query(LOG_STATUS, { context: () => LOCAL_LOG_OWNER, request: undefined })
      .catch((error) => error);
    await entered.promise;
    const started = Date.now();
    const closing = access.close();
    expect(access.close()).toBe(closing);
    await closing;
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await request).toBeInstanceOf(Error);
    expect(statCalls).toBe(1);
    expect(closed).toBe(true);
    expect(f.capacity.arbiter.snapshot().occupancyInUse.slots).toBe(0);
    await expect(native.open(true)).rejects.toThrow();
    await expect(
      access.api.query(LOG_SEARCH, {
        context: () => LOCAL_LOG_OWNER,
        request: {},
      }),
    ).rejects.toThrow("暂忙");
  }, 30_000);

  it("reauthorizes policy after resource admission and before its first state change", async () => {
    const f = await fixture();
    let grant: LogReadContext = LOCAL_LOG_OWNER;
    const capacity: typeof f.capacity.arbiter = {
      snapshot: () => f.capacity.arbiter.snapshot(),
      acquire: async (request, abort) => {
        const admission = await f.capacity.arbiter.acquire(request, abort);
        grant = { ...grant, revision: "revoked", managePolicy: false };
        return admission;
      },
    };
    const store = new LocalLogStore({
      files: new LogFilesProcess(f.home),
      capacity,
    });
    cleanups.push(() => store.close());
    const app = new LogApplication(store, () => grant);
    await expect(
      app.applyPolicy(
        { ...f.status.policy.effective, queryRecords: 3 },
        f.status.policy.version,
      ),
    ).rejects.toThrow("权限发生变化");
    expect((await f.manager.status()).policy.version).toBe(
      f.status.policy.version,
    );
    expect((await f.manager.status()).policy.desired).toBeUndefined();
  }, 30_000);

  it("passes a legal page over 2 MiB through Security without cutting JSON, cursor or gaps", async () => {
    const f = await fixture({
      recordBytes: 256 * 1024,
      queryResultBytes: 4 * 1024 * 1024,
      queryRecords: 1000,
      queryScanBytes: 16 * 1024 * 1024,
      queryMs: 10_000,
    });
    for (let batch = 0; batch < 3; batch++)
      await f.store.append(
        Array.from({ length: 8 }, () =>
          f.capture("conversation:a", "x".repeat(235_000)),
        ),
      );
    const tools = createLogQueryTools(f.access.api, () => LOCAL_LOG_OWNER);
    const execute = createSecureExecuteTool({
      pipeline: new SecurityPipeline({
        sessionType: "ci",
        toolBoundaryRegistry: BoundaryRegistry.fromTools(tools),
      }),
      securityApproval: {
        contextId: { kind: "main" },
        recordApproval: () => ({ kind: "recorded" }),
      },
      originalExecute: (tool, input, context) => tool.call(input, context),
    });
    const result = await execute(tools[0]!, {}, { workingDirectory: f.home });
    expect(result.isError).not.toBe(true);
    expect(Buffer.byteLength(result.content as string)).toBeGreaterThan(
      2 * 1024 * 1024,
    );
    expect(Buffer.byteLength(result.content as string)).toBeLessThanOrEqual(
      4 * 1024 * 1024,
    );
    const page = JSON.parse(result.content as string);
    expect(page.cursor).toBeTypeOf("string");
    expect(page.gaps).toBeInstanceOf(Array);
    expect(page.coverage.complete).toBe(false);
  }, 30_000);

  it("does not expose unclassified storage errors through RPC or model tools", async () => {
    const f = await fixture();
    const api = {
      supports: () => true,
      query: async () => {
        throw Error("unrelated secret record content");
      },
    } as unknown as typeof f.access.api;
    const w = wire(api);
    await w.request("auth", { token: "fixture-only" });
    await expect(w.client.search()).rejects.toMatchObject({
      message: "日志访问暂不可用，请稍后重试或在本机检查存储状态",
    });
    const result = await createLogQueryTools(
      api,
      () => LOCAL_LOG_OWNER,
    )[0]!.call({}, { workingDirectory: f.home });
    expect(result).toEqual({
      isError: true,
      content: "日志访问暂不可用，请稍后重试或在本机检查存储状态",
    });
  }, 30_000);
  it("real Task delegation projects only canonical log tools, reads its conversation and cannot issue an escape", async () => {
    const f = await fixture();
    const parentTools = createLogQueryTools(
      f.access.api,
      () => LOCAL_LOG_OWNER,
    );
    const dangerous: ToolDefinition = {
      name: "read",
      description: "read file",
      inputSchema: { type: "object" },
      call: async () => {
        throw Error("must not execute");
      },
    };
    const provider = new MockLLMProvider([
      { toolCalls: [{ id: "query", name: "log_search", input: {} }] },
      { toolCalls: [{ id: "escape", name: "read", input: { path: f.home } }] },
      { text: "finished" },
    ]);
    const role = {
      provider,
      model: "mock-model",
      chat: provider.chat.bind(provider),
    };
    const securityApproval = {
      contextId: { kind: "main" as const },
      recordApproval: () => ({ kind: "recorded" as const }),
    };
    const task = createTaskTool({
      provider,
      model: "mock-model",
      llmRoles: { main: role, light: role, power: role },
      securityPipeline: new SecurityPipeline({
        sessionType: "ci",
        toolBoundaryRegistry: BoundaryRegistry.fromTools(parentTools),
      }),
      securityApproval,
      workspace: f.home,
      parentBroker: new ConfirmationBroker(),
      parentTools: [...parentTools, dangerous],
      childToolNames: ["read", "log_search", "log_read"],
      riskMaxTokens: 1_000_000,
    });
    const run = {
      bus: createEventBus<AgentEventMap>({ lineage: "main" }),
      lineage: "main",
      conversationId: "a",
    };
    const result = await runContextStorage.run(run, () =>
      task.call(
        { description: "trace", prompt: "Read evidence", logOnly: true },
        {
          workingDirectory: f.home,
          abortSignal: new AbortController().signal,
          toolCallId: "delegation-one",
        },
      ),
    );
    expect(result.isError).toBe(false);
    expect(provider.calls[0]!.tools.map((tool) => tool.name).sort()).toEqual([
      "log_read",
      "log_search",
    ]);
    const history = JSON.stringify(provider.calls.at(-1)!.messages);
    expect(history).toContain("conversation:a");
    expect(history).not.toContain("conversation:b");
    expect(history).toContain("read");
    const absent = await runContextStorage.run(
      { ...run, conversationId: undefined },
      () =>
        task.call(
          { description: "trace", prompt: "Read", logOnly: true },
          {
            workingDirectory: f.home,
            abortSignal: new AbortController().signal,
            toolCallId: "absent",
          },
        ),
    );
    expect(absent).toMatchObject({ isError: true });
  }, 30_000);

  it("Security enforces object provenance and a live ceiling again at the effect boundary", async () => {
    const f = await fixture();
    const tools = createLogQueryTools(f.access.api, () => LOCAL_LOG_OWNER);
    const allowed = tools[0]!;
    let executed = 0,
      active = true,
      admissionCount = 0;
    const execute = createSecureExecuteTool({
      pipeline: new SecurityPipeline({
        sessionType: "ci",
        toolBoundaryRegistry: BoundaryRegistry.fromTools(tools),
      }),
      securityApproval: {
        contextId: { kind: "main" },
        recordApproval: () => ({ kind: "recorded" }),
      },
      originalExecute: async () => {
        executed++;
        return { content: "effect" };
      },
      authorizeToolExecution: async () => {
        if (++admissionCount === 2) active = false;
        return [];
      },
    });
    const run = {
      bus: createEventBus<AgentEventMap>({ lineage: "main" }),
      lineage: "main",
      toolExecutionCeiling: restrictToolExecution(
        tools,
        Object.freeze({ permits: () => active }),
      ),
    };
    for (const name of ["read", "bash", "mcp__escape", "Task", "log_search"]) {
      const spoof = {
        ...allowed,
        name,
        call: async () => ({ content: "escape" }),
      };
      await expect(
        runContextStorage.run(run, () =>
          execute(spoof, {}, { workingDirectory: f.home }),
        ),
      ).rejects.toThrow("受限运行");
    }
    expect(admissionCount).toBe(0);
    await expect(
      runContextStorage.run(run, () =>
        execute(allowed, {}, { workingDirectory: f.home }),
      ),
    ).rejects.toThrow("受限运行");
    expect(admissionCount).toBe(2);
    expect(executed).toBe(0);
  }, 30_000);

  it("uses authenticated JSON-RPC and the same query/policy application; no query self-grant", async () => {
    const f = await fixture(),
      w = wire(f.access.api);
    await expect(w.client.search()).rejects.toMatchObject({ code: -32001 });
    await w.request("auth", { token: "fixture-only" });
    const expected = await f.access.api.query(LOG_SEARCH, {
      context: () => ({
        subject: "home-rpc:1",
        revision: "home-token:1",
        manageStorage: true,
        managePolicy: true,
        scopes: [],
      }),
      request: {},
    });
    expect(await w.client.search()).toEqual(expected);
    await expect(
      w.request("logs.search", {
        context: { manageStorage: true },
        filter: {},
      }),
    ).rejects.toBeDefined();
    await expect(
      w.request("logs.read", {
        address: f.address(f.records[0]!.record.id),
        view: "all",
        scopes: ["*"],
      }),
    ).rejects.toBeDefined();
    const before = await f.hashes();
    for (let count = 0; count < 3; count++) await w.client.search();
    expect(await f.hashes()).toEqual(before);
    const changed = await w.client.applyPolicy({
      expectedVersion: f.status.policy.version,
      patch: { queryRecords: 2 },
    });
    expect(changed.policy.effective.queryRecords).toBe(2);
    await expect(
      w.client.applyPolicy({
        expectedVersion: f.status.policy.version,
        patch: { queryRecords: 3 },
      }),
    ).rejects.toBeDefined();
    expect((await w.client.status()).policy.effective.queryRecords).toBe(2);
    w.connection.authenticated = false;
    await expect(w.client.search()).rejects.toBeDefined();
  }, 30_000);

  it("full-store read on a remote authenticated surface cannot mutate policy through the application", async () => {
    const f = await fixture(),
      w = wire(f.access.api, false);
    await w.request("auth", { token: "fixture-only" });
    expect((await w.client.search()).records).toHaveLength(1);
    const policy = (await w.client.status()).policy;
    await expect(
      w.client.applyPolicy({
        expectedVersion: policy.version,
        patch: { queryRecords: 8 },
      }),
    ).rejects.toBeDefined();
    await expect(
      f.access.api.command(LOG_APPLY_POLICY, {
        context: () => ({ ...LOCAL_LOG_OWNER, managePolicy: false }),
        request: {
          expectedVersion: policy.version,
          patch: { queryRecords: 8 },
        },
      }),
    ).rejects.toThrow("不能修改");
    expect((await f.manager.status()).policy.version).toBe(policy.version);
  }, 30_000);

  it("scoped records, guessed details, cursors, metadata and foreign origins remain bounded and honest", async () => {
    const f = await fixture();
    let grant = f.scoped();
    const query = (request = {}) =>
      f.access.api.query(LOG_SEARCH, { context: () => grant, request });
    const page = await query();
    expect(page.records.map((record) => record.access.scope)).toEqual([
      "conversation:a",
    ]);
    expect(page.records[0]!.refs).toEqual([]);
    expect(page.coverage.upper).toBe(2);
    expect(page.cursor).toBeTruthy();
    const read = (address: string) =>
      f.access.api.query(LOG_READ, {
        context: () => grant,
        request: { address, view: "detail" },
      });
    expect(await read(f.address(f.records[1]!.record.id))).toEqual(
      await read(f.address(randomUUID())),
    );
    await expect(
      f.access.api.query(LOG_STATUS, {
        context: () => grant,
        request: undefined,
      }),
    ).rejects.toThrow("管理授权");
    await f.store.append([
      f.capture("conversation:a", "later"),
      f.capture("conversation:b", "later-hidden"),
    ]);
    const next = await query({ cursor: page.cursor });
    expect(next.coverage.upper).toBe(2);
    expect(next.records[0]!.id).toBe(f.records[2]!.record.id);
    expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThanOrEqual(
      DEFAULT_LOG_POLICY.queryResultBytes,
    );
    expect(
      (await read(f.address(f.records[2]!.record.id))).detail,
    ).toBeDefined();
    grant = { ...grant, revision: "2", scopes: [] };
    await expect(query({ cursor: page.cursor })).rejects.toThrow("游标");
    const remote = await read(f.address(randomUUID(), randomUUID()));
    expect(remote).toMatchObject({
      records: [],
      gaps: [{ kind: "unavailable", reason: "remote-store" }],
      coverage: { complete: false },
    });
  }, 30_000);

  it("scoped readers can follow their local conversation without exposing other relations", async () => {
    const f = await fixture({ queryRecords: 16 });
    const captured = f.capture("conversation:a"), remote = randomUUID();
    const localRefs = [
      { kind: "conversation", id: "a" },
      { kind: "conversation", id: "a", storeId: f.status.storeId },
    ];
    await f.store.append([{ ...captured, record: { ...captured.record, refs: [
      ...localRefs,
      { kind: "conversation", id: "a", storeId: remote },
      { kind: "conversation", id: "b" },
      { kind: "run", id: "private-run" },
    ] } }]);
    const ref = { kind: "conversation", id: "a" };
    const search = (value: typeof ref & { storeId?: string }) => f.access.api.query(LOG_SEARCH, {
      context: f.scoped, request: { filter: { ref: value } },
    });
    const page = await search(ref);
    expect(page.records.map((record) => record.id)).toEqual([captured.record.id]);
    expect(page.records[0]!.refs).toEqual(localRefs);
    const timeline = await f.access.api.query(LOG_READ, {
      context: f.scoped,
      request: { address: formatLogAddress({ storeId: f.status.storeId, kind: "operation", ref }), view: "timeline" },
    });
    expect(timeline.records).toEqual(page.records);
    expect(await search({ kind: "conversation", id: "b" })).toEqual(await search({ kind: "conversation", id: "absent" }));
    expect(await search({ ...ref, storeId: remote })).toEqual(await search({ kind: "conversation", id: "absent", storeId: remote }));
    expect((await search({ kind: "run", id: "private-run" })).records).toEqual([]);
    const revoked = await f.access.api.query(LOG_SEARCH, {
      context: () => ({ ...f.scoped(), revision: "2", scopes: [] }), request: { filter: { ref } },
    });
    expect(revoked.records).toEqual([]);
  }, 30_000);

  it("hidden references cannot be probed by filters, combined ids or operation addresses", async () => {
    const f = await fixture();
    const inspect = async (id: string, foreign?: string) => {
      const ref = { kind: "run", id, ...(foreign ? { storeId: foreign } : {}) };
      const page = await f.access.api.query(LOG_SEARCH, {
        context: f.scoped,
        request: { filter: { ref } },
      });
      const combined = await f.access.api.query(LOG_SEARCH, {
        context: f.scoped,
        request: { filter: { id: f.records[0]!.record.id, ref } },
      });
      const address = formatLogAddress({
        storeId: f.status.storeId,
        kind: "operation",
        ref: { kind: "run", id },
      });
      const detail = await f.access.api.query(LOG_READ, {
        context: f.scoped,
        request: { address, view: "detail" },
      });
      // Cursors encode the caller's different filters, so compare observable evidence and scan progress.
      return [page, combined, detail].map(({ cursor, ...result }) => ({
        ...result,
        continues: !!cursor,
      }));
    };
    expect(await inspect("run-one")).toEqual(await inspect("never-existed"));
    expect(await inspect("run-one", randomUUID())).toEqual(
      await inspect("never-existed", randomUUID()),
    );
    const owner = await f.access.api.query(LOG_SEARCH, {
      context: () => LOCAL_LOG_OWNER,
      request: { filter: { ref: { kind: "run", id: "run-one" } } },
    });
    expect(owner.records).toHaveLength(1);
    expect(owner.records[0]!.refs).toEqual([{ kind: "run", id: "run-one" }]);
  }, 30_000);

  it("canonical log tools survive frozen runtime projection; same-name code cannot enter a scoped delegation", async () => {
    const f = await fixture();
    let parent: LogReadContext = LOCAL_LOG_OWNER;
    const canonical = createLogQueryTools(f.access.api, () => parent);
    const projection = createRuntimeToolProjection({
      extraTools: canonical,
      executionMcpServers: [],
      implementation: Object.freeze({
        create: () => {
          throw Error("unused");
        },
      }),
    });
    const scoped = restrictLogQueryTools(projection.extraTools, {
      subject: "child",
      revision: "v1",
      scope: "conversation:a",
      assertActive() {},
    });
    const call = () => scoped[0]!.call({}, { workingDirectory: f.home });
    expect(
      JSON.parse((await call()).content as string).records[0].access.scope,
    ).toBe("conversation:a");
    parent = {
      subject: "owner",
      revision: "revoked",
      manageStorage: false,
      scopes: [],
    };
    expect(JSON.parse((await call()).content as string).records).toEqual([]);
    const fake = {
      ...canonical[0]!,
      call: async () => ({ content: "bypass" }),
    };
    expect(() =>
      restrictLogQueryTools([fake, canonical[1]!], {
        subject: "child",
        revision: "v1",
        scope: "conversation:a",
        assertActive() {},
      }),
    ).toThrow("完整日志");
  }, 30_000);

  it("existing configuration entry uses CAS and reports the effective policy", async () => {
    const f = await fixture(),
      w = wire(f.access.api);
    await w.request("auth", { token: "fixture-only" });
    const lines: string[] = [];
    const registry = new DefaultCommandRegistry();
    const dispatcher = new CommandDispatcher({ registry });
    const management = new RpcManagementFacade({
      getClient: async () => ({ request: w.request }),
    } as ConstructorParameters<typeof RpcManagementFacade>[0]);
    registerConfigCommands({
      registry,
      dispatcher,
      management,
      writer: { line: (value: string) => lines.push(value) },
    } as unknown as ConfigCommandsDeps);
    await dispatcher.dispatch(
      `/config logs 128 14 ${f.status.policy.version}`,
      {
        sessionBusy: false,
        workspaceId: null,
        cwd: f.home,
        target: "cli",
        features: { [FEATURE_CHROME]: true },
        now: 0,
      },
    );
    const status = await f.manager.status();
    expect(status.policy.effective.maxBytes).toBe(128 * 1024 * 1024);
    expect(lines.join("\n")).toContain("已生效容量 128 MiB");
    await expect(
      configureLogs(`64 7 ${f.status.policy.version}`, w.client, { line() {} }),
    ).rejects.toBeDefined();
    expect((await f.manager.status()).policy.effective.maxBytes).toBe(
      128 * 1024 * 1024,
    );
  }, 30_000);
});
