import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import { DeviceKey } from "@zhixing/mesh/device-identity";
import { persistDeviceKey } from "@zhixing/mesh/device-key-store";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, vi } from "vitest";
import { cleanupExecutorDeviceLocalState } from "./device-removal-cleanup.js";

describe("executor device local cleanup", () => {
  it("removes only the frozen home-local projections and preserves authority, checkpoints and the exact device key", async () => {
    const home = await createTempDir("executor-removal-cleanup");
    const secrets = new MemorySecretStore();
    const deviceKey = await DeviceKey.generate();
    await persistDeviceKey(secrets, deviceKey);
    await secrets.put({ kind: "provider", bindingId: "provider-a" }, "secret");
    for (let index = 0; index < 129; index += 1) {
      await secrets.put({ kind: "provider", bindingId: `bulk-${index.toString().padStart(3, "0")}` }, "secret");
      await putFile(path.join(home, "runtime", "bulk", `${index}.json`), "remove");
    }
    await putFile(path.join(home, "runtime", "ephemeral.json"), "remove");
    await putFile(path.join(home, "distributed-runtime", "workspace-bindings", "binding.json"), "remove");
    await putFile(path.join(home, "distributed-runtime", "authority", "authority.keep"), "keep");
    await putFile(path.join(home, "recovery-checkpoints", "checkpoint.keep"), "keep");
    await putFile(path.join(home, "workspace", "user.keep"), "keep");
    const unregisterFuture = vi.fn(async () => undefined);

    const evidence = await cleanupExecutorDeviceLocalState({
      zhixingHome: home,
      secretStore: secrets,
      deviceKey,
      unregisterFuture,
    });

    expect(unregisterFuture).toHaveBeenCalledTimes(1);
    await expect(readFile(path.join(home, "runtime", "ephemeral.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(home, "runtime", "bulk", "128.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(home, "distributed-runtime", "workspace-bindings", "binding.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(home, "distributed-runtime", "authority", "authority.keep"), "utf8"))
      .resolves.toBe("keep");
    await expect(readFile(path.join(home, "recovery-checkpoints", "checkpoint.keep"), "utf8"))
      .resolves.toBe("keep");
    await expect(readFile(path.join(home, "workspace", "user.keep"), "utf8"))
      .resolves.toBe("keep");
    expect(await secrets.get({ kind: "provider", bindingId: "provider-a" })).toBeNull();
    expect(await secrets.get({ kind: "provider", bindingId: "bulk-128" })).toBeNull();
    expect((await secrets.list("")).filter((ref) => ref.kind === "device-key")).toHaveLength(1);
    expect(evidence.some((item) => item.kind === "cleanup")).toBe(true);
  }, 120_000);
});

async function putFile(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents, "utf8");
}

class MemorySecretStore implements SecretStorePort {
  readonly values = new Map<string, string>();

  async put(ref: SecretRef, value: string): Promise<void> {
    this.values.set(key(ref), value);
  }

  async get(ref: SecretRef): Promise<string | null> {
    return this.values.get(key(ref)) ?? null;
  }

  async delete(ref: SecretRef): Promise<void> {
    this.values.delete(key(ref));
  }

  async list(prefix: string): Promise<SecretRef[]> {
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

  async unlockState(): Promise<"unlocked"> {
    return "unlocked";
  }
}

function key(ref: SecretRef): string {
  return `${ref.kind}/${ref.bindingId}`;
}
