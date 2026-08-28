import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";

const harness = vi.hoisted(() => ({
  order: [] as string[],
  secretStore: { marker: "secret-store" },
  startup: vi.fn(),
  hostInput: undefined as unknown,
  hostRun: vi.fn(),
  createHost: vi.fn(),
  writer: {
    line: vi.fn(),
    appendInline: vi.fn(),
    notify: vi.fn(),
    ensureSegmentBreak: vi.fn(),
  },
}));

vi.mock("@zhixing/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@zhixing/core")>(),
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

import {
  runServeCommand,
  waitForManagedHostTurn,
} from "./topology-command.js";

describe("serve topology command", () => {
  beforeEach(() => {
    harness.order.length = 0;
    harness.startup.mockReset();
    harness.hostInput = undefined;
    harness.hostRun.mockReset();
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

  it("performs shared preflight before creating and running the production Host", async () => {
    const startup = {
      kind: "ready",
      config: { mesh: { enabledRoles: ["executor"] } },
      credentials: {},
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
    }));
  });

  it("leaves outer failure and cleanup ownership with the production Host", async () => {
    const failure = new Error("host failed");
    harness.startup.mockResolvedValue({
      kind: "ready",
      config: {},
      credentials: {},
      credentialGeneration: null,
      secretStore: harness.secretStore,
    });
    harness.hostRun.mockRejectedValue(failure);

    await expect(runServeCommand({}, harness.writer)).rejects.toBe(failure);
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
