import { expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { fork } from "node:child_process";
import { IsolatedLogStore } from "./store-process.js";
import { LogAppendIndeterminateError, LogStorageError } from "@zhixing/core/logging";

vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), fork: vi.fn() }));

it.each(["initialize", "append"] as const)("retains worker errors and fences before settling %s", async operation => {
  let closed = false;
  const child = Object.assign(new EventEmitter(), { connected: true, ref() {}, unref() {},
    send(_message: unknown, callback: (error: Error) => void) { queueMicrotask(() => callback(Object.assign(Error("private path"), { code: "EPIPE" }))); },
    kill() { queueMicrotask(() => { closed = true; child.emit("close", 1); }); return true; },
  });
  vi.mocked(fork).mockReturnValue(child as any);
  const store = new IsolatedLogStore("fixture-home", { acquire: vi.fn(), snapshot: vi.fn() });
  const error = await (operation === "append" ? store.append([]) : store.initialize()).catch(error => error);
  expect(closed).toBe(true);
  expect(error).toBeInstanceOf(operation === "append" ? LogAppendIndeterminateError : LogStorageError);
  expect(error.evidence).toEqual({ category: "system", code: "EPIPE", operation: `store.${operation}`, exitCode: 1 });
  expect(JSON.stringify(error.evidence)).not.toContain("private path");
  await store.close();
});
