import { acquireLocalWorkspaceOwner, LocalWorkspaceTransportServer } from "../runtime/local-workspace-owner.js";
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { writeFile, readdir, stat, mkdir, rmdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTempDir } from "@zhixing/test-utils";
import { getGlobalConfigPath } from "@zhixing/providers";

const cli = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
function run(
  home: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: {
        ...process.env,
        ZHIXING_HOME: home,
        ZHIXING_CONFIG_PATH: getGlobalConfigPath({}, home),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (bytes) => {
      stdout += String(bytes);
    });
    child.stderr.on("data", (bytes) => {
      stderr += String(bytes);
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(Error("isolated CLI timed out"));
    }, 15_000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}
describe("built CLI log entry and exit chain", () => {
  it("explains an unavailable offline store without creating it or fabricating results", async () => {
    const home = await createTempDir("logging-empty"),
      root = path.join(home, "logs", "runtime");
    for (const args of [
      ["logs"],
      ["logs", "--offline", "search"],
      ["logs", "--offline", "policy"],
    ]) {
      const result = await run(home, args);
      expect(result.code).toBe(1);
      expect(result.stdout).toContain("日志存储尚未初始化");
      expect(result.stdout).toContain("zz logs read zxlog-local:legacy/catalog");
      expect(result.stdout + result.stderr).not.toContain("checkpoint-child-missing");
      expect(await readdir(home)).toEqual([]);
    }
    expect((await run(home, ["logs", "location"])).code).toBe(0);
    expect(await readdir(home)).toEqual([]);
    await mkdir(root, { recursive: true });
    const emptyDirectory = await run(home, ["logs", "--offline", "search"]);
    expect(emptyDirectory.code).toBe(1);
    expect(emptyDirectory.stdout).toContain("日志存储尚未初始化");
    expect(await readdir(root)).toEqual([]);
    await rmdir(root); // This test's known empty directory only.
    await writeFile(root, "not-a-log-directory");
    const fileRoot = await run(home, ["logs", "--offline", "policy"]);
    expect(fileRoot.code).toBe(1);
    expect(fileRoot.stdout).toContain("日志存储当前不可读取");
    expect(fileRoot.stdout).not.toContain("尚未初始化");
    expect((await stat(root)).size).toBe(19);
  }, 30_000);

  it("completes public Store.close without any other application handles", async () => {
    const home = await createTempDir("logging-close");
    const child = spawn(
      process.execPath,
      [
        "--import=tsx/esm",
        fileURLToPath(new URL("./__tests__/close-fixture.ts", import.meta.url)),
        home,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (bytes) => {
      stdout += String(bytes);
    });
    child.stderr.on("data", (bytes) => {
      stderr += String(bytes);
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(Error("close fixture timed out"));
      }, 10_000);
      child.once("error", reject);
      child.once("close", (value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
    expect(code, stderr).toBe(0);
    expect(stdout).toBe("closed\n");
  }, 15_000);

  it.each([
    { args: [] },
    { args: ["serve"] },
  ])("preserves startup failure and supports offline evidence for $args", async ({ args }) => {
    const home = await createTempDir("logging-entry");
    await writeFile(getGlobalConfigPath({ ZHIXING_HOME: home }, home), "{broken", "utf8");
    const failed = await run(home, args);
    expect(failed.code).toBe(2);
    expect(failed.stderr + failed.stdout).toContain("配置错误");
    const before = await readdir(path.join(home, "logs", "runtime"));
    const result = await run(home, ["logs", "--offline", "search"]);
    expect(result.code).toBe(0);
    const page = JSON.parse(result.stdout);
    expect(page.records).toContainEqual(expect.objectContaining({ event: "failed", result: "failure", data: expect.objectContaining({ reason: "schema-error", error: expect.stringContaining("JSONC") }) }));
    expect(page.records.some((record: { event: string }) => record.event === "started")).toBe(true);
    expect(
      page.records.some(
        (record: { event: string; result: string }) =>
          record.event === "stopped" && record.result === "failure",
      ),
    ).toBe(true);
    expect(await readdir(path.join(home, "logs", "runtime"))).toEqual(before);
    const location = await run(home, ["logs", "location"]);
    expect(location.stdout).toContain("published-");
    expect((await stat(path.join(home, "logs", "runtime"))).isDirectory()).toBe(true);
  }, 30_000);

  it("allows the owning entry to drain after the server signal handler returns", async () => {
    const home = await createTempDir("logging-signal");
    const child = spawn(
      process.execPath,
      [
        "--import=tsx/esm",
        fileURLToPath(new URL("./__tests__/lifecycle-fixture.ts", import.meta.url)),
        home,
      ],
      { stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true },
    );
    const phases: string[] = [];
    let stderr = "";
    child.stderr.on("data", (bytes) => {
      stderr += String(bytes);
    });
    child.on("message", (value: { phase: string }) => {
      phases.push(value.phase);
      if (value.phase === "started") child.send("stop");
    });
    try {
      const exit = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(Error(`signal fixture timed out: ${stderr}`));
        }, 10_000);
        child.once("error", reject);
        child.once("close", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      expect(exit, stderr).toBe(0);
      expect(phases).toEqual(["started", "finished"]);
      const result = await run(home, ["logs", "--offline", "search"]);
      expect(result.code).toBe(0);
      expect(
        JSON.parse(result.stdout).records.some(
          (record: { event: string; result: string }) =>
            record.event === "stopped" && record.result === "success",
        ),
      ).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  }, 20_000);
});


describe("independent CLI logging owner", () => {
  it.each([["backup", "setup"], ["workspace", "status"]])("drains failure from actual command %j without spawning a replacement owner", async (...args) => {
    const home = await createTempDir("logging-command-entry");
    // No production settings or secrets: workspace preflight fails deterministically.
    await writeFile(getGlobalConfigPath({ ZHIXING_HOME: home }, home), "{broken", "utf8");
    const failed = await run(home, args);
    expect(failed.code).toBe(1);
    const result = await run(home, ["logs", "--offline", "search"]);
    expect(result.code).toBe(0);
    const records = JSON.parse(result.stdout).records;
    expect(records.filter((record: any) => record.event === "started")).toHaveLength(1);
    expect(records).toEqual(expect.arrayContaining([expect.objectContaining({ event: "failed", result: "failure" }), expect.objectContaining({ event: "stopped", result: "failure" })]));
  }, 20000);
});


it.each([false, true])("drains the standalone owner and preserves workspace JSON when logs unavailable=%s", async (unavailable) => {
  const home = await createTempDir("logging-natural-command");
  if (unavailable) {
    await mkdir(path.join(home, "logs"));
    await writeFile(path.join(home, "logs", "runtime"), "not-a-log-directory");
  }
  const lease = await acquireLocalWorkspaceOwner(home);
  // A local authenticated transport fixture supplies the existing Host contract.
  const host = new LocalWorkspaceTransportServer(lease, async body => {
    const kind = (body as { kind: string }).kind;
    if (kind === "host-status") return { state: "ready" };
    if (kind === "pending") return { outboxId: "outbox-" + "a".repeat(32), operations: [], confirmation: { throughSeq: 0, prefixDigest: "sha256:" + "0".repeat(64) } };
    if (kind === "list") return [];
    throw Error("unexpected fixture call " + kind);
  });
  await host.start();
  try {
    const result = await run(home, ["workspace", "list"]);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([]);
    if (unavailable) {
      expect(result.stderr).toContain("日志");
      expect(Buffer.byteLength(result.stderr)).toBeLessThan(4096);
      expect((await stat(path.join(home, "logs", "runtime"))).size).toBe(19);
    }
  } finally { await host.close(); await lease.release(); }
  if (unavailable) return;
  const page = await run(home, ["logs", "--offline", "search"]);
  expect(page.code).toBe(0);
  expect(JSON.parse(page.stdout).records).toContainEqual(expect.objectContaining({ event: "stopped", result: "success" }));
}, 20000);
