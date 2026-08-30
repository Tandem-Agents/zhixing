/**
 * S2.E 集成测试：schedule.* RPC + 事件桥接 + 系统 handler
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import WebSocket from "ws";
import {
  Scheduler,
  InMemoryTaskStore,
  createEventBus,
  type IEventBus,
  type SchedulerEventMap,
  type AgentTurnResult,
  type ScheduledTask,
} from "@zhixing/core";
import {
  createScheduleManagementProductApiContribution,
  createScheduleRuntimeProductApiContribution,
  SCHEDULE_MANAGEMENT_PRODUCT_API_EXACT_SET,
  SCHEDULE_RUNTIME_PRODUCT_API_EXACT_SET,
  ScheduleManagementApplicationService,
  ScheduleRuntimeApplicationService,
  type ScheduleManagementRepository,
  type ScheduleRuntimeApplication,
  type ScheduleRuntimeProjectionPort,
} from "@zhixing/core/scheduler/application";
import { defineProductApiExactSet, ProductApiDispatcher } from "@zhixing/core/product-api";
import { startServer, type ZhixingServerInstance } from "../server.js";
import { createServerContext } from "../context.js";
import { DEFAULT_SERVER_CONFIG } from "../types.js";
import { buildSystemHandlers } from "../system-handlers.js";
import {
  encodeRequest,
  parseMessage,
  RPC_ERROR_CODES,
  type JsonRpcResponse,
  isSuccessResponse,
  isErrorResponse,
} from "../rpc/protocol.js";

const TEST_VERSION = "0.1.0-test";
const TEST_TOKEN = "test-token-schedule";
let nextClientInstance = 0;
const conversations = {
  durableControlPrincipal(input: {
    readonly surfacePrincipal: string;
    readonly connectionId: string;
  }) {
    return { ...input, deviceId: "device-test" };
  },
  removeObserverFromAll() {},
  async disposeAll() {},
} as never;

// ─── Mock runAgentTurn (avoids real LLM) ───

function mockRunAgentTurn(
  result: Partial<AgentTurnResult> = {},
): (params: { prompt: string }) => Promise<AgentTurnResult> {
  return async () => ({
    status: "ok",
    output: "executed",
    durationMs: 10,
    ...result,
  });
}

function createManagementRepository(scheduler: Scheduler): ScheduleManagementRepository {
  const revisions = new Map<string, number>();
  const project = (task: ReturnType<Scheduler["getTask"]>) =>
    task ? { ...task, taskRevision: revisions.get(task.id) ?? 1 } : undefined;
  return {
    list: async () => scheduler.listTasks().map((task) => project(task)!),
    find: async (taskId) => project(scheduler.getTask(taskId)),
    commitCreate: async ({ spec }) => {
      const task = await scheduler.createTask(spec);
      revisions.set(task.id, 1);
      return project(task)!;
    },
    commitUpdate: async ({ taskId, spec, operation }) => {
      const task = await scheduler.updateTask(taskId, spec);
      revisions.set(taskId, operation.expectedRevision + 1);
      return project(task)!;
    },
    commitDelete: async ({ taskId }) => {
      await scheduler.deleteTask(taskId);
      revisions.delete(taskId);
    },
  };
}

function createRuntimeProjection(
  scheduler: Scheduler,
  eventBus: IEventBus<SchedulerEventMap>,
): ScheduleRuntimeProjectionPort {
  return {
    snapshot: () => ({
      tasks: scheduler.listTasks(),
      activeRunCount: scheduler.activeTaskCount,
    }),
    onSignal: (handler) => {
      const disposers = [
        eventBus.on("scheduler:task-accepted", (event) =>
          handler({ kind: "accepted", ...event })),
        eventBus.on("scheduler:task-started", (event) =>
          handler({ kind: "started", taskId: event.taskId, name: event.name })),
        eventBus.on("scheduler:task-completed", (event) =>
          handler({ kind: "completed", ...event })),
        eventBus.on("scheduler:task-failed", (event) =>
          handler({ kind: "failed", ...event })),
        eventBus.on("scheduler:task-disabled", (event) =>
          handler({ kind: "disabled", ...event })),
      ];
      return () => disposers.forEach((dispose) => dispose());
    },
  };
}

function createScheduleBoundary(input: {
  readonly scheduler: Scheduler;
  readonly eventBus: IEventBus<SchedulerEventMap>;
  readonly abort?: (runId: string) => Promise<boolean>;
}): {
  readonly productApi: ProductApiDispatcher;
  readonly runtime: ScheduleRuntimeApplication;
} {
  const management = new ScheduleManagementApplicationService(
    createManagementRepository(input.scheduler),
    {
      run: ({ taskId }) => input.scheduler.runTask(taskId),
      abort: ({ runId }) =>
        input.abort?.(runId) ?? Promise.reject(new Error("Schedule run abort is unavailable")),
    },
  );
  const runtime = new ScheduleRuntimeApplicationService(
    createRuntimeProjection(input.scheduler, input.eventBus),
  );
  return {
    productApi: new ProductApiDispatcher(
      defineProductApiExactSet({
        operations: [
          ...SCHEDULE_MANAGEMENT_PRODUCT_API_EXACT_SET.operations,
          ...SCHEDULE_RUNTIME_PRODUCT_API_EXACT_SET.operations,
        ],
        factEvents: [],
      }),
      [
        createScheduleManagementProductApiContribution(management),
        createScheduleRuntimeProductApiContribution(runtime),
      ],
    ),
    runtime,
  };
}

// ─── Client helper (re-used pattern from session-rpc.test.ts) ───

interface RpcClient {
  ws: WebSocket;
  request(method: string, params?: unknown): Promise<JsonRpcResponse>;
  waitNotification(method: string, timeoutMs?: number): Promise<{ method: string; params: unknown }>;
  close(): void;
}

async function connect(port: number): Promise<RpcClient> {
  const clientInstanceId = `schedule-test-${++nextClientInstance}`;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });

  let nextId = 0;
  const pending = new Map<string | number, (msg: JsonRpcResponse) => void>();
  const queue: Array<{ method: string; params: unknown }> = [];
  const waiters: Array<{
    predicate: (n: { method: string; params: unknown }) => boolean;
    resolve: (n: { method: string; params: unknown }) => void;
  }> = [];

  ws.on("message", (data) => {
    const parsed = parseMessage(data.toString());
    if (parsed.kind === "response") {
      const id = parsed.message.id;
      if (id !== null && pending.has(id)) {
        const cb = pending.get(id)!;
        pending.delete(id);
        cb(parsed.message);
      }
    } else if (parsed.kind === "notification") {
      const notif = { method: parsed.message.method, params: parsed.message.params };
      const idx = waiters.findIndex((w) => w.predicate(notif));
      if (idx >= 0) waiters.splice(idx, 1)[0]!.resolve(notif);
      else queue.push(notif);
    }
  });

  return {
    ws,
    request(method, params) {
      const id = ++nextId;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        const authenticatedParams =
          method === "auth" && typeof params === "object" && params !== null
            ? { ...params, client: { id: clientInstanceId } }
            : params;
        const requestParams =
          method.startsWith("schedule.") &&
          method !== "schedule.list" &&
          typeof authenticatedParams === "object" &&
          authenticatedParams !== null
            ? {
                ...authenticatedParams,
                requestId:
                  "requestId" in authenticatedParams
                    ? (authenticatedParams as { requestId?: unknown }).requestId
                    : `${clientInstanceId}:${method}:${id}`,
              }
            : authenticatedParams;
        ws.send(encodeRequest(id, method, requestParams));
      });
    },
    waitNotification(method, timeoutMs = 2000) {
      return new Promise((resolve, reject) => {
        const predicate = (n: { method: string; params: unknown }) => n.method === method;
        const idx = queue.findIndex(predicate);
        if (idx >= 0) {
          resolve(queue.splice(idx, 1)[0]!);
          return;
        }
        const timer = setTimeout(
          () => reject(new Error(`Timeout waiting for: ${method}`)),
          timeoutMs,
        );
        waiters.push({
          predicate,
          resolve: (n) => {
            clearTimeout(timer);
            resolve(n);
          },
        });
      });
    },
    close() {
      ws.close();
    },
  };
}

// ─── Tests ───

describe("schedule.* RPC + event bridge (S2.E)", () => {
  let server: ZhixingServerInstance;
  let scheduler: Scheduler;

  beforeEach(async () => {
    const eventBus = createEventBus<SchedulerEventMap>();
    scheduler = new Scheduler({
      store: new InMemoryTaskStore(),
      eventBus,
      runAgentTurn: mockRunAgentTurn(),
      systemHandlers: buildSystemHandlers(),
      config: { minTickIntervalMs: 100, maxTickIntervalMs: 500 },
    });
    await scheduler.start();
    const boundary = createScheduleBoundary({ scheduler, eventBus });

    const ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 0 },
      version: TEST_VERSION,
      token: TEST_TOKEN,
      productApi: boundary.productApi,
      conversations,
    });
    server = await startServer({ context: ctx, scheduleRuntimeEvents: boundary.runtime });
  });

  afterEach(async () => {
    await server.close();
    await scheduler.stop();
  });

  // ─── auth ───

  it("auth reports 'schedule' capability when scheduler is present", async () => {
    const client = await connect(server.port);
    const r = await client.request("auth", { token: TEST_TOKEN });
    if (isSuccessResponse(r)) {
      const capabilities = (r.result as { capabilities: string[] }).capabilities;
      expect(capabilities).toContain("schedule");
    }
    client.close();
  });

  // ─── schedule.list / create / delete / run ───

  it("schedule.list initially empty", async () => {
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });
    const r = await client.request("schedule.list");
    if (isSuccessResponse(r)) {
      expect(r.result).toEqual([]);
    }
    client.close();
  });

  it("schedule.create + schedule.list round-trip", async () => {
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const createResp = await client.request("schedule.create", {
      name: "test-task",
      schedule: { kind: "interval", everyMs: 60_000 },
      action: { kind: "agent-turn", prompt: "say hi" },
    });
    expect(isSuccessResponse(createResp)).toBe(true);
    const created = (createResp as { result: ScheduledTask }).result;
    expect(created.id).toBeTruthy();
    expect(created.name).toBe("test-task");
    expect(created.enabled).toBe(true);
    expect(created.priority).toBe("normal");

    const listResp = await client.request("schedule.list");
    if (isSuccessResponse(listResp)) {
      const tasks = listResp.result as ScheduledTask[];
      expect(tasks).toHaveLength(1);
      expect(tasks[0]!.id).toBe(created.id);
    }

    client.close();
  });

  it("schedule.create requires name/schedule/action", async () => {
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });
    const r = await client.request("schedule.create", { name: "x" });
    expect(isErrorResponse(r)).toBe(true);
    if (isErrorResponse(r)) {
      expect(r.error.code).toBe(RPC_ERROR_CODES.INVALID_PARAMS);
    }
    client.close();
  });

  it("schedule.delete removes task", async () => {
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const created = (await client.request("schedule.create", {
      name: "to-delete",
      schedule: { kind: "interval", everyMs: 60_000 },
      action: { kind: "agent-turn", prompt: "x" },
    })) as { result: ScheduledTask };

    const delResp = await client.request("schedule.delete", {
      id: created.result.id,
      // This integration fixture intentionally uses the retired in-memory
      // scheduler, whose test projection predates durable revisions. The
      // production scheduler port validates the observed revision itself.
      taskRevision: 1,
    });
    if (!isSuccessResponse(delResp)) {
      throw new Error(`schedule.delete failed: ${JSON.stringify(delResp)}`);
    }

    const list = await client.request("schedule.list");
    if (isSuccessResponse(list)) {
      expect(list.result).toEqual([]);
    }
    client.close();
  });

  it("schedule.delete returns NOT_FOUND for unknown id", async () => {
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });
    const r = await client.request("schedule.delete", { id: "nope", taskRevision: 1 });
    expect(isErrorResponse(r)).toBe(true);
    if (isErrorResponse(r)) {
      expect(r.error.code).toBe(RPC_ERROR_CODES.NOT_FOUND);
    }
    client.close();
  });

  it("schedule.run executes immediately and returns AgentTurnResult", async () => {
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const created = (await client.request("schedule.create", {
      name: "manual-run",
      schedule: { kind: "interval", everyMs: 999_999 }, // won't fire on its own
      action: { kind: "agent-turn", prompt: "do something" },
    })) as { result: ScheduledTask };

    const runResp = await client.request("schedule.run", { id: created.result.id });
    if (isSuccessResponse(runResp)) {
      const result = runResp.result as AgentTurnResult;
      expect(result.status).toBe("ok");
      expect(result.output).toBe("executed");
    }
    client.close();
  });

  // ─── 事件桥接 ───

  it("schedule.completed event is pushed to authenticated connections", async () => {
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const created = (await client.request("schedule.create", {
      name: "event-test",
      schedule: { kind: "interval", everyMs: 999_999 },
      action: { kind: "agent-turn", prompt: "x" },
    })) as { result: ScheduledTask };

    // Trigger via schedule.run; expect schedule.started + schedule.completed pushes
    const startedWaiter = client.waitNotification("schedule.started");
    const completedWaiter = client.waitNotification("schedule.completed");
    await client.request("schedule.run", { id: created.result.id });

    const started = await startedWaiter;
    expect(started.params).toMatchObject({ taskId: created.result.id, name: "event-test" });

    const completed = await completedWaiter;
    const cParams = completed.params as {
      taskId: string;
      status: string;
      durationMs: number;
    };
    expect(cParams.taskId).toBe(created.result.id);
    expect(cParams.status).toBe("ok");
    expect(cParams.durationMs).toBeGreaterThanOrEqual(0);

    client.close();
  });

  it("unauthenticated connection does not receive schedule events", async () => {
    const authedClient = await connect(server.port);
    await authedClient.request("auth", { token: TEST_TOKEN });

    const unauthedClient = await connect(server.port);
    // Don't call auth on unauthedClient

    const created = (await authedClient.request("schedule.create", {
      name: "auth-isolation",
      schedule: { kind: "interval", everyMs: 999_999 },
      action: { kind: "agent-turn", prompt: "x" },
    })) as { result: ScheduledTask };

    // Unauthed should NOT receive the event; authed should
    const authedReceived = authedClient.waitNotification("schedule.completed");
    const unauthedTimeout = unauthedClient
      .waitNotification("schedule.completed", 500)
      .then(() => "received")
      .catch(() => "timeout");

    await authedClient.request("schedule.run", { id: created.result.id });

    await authedReceived; // must arrive
    expect(await unauthedTimeout).toBe("timeout");

    authedClient.close();
    unauthedClient.close();
  });

  // ─── system task 隔离 ───

  it("RPC 不能创建 system task", async () => {
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const response = await client.request("schedule.create", {
      name: "health-self",
      schedule: { kind: "interval", everyMs: 999_999 },
      action: { kind: "system", handler: "__health-check" },
    });
    expect(isErrorResponse(response)).toBe(true);
    client.close();
  });

  it("伪造 system 字段不能绕过 agent-turn 白名单", async () => {
    const client = await connect(server.port);
    await client.request("auth", { token: TEST_TOKEN });

    const response = await client.request("schedule.create", {
      name: "gc",
      system: true,
      schedule: { kind: "interval", everyMs: 999_999 },
      action: { kind: "agent-turn", prompt: "gc" },
    });
    expect(isErrorResponse(response)).toBe(true);
    client.close();
  });

  // ─── schedule.abortRun（由 scheduler 权威持有取消事实） ───

  describe("schedule.abortRun", () => {
    it("后端未提供取消能力 → INTERNAL_ERROR", async () => {
      const client = await connect(server.port);
      await client.request("auth", { token: TEST_TOKEN });
      const r = await client.request("schedule.abortRun", { runId: "any" });
      expect(isErrorResponse(r)).toBe(true);
      if (isErrorResponse(r)) {
        expect(r.error.code).toBe(RPC_ERROR_CODES.INTERNAL_ERROR);
        expect(r.error.message).toBe("Internal error");
      }
      client.close();
    });
  });

  describe("schedule.abortRun (with scheduler authority)", () => {
    let serverWithReg: ZhixingServerInstance;
    let schedulerWithReg: Scheduler;
    let abortRun: (runId: string) => Promise<boolean>;

    beforeEach(async () => {
      const eventBus = createEventBus<SchedulerEventMap>();
      schedulerWithReg = new Scheduler({
        store: new InMemoryTaskStore(),
        eventBus,
        runAgentTurn: mockRunAgentTurn(),
        systemHandlers: buildSystemHandlers(),
        config: { minTickIntervalMs: 100, maxTickIntervalMs: 500 },
      });
      await schedulerWithReg.start();
      abortRun = async (runId) => runId === "task-42";
      const boundary = createScheduleBoundary({
        scheduler: schedulerWithReg,
        eventBus,
        abort: abortRun,
      });

      const ctx = createServerContext({
        config: { ...DEFAULT_SERVER_CONFIG, port: 0 },
        version: TEST_VERSION,
        token: TEST_TOKEN,
        productApi: boundary.productApi,
        conversations,
      });
      serverWithReg = await startServer({
        context: ctx,
        scheduleRuntimeEvents: boundary.runtime,
      });
    });

    afterEach(async () => {
      await serverWithReg.close();
      await schedulerWithReg.stop();
    });

    it("缺 runId → INVALID_PARAMS", async () => {
      const client = await connect(serverWithReg.port);
      await client.request("auth", { token: TEST_TOKEN });
      const r = await client.request("schedule.abortRun", {});
      expect(isErrorResponse(r)).toBe(true);
      if (isErrorResponse(r)) {
        expect(r.error.code).toBe(RPC_ERROR_CODES.INVALID_PARAMS);
      }
      client.close();
    });

    it("不存在的 runId → { aborted: false }(幂等,不抛)", async () => {
      const client = await connect(serverWithReg.port);
      await client.request("auth", { token: TEST_TOKEN });
      const r = await client.request("schedule.abortRun", { runId: "ghost" });
      expect(isSuccessResponse(r)).toBe(true);
      if (isSuccessResponse(r)) {
        expect(r.result).toEqual({ aborted: false });
      }
      client.close();
    });

    it("存在的 runId → { aborted: true }", async () => {
      const client = await connect(serverWithReg.port);
      await client.request("auth", { token: TEST_TOKEN });

      const r = await client.request("schedule.abortRun", { runId: "task-42" });
      expect(isSuccessResponse(r)).toBe(true);
      if (isSuccessResponse(r)) {
        expect(r.result).toEqual({ aborted: true });
      }
      client.close();
    });
  });
});
