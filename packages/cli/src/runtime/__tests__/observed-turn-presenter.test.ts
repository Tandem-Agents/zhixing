import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEventMap, Listener, Unsubscribe } from "@zhixing/core";
import { createObservedTurnPresenter } from "../observed-turn-presenter.js";

class FakeBus {
  private readonly listeners = new Map<string, Set<Listener<never>>>();

  on<K extends keyof AgentEventMap & string>(
    event: K,
    listener: Listener<AgentEventMap[K]>,
  ): Unsubscribe {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => {
      set?.delete(listener as Listener<never>);
    };
  }

  emit<K extends keyof AgentEventMap & string>(
    event: K,
    payload: AgentEventMap[K],
  ): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as Listener<AgentEventMap[K]>)(payload, {
        emittedAt: Date.now(),
      });
    }
  }
}

function makeWriter() {
  return {
    ensureSegmentBreak: vi.fn(),
    line: vi.fn(),
  };
}

function decorate(
  bus: FakeBus,
  presenter: ReturnType<typeof createObservedTurnPresenter>,
  turnId = "turn-remote",
) {
  return presenter.decorateRunBus({
    bus: bus as never,
    conversationId: "conv-1",
    turnContext: { turnId },
  });
}

describe("ObservedTurnPresenter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("agent:run_start 为旁观端补远端用户边界", () => {
    const bus = new FakeBus();
    const writer = makeWriter();
    const flushOutput = vi.fn();
    const presenter = createObservedTurnPresenter({
      writer,
      flushOutput,
      isLocalTurn: () => false,
      width: () => 120,
    });
    decorate(bus, presenter);

    bus.emit("agent:run_start", { prompt: "我们刚才说了什么" });

    expect(flushOutput).toHaveBeenCalledTimes(1);
    expect(writer.ensureSegmentBreak).toHaveBeenCalledTimes(1);
    expect(writer.line).toHaveBeenCalledTimes(1);
    expect(writer.line.mock.calls[0]![0]).toContain("来自另一个接入面");
    expect(writer.line.mock.calls[0]![0]).toContain("我们刚才说了什么");
  });

  it("本地发起的 run_start 不重复渲染输入边界", () => {
    const bus = new FakeBus();
    const writer = makeWriter();
    const flushOutput = vi.fn();
    const presenter = createObservedTurnPresenter({
      writer,
      flushOutput,
      isLocalTurn: () => true,
    });
    decorate(bus, presenter);

    bus.emit("agent:run_start", { prompt: "本地输入" });
    presenter.onObservedTurnDelta({
      conversationId: "conv-1",
      turnId: "turn-remote",
    });
    presenter.onObservedTurnComplete({
      conversationId: "conv-1",
      turnId: "turn-remote",
    });

    expect(flushOutput).not.toHaveBeenCalled();
    expect(writer.line).not.toHaveBeenCalled();
  });

  it("session.complete 是旁观 turn 的权威收束点", () => {
    const writer = makeWriter();
    const flushOutput = vi.fn();
    const presenter = createObservedTurnPresenter({
      writer,
      flushOutput,
      isLocalTurn: () => false,
    });

    presenter.onObservedTurnDelta({
      conversationId: "conv-1",
      turnId: "turn-remote",
    });
    presenter.onObservedTurnComplete({
      conversationId: "conv-1",
      turnId: "turn-remote",
    });

    expect(flushOutput).toHaveBeenCalledTimes(1);
  });

  it("agent:run_end 只作 complete 缺失时的兜底,不会与 complete 重复 flush", () => {
    vi.useFakeTimers();
    const bus = new FakeBus();
    const writer = makeWriter();
    const flushOutput = vi.fn();
    const presenter = createObservedTurnPresenter({
      writer,
      flushOutput,
      isLocalTurn: () => false,
    });
    decorate(bus, presenter);

    bus.emit("agent:run_start", { prompt: "远端输入" });
    flushOutput.mockClear();
    bus.emit("agent:run_end", {
      reason: "completed",
      duration: 1,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    presenter.onObservedTurnComplete({
      conversationId: "conv-1",
      turnId: "turn-remote",
    });
    vi.runAllTimers();

    expect(flushOutput).toHaveBeenCalledTimes(1);
  });

  it("缺失 complete 时 agent:run_end 兜底收束旁观输出", () => {
    vi.useFakeTimers();
    const bus = new FakeBus();
    const writer = makeWriter();
    const flushOutput = vi.fn();
    const presenter = createObservedTurnPresenter({
      writer,
      flushOutput,
      isLocalTurn: () => false,
    });
    decorate(bus, presenter);

    presenter.onObservedTurnDelta({
      conversationId: "conv-1",
      turnId: "turn-remote",
    });
    bus.emit("agent:run_end", {
      reason: "completed",
      duration: 1,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    vi.runAllTimers();

    expect(flushOutput).toHaveBeenCalledTimes(1);
  });
});
