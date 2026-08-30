/**
 * trust.* / skill.* 管理面方法契约 —— 薄壳直达目录、坏参数
 * fail-fast、skill 写后向全连接广播 skill.changed(携结构版本)。
 */

import { describe, expect, it, vi } from "vitest";
import type { TaskView } from "@zhixing/core";
import {
  createSkillCatalogProductApiContribution,
  SKILL_CATALOG_LIST_QUERY,
  SKILL_CATALOG_PRODUCT_API_EXACT_SET,
  SkillCatalogApplicationError,
  type SkillCatalogApplication,
} from "@zhixing/core/skills/catalog";
import {
  createTrustAdministrationProductApiContribution,
  TRUST_ADMINISTRATION_PRODUCT_API_EXACT_SET,
  TrustAdministrationApplicationError,
  type TrustAdministrationApplication,
} from "@zhixing/core/trust-administration";
import { ProductApiDispatcher } from "@zhixing/core/product-api";
import {
  createScheduleManagementProductApiContribution,
  SCHEDULE_MANAGEMENT_PRODUCT_API_EXACT_SET,
  ScheduleManagementApplicationError,
  ScheduleManagementApplicationService,
  type ScheduleManagementApplication,
  type ScheduleManagementRepository,
} from "@zhixing/core/scheduler/application";
import {
  buildTrustListMethod,
  buildTrustRevokeMethod,
} from "../methods/trust.js";
import {
  buildSkillListMethod,
  buildSkillSetStateMethod,
  buildSkillArchiveMethod,
} from "../methods/skill.js";
import {
  buildScheduleCreateMethod,
  buildScheduleAbortRunMethod,
  buildScheduleDeleteMethod,
  buildScheduleListMethod,
  buildScheduleRunMethod,
  buildScheduleUpdateMethod,
} from "../methods/schedule.js";
import { RpcDispatcher } from "../dispatcher.js";
import { HandlerRegistry } from "../handlers.js";
import { RPC_ERROR_CODES } from "../protocol.js";
import type { ServerContext } from "../../context.js";

function makeCtx(slots: {
  productApi?: ProductApiDispatcher;
  broadcastAll?: (method: string, params: unknown) => void;
}) {
  return {
    server: slots as unknown as ServerContext,
    connection: { id: 1 },
  } as never;
}

async function call(entry: { handler: (p: unknown, c: never) => unknown }, params: unknown, ctx: never) {
  return await entry.handler(params, ctx);
}

async function dispatchSkillRequest(input: {
  readonly method: string;
  readonly params?: unknown;
  readonly productApi: ProductApiDispatcher;
}) {
  const registry = new HandlerRegistry();
  registry.registerAll([
    buildSkillListMethod(),
    buildSkillSetStateMethod(),
    buildSkillArchiveMethod(),
  ]);
  const sendSuccess = vi.fn();
  const sendError = vi.fn();
  const dispatcher = new RpcDispatcher({
    registry,
    server: { productApi: input.productApi } as ServerContext,
  });
  await dispatcher.handleMessage({
    id: 1,
    authenticated: true,
    loopback: true,
    closed: false,
    clientInfo: { id: "skill-management-test" },
    sendSuccess,
    sendError,
    notify: vi.fn(),
    close: vi.fn(),
    onClose: () => () => undefined,
  }, JSON.stringify({
    jsonrpc: "2.0",
    id: "skill-wire",
    method: input.method,
    params: input.params,
  }));
  return { sendSuccess, sendError };
}

