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
import { shouldIdleExit } from "../idle-policy.js";

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
