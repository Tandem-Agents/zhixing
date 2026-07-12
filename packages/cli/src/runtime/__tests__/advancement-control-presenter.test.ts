import { describe, expect, it, vi } from "vitest";
import type { SessionEventEnvelope } from "@zhixing/rpc";
import { createAdvancementControlPresenter } from "../advancement-control-presenter.js";

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
  const flushOutput = vi.fn();
  const presenter = createAdvancementControlPresenter({
    link: link as never,
    writer: {
      ensureSegmentBreak: () => {},
      line: (text: string) => {
        lines.push(text);
      },
    },
    flushOutput,
    width: () => 120,
    ...(opts.filter ? { filter: opts.filter } : {}),
  });
  const emit = (envelope: Partial<SessionEventEnvelope>) =>
    handler?.({
      conversationId: "conv-1",
      scope: "control",
      runId: "turn-1",
      seq: 0,
      event: "advancement:proxy_enqueued",
      payload: {},
      meta: {},
      ...envelope,
    });
  return { presenter, emit, lines, flushOutput, unsubscribe };
}

describe("AdvancementControlPresenter", () => {
  it("渲染 control scope 的推进事件为系统行", () => {
    const { emit, lines, flushOutput } = harness();
    emit({ event: "advancement:proxy_enqueued" });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("知行推进");
    expect(flushOutput).toHaveBeenCalledTimes(1);
  });

  it("run scope 的信封不响应——那是 RpcEventBus 的领域", () => {
    const { emit, lines } = harness();
    emit({ scope: "run", event: "agent:run_start" });
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
