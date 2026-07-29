import { describe, it, expect } from "vitest";
import {
  setupAccessSurfaces,
  type AccessSurface,
  type AssemblyContext,
  type SurfacePhase,
} from "../access-surface.js";
import { PROFILES, type ServerProfile } from "../profile.js";

function mockSurface(
  name: string,
  phase: SurfacePhase,
  calls: string[],
  mandatory = false,
): AccessSurface {
  return {
    name,
    phase,
    ...(mandatory ? { mandatory: true } : {}),
    setup: async () => {
      calls.push(name);
    },
  };
}

// mock 装配集合 —— profile 接入面与声明对账，mandatory 项独立于 profile，
// 数组序仍是统一依赖拓扑序。
function allSurfaces(calls: string[]): AccessSurface[] {
  return [
    mockSurface("mcp", "pre-server", calls),
    mockSurface("authority-runtime", "pre-server", calls),
    mockSurface("executor-data-plane", "pre-server", calls),
    mockSurface("conversation", "pre-server", calls),
    mockSurface("executor-job-owner", "pre-server", calls, true),
    mockSurface("asset-maintenance", "pre-server", calls),
    mockSurface("mesh-control", "pre-server", calls),
    mockSurface("lossless-data-plane", "pre-server", calls),
    mockSurface("channel", "pre-server", calls),
    mockSurface("delivery", "pre-server", calls),
    mockSurface("confirmation-bridge", "post-server", calls),
    mockSurface("conversation-recovery", "post-server", calls),
  ];
}

// 遍历引擎只读 ctx.profile；surface.setup 的 mock 不碰 ctx 其余字段。
function ctx(profile: ServerProfile): AssemblyContext {
  return { profile } as unknown as AssemblyContext;
}

describe("access-surface 数据驱动装配", () => {
  it("full 档 pre-server 按数组序装、post-server 单独装 bridge", async () => {
    const calls: string[] = [];
    const surfaces = allSurfaces(calls);
    await setupAccessSurfaces(surfaces, ctx("full"), "pre-server");
    expect(calls).toEqual([
      "mcp",
      "authority-runtime",
      "executor-data-plane",
      "conversation",
      "executor-job-owner",
      "asset-maintenance",
      "mesh-control",
      "lossless-data-plane",
      "channel",
      "delivery",
    ]);

    await setupAccessSurfaces(surfaces, ctx("full"), "post-server");
    expect(calls).toEqual([
      "mcp",
      "authority-runtime",
      "executor-data-plane",
      "conversation",
      "executor-job-owner",
      "asset-maintenance",
      "mesh-control",
      "lossless-data-plane",
      "channel",
      "delivery",
      "confirmation-bridge",
      "conversation-recovery",
    ]);
  });

  it("phase 过滤：pre-server 装配不触发 post-server 接入面", async () => {
    const calls: string[] = [];
    await setupAccessSurfaces(allSurfaces(calls), ctx("full"), "pre-server");
    expect(calls).not.toContain("confirmation-bridge");
  });

  it("PROFILES.full.surfaces 与接入面单元集合一致（防集合 / 单元漂移）", () => {
    const names = allSurfaces([])
      .filter((surface) => surface.mandatory !== true)
      .map((s) => s.name)
      .sort();
    expect([...PROFILES.full.surfaces].sort()).toEqual(names);
  });
});
