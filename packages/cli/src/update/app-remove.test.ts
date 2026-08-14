import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import { removeApplication } from "./app-remove.js";

describe("application removal", () => {
  it("stops safely and only hands the program root to the installer", async () => {
    const root = await createTempDir("app-remove");
    const executable = path.join(root, "runtime", process.platform === "win32" ? "node.exe" : "node");
    const installer = path.join(root, "installer", "program-installer.js");
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "installer");
    await mkdir(path.dirname(installer), { recursive: true });
    await writeFile(installer, "installer");
    await chmod(executable, 0o755);
    const order: string[] = [];
    const handoff = vi.fn(async () => undefined);
    await removeApplication({
      programRoot: root,
      prepareManagedRemoval: async () => {
        order.push("future-disabled");
        return {
          commit: async () => { order.push("future-unregistered"); },
          rollback: async () => { order.push("future-restored"); },
        };
      },
      stop: async () => {
        order.push("current-stopped");
        return { status: "nothing-to-stop" };
      },
      handoff: async (...args) => {
        order.push("program-removal-handed-off");
        await handoff(...args);
      },
    });
    expect(handoff).toHaveBeenCalledWith(executable, [
      installer,
      "remove",
      "--program-root",
      root,
      "--preserve-user-data",
    ]);
    expect(order).toEqual([
      "future-disabled",
      "current-stopped",
      "future-unregistered",
      "program-removal-handed-off",
    ]);
  });

  it("does not hand off when accepted work blocks the safe stop", async () => {
    const root = await createTempDir("app-remove-blocked");
    const executable = path.join(root, "runtime", process.platform === "win32" ? "node.exe" : "node");
    const installer = path.join(root, "installer", "program-installer.js");
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "installer");
    await mkdir(path.dirname(installer), { recursive: true });
    await writeFile(installer, "installer");
    const handoff = vi.fn(async () => undefined);
    await expect(removeApplication({
      programRoot: root,
      prepareManagedRemoval: async () => ({
        commit: async () => undefined,
        rollback: async () => undefined,
      }),
      stop: async () => ({ status: "refused", pid: 1, reason: "busy", blockers: ["work"] }),
      handoff,
    })).rejects.toThrow("当前工作尚未安全结束");
    expect(handoff).not.toHaveBeenCalled();
  });

  it("restores only this removal's future-disable when safe stop is refused", async () => {
    const root = await createTempDir("app-remove-rollback");
    const executable = path.join(root, "runtime", process.platform === "win32" ? "node.exe" : "node");
    const installer = path.join(root, "installer", "program-installer.js");
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "installer");
    await mkdir(path.dirname(installer), { recursive: true });
    await writeFile(installer, "installer");
    const rollback = vi.fn(async () => undefined);
    const commit = vi.fn(async () => undefined);
    await expect(removeApplication({
      programRoot: root,
      prepareManagedRemoval: async () => ({ commit, rollback }),
      stop: async () => ({ status: "refused", pid: 1, reason: "busy", blockers: ["work"] }),
      handoff: vi.fn(),
    })).rejects.toThrow("当前工作尚未安全结束");
    expect(rollback).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
  });
});
