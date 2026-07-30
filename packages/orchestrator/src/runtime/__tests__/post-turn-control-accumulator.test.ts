import { describe, expect, it } from "vitest";
import type { AgentEventMap } from "@zhixing/core";
import { EventBus } from "@zhixing/core";
import { subscribePostTurnControlAccumulator } from "../post-turn-control-accumulator.js";

function makeBus(): EventBus<AgentEventMap> {
  return new EventBus<AgentEventMap>();
}

describe("subscribePostTurnControlAccumulator · last-wins 单一意图", () => {
  it("从未 emit 时 getOutcome 返回 undefined", () => {
    const acc = subscribePostTurnControlAccumulator(makeBus());
    expect(acc.getOutcome()).toBeUndefined();
  });

  it("emit 一次 → getIntent 原样带出", async () => {
    const bus = makeBus();
    const acc = subscribePostTurnControlAccumulator(bus);
    await bus.emit("post_turn_control:requested", {
      kind: "enter",
      sceneId: "scene-a",
    });
    expect(acc.getOutcome()).toEqual({
      intent: { kind: "enter", sceneId: "scene-a" },
    });
  });

  it("同 turn 多次 enter（不同 sceneId）→ 取最后（last-wins）", async () => {
    const bus = makeBus();
    const acc = subscribePostTurnControlAccumulator(bus);
    await bus.emit("post_turn_control:requested", {
      kind: "enter",
      sceneId: "scene-a",
    });
    await bus.emit("post_turn_control:requested", {
      kind: "enter",
      sceneId: "scene-b",
    });
    expect(acc.getOutcome()).toEqual({
      intent: { kind: "enter", sceneId: "scene-b" },
    });
  });

  it("exit 后再 enter → 取最后并标记异类冲突", async () => {
    const bus = makeBus();
    const acc = subscribePostTurnControlAccumulator(bus);
    await bus.emit("post_turn_control:requested", { kind: "exit" });
    await bus.emit("post_turn_control:requested", {
      kind: "enter",
      sceneId: "scene-x",
    });
    expect(acc.getOutcome()).toEqual({
      intent: { kind: "enter", sceneId: "scene-x" },
      conflict: { kindsSeen: ["exit", "enter"] },
    });
  });

  it("同类重复 set_workdir → last-wins 且不标冲突", async () => {
    const bus = makeBus();
    const acc = subscribePostTurnControlAccumulator(bus);
    await bus.emit("post_turn_control:requested", {
      kind: "set_workdir",
      sceneId: "scene-x",
      workspace: { deviceId: "device-a", bindingRef: "workspace-a" },
    });
    await bus.emit("post_turn_control:requested", {
      kind: "set_workdir",
      sceneId: "scene-x",
      workspace: null,
    });
    expect(acc.getOutcome()).toEqual({
      intent: { kind: "set_workdir", sceneId: "scene-x", workspace: null },
    });
  });

  it("onEvent 在覆盖逻辑之前调用（每次 emit 均触发）", async () => {
    const bus = makeBus();
    const seen: string[] = [];
    subscribePostTurnControlAccumulator(bus, (intent) => {
      seen.push(intent.kind === "enter" ? intent.sceneId : "exit");
    });
    await bus.emit("post_turn_control:requested", {
      kind: "enter",
      sceneId: "s1",
    });
    await bus.emit("post_turn_control:requested", { kind: "exit" });
    expect(seen).toEqual(["s1", "exit"]);
  });

  it("dispose 后不再收集；多次 dispose 幂等", async () => {
    const bus = makeBus();
    const acc = subscribePostTurnControlAccumulator(bus);
    await bus.emit("post_turn_control:requested", {
      kind: "enter",
      sceneId: "s1",
    });
    acc.dispose();
    acc.dispose(); // 幂等，不抛
    await bus.emit("post_turn_control:requested", {
      kind: "enter",
      sceneId: "s2",
    });
    expect(acc.getOutcome()).toEqual({
      intent: { kind: "enter", sceneId: "s1" },
    });
  });

  it("多次订阅互不干扰（独立句柄）", async () => {
    const bus = makeBus();
    const a = subscribePostTurnControlAccumulator(bus);
    const b = subscribePostTurnControlAccumulator(bus);
    await bus.emit("post_turn_control:requested", {
      kind: "enter",
      sceneId: "shared",
    });
    a.dispose();
    await bus.emit("post_turn_control:requested", { kind: "exit" });
    // a 已 dispose 停在 shared；b 继续收到 exit
    expect(a.getOutcome()).toEqual({
      intent: { kind: "enter", sceneId: "shared" },
    });
    expect(b.getOutcome()).toEqual({
      intent: { kind: "exit" },
      conflict: { kindsSeen: ["enter", "exit"] },
    });
  });
});

describe("subscribePostTurnControlAccumulator · onEvent 时序契约", () => {
  it("onEvent 内读 getOutcome 拿到的是不含当前事件的旧值", async () => {
    const bus = makeBus();
    const observed: Array<string | undefined> = [];
    const acc = subscribePostTurnControlAccumulator(bus, () => {
      const cur = acc.getOutcome()?.intent;
      observed.push(cur && cur.kind === "enter" ? cur.sceneId : cur?.kind);
    });
    await bus.emit("post_turn_control:requested", {
      kind: "enter",
      sceneId: "first",
    });
    await bus.emit("post_turn_control:requested", {
      kind: "enter",
      sceneId: "second",
    });
    // 第一次 onEvent 时 last 仍 undefined；第二次时 last 仍是 first
    expect(observed).toEqual([undefined, "first"]);
    expect(acc.getOutcome()).toEqual({
      intent: { kind: "enter", sceneId: "second" },
    });
  });
});