async function dispatchTrustRequest(input: {
  readonly method: string;
  readonly params?: unknown;
  readonly productApi: ProductApiDispatcher;
  readonly authenticated?: boolean;
}) {
  const registry = new HandlerRegistry();
  registry.registerAll([buildTrustListMethod(), buildTrustRevokeMethod()]);
  const sendSuccess = vi.fn();
  const sendError = vi.fn();
  const dispatcher = new RpcDispatcher({
    registry,
    server: { productApi: input.productApi } as ServerContext,
  });
  await dispatcher.handleMessage({
    id: 1,
    authenticated: input.authenticated ?? true,
    loopback: true,
    closed: false,
    clientInfo: { id: "trust-management-test" },
    sendSuccess,
    sendError,
    notify: vi.fn(),
    close: vi.fn(),
    onClose: () => () => undefined,
  }, JSON.stringify({
    jsonrpc: "2.0",
    id: "trust-wire",
    method: input.method,
    params: input.params,
  }));
  return { sendSuccess, sendError };
}

async function dispatchScheduleRequest(input: {
  readonly method: string;
  readonly params?: unknown;
  readonly application: ScheduleManagementApplication;
}) {
  const registry = new HandlerRegistry();
  registry.registerAll([
    buildScheduleListMethod(),
    buildScheduleCreateMethod(),
    buildScheduleUpdateMethod(),
    buildScheduleDeleteMethod(),
    buildScheduleRunMethod(),
    buildScheduleAbortRunMethod(),
  ]);
  const sendSuccess = vi.fn();
  const sendError = vi.fn();
  const dispatcher = new RpcDispatcher({
    registry,
    server: {
      productApi: new ProductApiDispatcher(
        SCHEDULE_MANAGEMENT_PRODUCT_API_EXACT_SET,
        [createScheduleManagementProductApiContribution(input.application)],
      ),
      conversations: {
        durableControlPrincipal: () => ({ deviceId: "device-1" }),
      },
    } as unknown as ServerContext,
  });
  await dispatcher.handleMessage({
    id: 1,
    authenticated: true,
    loopback: true,
    closed: false,
    clientInfo: { id: "schedule-management-test" },
    sendSuccess,
    sendError,
    notify: vi.fn(),
    close: vi.fn(),
    onClose: () => () => undefined,
  }, JSON.stringify({
    jsonrpc: "2.0",
    id: "schedule-wire",
    method: input.method,
    params: input.params,
  }));
  return { sendSuccess, sendError };
}

describe("trust.*", () => {
  function makeProductApi(
    application: TrustAdministrationApplication,
  ): ProductApiDispatcher {
    return new ProductApiDispatcher(TRUST_ADMINISTRATION_PRODUCT_API_EXACT_SET, [
      createTrustAdministrationProductApiContribution(application),
    ]);
  }

  function makeTrust(): TrustAdministrationApplication & { calls: unknown[] } {
    const calls: unknown[] = [];
    return {
      calls,
      async query(query) {
        calls.push(["query", query]);
        return { rules: [{ id: "r1", scope: "global" }] as never };
      },
      async execute(command) {
        calls.push(["execute", command]);
        if (command.ruleId === "ghost") {
          throw new TrustAdministrationApplicationError(
            "not-found",
            `Trust rule not found: ${command.ruleId}`,
          );
        }
        return {
          revoked: true,
          fact: {
            kind: "trust-administration-rule-revoked",
            ruleId: command.ruleId,
          },
        };
      },
    };
  }

  it("list/revoke 只经同一 Product API;不存在保持 NOT_FOUND", async () => {
    const rules = [{ id: "r1", scope: "global" }];
    const trust = makeTrust();
    const ctx = makeCtx({ productApi: makeProductApi(trust) });

    expect(await call(buildTrustListMethod(), {}, ctx)).toEqual({ rules });
    expect(await call(buildTrustRevokeMethod(), { ruleId: "r1" }, ctx)).toEqual({
      revoked: true,
    });
    await expect(
      call(buildTrustRevokeMethod(), { ruleId: "ghost" }, ctx),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.NOT_FOUND });
    await expect(
      call(buildTrustRevokeMethod(), {}, ctx),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
    expect(trust.calls).toEqual([
      ["query", { kind: "list", conversationId: undefined }],
      ["execute", { kind: "revoke", ruleId: "r1", conversationId: undefined }],
      ["execute", { kind: "revoke", ruleId: "ghost", conversationId: undefined }],
    ]);
  });

  it("fails closed when the Host did not contribute Trust Administration", async () => {
    await expect(call(buildTrustListMethod(), {}, makeCtx({})))
      .rejects.toMatchObject({
        code: RPC_ERROR_CODES.INTERNAL_ERROR,
        message: "Trust Administration application not configured on server",
      });
  });

  it("preserves authentication, wire results, invalid params, and not-found through the dispatcher", async () => {
    const productApi = makeProductApi(makeTrust());
    const unauthorized = await dispatchTrustRequest({
      method: "trust.list",
      productApi,
      authenticated: false,
    });
    expect(unauthorized.sendError).toHaveBeenCalledWith("trust-wire", {
      code: RPC_ERROR_CODES.UNAUTHORIZED,
      message: "Method requires authentication: trust.list",
      data: undefined,
    });

    const list = await dispatchTrustRequest({ method: "trust.list", productApi });
    expect(list.sendSuccess).toHaveBeenCalledWith("trust-wire", {
      rules: [{ id: "r1", scope: "global" }],
    });

    const invalid = await dispatchTrustRequest({
      method: "trust.revoke",
      params: {},
      productApi,
    });
    expect(invalid.sendError).toHaveBeenCalledWith("trust-wire", {
      code: RPC_ERROR_CODES.INVALID_PARAMS,
      message: "trust.revoke requires 'ruleId'",
      data: undefined,
    });

    const missing = await dispatchTrustRequest({
      method: "trust.revoke",
      params: { ruleId: "ghost" },
      productApi,
    });
    expect(missing.sendError).toHaveBeenCalledWith("trust-wire", {
      code: RPC_ERROR_CODES.NOT_FOUND,
      message: "Trust rule not found: ghost",
      data: undefined,
    });
  });
});

