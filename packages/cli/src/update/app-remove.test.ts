import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import { removeApplication } from "./app-remove.js";

describe("application removal", () => {
  it("stops safely and only hands the program root to the installer", async () => {
    const root = await createTempDir("app-remove");
    const executable = path.join(root, "installer", process.platform === "win32" ? "remove-zhixing.exe" : "remove-zhixing");
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "installer");
    await chmod(executable, 0o755);
    const handoff = vi.fn(async () => undefined);
    await removeApplication({
      programRoot: root,
      stop: async () => ({ status: "nothing-to-stop" }),
      handoff,
    });
    expect(handoff).toHaveBeenCalledWith(executable, ["--program-root", root, "--preserve-user-data"]);
  });

  it("does not hand off when accepted work blocks the safe stop", async () => {
    const root = await createTempDir("app-remove-blocked");
    const executable = path.join(root, "installer", process.platform === "win32" ? "remove-zhixing.exe" : "remove-zhixing");
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "installer");
    const handoff = vi.fn(async () => undefined);
    await expect(removeApplication({
      programRoot: root,
      stop: async () => ({ status: "refused", pid: 1, reason: "busy", blockers: ["work"] }),
      handoff,
    })).rejects.toThrow("当前工作尚未安全结束");
    expect(handoff).not.toHaveBeenCalled();
  });
});
