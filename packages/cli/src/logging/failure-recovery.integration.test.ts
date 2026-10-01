import { expect, it } from "vitest";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { execFile, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { beginRuntimeLogging } from "./runtime.js";

it("the native file worker preserves finite failure evidence across its IPC boundary", async () => {
  const home = await createTempDir("log-files-ipc-cause");
  await writeFile(path.join(home, "logs"), "owned obstruction");
  const worker = fork(new URL("../../dist/logging-files-worker.js", import.meta.url), [], {
    windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced", execArgv: [],
  });
  const exit = new Promise<void>(resolve => worker.once("close", () => resolve()));
  try {
    const reply = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("file worker timeout")), 10000);
      worker.once("message", message => { clearTimeout(timer); resolve(message); });
      worker.once("error", error => { clearTimeout(timer); reject(error); });
      worker.send({ id: 1, op: "open", args: [home, false] });
    });
    expect(reply.evidence.code).toMatch(process.platform === "win32" ? /NTSTATUS|Win32/u : /ENOTDIR|EEXIST/u);
    expect(JSON.stringify(reply)).not.toContain(home);
    expect(await readFile(path.join(home, "logs"), "utf8")).toBe("owned obstruction");
  } finally { worker.kill(); await exit; }
}, 15000);

it("recovers the first native storage cause through the installed reader after logging itself was unavailable", async () => {
  const home = await createTempDir("log-first-native-cause");
  await mkdir(path.join(home, "logs"));
  const obstruction = path.join(home, "logs", "runtime");
  const marker = "owned failure fixture";
  await writeFile(obstruction, marker);
  const notices: string[] = [];
  const logging = beginRuntimeLogging(home, "acceptance", message => notices.push(message));
  try {
    // Ordinary work can proceed while the real OS refuses the log directory.
    logging.records.record({ event: "hostConnected", result: "success", data: { attempt: 1 } });
    const deadline = performance.now() + 10000;
    while (!notices.some(item => item.includes("降级")) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    expect(notices.some(item => item.includes("降级"))).toBe(true);
    expect(await readFile(obstruction, "utf8")).toBe(marker);
    await unlink(obstruction); // Only this test's verified file, never user data.
  } finally { await logging.finish("success", "acceptance-complete"); }
  const cli = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
  const output = await new Promise<string>((resolve, reject) => execFile(process.execPath, [cli, "logs", "--offline", "search"], {
    env: { ...process.env, ZHIXING_HOME: home }, windowsHide: true, timeout: 15000,
  }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  const records = JSON.parse(output).records;
  const first = records.map((record: any) => record.data?.firstFailure).find(Boolean);
  expect(first).toMatchObject({ operation: "files.open", phase: "initialize", attempt: 1 });
  expect(first.code).toMatch(process.platform === "win32" ? /NTSTATUS|Win32/u : /ENOTDIR|EEXIST/u);
  expect(records.some((record: any) => record.event === "hostConnected")).toBe(true);
  expect(records.some((record: any) => record.event === "recovered")).toBe(true);
  expect(output).not.toContain(home);
}, 30000);
