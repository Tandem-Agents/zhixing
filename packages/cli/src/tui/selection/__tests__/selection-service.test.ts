import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";

import type { InputRegion, ScreenController } from "../../../screen/index.js";
import { stripAnsi } from "../../ansi.js";
import { _resetRawModeRefcountForTests } from "../../_internal/raw-mode.js";
import {
  createSelectionService,
  SelectionBusyError,
  SelectionUnavailableError,
} from "../index.js";

function makeRequest() {
  return {
    title: "  选择操作  ",
    options: [
      { value: "go", label: "继续" },
      { value: "stop", label: "停止" },
    ],
  } as const;
}

function makeStdin(): NodeJS.ReadStream {
  const stdin = new PassThrough();
  (stdin as unknown as { isTTY: boolean }).isTTY = false;
  return stdin as unknown as NodeJS.ReadStream;
}

function makeStdout(): NodeJS.WriteStream {
  const stdout = new PassThrough();
  Object.assign(stdout, {
    isTTY: true,
    columns: 80,
    rows: 24,
  });
  return stdout as unknown as NodeJS.WriteStream;
}

function makeScreen(): {
  screen: ScreenController;
  attached: () => InputRegion | null;
  repaintCount: () => number;
} {
  let attachedRegion: InputRegion | null = null;
  let repaints = 0;
  const screen = {
    attachInput: (region: InputRegion) => {
      attachedRegion = region;
    },
    requestInputRepaint: () => {
      repaints += 1;
    },
  } as unknown as ScreenController;
  return {
    screen,
    attached: () => attachedRegion,
    repaintCount: () => repaints,
  };
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
  await new Promise((resolve) => setImmediate(resolve));
}

describe("createSelectionService", () => {
  beforeEach(() => {
    _resetRawModeRefcountForTests();
  });

  it("rejects non-interactive environments before presenting", async () => {
    const service = createSelectionService({
      isInteractive: () => false,
    });

    await expect(service.choose(makeRequest())).rejects.toBeInstanceOf(
      SelectionUnavailableError,
    );
  });

  it("validates requests before presenting them through the real inline path", async () => {
    const stdin = makeStdin();
    const screen = makeScreen();
    const service = createSelectionService({
      screen: screen.screen,
      stdin,
      stdout: makeStdout(),
      isInteractive: () => true,
    });

    const done = service.choose(makeRequest());
    await new Promise((resolve) => setImmediate(resolve));

    expect(stripAnsi(screen.attached()?.renderLines().join("\n") ?? "")).toContain(
      "选择操作",
    );
    await sendKey(stdin, { name: "return" });
    await expect(done).resolves.toEqual({ kind: "selected", value: "go" });
  });

  it("keeps a single active selection owner", async () => {
    const stdin = makeStdin();
    const screen = makeScreen();
    const service = createSelectionService({
      screen: screen.screen,
      stdin,
      stdout: makeStdout(),
      isInteractive: () => true,
    });

    const first = service.choose(makeRequest());
    await new Promise((resolve) => setImmediate(resolve));
    await expect(service.choose(makeRequest())).rejects.toBeInstanceOf(
      SelectionBusyError,
    );

    await sendKey(stdin, { name: "return" });
    await expect(first).resolves.toEqual({ kind: "selected", value: "go" });
  });

  it("uses the inline screen presenter and releases chrome after selection", async () => {
    const stdin = makeStdin();
    const screen = makeScreen();
    const events: string[] = [];
    const service = createSelectionService({
      screen: screen.screen,
      stdin,
      stdout: makeStdout(),
      isInteractive: () => true,
      beforeShow: () => {
        events.push("before");
      },
      afterShow: () => {
        events.push("after");
      },
    });

    const done = service.choose(makeRequest());
    await new Promise((resolve) => setImmediate(resolve));

    expect(screen.attached()).not.toBeNull();
    await sendKey(stdin, { name: "return" });

    await expect(done).resolves.toEqual({ kind: "selected", value: "go" });
    expect(events).toEqual(["before", "after"]);
    expect(screen.attached()?.renderLines()).toEqual([]);
    expect(screen.repaintCount()).toBeGreaterThan(0);
  });

  it("returns cancelled when the run signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const screen = makeScreen();
    const service = createSelectionService({
      screen: screen.screen,
      stdin: makeStdin(),
      stdout: makeStdout(),
      isInteractive: () => true,
    });

    await expect(
      service.choose(makeRequest(), { signal: controller.signal }),
    ).resolves.toEqual({ kind: "cancelled", cause: "aborted" });
    expect(screen.attached()).toBeNull();
  });
});
