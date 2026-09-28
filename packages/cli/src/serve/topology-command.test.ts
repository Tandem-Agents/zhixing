import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";

const harness = vi.hoisted(() => ({
  order: [] as string[],
  secretStore: { marker: "secret-store" },
  startup: vi.fn(),
  reconcile: vi.fn(),
  hostInput: undefined as unknown,
  hostRun: vi.fn(),
  logFinish: vi.fn(async () => undefined),
  logRecord: vi.fn(),
  capacity: { marker: "entry-capacity" },
  createHost: vi.fn(),
  writer: {
    line: vi.fn(),
    appendInline: vi.fn(),
    notify: vi.fn(),
    ensureSegmentBreak: vi.fn(),
  },
}));

vi.mock("@zhixing/core/paths", async (importOriginal) => ({
  ...await importOriginal<typeof import("@zhixing/core/paths")>(),
  getZhixingHome: () => "test-home",
}));
vi.mock("@zhixing/secrets", () => ({
  createPlatformSecretStore: () => harness.secretStore,
}));
vi.mock("../startup.js", () => ({
  runStartupCheck: (...args: unknown[]) => harness.startup(...args),
}));
vi.mock("./application-host.js", () => ({
  createPersistentApplicationHost: (...args: unknown[]) => harness.createHost(...args),
}));
vi.mock("./managed-service-runtime.js", async original => ({
  ...await original<typeof import("./managed-service-runtime.js")>(),
  reconcileCurrentManagedService: (...args: unknown[]) => harness.reconcile(...args),
}));
vi.mock("../logging/runtime.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../logging/runtime.js")>(),
  beginRuntimeLogging: () => ({ capacity: harness.capacity, bind: () => ({ record: harness.logRecord }), records: { record: harness.logRecord }, finish: harness.logFinish }),
}));

import {
  runServeCommand,
  waitForManagedHostTurn,
} from "./topology-command.js";

