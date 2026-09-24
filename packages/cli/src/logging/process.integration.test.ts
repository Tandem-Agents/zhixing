import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createTempDir } from "@zhixing/test-utils";
import { fileURLToPath } from "node:url";
import { LocalLogStore } from "../../../core/src/logging/storage.js";
import { createDeviceCapacityRuntime } from "../__tests__/device-capacity-fixture.js";
import { LogFilesProcess } from "./files-process.js";

const children: ChildProcess[] = [],
  stores: LocalLogStore[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
    }
  }
  for (const store of stores.splice(0)) await store.close();
});
function message(child: ChildProcess): Promise<{
  phase: string;
  ownerPid: number;
  storeId: string;
  upper?: number;
}> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(Error("fixture timed out"));
    }, 10_000);
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off("message", receive);
      child.off("exit", ended);
    };
    const receive = (value: unknown): void => {
      cleanup();
      resolve(value as Awaited<ReturnType<typeof message>>);
    };
    const ended = (): void => {
      cleanup();
      reject(Error("fixture exited before reply"));
    };
    child.once("message", receive);
    child.once("exit", ended);
  });
}
async function fixture(mode: string) {
  const home = await createTempDir("log-process");
  const child = spawn(
    process.execPath,
    [
      "--import=tsx/esm",
      fileURLToPath(new URL("./__tests__/writer-fixture.ts", import.meta.url)),
      home,
      mode,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true },
  );
  children.push(child);
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk).slice(0, 2048);
  });
  const paused = await message(child).catch((error) => {
    throw Error(`${String(error)}: ${stderr}`);
  });
  const store = new LocalLogStore({
    files: new LogFilesProcess(home),
    capacity: createDeviceCapacityRuntime(home).arbiter,
  });
  stores.push(store);
  return { home, child, paused, store };
}
describe("real log process termination", () => {
  it.each([
    "segment",
    "detail",
    "published",
    "truncate",
  ])("recovers after SIGKILL at %s without inheriting an OS lock", async (mode) => {
    const h = await fixture(mode);
    const exited = new Promise<void>((resolve) => h.child.once("close", () => resolve()));
    h.child.kill("SIGKILL");
    await exited;
    let status;
    for (const deadline = Date.now() + 5000; Date.now() < deadline; ) {
      try {
        status = await h.store.initialize();
        break;
      } catch (error) {
        if (!(error instanceof Error) || !/正在维护/u.test(error.message)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    expect(status?.storeId).toBe(h.paused.storeId);
    expect(status?.pendingReclaims).toBe(0);
    expect(status?.retainedSegments).toBe(mode === "published" ? 1 : 0);
    expect(() => process.kill(h.paused.ownerPid, 0)).toThrow();
  }, 20_000);

  it("reopens fresh handles after the actual native owner is killed", async () => {
    const h = await fixture("native");
    process.kill(h.paused.ownerPid, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const reply = message(h.child);
    h.child.send("continue");
    const recovered = await reply;
    expect(recovered.phase).toBe("recovered");
    expect(recovered.storeId).toBe(h.paused.storeId);
    expect(recovered.upper).toBe(1);
  }, 20_000);

  it.runIf(process.platform === "win32")(
    "settles a timed-out native owner before another writer acquires the root",
    async () => {
      const home = await createTempDir("log-process");
      const files = new LogFilesProcess(home, 1);
      await expect(files.open(false)).rejects.toThrow();
      await files.close();
      const store = new LocalLogStore({
        files: new LogFilesProcess(home),
        capacity: createDeviceCapacityRuntime(home).arbiter,
      });
      stores.push(store);
      expect((await store.initialize()).upper).toBe(0);
    },
    20_000,
  );
});
