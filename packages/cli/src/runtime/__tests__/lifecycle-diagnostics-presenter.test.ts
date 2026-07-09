import { describe, expect, it, vi } from "vitest";
import type { SessionEventEnvelope } from "@zhixing/server";
import { createLifecycleDiagnosticsPresenter } from "../lifecycle-diagnostics-presenter.js";

const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\x1B\[[0-9;]*m/g, "");

function harness(opts: { filter?: (e: SessionEventEnvelope) => boolean } = {}) {
  let handler: ((params: unknown) => void) | undefined;
  const unsubscribe = vi.fn();
  const link = {
    onNotification: vi.fn((_method: string, cb: (params: unknown) => void) => {
      handler = cb;
      return unsubscribe;
    }),
  };
  const lines: string[] = [];
  const ensureSegmentBreak = vi.fn();
  const flushOutput = vi.fn();
  const presenter = createLifecycleDiagnosticsPresenter({
    link: link as never,
    writer: {
      ensureSegmentBreak,
      line: (text: string) => {
        lines.push(text);
      },
    },
    flushOutput,
    ...(opts.filter ? { filter: opts.filter } : {}),
  });
  const emit = (envelope: Partial<SessionEventEnvelope>) =>
    handler?.({
      conversationId: "conv-1",
      scope: "control",
      runId: "",
      seq: 0,
      event: "lifecycle:warning",
      payload: {
        hookId: "zhixing-guidance",
        phase: "onWindowOpen",
        runtimeId: "runtime-1",
        windowIndex: 0,
        message: "工作场景约定读取失败，已降级为仅全局约定",
      },
      meta: {},
      ...envelope,
    });
  return { presenter, emit, lines, ensureSegmentBreak, flushOutput, unsubscribe };
}

describe("LifecycleDiagnosticsPresenter", () => {
  it("渲染 control scope 的 lifecycle warning 为约定降级提示", () => {
    const { emit, lines, ensureSegmentBreak, flushOutput } = harness();
    emit({});
    emit({ payload: {
      hookId: "zhixing-guidance",
      phase: "onWindowOpen",
      runtimeId: "runtime-1",
      windowIndex: 1,
      message: "工作场景约定读取失败，已降级为仅全局约定",
    } });

    expect(flushOutput).toHaveBeenCalledTimes(1);
    expect(ensureSegmentBreak).toHaveBeenCalledTimes(1);
    expect(stripAnsi(lines[0] ?? "")).toBe(
      "  ⚠ 约定未完全生效：工作场景约定读取失败，已降级为仅全局约定",
    );
  });

  it("相同 runtime/hook/message 只提示一次，内容变化会重新提示", () => {
    const { emit, lines } = harness();

    emit({});
    emit({});
    emit({
      payload: {
        hookId: "zhixing-guidance",
        phase: "onWindowOpen",
        runtimeId: "runtime-1",
        windowIndex: 2,
        message: "工作场景约定目录不是绝对路径，已跳过场景层",
      },
    });

    expect(lines.map(stripAnsi)).toEqual([
      "  ⚠ 约定未完全生效：工作场景约定读取失败，已降级为仅全局约定",
      "  ⚠ 约定未完全生效：工作场景约定目录不是绝对路径，已跳过场景层",
    ]);
  });

  it("忽略非 control scope 与非 lifecycle warning 事件", () => {
    const { emit, lines } = harness();
    emit({ scope: "run" });
    emit({ event: "advancement:proxy_enqueued" });
    expect(lines).toEqual([]);
  });

  it("filter 拦掉非当前对话的事件", () => {
    const { emit, lines } = harness({
      filter: (envelope) => envelope.conversationId === "conv-current",
    });
    emit({ conversationId: "conv-other" });
    expect(lines).toEqual([]);
    emit({ conversationId: "conv-current" });
    expect(lines).toHaveLength(1);
  });

  it("dispose 退订且不再渲染", () => {
    const { presenter, emit, lines, unsubscribe } = harness();
    presenter.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    emit({});
    expect(lines).toEqual([]);
  });
});