describe("serve topology command", () => {
  beforeEach(() => {
    harness.order.length = 0;
    harness.startup.mockReset();
    harness.reconcile.mockReset();
    harness.hostInput = undefined;
    harness.hostRun.mockReset();
    harness.logFinish.mockClear();
    harness.logRecord.mockClear();
    harness.createHost.mockReset();
    harness.createHost.mockImplementation((input) => {
      harness.order.push("host-create");
      harness.hostInput = input;
      return {
        run: async () => {
          harness.order.push("host-run");
          return harness.hostRun();
        },
      };
    });
    harness.writer.line.mockReset();
    harness.writer.appendInline.mockReset();
    harness.writer.notify.mockReset();
    harness.writer.ensureSegmentBreak.mockReset();
  });

  it.each(["on-demand", "managed", "none"])("automatic %s planning stays with the Host credential owner", async mode => {
    const previousSend = process.send;
    vi.stubEnv("ZHIXING_DAEMON_CHILD", "1");
    const send = vi.fn((message, callback) => { callback(null); return true; });
    process.send = send as typeof process.send;
    harness.reconcile.mockResolvedValue({ plan: { mode } });
    harness.startup.mockResolvedValue({ kind: "ready" });
    try {
      await runServeCommand({ autoStart: true }, harness.writer);
      expect(harness.reconcile).toHaveBeenCalledWith("host-missing", undefined, "test-home", harness.secretStore);
      expect(send).toHaveBeenCalledWith({ type: "host-launch-plan", mode }, expect.any(Function));
      if (mode === "on-demand") {
        expect(harness.startup).toHaveBeenCalledWith(expect.objectContaining({ secretStore: harness.secretStore }));
        expect(harness.hostInput).toMatchObject({ secretStore: harness.secretStore });
        expect(harness.hostRun).toHaveBeenCalledOnce();
      } else {
        expect(harness.startup).not.toHaveBeenCalled();
        expect(harness.createHost).not.toHaveBeenCalled();
      }
      expect(harness.logFinish).toHaveBeenCalledWith("success", "completed");
    } finally {
      process.send = previousSend;
      vi.unstubAllEnvs();
    }
  });

  it("performs shared preflight before creating and running the production Host", async () => {
    const startup = {
      kind: "ready",
      runtimeConfiguration: {
        mesh: { enabledRoles: ["executor"] },
      },
      providerCredentials: {},
      mcpCredentials: {},
      channelCredentials: {},
      credentialExposureCredentials: {},
      credentialRotationCredentials: {},
      credentialGeneration: null,
      secretStore: harness.secretStore,
    };
    harness.startup.mockImplementation(async () => {
      harness.order.push("startup");
      return startup;
    });

    await runServeCommand({}, harness.writer);

    expect(harness.order).toEqual(["startup", "host-create", "host-run"]);
    expect(harness.createHost).toHaveBeenCalledOnce();
    expect(harness.hostRun).toHaveBeenCalledOnce();
    expect(harness.hostInput).toEqual(expect.objectContaining({
      zhixingHome: "test-home",
      processMode: "foreground",
      options: {},
      secretStore: harness.secretStore,
      startup,
      deviceCapacity: harness.capacity,
      logRecords: expect.any(Object),
    }));
    expect(harness.logFinish).toHaveBeenCalledWith("success", "completed");
  });

  it("leaves outer failure and cleanup ownership with the production Host", async () => {
    const failure = new Error("host failed");
    harness.startup.mockResolvedValue({
      kind: "ready",
      runtimeConfiguration: {},
      providerCredentials: {},
      mcpCredentials: {},
      channelCredentials: {},
      credentialExposureCredentials: {},
      credentialRotationCredentials: {},
      credentialGeneration: null,
      secretStore: harness.secretStore,
    });
    harness.hostRun.mockRejectedValue(failure);

    await expect(runServeCommand({}, harness.writer)).rejects.toBe(failure);
    expect(harness.logFinish).toHaveBeenCalledWith("failure", "host-or-preflight-failed");
    expect(harness.createHost).toHaveBeenCalledOnce();
    expect(harness.hostRun).toHaveBeenCalledOnce();
  });

  it("does not create mesh or role state when preflight is not ready", async () => {
    harness.startup.mockResolvedValue({
      kind: "semantic-error",
      filePath: "config.jsonc",
      issues: [{ field: "legacy", reason: "removed", fix: "delete it" }],
    });
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      await runServeCommand({}, harness.writer);
      expect(exit).toHaveBeenCalledWith(2);
      expect(harness.order).toEqual([]);
      expect(harness.createHost).not.toHaveBeenCalled();
      expect(harness.hostRun).not.toHaveBeenCalled();
      expect(harness.writer.line).toHaveBeenCalledWith(expect.stringContaining("配置错误"));
    } finally {
      exit.mockRestore();
    }
  });

  it("contains no parallel mesh, lease, recovery, or role-root owner", async () => {
    const source = await readFile(new URL("./topology-command.ts", import.meta.url), "utf8");

    expect(source).toContain("createPersistentApplicationHost");
    expect(source).toContain("await host.run()");
    expect(source).not.toContain("prepareMeshRuntimeBootstrap");
    expect(source).not.toContain("runRecoveryRootEstablishmentTopology");
    expect(source).not.toContain("acquireExecutorLocalWorkspaceOwner");
    expect(source).not.toContain("runConfiguredServeTopology");
  });
});

describe("managed host preflight", () => {
  it("waits without starting roles until the existing healthy host exits", async () => {
    const alive = [true, true, false];
    const wait = vi.fn(async () => undefined);
    await expect(waitForManagedHostTurn({
      existingHostAlive: async () => alive.shift() ?? false,
      shouldRemainManaged: async () => true,
      wait,
    })).resolves.toBe(true);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("leaves preflight when the durable launch plan changes", async () => {
    const reconcileChangedPlan = vi.fn(async () => undefined);
    await expect(waitForManagedHostTurn({
      existingHostAlive: async () => true,
      shouldRemainManaged: async () => false,
      wait: async () => undefined,
      reconcileChangedPlan,
    })).resolves.toBe(false);
    expect(reconcileChangedPlan).toHaveBeenCalledOnce();
  });
});
