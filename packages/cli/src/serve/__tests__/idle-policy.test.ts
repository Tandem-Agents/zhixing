/**
 * 空闲退出判定回归 —— "无人且无事"才退。
 *
 * 锁住三个曾经/容易出错的语义:
 *   - 渠道在场看真实连接状态,不是 registry 对象存在性(配了渠道但全部
 *     error/disconnected 必须退出——废宿主常驻的回归锚)
 *   - connecting 算在场(断线重连窗口不被误杀)
 *   - 用户待办保活,内部维护任务不算待办
 */

import { describe, expect, it } from "vitest";
import { createIdleExitGate, shouldIdleExit } from "../idle-policy.js";

describe("空闲须跨过一个完整检查周期", () => {
  it("单次空闲不退出；连续两次空闲且期间无连接进出才退出", () => {
    const gate = createIdleExitGate();
    expect(gate(true, 4)).toBe(false);
    expect(gate(true, 4)).toBe(true);
  });

  it("上一终端刚断开、新终端在两次检查之间连上又断开：连接变动计数变化，不退出", () => {
    const gate = createIdleExitGate();
    expect(gate(true, 4)).toBe(false);
    // 期间一条连接加入并断开（+2）：上一次的空闲判定作废，重新起算
    expect(gate(true, 6)).toBe(false);
    expect(gate(true, 6)).toBe(true);
  });

  it("任一次检查不空闲即重置", () => {
    const gate = createIdleExitGate();
    expect(gate(true, 4)).toBe(false);
    expect(gate(false, 5)).toBe(false);
    expect(gate(true, 6)).toBe(false);
    expect(gate(true, 6)).toBe(true);
  });
});

describe("shouldIdleExit", () => {
  it("无人且无事 → 退出(含:渠道装配过但全部 error/disconnected)", () => {
    expect(
      shouldIdleExit({
        connectionCount: 0,
        channelStates: [],
        hasUserPendingWork: false,
      }),
    ).toBe(true);
    // 回归锚:配了渠道但连接全失败 ≠ 在场——必须退出
    expect(
      shouldIdleExit({
        connectionCount: 0,
        channelStates: ["error", "disconnected"],
        hasUserPendingWork: false,
      }),
    ).toBe(true);
  });

  it("有活跃 RPC 连接 → 不退", () => {
    expect(
      shouldIdleExit({
        connectionCount: 1,
        channelStates: [],
        hasUserPendingWork: false,
      }),
    ).toBe(false);
  });

  it("渠道 connected 或 connecting → 不退(重连窗口不被误杀)", () => {
    for (const state of ["connected", "connecting"] as const) {
      expect(
        shouldIdleExit({
          connectionCount: 0,
          channelStates: ["error", state],
          hasUserPendingWork: false,
        }),
      ).toBe(false);
    }
  });

  it("有用户待办 → 不退('我不在它也跑')", () => {
    expect(
      shouldIdleExit({
        connectionCount: 0,
        channelStates: [],
        hasUserPendingWork: true,
      }),
    ).toBe(false);
  });
});
