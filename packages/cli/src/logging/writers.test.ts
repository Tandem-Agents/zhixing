import { describe, expect, it } from "vitest";
import { classifyWindowsWriters, createLogWriterProbe } from "./writers.js";
import { isProductLogWriter } from "./writer-classification.js";
import { declareLogWriter, writerEndpoint, writerRootKey } from "./writer-admission.js";
import { LogFilesProcess } from "./files-process.js";
import { createTempDir } from "@zhixing/test-utils";
import { managedHomeArgument, normalizeCliArgs } from "./entry-mode.js";
import { spawn } from "node:child_process";

describe("log writer OS observation", () => {
  it.skipIf(process.platform !== "win32")("does not turn exited unrelated processes into unavailable writer inventory", async () => {
    const home = await createTempDir("log-process-churn"), files = new LogFilesProcess(home);
    try {
      await files.open(true);
      for (let i = 0; i < 20; i++) {
        const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20)"], { windowsHide: true, stdio: "ignore" });
        const exited = new Promise<void>((resolve, reject) => { child.once("close", () => resolve()); child.once("error", reject); });
        try {
          const inventory = await files.observeNodeProcesses();
          expect(inventory.complete, JSON.stringify(inventory.failure)).toBe(true);
          expect(inventory.entries.some(row => row.pid === process.pid)).toBe(true);
        } finally { await exited; }
      }
    } finally { await files.close(); }
  }, 15000);

  it.skipIf(process.platform !== "win32")("proves a live declaration against the OS peer, without a registry write", async () => {
    const home = await createTempDir("log-admission");
    const declaration = declareLogWriter(home);
    const files = new LogFilesProcess(home);
    await declaration.ready;
    try {
      await files.open(false);
      const endpoint = writerEndpoint(process.pid);
      expect(JSON.parse(await files.readLocalProcessDeclaration(endpoint, process.pid))).toEqual({ protocol: 2, root: writerRootKey(home), pid: process.pid });
      const whileBusy = files.readLocalProcessDeclaration(endpoint, process.pid);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
      expect(JSON.parse(await whileBusy).protocol).toBe(2); // Main-thread loading cannot starve the peer proof.
      await expect(files.readLocalProcessDeclaration(endpoint, process.pid + 1)).rejects.toThrow("peer mismatch");
      const owner = { pid: 999999, birth: "123", argv: ["node", "self"] };
      const candidate = { pid: process.pid, birth: "456", argv: ["node", "C:\\product\\packages\\cli\\dist\\index.js"] };
      const probe = createLogWriterProbe(home, { observeNodeProcesses: async () => ({ complete: true, entries: [owner, candidate] }), readLocalProcessDeclaration: (target, pid) => files.readLocalProcessDeclaration(target, pid) }, owner.pid);
      expect((await probe()).compatible).toEqual([{ pid: process.pid, birth: "456" }]);
      const different = createLogWriterProbe(home + "-different", { observeNodeProcesses: async () => ({ complete: true, entries: [owner, candidate] }), readLocalProcessDeclaration: (target, pid) => files.readLocalProcessDeclaration(target, pid) }, owner.pid);
      expect((await different()).candidates).toEqual([{ pid: owner.pid, birth: owner.birth }]);
    } finally { await declaration.close(); await files.close(); }
  });
  const home = "C:\\home", entry = "C:\\product\\packages\\cli\\dist\\index.js";
  it.each([
    { args: [entry], writer: true },
    { args: ["--import", "loader", entry], writer: true },
    { args: ["--", entry], writer: true },
    { args: ["--inspect-port", "0", entry, "logs"], writer: true },
    { args: [entry, "logs", "read"], writer: false },
    { args: [entry, "logs", "policy"], writer: false },
    { args: [entry, "logs", "policy", "--set", "{}"], writer: true },
    { args: [entry, "logs", "--offline", "policy", "--set={}"], writer: true },
    { args: [entry, "logs", "--offline", "policy"], writer: false },
    { args: [entry, "--", "logs", "--offline", "policy"], writer: false },
    { args: [entry, "--", "logs", "--offline", "policy", "--set={}"], writer: true },
    { args: [entry, "serve", "logs"], writer: false },
    { args: [entry, "workspace", "status"], writer: false },
    { args: [entry, "workspace", "list"], writer: false },
    { args: [entry, "backup", "status"], writer: false },
    ...["create", "create-scene", "rename", "repath", "remove", "reset", "unknown"].map(command => ({ args: [entry, "workspace", command], writer: true })),
    ...["setup", "verify", "recover", "recover-finish", "root", "unknown"].map(command => ({ args: [entry, "backup", command], writer: true })),
    ...["status", "stop", "doctor", "device", "duty", "app", "--help", "--version"].map(command => ({ args: [entry, command], writer: false })),
    ...["backup", "workspace", "pair", "serve", "unknown"].map(command => ({ args: [entry, command], writer: true })),
    { args: [entry, "serve", "--managed-home", "C:\\elsewhere"], writer: false },
    { args: [entry, "serve", "--managed-home", "c:\\HOME"], writer: true },
    { args: [entry, "serve", "--managed-home=C:\\elsewhere"], writer: false },
    { args: [entry, "serve", "--managed-home=C:\\elsewhere", "--managed-home", "c:\\HOME"], writer: true },
    { args: [entry, "serve", "--managed-home", "c:\\HOME", "--managed-home=C:\\elsewhere"], writer: false },
    { args: ["--eval", entry], writer: false },
    { args: ["unrelated.js", entry], writer: false },
  ])("classifies $args with conservative option parsing", ({ args, writer }) => {
    expect(isProductLogWriter(["node", ...args], home, true)).toBe(writer);
  });
  it("keeps the same last home and remaining separator as Commander", () => {
    const args = normalizeCliArgs(["--", "serve", "--managed-home=first", "--managed-home", "last", "--", "--managed-home=ignored"]);
    expect(args).toEqual(["serve", "--managed-home=first", "--managed-home", "last", "--", "--managed-home=ignored"]);
    expect(managedHomeArgument(args)).toBe("last");
  });
  it("returns identities only, preserving unknown and missing-self proof", () => {
    const self = { pid: 1, birth: "123", argv: ["node", "unrelated"] };
    const other = { pid: 2, birth: "124", argv: ["node", entry] };
    expect(classifyWindowsWriters({ complete: true, entries: [self, other] }, home, 1)).toEqual({
      complete: true, self: { pid: 1, birth: "123" }, candidates: [{ pid: 1, birth: "123" }, { pid: 2, birth: "124" }],
    });
    for (const entries of [[other], [self, { ...other, argv: null }], [self, { ...other, birth: "" }]]) {
      expect(classifyWindowsWriters({ complete: true, entries }, home, 1).complete).toBe(false);
    }
    expect(classifyWindowsWriters({ complete: false, entries: [self] }, home, 1).complete).toBe(false);
    expect(classifyWindowsWriters({ complete: false, entries: [self], failure: { reason: "arguments-unavailable", pid: 2 } }, home, 1)).toMatchObject({
      complete: false, failure: { category: "writer-admission", operation: "writers.inventory", code: "arguments-unavailable", writerPids: [2] },
    });
  });
  it.skipIf(process.platform !== "win32")("fails closed when the owned observer is unavailable", async () => {
    const observe = createLogWriterProbe(home, { observeNodeProcesses: async () => { throw Object.assign(Error("private process metadata"), { code: "EACCES" }); }, readLocalProcessDeclaration: async () => { throw Error("not reached"); } });
    const result = await observe();
    expect(result).toMatchObject({ complete: false, candidates: [], failure: { category: "system", code: "EACCES" } });
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it.skipIf(process.platform !== "win32").each(["reused", "incomplete"])("does not attach a peer proof to a %s inventory", async kind => {
    const self = { pid: 1, birth: "123", argv: ["node", "self"] };
    const peer = { pid: 2, birth: "456", argv: ["node", entry] };
    let observations = 0;
    const result = await createLogWriterProbe(home, {
      observeNodeProcesses: async () => ++observations === 1
        ? { complete: true, entries: [self, peer] }
        : { complete: kind !== "incomplete", entries: [self, { ...peer, birth: "789" }] },
      readLocalProcessDeclaration: async () => JSON.stringify({ protocol: 2, pid: peer.pid, root: writerRootKey(home + "-other") }),
    }, self.pid)();
    expect(result.candidates).toContainEqual({ pid: peer.pid, birth: "789" });
    expect(result.compatible).toEqual([]);
    expect(result.complete).toBe(kind !== "incomplete");
  });
});
