import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";

import { _getRawModeRefcount, _resetRawModeRefcountForTests } from "../../_internal/raw-mode.js";
import { LegacySelectionPresenter } from "../legacy-selection-presenter.js";
import { validateSelectionRequest } from "../types.js";

function makeStdin(): NodeJS.ReadStream {
  const stdin = new PassThrough();
  (stdin as unknown as { isTTY: boolean }).isTTY = false;
  return stdin as unknown as NodeJS.ReadStream;
}

function makeStdout(): NodeJS.WriteStream & { chunks: string[] } {
  const stdout = new PassThrough();
  const chunks: string[] = [];
  stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof stdout.write;
  Object.assign(stdout, {
    isTTY: true,
    columns: 80,
    rows: 24,
    chunks,
  });
  return stdout as unknown as NodeJS.WriteStream & { chunks: string[] };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function sendKey(
  stdin: NodeJS.ReadStream,
  key: { name: string; ctrl?: boolean; sequence?: string },
): Promise<void> {
  (stdin as unknown as EventEmitter).emit("keypress", key.sequence ?? "", {
    name: key.name,
    ctrl: key.ctrl ?? false,
    meta: false,
    shift: false,
    sequence: key.sequence ?? "",
  });
  await tick();
}

async function sendChar(stdin: NodeJS.ReadStream, ch: string): Promise<void> {
  await sendKey(stdin, { name: ch, sequence: ch });
}

describe("LegacySelectionPresenter", () => {
  beforeEach(() => {
    _resetRawModeRefcountForTests();
  });

  it("supports input options with the shared selection protocol", async () => {
    const stdin = makeStdin();
    const presenter = new LegacySelectionPresenter({
      stdin,
      stdout: makeStdout(),
    });
    const request = validateSelectionRequest({
      title: "选择",
      options: [
        { value: "save", label: "保存" },
        {
          value: "rename",
          label: "重命名",
          input: { placeholder: "名称" },
        },
      ],
    });

    const done = presenter.run(request);
    await tick();
    await sendKey(stdin, { name: "down" });
    await sendKey(stdin, { name: "return" });
    await sendChar(stdin, "新");
    await sendChar(stdin, "名");
    await sendKey(stdin, { name: "return" });

    await expect(done).resolves.toEqual({
      kind: "selected",
      value: "rename",
      input: "新名",
    });
    expect(_getRawModeRefcount()).toBe(0);
  });

  it("supports confirm options and returns to the selection layer on escape", async () => {
    const stdin = makeStdin();
    const presenter = new LegacySelectionPresenter({
      stdin,
      stdout: makeStdout(),
    });
    const request = validateSelectionRequest({
      title: "选择",
      options: [
        {
          value: "delete",
          label: "删除",
          confirm: { title: "确认删除" },
        },
      ],
    });

    const done = presenter.run(request);
    await tick();
    await sendKey(stdin, { name: "return" });
    await sendKey(stdin, { name: "escape" });
    await sendKey(stdin, { name: "return" });
    await sendKey(stdin, { name: "return" });

    await expect(done).resolves.toEqual({
      kind: "selected",
      value: "delete",
    });
    expect(_getRawModeRefcount()).toBe(0);
  });

  it("settles as aborted and releases resources when the signal fires", async () => {
    const stdin = makeStdin();
    const controller = new AbortController();
    const presenter = new LegacySelectionPresenter({
      stdin,
      stdout: makeStdout(),
    });
    const request = validateSelectionRequest({
      title: "选择",
      options: [{ value: "continue", label: "继续" }],
    });

    const done = presenter.run(request, { signal: controller.signal });
    await tick();
    controller.abort();

    await expect(done).resolves.toEqual({
      kind: "cancelled",
      cause: "aborted",
    });
    expect(_getRawModeRefcount()).toBe(0);
  });

  it("keeps the run render budget stable after terminal resize events", async () => {
    const stdin = makeStdin();
    const stdout = makeStdout();
    stdout.columns = 40;
    stdout.rows = 10;
    const presenter = new LegacySelectionPresenter({ stdin, stdout });
    const request = validateSelectionRequest({
      title: "选择",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    });

    const done = presenter.run(request);
    await tick();
    stdout.columns = 10;
    stdout.rows = 1;
    await sendKey(stdin, { name: "down" });
    await sendKey(stdin, { name: "return" });

    await expect(done).resolves.toEqual({ kind: "selected", value: "b" });
    expect(_getRawModeRefcount()).toBe(0);
  });
});