describe("skill.*", () => {
  function makeProductApi(application: SkillCatalogApplication): ProductApiDispatcher {
    return new ProductApiDispatcher(SKILL_CATALOG_PRODUCT_API_EXACT_SET, [
      createSkillCatalogProductApiContribution(application),
    ]);
  }

  function makeSkills(): SkillCatalogApplication & { calls: unknown[] } {
    const calls: unknown[] = [];
    let version = 7;
    return {
      calls,
      async query(query) {
        calls.push(["query", query]);
        return {
          entries: [{ id: "s1" }] as never,
          catalogRevision: version,
        };
      },
      async execute(command) {
        calls.push(["execute", command]);
        if (command.skillId === "ghost") {
          throw new SkillCatalogApplicationError(
            "not-found",
            `Skill not found: ${command.skillId}`,
          );
        }
        if (command.skillId === "conflict") {
          throw new SkillCatalogApplicationError("conflict", "Skill changed");
        }
        if (command.skillId === "failed") throw new Error("commit failed");
        version += 1;
        return {
          fact: {
            kind: "skill-catalog-changed",
            catalogRevision: version,
          },
        };
      },
    };
  }

  it("fails closed when the Host did not contribute the Skill Product API", async () => {
    await expect(call(buildSkillListMethod(), {}, makeCtx({}))).rejects.toMatchObject({
      code: RPC_ERROR_CODES.INTERNAL_ERROR,
      message: "Skill Catalog application not configured on server",
    });
  });

  it("list 返回管理视图与结构版本", async () => {
    const skills = makeSkills();
    const productApi = makeProductApi(skills);
    const ctx = makeCtx({ productApi });
    const direct = await productApi.query(SKILL_CATALOG_LIST_QUERY, { kind: "list" });
    expect(await call(buildSkillListMethod(), {}, ctx)).toEqual({
      skills: [{ id: "s1" }],
      structuralVersion: 7,
    });
    expect(direct).toEqual({ entries: [{ id: "s1" }], catalogRevision: 7 });
  });

  it("setState:patch 校验(空 patch / 坏类型 / 坏 mode 拒)、成功后广播 skill.changed 携新版本", async () => {
    const skills = makeSkills();
    const broadcastAll = vi.fn();
    const ctx = makeCtx({ productApi: makeProductApi(skills), broadcastAll });
    const method = buildSkillSetStateMethod();
    const command = {
      kind: "set-state" as const,
      skillId: "s1",
      patch: { pinned: true, mode: "work" as const },
    };
    await expect(makeSkills().execute(command)).resolves.toEqual({
      fact: { kind: "skill-catalog-changed", catalogRevision: 8 },
    });

    for (const bad of [
      {},
      { skillId: "s1" },
      { skillId: "s1", pinned: "yes" },
      { skillId: "s1", mode: "ghost-mode" },
      { skillId: "s1", mode: "all" }, // 非法值——SkillMode 只有 main / work
    ]) {
      await expect(call(method, bad, ctx)).rejects.toMatchObject({
        code: RPC_ERROR_CODES.INVALID_PARAMS,
      });
    }
    expect(broadcastAll).not.toHaveBeenCalled();

    await call(method, { skillId: "s1", pinned: true, mode: "work" }, ctx);
    expect(skills.calls).toEqual([["execute", command]]);
    expect(broadcastAll).toHaveBeenCalledWith("skill.changed", {
      structuralVersion: 8,
    });

    await expect(
      call(method, { skillId: "ghost", disabled: true }, ctx),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.NOT_FOUND });
    await expect(makeSkills().execute({
      kind: "set-state",
      skillId: "ghost",
      patch: { disabled: true },
    })).rejects.toMatchObject({ code: "not-found" });
    await expect(
      call(method, { skillId: "conflict", disabled: true }, ctx),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      call(method, { skillId: "failed", disabled: true }, ctx),
    ).rejects.toThrow("commit failed");
    expect(broadcastAll).toHaveBeenCalledTimes(1);
  });

  it("archive:成功广播、不存在 NOT_FOUND 不广播", async () => {
    const skills = makeSkills();
    const broadcastAll = vi.fn();
    const ctx = makeCtx({ productApi: makeProductApi(skills), broadcastAll });
    await expect(makeSkills().execute({
      kind: "archive",
      skillId: "s1",
    })).resolves.toEqual({
      fact: { kind: "skill-catalog-changed", catalogRevision: 8 },
    });

    await call(buildSkillArchiveMethod(), { skillId: "s1" }, ctx);
    expect(broadcastAll).toHaveBeenCalledTimes(1);

    await expect(
      call(buildSkillArchiveMethod(), { skillId: "ghost" }, ctx),
    ).rejects.toMatchObject({ code: RPC_ERROR_CODES.NOT_FOUND });
    expect(broadcastAll).toHaveBeenCalledTimes(1);
  });

  it("preserves all three methods and pre-migration errors through the real dispatcher", async () => {
    const skills = makeSkills();

    const list = await dispatchSkillRequest({
      method: "skill.list",
      productApi: makeProductApi(skills),
    });
    expect(list.sendSuccess).toHaveBeenCalledWith("skill-wire", {
      skills: [{ id: "s1" }],
      structuralVersion: 7,
    });

    const setState = await dispatchSkillRequest({
      method: "skill.setState",
      params: { skillId: "s1", pinned: true },
      productApi: makeProductApi(skills),
    });
    expect(setState.sendSuccess).toHaveBeenCalledWith("skill-wire", { ok: true });

    const archive = await dispatchSkillRequest({
      method: "skill.archive",
      params: { skillId: "s1" },
      productApi: makeProductApi(skills),
    });
    expect(archive.sendSuccess).toHaveBeenCalledWith("skill-wire", { ok: true });

    const invalid = await dispatchSkillRequest({
      method: "skill.setState",
      params: { skillId: "s1" },
      productApi: makeProductApi(skills),
    });
    expect(invalid.sendError).toHaveBeenCalledWith("skill-wire", {
      code: RPC_ERROR_CODES.INVALID_PARAMS,
      message: "skill.setState requires at least one of: pinned / disabled / mode",
      data: undefined,
    });

    const notFound = await dispatchSkillRequest({
      method: "skill.archive",
      params: { skillId: "ghost" },
      productApi: makeProductApi(skills),
    });
    expect(notFound.sendError).toHaveBeenCalledWith("skill-wire", {
      code: RPC_ERROR_CODES.NOT_FOUND,
      message: "Skill not found: ghost",
      data: undefined,
    });

    const conflict = await dispatchSkillRequest({
      method: "skill.setState",
      params: { skillId: "conflict", disabled: true },
      productApi: makeProductApi(skills),
    });
    expect(conflict.sendError).toHaveBeenCalledWith("skill-wire", {
      code: RPC_ERROR_CODES.INTERNAL_ERROR,
      message: "Internal error",
      data: { message: "Skill changed" },
    });

    const commitFailure = await dispatchSkillRequest({
      method: "skill.archive",
      params: { skillId: "failed" },
      productApi: makeProductApi(skills),
    });
    expect(commitFailure.sendError).toHaveBeenCalledWith("skill-wire", {
      code: RPC_ERROR_CODES.INTERNAL_ERROR,
      message: "Internal error",
      data: { message: "commit failed" },
    });
  });
});

