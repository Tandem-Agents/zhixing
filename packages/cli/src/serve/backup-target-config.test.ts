import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalize } from "@zhixing/core/protocol";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import {
  projectBackupTargetConfigurationRepository,
  type BackupTargetConfigurationRepository,
} from "./backup-target-config.js";
import { createBackupTargetConfigurationInfrastructure } from "./backup-target-config-infrastructure.js";

describe("backup target configuration infrastructure", () => {
  it("projects an exact frozen load/select repository", async () => {
    const selected = vi.fn(async () => undefined);
    const source: BackupTargetConfigurationRepository = {
      load: async () => ({
        currentTargetId: "backup-device:peer",
        bindings: [{ kind: "paired-device", targetId: "backup-device:peer", deviceId: "peer" }],
      }),
      select: selected,
    };
    const repository = projectBackupTargetConfigurationRepository(source);

    expect(Object.keys(repository).sort()).toEqual(["load", "select"]);
    expect(Object.isFrozen(repository)).toBe(true);
    const loaded = await repository.load();
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded?.bindings)).toBe(true);
    expect(Object.isFrozen(loaded?.bindings[0])).toBe(true);

    await repository.select({
      kind: "directory",
      targetId: "backup-directory:one",
      directory: "relative-target",
    });
    expect(selected).toHaveBeenCalledOnce();
    expect(Object.isFrozen(selected.mock.calls[0]![0])).toBe(true);
    expect(() => projectBackupTargetConfigurationRepository({ load: source.load } as never))
      .toThrow("requires load and select");
  });

  it("round-trips canonical sorted bindings and rejects an identity conflict", async () => {
    const home = await createTempDir("backup-target-configuration");
    const repository = createBackupTargetConfigurationInfrastructure(home);
    const file = path.join(home, "distributed-runtime", "recovery-backup-targets.json");

    await expect(repository.load()).resolves.toBeUndefined();
    await repository.select({
      kind: "paired-device",
      targetId: "backup-device:z",
      deviceId: "z",
    });
    await repository.select({
      kind: "directory",
      targetId: "backup-directory:a",
      directory: "relative-backup-target",
    });

    const loaded = await repository.load();
    expect(loaded).toEqual({
      currentTargetId: "backup-directory:a",
      bindings: [
        { kind: "paired-device", targetId: "backup-device:z", deviceId: "z" },
        {
          kind: "directory",
          targetId: "backup-directory:a",
          directory: path.resolve("relative-backup-target"),
        },
      ],
    });
    const text = await readFile(file, "utf8");
    expect(text).toBe(canonicalize(JSON.parse(text)));
    expect((await readdir(path.dirname(file))).filter((name) => name.endsWith(".tmp")))
      .toEqual([]);

    await repository.select({
      kind: "directory",
      targetId: "backup-directory:a",
      directory: path.resolve("relative-backup-target"),
    });
    const idempotent = await readFile(file, "utf8");
    await expect(repository.select({
      kind: "directory",
      targetId: "backup-directory:a",
      directory: path.resolve("different-target"),
    })).rejects.toThrow("identity is already bound differently");
    await expect(readFile(file, "utf8")).resolves.toBe(idempotent);
  });

  it.each([
    ["bad JSON", "not-json"],
    ["non-canonical bytes", `${canonicalize({
      v: 1,
      currentTargetId: "backup-device:peer",
      bindings: [{ kind: "paired-device", targetId: "backup-device:peer", deviceId: "peer" }],
    })}\n`],
    ["unknown top-level key", canonicalize({
      v: 1,
      currentTargetId: "backup-device:peer",
      bindings: [{ kind: "paired-device", targetId: "backup-device:peer", deviceId: "peer" }],
      extra: true,
    })],
    ["unknown binding key", canonicalize({
      v: 1,
      currentTargetId: "backup-device:peer",
      bindings: [{
        kind: "paired-device",
        targetId: "backup-device:peer",
        deviceId: "peer",
        extra: true,
      }],
    })],
    ["duplicate target", canonicalize({
      v: 1,
      currentTargetId: "backup-device:peer",
      bindings: [
        { kind: "paired-device", targetId: "backup-device:peer", deviceId: "peer" },
        { kind: "paired-device", targetId: "backup-device:peer", deviceId: "other" },
      ],
    })],
    ["missing current target", canonicalize({
      v: 1,
      currentTargetId: "backup-device:missing",
      bindings: [{ kind: "paired-device", targetId: "backup-device:peer", deviceId: "peer" }],
    })],
  ])("rejects %s without returning a partial projection", async (_label, text) => {
    const home = await createTempDir("backup-target-invalid");
    const directory = path.join(home, "distributed-runtime");
    const repository = createBackupTargetConfigurationInfrastructure(home);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "recovery-backup-targets.json"), text);
    await expect(repository.load()).rejects.toThrow();
  });
});
