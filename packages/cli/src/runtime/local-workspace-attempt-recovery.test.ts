import { mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  ImmediateRootReservationInspection,
  ResourceReservationPort,
  SecretRef,
  SecretStorePort,
  WorkspaceBindingAdminPort,
} from "@zhixing-ai/core/contracts";
import { localEnvironmentControlSubject } from "@zhixing-ai/core/environment";
import { protocolDigest } from "@zhixing-ai/core/protocol";
import { createTempDir } from "@zhixing-ai/test-utils";
import { setupAuthorityRuntime } from "../setup-delivery.js";
import { createDeviceCapacityRuntime } from "../serve/device-capacity-runtime.js";
import {
  createLocalWorkspaceClient,
  createLocalWorkspaceManagementHost,
  readLocalWorkspaceHostStatus,
} from "./local-workspace-management-host.js";
import { LocalWorkspaceOperationOutbox } from "./local-workspace-operation-outbox.js";
import { acquireLocalWorkspaceOwner } from "./local-workspace-owner.js";
import { useLocalWorkspaceClient } from "./workspace-command.js";

vi.setConfig({ testTimeout: 120_000 });

// 治理器只给自己的执行器签发租约，宿主装配要用同一个执行器身份
const EXECUTOR_ID = "executor:workspace-attempt-test";

const TEST_EXECUTOR_READINESS = {
  tools: [] as string[],
  mcpServers: [] as string[],
  credentialBindings: [],
  deviceScopedCredentialBindingIds: [] as string[],
  credentialGeneration: null,
};

/**
 * 中断点。before-acquire/queued/acquired/effect：进程在这一步之后“消失”，此后它的任何调用都不再生效；
 * fault-*：进程还活着，绑定操作在效果前或效果后抛出宿主内异常（Z46 那类），控制适配器照常结算释放资源根；
 * retryable 时异常是一次可恢复的 I/O 故障（EBUSY），生命周期在同一进程里重试。
 * complete-fault：效果之后、结果落盘时 outbox 的存储维护许可被背压一次（可恢复）。
 */
type Cut =
  | { readonly at: "before-acquire" | "queued" | "acquired" }
  | {
      readonly at: "effect" | "fault-before-effect" | "fault-after-effect" | "complete-fault";
      readonly method: "create" | "update" | "remove";
      readonly retryable?: true;
    };

class ProcessGone extends Error {
  constructor() {
    super("模拟进程中断");
  }
}

/**
 * 真实装配（executor 角色的真实治理器、绑定权威与目录，真实 outbox、生命周期、宿主与客户端），
 * 只在资源端口与绑定端口外包一层中断注入。“重启”关闭宿主与整个运行时，再在同一 home 上重新装配。
 */
