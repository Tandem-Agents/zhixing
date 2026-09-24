import { describe, expect, it } from "vitest";
import { classifyWindowsWriters, createLogWriterProbe } from "./writers.js";
import { isProductLogWriter } from "./writer-classification.js";

describe("log writer OS observation", () => {
  const home = "C:\\home", entry = "C:\\product\\packages\\cli\\dist\\index.js";
  it.each([
    { args: [entry], writer: true },
    { args: ["--import", "loader", entry], writer: true },
    { args: ["--", entry], writer: true },
    { args: ["--inspect-port", "0", entry, "logs"], writer: true },
    { args: [entry, "logs", "read"], writer: false },
    { args: [entry, "logs", "policy"], writer: false },
    { args: [entry, "logs", "policy", "--set", "{}"], writer: true },
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
    { args: ["--eval", entry], writer: false },
    { args: ["unrelated.js", entry], writer: false },
  ])("classifies $args with conservative option parsing", ({ args, writer }) => {
    expect(isProductLogWriter(["node", ...args], home, true)).toBe(writer);
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
  });
  it.skipIf(process.platform !== "win32")("fails closed when the owned observer is unavailable", async () => {
    const observe = createLogWriterProbe(home, async () => { throw Error("unavailable"); });
    expect(await observe()).toMatchObject({ complete: false, candidates: [] });
  });
});
