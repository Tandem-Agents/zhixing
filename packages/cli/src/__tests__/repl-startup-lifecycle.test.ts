import { describe, expect, it } from "vitest";
import {
  renderCoreHostLifecycleNotice,
  renderCoreHostPersistentLifecycleNotice,
} from "../repl.js";
import type { CoreHostLifecycleNotice } from "../runtime/core-host-connection.js";
import type { CliWriter, StartupProgressPresenter } from "../screen/index.js";

class FakeWriter implements CliWriter {
  lines: string[] = [];

  line(text: string): void {
    this.lines.push(text);
  }

  appendInline(): void {}

  notify(text: string): void {
    this.lines.push(text);
  }

  ensureSegmentBreak(): void {}

  beginReplaceableSegment(): never {
    throw new Error("not used");
  }
}

class FakeStartupProgress {
  begins = 0;
  stops = 0;
  accepts = true;

  begin(): void {
    this.begins += 1;
  }

  stop(): void {
    this.stops += 1;
  }

  acceptsStartupNotices(): boolean {
    return this.accepts;
  }
}

function asStartupProgress(
  progress: FakeStartupProgress,
): StartupProgressPresenter {
  return progress as unknown as StartupProgressPresenter;
}

describe("REPL startup lifecycle notice rendering", () => {
  it("starting 只启动 transient presenter，不写持久输出", () => {
    const writer = new FakeWriter();
    const progress = new FakeStartupProgress();

    renderCoreHostLifecycleNotice({
      writer,
      phase: "initial",
      startupProgress: asStartupProgress(progress),
      notice: { kind: "starting" },
    });

    expect(progress.begins).toBe(1);
    expect(writer.lines).toEqual([]);
  });

  it("无 transient presenter 的启动期 starting 显示打开知行，不误报恢复连接", () => {
    const writer = new FakeWriter();

    renderCoreHostLifecycleNotice({
      writer,
      phase: "initial",
      startupProgress: null,
      notice: { kind: "starting" },
    });

    expect(writer.lines[0]).toContain("正在打开知行");
    expect(writer.lines[0]).not.toContain("恢复连接");
  });

  it("首页 attach 前的非 starting 通知会 defer，不会丢弃也不会写到欢迎块前", () => {
    const writer = new FakeWriter();
    const progress = new FakeStartupProgress();
    const deferred: Array<
      Exclude<CoreHostLifecycleNotice, { kind: "starting" }>
    > = [];
    const notice: Exclude<CoreHostLifecycleNotice, { kind: "starting" }> = {
      kind: "version-pending",
      clientVersion: "2.0.0",
      serverVersion: "1.0.0",
      connectionCount: 2,
    };

    renderCoreHostLifecycleNotice({
      writer,
      phase: "initial",
      startupProgress: asStartupProgress(progress),
      notice,
      deferNotice: (n) => deferred.push(n),
    });

    expect(progress.stops).toBe(1);
    expect(writer.lines).toEqual([]);
    expect(deferred).toEqual([notice]);

    for (const deferredNotice of deferred) {
      renderCoreHostPersistentLifecycleNotice(writer, deferredNotice);
    }
    expect(writer.lines[0]).toContain("知行版本待更新");
  });

  it("首页 attach 后的非 starting 通知立即按原语义渲染", () => {
    const writer = new FakeWriter();
    const progress = new FakeStartupProgress();
    progress.accepts = false;

    renderCoreHostLifecycleNotice({
      writer,
      phase: "running",
      startupProgress: asStartupProgress(progress),
      notice: { kind: "host-replaced", reason: "unresponsive" },
    });

    expect(progress.stops).toBe(1);
    expect(writer.lines[0]).toContain("知行已完成更新");
  });

  it("首页 attach 后的 starting 通知立即渲染运行期等待反馈", () => {
    const writer = new FakeWriter();
    const progress = new FakeStartupProgress();
    progress.accepts = false;

    renderCoreHostLifecycleNotice({
      writer,
      phase: "running",
      startupProgress: asStartupProgress(progress),
      notice: { kind: "starting" },
    });

    expect(progress.begins).toBe(0);
    expect(writer.lines[0]).toContain("知行正在恢复连接");
  });
});