async function boot(home: string, secretStore: SecretStorePort, cut?: Cut, target?: string, clock?: () => string) {
  const capacity = createDeviceCapacityRuntime(path.join(home, "capacity"));
  const runtime = await setupAuthorityRuntime({
    zhixingHome: home,
    secretStore,
    executorReadiness: TEST_EXECUTOR_READINESS,
    executorId: EXECUTOR_ID,
    enableAnchor: false,
    enableLocalExecutor: true,
    deviceCapacity: capacity.arbiter,
    storageMaintenance: capacity.storage,
    ...(clock ? { clock } : {}),
  });
  // 结果落盘切点：目标效果之后，outbox 的下一次存储维护许可被背压一次
  let failNextOutboxStep = false;
  const storageMaintenance: typeof capacity.storage = Object.assign(Object.create(capacity.storage) as typeof capacity.storage, {
    acquire: async (request: Parameters<typeof capacity.storage.acquire>[0], abort: AbortSignal) => {
      if (failNextOutboxStep && request.kind === "local-workspace-operation-outbox") {
        failNextOutboxStep = false;
        return { kind: "backpressured", blockedBy: { kind: "storage" }, retryAfterMs: 0 } as never;
      }
      return capacity.storage.acquire(request, abort);
    },
    snapshot: () => capacity.storage.snapshot(),
  });
  const governor = runtime.executorResourceGovernor;
  const admin = runtime.workspaceBindingAdmin!;
  let gone = false;
  let fired = false;
  // 只有目标操作的那次执行会被中断：控制主体在取根时出现，之后同一主体的调用随进程一起消失
  let armedSubject: string | undefined;
  const alive = () => {
    if (gone) throw new ProcessGone();
  };
  const crash = (): never => {
    gone = true;
    fired = true;
    throw new ProcessGone();
  };
  const fault = (): never => {
    fired = true;
    if (cut && "retryable" in cut && cut.retryable) {
      throw Object.assign(new Error("模拟一次可恢复的 I/O 故障"), { code: "EBUSY" });
    }
    throw new Error("模拟宿主内异常");
  };
  const resources: Pick<ResourceReservationPort, "acquireRoot" | "settle" | "release" | "inspectImmediateRoot"> &
    { reclaimExpired(): Promise<number> } = {
    reclaimExpired: async () => {
      alive();
      return governor.reclaimExpired();
    },
    inspectImmediateRoot: async (workload) => {
      alive();
      return governor.inspectImmediateRoot(workload);
    },
    acquireRoot: async (...args) => {
      alive();
      const [workload, , origin, ctx] = args;
      const targeted = cut !== undefined && armedSubject === undefined && await isTarget(workload.id);
      if (targeted) armedSubject = workload.id;
      if (targeted && cut.at === "before-acquire") crash();
      if (targeted && cut.at === "queued") {
        await governor.enqueueRoot(immediateReservationId(workload), workload, origin, ctx);
        crash();
      }
      const lease = await governor.acquireRoot(...args);
      if (targeted && cut.at === "acquired") crash();
      return lease;
    },
    settle: async (...args) => {
      alive();
      return governor.settle(...args);
    },
    release: async (...args) => {
      alive();
      return governor.release(...args);
    },
  };
  const effect = <K extends "create" | "update" | "remove">(method: K) =>
    (async (...args: Parameters<WorkspaceBindingAdminPort[K]>) => {
      alive();
      const control = args.at(-1) as { readonly requestId: string };
      // 每个切点只触发一次：之后的恢复执行照常进行
      const armed = !fired && cut !== undefined && "method" in cut && cut.method === method &&
        control.requestId === armedSubject;
      if (armed && cut.at === "fault-before-effect") fault();
      const result = await (admin[method] as (...input: unknown[]) => Promise<unknown>).apply(admin, args);
      if (armed && cut.at === "effect") crash();
      if (armed && cut.at === "fault-after-effect") fault();
      if (armed && cut.at === "complete-fault") {
        fired = true;
        failNextOutboxStep = true;
      }
      return result;
    }) as WorkspaceBindingAdminPort[K];
  const wrappedAdmin: WorkspaceBindingAdminPort = {
    list: async (control) => {
      alive();
      return admin.list(control);
    },
    requestOutcome: async (control) => {
      alive();
      return admin.requestOutcome(control);
    },
    create: effect("create"),
    update: effect("update"),
    remove: effect("remove"),
  };
  const outboxRoot = path.join(home, "runtime", "local-workspace-operation-outbox");
  // 中断目标按操作输入识别：取根时的主体由 outbox 里该输入的操作身份导出
  async function isTarget(subject: string): Promise<boolean> {
    if (target === undefined) return false;
    const page = await new LocalWorkspaceOperationOutbox({ rootDir: outboxRoot }).pending();
    return page.operations.some((operation) =>
      operationSubject(runtime.deviceId, page.outboxId, operation) === subject &&
      JSON.stringify(operation.input).includes(JSON.stringify(target)));
  }
  if (cut !== undefined && "method" in cut) {
    // 效果与异常切点不在取根时中断，只在取根时记下目标主体
    const acquire = resources.acquireRoot;
    resources.acquireRoot = async (...args) => {
      if (armedSubject === undefined && await isTarget(args[0].id)) armedSubject = args[0].id;
      return acquire(...args);
    };
  }
  const lease = await acquireLocalWorkspaceOwner(home);
  const host = createLocalWorkspaceManagementHost({
    lease,
    zhixingHome: home,
    management: {
      deviceId: runtime.deviceId,
      executorId: EXECUTOR_ID,
      admin: wrappedAdmin,
      recovery: runtime.workspaceBindingRecovery!,
      resources,
    },
    storageMaintenance,
  });
  await host.start();
  return {
    runtime,
    governor,
    deviceId: runtime.deviceId,
    gone: () => gone,
    fired: () => fired,
    subject: () => armedSubject,
    async stop() {
      try {
        await host.close().catch(() => undefined);
        await lease.release();
        await runtime.startupCleanup.run();
      } finally {
        capacity.close();
      }
    },
  };
}

