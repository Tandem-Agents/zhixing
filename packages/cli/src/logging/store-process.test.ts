import { expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { fork } from "node:child_process";
import { IsolatedLogStore } from "./store-process.js";
import { LogAppendIndeterminateError, LogStorageError } from "@zhixing/core/logging";

vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), fork: vi.fn() }));

it('retains the first Store call until its supervised private channel is connected', async () => {
  let admit!: () => void;
  const ready = new Promise<void>(resolve => { admit = resolve; });
  const sent: unknown[] = [];
  const child = Object.assign(new EventEmitter(), { connected: false, ref() {}, unref() {},
    send(message: any, _callback: (error?: Error | null) => void) {
      sent.push(message);
      queueMicrotask(() => message.kind === 'close' ? child.emit('close', 0) : child.emit('message', { kind: 'result', id: message.id, value: { synthetic: true } }));
    },
    kill() { queueMicrotask(() => child.emit('close', 1)); return true; },
  });
  const store = new IsolatedLogStore('fixture-home', { acquire: vi.fn(), snapshot: vi.fn() }, () => ({ worker: child, ready }));
  const pending = store.initialize();
  expect(sent).toHaveLength(0);
  child.connected = true; admit();
  expect(await pending).toEqual({ synthetic: true });
  expect(sent).toEqual([{ kind: 'call', id: 1, operation: 'initialize' }]);
  await store.close();
});

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
