/**
 * OutboxRegistry 单测
 */

import { describe, it, expect, vi } from "vitest";
import { OutboxRegistry, makeKey } from "../outbox-registry.js";
import type {
  OutboxDoSend,
  EmissionSource,
} from "../outbox-types.js";
import type { DeliveryTarget } from "../../channels/types.js";

const T_A: DeliveryTarget = { channelId: "feishu", to: "ou_a" };
const T_B: DeliveryTarget = { channelId: "feishu", to: "ou_b" };
const T_THREAD: DeliveryTarget = { channelId: "feishu", to: "ou_a", threadId: "t1" };

function llmSource(): EmissionSource {
  return { kind: "llm-reply", conversationId: "c", turnId: "t" };
}

const mkSend = (): OutboxDoSend =>
  vi.fn(async () => ({ success: true, retryable: false }));

// ─── 基础生命周期 ───

describe("OutboxRegistry 生命周期", () => {
  it("of() 懒创建，同一 key 返回同一实例", () => {
    const r = new OutboxRegistry(mkSend());
    const ob1 = r.of(T_A);
    const ob2 = r.of(T_A);
    expect(ob1).toBe(ob2);
    expect(r.size()).toBe(1);
  });

  it("不同 target 得到不同 Outbox 实例", () => {
    const r = new OutboxRegistry(mkSend());
    const ob1 = r.of(T_A);
    const ob2 = r.of(T_B);
    expect(ob1).not.toBe(ob2);
    expect(r.size()).toBe(2);
  });

  it("threadId 不进 key——同 to 的 thread 共享 timeline", () => {
    const r = new OutboxRegistry(mkSend());
    const ob1 = r.of(T_A);
    const ob2 = r.of(T_THREAD);
    expect(ob1).toBe(ob2);
    expect(r.size()).toBe(1);
  });

  it("makeKey 格式 `${channelId}:${to}`", () => {
    expect(makeKey(T_A)).toBe("feishu:ou_a");
    expect(makeKey(T_THREAD)).toBe("feishu:ou_a");
  });
});

// ─── 独立性（INV-2 的 registry 层验证） ───

describe("OutboxRegistry target 独立性", () => {
  it("A 卡死不影响 B 的 drain", async () => {
    let aFirstCalled = false;
    const send: OutboxDoSend = (target) => {
      if (target.to === "ou_a" && !aFirstCalled) {
        aFirstCalled = true;
        return new Promise(() => {}); // A 第一条永不完成
      }
      return Promise.resolve({ success: true, retryable: false });
    };

    const r = new OutboxRegistry(send, { sendTimeoutMs: 0 });
    const pA = r.of(T_A).post({
      target: T_A,
      content: { text: "stuck" },
      source: llmSource(),
    });
    const pB = r.of(T_B).post({
      target: T_B,
      content: { text: "fine" },
      source: llmSource(),
    });

    await pB;
    expect(r.of(T_B).isIdle()).toBe(true);
    // A 还在 inflight
    expect(r.of(T_A).isIdle()).toBe(false);
    // 避免 test hang 的 promise leak：不等 pA
    void pA;
  });
});

// ─── reapIdle ───

describe("OutboxRegistry reapIdle", () => {
  it("回收超过 idleTimeoutMs 且空闲的 Outbox", async () => {
    let currentTime = 1_000_000;
    const now = () => currentTime;
    const r = new OutboxRegistry(mkSend(), {
      now,
      idleTimeoutMs: 100,
    });

    // 创建后立即 post 一条
    const ob = r.of(T_A);
    await ob.post({
      target: T_A,
      content: { text: "hi" },
      source: llmSource(),
    });
    expect(r.size()).toBe(1);

    // 时间推进，但未到阈值
    currentTime += 50;
    expect(r.reapIdle()).toBe(0);
    expect(r.size()).toBe(1);

    // 超过阈值
    currentTime += 100;
    expect(r.reapIdle()).toBe(1);
    expect(r.size()).toBe(0);
  });

  it("inflight 状态的 Outbox 即使超时也不回收", async () => {
    let currentTime = 1_000_000;
    const now = () => currentTime;

    const send: OutboxDoSend = () =>
      new Promise<never>(() => {}); // 永不完成，保持 inflight

    const r = new OutboxRegistry(send, {
      now,
      idleTimeoutMs: 10,
      sendTimeoutMs: 0,
    });

    const ob = r.of(T_A);
    void ob.post({
      target: T_A,
      content: { text: "hi" },
      source: llmSource(),
    });

    // 等 drain 进入 inflight
    await new Promise((r2) => setTimeout(r2, 5));

    currentTime += 100;
    expect(r.reapIdle()).toBe(0);
    expect(r.size()).toBe(1);
  });

  it("reapIdle 支持覆盖默认 maxIdleMs 参数", () => {
    let currentTime = 1_000_000;
    const now = () => currentTime;
    const r = new OutboxRegistry(mkSend(), {
      now,
      idleTimeoutMs: 999_999,  // 默认不回收
    });

    r.of(T_A);
    currentTime += 50;
    expect(r.reapIdle(10)).toBe(1);
  });
});

// ─── dispose ───

describe("OutboxRegistry dispose", () => {
  it("等待所有 Outbox 排空后移除全部", async () => {
    let pending = 0;
    const send: OutboxDoSend = async () => {
      pending++;
      await new Promise((r) => setTimeout(r, 10));
      pending--;
      return { success: true, retryable: false };
    };

    const r = new OutboxRegistry(send, { sendTimeoutMs: 0 });
    r.of(T_A).post({ target: T_A, content: { text: "a" }, source: llmSource() });
    r.of(T_B).post({ target: T_B, content: { text: "b" }, source: llmSource() });

    await r.dispose();
    expect(r.size()).toBe(0);
    expect(pending).toBe(0);
  });
});

// ─── keys 观测 ───

describe("OutboxRegistry 观测接口", () => {
  it("keys() 返回已托管的 OutboxKey 列表", () => {
    const r = new OutboxRegistry(mkSend());
    r.of(T_A);
    r.of(T_B);
    expect(r.keys().sort()).toEqual(["feishu:ou_a", "feishu:ou_b"]);
  });
});