type Booted = Awaited<ReturnType<typeof boot>>;

function operationSubject(
  deviceId: string,
  outboxId: string,
  operation: { readonly localSeq: number; readonly operationId: string; readonly inputDigest: string },
): string {
  return localEnvironmentControlSubject(deviceId, [
    "workspace-operation",
    outboxId,
    operation.localSeq,
    operation.operationId,
    operation.inputDigest,
  ].join(":"));
}

function immediateReservationId(workload: { readonly kind: "control"; readonly id: string; readonly attempt: number }): string {
  return `reservation:${protocolDigest("ImmediateResourceReservation", 1, workload).slice("sha256:".length)}`;
}

/** 走一次真实客户端写入：恢复结果先交付，再交付本次结果，并记下顺序。 */
async function write<T>(
  home: string,
  operation: (workspace: ReturnType<typeof createLocalWorkspaceClient>) => Promise<T>,
) {
  const delivered: string[] = [];
  const value = await useLocalWorkspaceClient(createLocalWorkspaceClient(home), operation, {
    result: async (result) => {
      delivered.push("result");
      return result;
    },
    recovered: async (operations) => {
      delivered.push(...operations.map((item) => `recovered:${item.operation}:${item.target}:${item.outcome}`));
    },
    failure: async (error) => {
      delivered.push(`failure:${error.code}`);
    },
  });
  return { value, delivered };
}

/**
 * 该操作各尝试号的资源根状态，到第一个从未取过的尝试为止（含它）。
 * 期望：全部终态，没有活动、排队或结算未释放的残留，也没有跳号。
 */
async function attemptRoots(booted: Booted, subject: string | undefined): Promise<readonly string[]> {
  if (!subject) throw new Error("中断目标没有被取根，切点没有生效");
  const roots: string[] = [];
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const inspection: ImmediateRootReservationInspection =
      await booted.governor.inspectImmediateRoot({ kind: "control", id: subject, attempt });
    roots.push(inspection.kind === "reservation" ? inspection.state : inspection.kind);
    if (inspection.kind === "absent") break;
  }
  return roots;
}

async function workspaceDir(home: string, name: string): Promise<string> {
  const dir = path.join(home, "dirs", name);
  await mkdir(dir, { recursive: true });
  return dir;
}