describe("schedule management Product API", () => {
  const task: TaskView = {
    id: "task-1",
    taskRevision: 2,
    name: "morning",
    enabled: true,
    priority: "normal" as const,
    schedule: { kind: "interval" as const, everyMs: 60_000 },
    action: { kind: "agent-turn" as const, prompt: "work" },
    state: { consecutiveErrors: 0, runCount: 0 },
    createdAt: "2026-08-30T00:00:00.000Z",
    updatedAt: "2026-08-30T00:00:00.000Z",
  };

  function makeApplication(): ScheduleManagementApplication & { calls: unknown[] } {
    const calls: unknown[] = [];
    return {
      calls,
      async query(query) {
        calls.push(["query", query]);
        return { tasks: [task] };
      },
      async execute(command) {
        calls.push(["execute", command]);
        if ("taskId" in command && command.taskId === "missing") {
          throw new ScheduleManagementApplicationError(
            "not-found",
            "Task not found: missing",
          );
        }
        if (command.kind === "create") return { kind: "created", task };
        if (command.kind === "update") return { kind: "updated", task };
        if (command.kind === "delete") return { kind: "deleted", taskId: command.taskId };
        if (command.kind === "run") {
          return {
            kind: "ran",
            result: { status: "ok", output: "ran", durationMs: 3 },
          };
        }
        return { kind: "run-aborted", runId: command.runId, aborted: command.runId !== "ghost" };
      },
    };
  }

  function makeRealApplication(initial: readonly TaskView[] = []) {
    const tasks = new Map(initial.map((entry) => [entry.id, structuredClone(entry)]));
    const repository: ScheduleManagementRepository = {
      list: async () => [...tasks.values()].map((entry) => structuredClone(entry)),
      find: async (taskId) => {
        const entry = tasks.get(taskId);
        return entry ? structuredClone(entry) : undefined;
      },
      commitCreate: async ({ spec }) => ({
        ...structuredClone(task),
        id: "created",
        ...structuredClone(spec),
      }),
      commitUpdate: async ({ taskId, spec, operation }) => ({
        ...structuredClone(tasks.get(taskId)!),
        ...structuredClone(spec),
        taskRevision: operation.expectedRevision + 1,
      }),
      commitDelete: async ({ taskId }) => {
        if (!tasks.has(taskId)) throw new Error(`Task not found: ${taskId}`);
        tasks.delete(taskId);
      },
    };
    return new ScheduleManagementApplicationService(repository, {
      run: async () => ({ status: "ok", output: "ran", durationMs: 3 }),
      abort: async ({ runId }) => runId !== "ghost",
    });
  }

  function makeScheduleContext(application: ScheduleManagementApplication) {
    const productApi = new ProductApiDispatcher(
      SCHEDULE_MANAGEMENT_PRODUCT_API_EXACT_SET,
      [createScheduleManagementProductApiContribution(application)],
    );
    return {
      server: {
        productApi,
        conversations: {
          durableControlPrincipal: () => ({ deviceId: "device-1" }),
        },
      } as unknown as ServerContext,
      connection: {
        id: 7,
        clientInfo: { id: "schedule-management-test" },
      },
    } as never;
  }

  it("binds all six operations only through one dispatcher and stable surface identity", async () => {
    const application = makeApplication();
    const ctx = makeScheduleContext(application);
    await expect(call(buildScheduleListMethod(), {}, ctx)).resolves.toEqual([task]);
    await expect(call(buildScheduleCreateMethod(), {
      requestId: "create-1",
      name: "morning",
      schedule: task.schedule,
      action: task.action,
    }, ctx)).resolves.toEqual(task);
    await expect(call(buildScheduleUpdateMethod(), {
      requestId: "update-1",
      id: task.id,
      taskRevision: 2,
      patch: { enabled: false },
    }, ctx)).resolves.toEqual(task);
    await expect(call(buildScheduleDeleteMethod(), {
      requestId: "delete-1",
      id: task.id,
      taskRevision: 2,
    }, ctx)).resolves.toBeUndefined();
    await expect(call(buildScheduleRunMethod(), {
      requestId: "run-1",
      id: task.id,
    }, ctx)).resolves.toEqual({ status: "ok", output: "ran", durationMs: 3 });
    await expect(call(buildScheduleAbortRunMethod(), {
      requestId: "abort-1",
      runId: "job-1",
    }, ctx)).resolves.toEqual({ aborted: true });

    expect(application.calls).toMatchObject([
      ["query", { kind: "list" }],
      ["execute", {
        kind: "create",
        draft: { name: "morning" },
        operation: {
          operationId: "create-1",
          surface: {
            surfacePrincipal: "rpc:schedule-management-test",
            connectionId: "7",
            deviceId: "device-1",
          },
        },
      }],
      ["execute", { kind: "update", taskId: "task-1" }],
      ["execute", { kind: "delete", taskId: "task-1" }],
      ["execute", {
        kind: "run",
        taskId: "task-1",
        operation: { operationId: "run-1" },
      }],
      ["execute", {
        kind: "abort-run",
        runId: "job-1",
        operation: { operationId: "abort-1" },
      }],
    ]);
  });

  it("preserves run not-found and idempotent ghost abort through the real dispatcher", async () => {
    const application = makeRealApplication([task]);
    const runMissing = await dispatchScheduleRequest({
      method: "schedule.run",
      params: { requestId: "run-missing", id: "missing" },
      application,
    });
    expect(runMissing.sendError).toHaveBeenCalledWith("schedule-wire", {
      code: RPC_ERROR_CODES.NOT_FOUND,
      message: "Task not found: missing",
    });

    const abortGhost = await dispatchScheduleRequest({
      method: "schedule.abortRun",
      params: { requestId: "abort-ghost", runId: "ghost" },
      application,
    });
    expect(abortGhost.sendSuccess).toHaveBeenCalledWith("schedule-wire", {
      aborted: false,
    });

    const systemTask: TaskView = {
      ...task,
      id: "system",
      system: true,
      action: { kind: "system", handler: "__transcript-gc" },
    };
    const runSystem = await dispatchScheduleRequest({
      method: "schedule.run",
      params: { requestId: "run-system", id: "system" },
      application: makeRealApplication([systemTask]),
    });
    expect(runSystem.sendError).toHaveBeenCalledWith("schedule-wire", {
      code: RPC_ERROR_CODES.INTERNAL_ERROR,
      message: "Internal error",
      data: { message: "Cannot modify system task: system" },
    });
  });

  it("preserves binding errors and fails closed without the contribution", async () => {
    const application = makeApplication();
    const ctx = makeScheduleContext(application);
    await expect(call(buildScheduleCreateMethod(), {
      requestId: "bad",
      name: "morning",
    }, ctx)).rejects.toMatchObject({ code: RPC_ERROR_CODES.INVALID_PARAMS });
    await expect(call(buildScheduleDeleteMethod(), {
      requestId: "missing-1",
      id: "missing",
      taskRevision: 1,
    }, ctx)).rejects.toMatchObject({ code: RPC_ERROR_CODES.NOT_FOUND });
    await expect(call(buildScheduleListMethod(), {}, makeCtx({})))
      .rejects.toMatchObject({
        code: RPC_ERROR_CODES.INTERNAL_ERROR,
        message: "Schedule management application not configured on server",
      });
  });

  it("preserves the pre-migration update/delete generic errors and create validation error", async () => {
    const systemTask: TaskView = {
      ...task,
      id: "system",
      system: true,
      action: { kind: "system", handler: "__transcript-gc" },
    };
    for (const method of ["schedule.update", "schedule.delete"] as const) {
      const params = method === "schedule.update"
        ? {
            requestId: `${method}-system`,
            id: "system",
            taskRevision: 2,
            patch: { enabled: false },
          }
        : {
            requestId: `${method}-system`,
            id: "system",
            taskRevision: 2,
          };
      const result = await dispatchScheduleRequest({
        method,
        params,
        application: makeRealApplication([systemTask]),
      });
      expect(result.sendError).toHaveBeenCalledWith("schedule-wire", {
        code: RPC_ERROR_CODES.INTERNAL_ERROR,
        message: "Internal error",
        data: { message: "Cannot modify system task: system" },
      });
    }

    const invalidUpdate = await dispatchScheduleRequest({
      method: "schedule.update",
      params: {
        requestId: "update-invalid",
        id: task.id,
        taskRevision: 2,
        patch: { name: "" },
      },
      application: makeRealApplication([task]),
    });
    expect(invalidUpdate.sendError).toHaveBeenCalledWith("schedule-wire", {
      code: RPC_ERROR_CODES.INTERNAL_ERROR,
      message: "Internal error",
      data: { message: "Schedule task name must be a bounded string" },
    });

    for (const method of ["schedule.update", "schedule.delete"] as const) {
      const params = method === "schedule.update"
        ? {
            requestId: `${method}-empty`,
            id: "",
            taskRevision: 1,
            patch: { enabled: false },
          }
        : {
            requestId: `${method}-empty`,
            id: "",
            taskRevision: 1,
          };
      const result = await dispatchScheduleRequest({
        method,
        params,
        application: makeRealApplication(),
      });
      expect(result.sendError).toHaveBeenCalledWith("schedule-wire", {
        code: RPC_ERROR_CODES.NOT_FOUND,
        message: "Task not found: ",
      });
    }

    const invalidCreate = await dispatchScheduleRequest({
      method: "schedule.create",
      params: {
        requestId: "create-invalid",
        name: "invalid",
        schedule: { kind: "interval", everyMs: 0 },
        action: { kind: "agent-turn", prompt: "work" },
      },
      application: makeRealApplication(),
    });
    expect(invalidCreate.sendError).toHaveBeenCalledWith("schedule-wire", {
      code: RPC_ERROR_CODES.INVALID_PARAMS,
      message: "schedule.create is invalid: Schedule interval must be a positive safe integer",
    });
  });
});

describe("isLoopbackAddress(信任级判定要素)", () => {
  it("IPv4 127/8、IPv6 ::1 及 IPv4 映射为 loopback;其余与空值不是", async () => {
    const { isLoopbackAddress } = await import("../connection.js");
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("127.8.8.8")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("192.168.1.2")).toBe(false);
    expect(isLoopbackAddress("::ffff:192.168.1.2")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});
