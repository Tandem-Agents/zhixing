import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  order: [] as string[],
  secretStore: { marker: "secret-store" },
  startup: vi.fn(),
  prepareMesh: vi.fn(),
  runTopology: vi.fn(),
  writer: {
    line: vi.fn(),
    appendInline: vi.fn(),
    notify: vi.fn(),
    ensureSegmentBreak: vi.fn(),
  },
}));

vi.mock("@zhixing/core", () => ({
  getZhixingHome: () => "test-home",
}));
vi.mock("@zhixing/secrets", () => ({
  createPlatformSecretStore: () => harness.secretStore,
}));
vi.mock("../startup.js", () => ({
  runStartupCheck: (...args: unknown[]) => harness.startup(...args),
}));
vi.mock("./mesh-runtime-bootstrap.js", () => ({
  prepareMeshRuntimeBootstrap: (...args: unknown[]) => harness.prepareMesh(...args),
}));
vi.mock("./role-topology.js", () => ({
  DEFAULT_LOCAL_ROLE_CONFIGURATION: { roles: ["anchor", "executor"] },
  runConfiguredServeTopology: (...args: unknown[]) => harness.runTopology(...args),
}));

import { runServeCommand } from "./topology-command.js";

describe("serve topology command", () => {
  beforeEach(() => {
    harness.order.length = 0;
    harness.startup.mockReset();
    harness.prepareMesh.mockReset();
    harness.runTopology.mockReset();
    harness.writer.line.mockReset();
    harness.writer.appendInline.mockReset();
    harness.writer.notify.mockReset();
    harness.writer.ensureSegmentBreak.mockReset();
  });

  it("performs the shared startup preflight before mesh or role side effects", async () => {
    const startup = {
      kind: "ready",
      config: { mesh: { enabledRoles: ["executor"] } },
      credentials: {},
      credentialGeneration: null,
      secretStore: harness.secretStore,
    };
    const mesh = { roles: ["executor"] };
    harness.startup.mockImplementation(async () => {
      harness.order.push("startup");
      return startup;
    });
    harness.prepareMesh.mockImplementation(async () => {
      harness.order.push("mesh");
      return mesh;
    });
    harness.runTopology.mockImplementation(async () => {
      harness.order.push("roles");
    });

    await runServeCommand({}, harness.writer);

    expect(harness.order).toEqual(["startup", "mesh", "roles"]);
    expect(harness.prepareMesh).toHaveBeenCalledWith(expect.objectContaining({
      zhixingHome: "test-home",
      secretStore: harness.secretStore,
      configuration: startup.config.mesh,
    }));
    expect(harness.runTopology).toHaveBeenCalledWith(
      { roles: mesh.roles },
      expect.any(Object),
      {},
      { mesh, secretStore: harness.secretStore, startup },
    );
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
      expect(harness.prepareMesh).not.toHaveBeenCalled();
      expect(harness.runTopology).not.toHaveBeenCalled();
      expect(harness.writer.line).toHaveBeenCalledWith(expect.stringContaining("配置错误"));
    } finally {
      exit.mockRestore();
    }
  });
});