describe("本机工作区已提交操作的耐久执行尝试（真实装配）", () => {
  it("四个中断点各自重启恢复：效果只一次、各尝试资源根收敛、恢复结果先交付、后续写入成功", async () => {
    const home = await createTempDir("workspace-attempt-cuts");
    const secretStore = new MemorySecretStore();
    // 没取过或仍在排队的尝试沿用（排队项被这次取根消化）；取过的先收敛再推进到下一号。
    // fault-* 是旧实现永久卡住的现场：资源根已结算释放、结果没落盘
    const expectations = [
      { cut: { at: "fault-after-effect", method: "create" } as const, roots: ["released", "released", "absent"] },
      { cut: { at: "fault-before-effect", method: "create" } as const, roots: ["released", "released", "absent"] },
      { cut: { at: "before-acquire" } as const, roots: ["released", "absent"] },
      { cut: { at: "queued" } as const, roots: ["released", "absent"] },
      { cut: { at: "acquired" } as const, roots: ["released", "released", "absent"] },
      { cut: { at: "effect", method: "create" } as const, roots: ["released", "released", "absent"] },
    ];
    for (const { cut, roots } of expectations) {
      const name = `cut-${cut.at}`;
      const dir = await workspaceDir(home, name);
      const crashed = await boot(home, secretStore, cut, name);
      let subject: string | undefined;
      try {
        await expect(write(home, (workspace) => workspace.create(name, dir))).rejects.toThrow();
        expect(crashed.fired()).toBe(true);
        subject = crashed.subject();
      } finally {
        await crashed.stop();
      }

      const restarted = await boot(home, secretStore);
      try {
        const next = await write(home, async (workspace) => workspace.create(`after-${cut.at}`, await workspaceDir(home, `after-${cut.at}`)));
        expect(next.delivered).toEqual([`recovered:create:${name}:succeeded`, "result"]);
        const listed = await write(home, (workspace) => workspace.list());
        expect(listed.value.filter((view) => view.name === name)).toHaveLength(1);
        await expect(attemptRoots(restarted, subject), cut.at).resolves.toEqual(roots);
      } finally {
        await restarted.stop();
      }
    }
  });

  it("同一宿主里可恢复故障（效果前、效果后、结果落盘前）：重试推进新尝试，同一次写入完成，效果只一次", async () => {
    const home = await createTempDir("workspace-attempt-transient");
    const secretStore = new MemorySecretStore();
    const cases = [
      { cut: { at: "fault-before-effect", method: "create", retryable: true } as const },
      { cut: { at: "fault-after-effect", method: "create", retryable: true } as const },
      { cut: { at: "complete-fault", method: "create" } as const },
    ];
    for (const { cut } of cases) {
      const name = `transient-${cut.at}`;
      const dir = await workspaceDir(home, name);
      // 先让尝试 1 在宿主内异常后已结算释放、结果未落盘
      const first = await boot(home, secretStore, { at: "fault-after-effect", method: "create" }, name);
      let subject: string | undefined;
      try {
        await expect(write(home, (workspace) => workspace.create(name, dir)), cut.at).rejects.toThrow();
        subject = first.subject();
      } finally {
        await first.stop();
      }
      // 重启后推进到尝试 2，尝试 2 真实进入效果时再遇一次可恢复故障
      const booted = await boot(home, secretStore, cut, name);
      try {
        const next = await write(home, async (workspace) => workspace.create(`after-${name}`, await workspaceDir(home, `after-${name}`)));
        expect(next.delivered, cut.at).toEqual([`recovered:create:${name}:succeeded`, "result"]);
        expect(booted.fired(), cut.at).toBe(true);
        const views = (await write(home, (workspace) => workspace.list())).value;
        expect(views.filter((view) => view.name === name), cut.at).toHaveLength(1);
        await expect(attemptRoots(booted, subject), cut.at).resolves.toEqual(["released", "released", "released", "absent"]);
        await expect(readLocalWorkspaceHostStatus(home), cut.at).resolves.toEqual({ state: "ready" });
      } finally {
        await booted.stop();
      }
    }
  });

  it("上一尝试的活动根租约已过期、没有完整宿主的后台恢复：本路径按治理器到期回收收束，原根终态，后续读写可用", async () => {
    const home = await createTempDir("workspace-attempt-expired-leftover");
    const secretStore = new MemorySecretStore();
    const dir = await workspaceDir(home, "expired");
    // 上一个进程的时钟早 20 分钟：它取到的根租约（15 分钟）到这次启动时已过期
    const earlier = () => new Date(Date.now() - 20 * 60_000).toISOString();
    const crashed = await boot(home, secretStore, { at: "acquired" }, "expired", earlier);
    let subject: string | undefined;
    try {
      await expect(write(home, (workspace) => workspace.create("expired", dir))).rejects.toThrow();
      subject = crashed.subject();
    } finally {
      await crashed.stop();
    }
    const restarted = await boot(home, secretStore);
    try {
      const next = await write(home, async (workspace) => workspace.create("after-expired", await workspaceDir(home, "after-expired")));
      expect(next.delivered).toEqual(["recovered:create:expired:succeeded", "result"]);
      await expect(attemptRoots(restarted, subject)).resolves.toEqual(["reclaimed", "released", "absent"]);
      const views = (await write(home, (workspace) => workspace.list())).value;
      expect(views.map((view) => view.name).sort()).toEqual(["after-expired", "expired"]);
      await expect(readLocalWorkspaceHostStatus(home)).resolves.toEqual({ state: "ready" });
    } finally {
      await restarted.stop();
    }
  });

  it("改名、改目录、移除在效果生效后中断：重放按稳定主体取回原结果，不误报找不到", async () => {
    const home = await createTempDir("workspace-attempt-replay");
    const secretStore = new MemorySecretStore();
    const setup = await boot(home, secretStore);
    try {
      for (const name of ["rename-me", "repath-me", "remove-me"]) {
        await write(home, async (workspace) => workspace.create(name, await workspaceDir(home, name)));
      }
    } finally {
      await setup.stop();
    }
    const newDir = await workspaceDir(home, "repath-target");
    const cases = [
      {
        target: "rename-me",
        method: "update" as const,
        run: (workspace: ReturnType<typeof createLocalWorkspaceClient>) => workspace.rename("rename-me", "renamed", 1),
        notice: "recovered:rename:rename-me:succeeded",
        check: (names: readonly string[]) => expect(names).toContain("renamed"),
      },
      {
        target: "repath-me",
        method: "update" as const,
        run: (workspace: ReturnType<typeof createLocalWorkspaceClient>) => workspace.repath("repath-me", newDir, 1),
        notice: "recovered:repath:repath-me:succeeded",
        check: () => undefined,
      },
      {
        target: "remove-me",
        method: "remove" as const,
        run: (workspace: ReturnType<typeof createLocalWorkspaceClient>) => workspace.remove("remove-me", 1),
        notice: "recovered:remove:remove-me:succeeded",
        check: (names: readonly string[]) => expect(names).not.toContain("remove-me"),
      },
    ];
    for (const item of cases) {
      const crashed = await boot(home, secretStore, { at: "effect", method: item.method }, item.target);
      let subject: string | undefined;
      try {
        await expect(write(home, item.run)).rejects.toThrow();
        expect(crashed.fired()).toBe(true);
        subject = crashed.subject();
      } finally {
        await crashed.stop();
      }
      const restarted = await boot(home, secretStore);
      try {
        const next = await write(home, async (workspace) => workspace.create(`after-${item.target}`, await workspaceDir(home, `after-${item.target}`)));
        expect(next.delivered).toEqual([item.notice, "result"]);
        const names = (await write(home, (workspace) => workspace.list())).value.map((view) => view.name);
        item.check(names);
        await expect(attemptRoots(restarted, subject), item.target).resolves.toEqual(["released", "released", "absent"]);
      } finally {
        await restarted.stop();
      }
    }
    const final = await boot(home, secretStore);
    try {
      const views = (await write(home, (workspace) => workspace.list())).value;
      expect(views.find((view) => view.name === "repath-me")).toMatchObject({ path: newDir, revision: 2 });
      expect(views.find((view) => view.name === "renamed")).toMatchObject({ revision: 2 });
    } finally {
      await final.stop();
    }
  });

  it("同一操作连续两次中断（取根后、效果后）再恢复：效果只一次，三个尝试的根都收敛", async () => {
    const home = await createTempDir("workspace-attempt-twice");
    const secretStore = new MemorySecretStore();
    const dir = await workspaceDir(home, "twice");
    const first = await boot(home, secretStore, { at: "acquired" }, "twice");
    let subject: string | undefined;
    try {
      await expect(write(home, (workspace) => workspace.create("twice", dir))).rejects.toThrow();
      subject = first.subject();
    } finally {
      await first.stop();
    }
    // 第二次进程一启动就排空这个操作，并在效果生效后中断
    const second = await boot(home, secretStore, { at: "effect", method: "create" }, "twice");
    try {
      await vi.waitFor(() => expect(second.fired()).toBe(true), { timeout: 30_000 });
    } finally {
      await second.stop();
    }
    const third = await boot(home, secretStore);
    try {
      const next = await write(home, async (workspace) => workspace.create("after-twice", await workspaceDir(home, "after-twice")));
      expect(next.delivered).toEqual(["recovered:create:twice:succeeded", "result"]);
      const views = (await write(home, (workspace) => workspace.list())).value;
      expect(views.filter((view) => view.name === "twice")).toHaveLength(1);
      await expect(attemptRoots(third, subject)).resolves.toEqual(["released", "released", "released", "absent"]);
    } finally {
      await third.stop();
    }
  });

  it("第 10 次及以后的写操作照常执行：操作主体随序号变长超过 256 字符，治理器调用标识仍有界", async () => {
    const home = await createTempDir("workspace-attempt-long-subject");
    const booted = await boot(home, new MemorySecretStore());
    try {
      for (let index = 1; index <= 11; index += 1) {
        const name = `seq-${index}`;
        const created = await write(home, async (workspace) => workspace.create(name, await workspaceDir(home, name)));
        expect(created.value).toMatchObject({ name });
      }
      const views = (await write(home, (workspace) => workspace.list())).value;
      expect(views.filter((view) => view.name.startsWith("seq-"))).toHaveLength(11);
    } finally {
      await booted.stop();
    }
  });

  it("启动排空进行中同时查看：两边各自取根结算释放互不干扰", async () => {
    const home = await createTempDir("workspace-attempt-concurrent-read");
    const secretStore = new MemorySecretStore();
    for (let round = 1; round <= 3; round += 1) {
      const name = `concurrent-${round}`;
      const dir = await workspaceDir(home, name);
      const crashed = await boot(home, secretStore, { at: "fault-after-effect", method: "create" }, name);
      try {
        await expect(write(home, (workspace) => workspace.create(name, dir))).rejects.toThrow();
      } finally {
        await crashed.stop();
      }
      const restarted = await boot(home, secretStore);
      try {
        // 宿主启动即开始排空；排空期间做一次查看（离线一次性命令的真实形状）
        const read = await createLocalWorkspaceClient(home).list().then(
          (views) => ({ ok: true as const, views }),
          (error: unknown) => ({ ok: false as const, error: String(error) }),
        );
        expect(read, `round ${round}`).toEqual({ ok: true, views: expect.anything() });
        const next = await write(home, async (workspace) => workspace.create(`after-${name}`, await workspaceDir(home, `after-${name}`)));
        expect(next.delivered).toEqual([`recovered:create:${name}:succeeded`, "result"]);
      } finally {
        await restarted.stop();
      }
    }
  });

  it("已完成但未交付的结果在下一次写入前交付，并只交付一次", async () => {
    const home = await createTempDir("workspace-attempt-undelivered");
    const secretStore = new MemorySecretStore();
    const booted = await boot(home, secretStore);
    try {
      const dir = await workspaceDir(home, "undelivered");
      await expect(useLocalWorkspaceClient(createLocalWorkspaceClient(home), (workspace) => workspace.create("undelivered", dir), {
        result: async () => {
          throw new Error("呈现失败");
        },
        recovered: async () => undefined,
        failure: async () => undefined,
      })).rejects.toThrow("呈现失败");
    } finally {
      await booted.stop();
    }
    const restarted = await boot(home, secretStore);
    try {
      const next = await write(home, async (workspace) => workspace.create("after-undelivered", await workspaceDir(home, "after-undelivered")));
      expect(next.delivered).toEqual(["recovered:create:undelivered:succeeded", "result"]);
      const again = await write(home, async (workspace) => workspace.create("third", await workspaceDir(home, "third")));
      expect(again.delivered).toEqual(["result"]);
    } finally {
      await restarted.stop();
    }
  });
});

class MemorySecretStore implements SecretStorePort {
  readonly values = new Map<string, string>();
  async put(ref: SecretRef, value: string) { this.values.set(secretKey(ref), value); }
  async get(ref: SecretRef) { return this.values.get(secretKey(ref)) ?? null; }
  async getOrCreate(ref: SecretRef, create: () => string): Promise<string> {
    const storageKey = secretKey(ref);
    const existing = this.values.get(storageKey);
    if (existing !== undefined) return existing;
    const value = create();
    this.values.set(storageKey, value);
    return value;
  }
  async delete(ref: SecretRef) { this.values.delete(secretKey(ref)); }
  async list(prefix: string) {
    return [...this.values.keys()]
      .filter((value) => value.startsWith(prefix))
      .map((value) => {
        const separator = value.indexOf("/");
        return {
          kind: value.slice(0, separator) as SecretRef["kind"],
          bindingId: value.slice(separator + 1),
        };
      });
  }
  async unlockState() { return "unlocked" as const; }
}

function secretKey(ref: SecretRef): string {
  return `${ref.kind}/${ref.bindingId}`;
}
