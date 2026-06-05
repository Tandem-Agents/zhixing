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
): AccessSurface {
  return {
    name,
    phase,
    setup: async () => {
      calls.push(name);
    },
  };
}

// mock 接入面集合 —— name 与 PROFILES.full.surfaces 对齐，数组序 = 依赖拓扑序。
function allSurfaces(calls: string[]): AccessSurface[] {
  return [
    mockSurface("mcp", "pre-server", calls),
    mockSurface("conversation", "pre-server", calls),
    mockSurface("channel", "pre-server", calls),
    mockSurface("delivery", "pre-server", calls),
    mockSurface("text-renderer", "pre-server", calls),
    mockSurface("confirmation-bridge", "post-server", calls),
  ];
}

// 遍历引擎只读 ctx.profile；surface.setup 的 mock 不碰 ctx 其余字段。
function ctx(profile: ServerProfile): AssemblyContext {
  return { profile } as unknown as AssemblyContext;
}

describe("access-surface 数据驱动装配", () => {
  it("schedule 档不装任何接入面（恒定核心 only）", async () => {
    const calls: string[] = [];
    await setupAccessSurfaces(allSurfaces(calls), ctx("schedule"), "pre-server");
    await setupAccessSurfaces(allSurfaces(calls), ctx("schedule"), "post-server");
    expect(calls).toEqual([]);
  });

  it("full 档 pre-server 按数组序装、post-server 单独装 bridge", async () => {
    const calls: string[] = [];
    const surfaces = allSurfaces(calls);
    await setupAccessSurfaces(surfaces, ctx("full"), "pre-server");
    expect(calls).toEqual([
      "mcp",
      "conversation",
      "channel",
      "delivery",
      "text-renderer",
    ]);

    await setupAccessSurfaces(surfaces, ctx("full"), "post-server");
    expect(calls).toEqual([
      "mcp",
      "conversation",
      "channel",
      "delivery",
      "text-renderer",
      "confirmation-bridge",
    ]);
  });

  it("phase 过滤：pre-server 装配不触发 post-server 接入面", async () => {
    const calls: string[] = [];
    await setupAccessSurfaces(allSurfaces(calls), ctx("full"), "pre-server");
    expect(calls).not.toContain("confirmation-bridge");
  });

  it("PROFILES.full.surfaces 与接入面单元集合一致（防集合 / 单元漂移）", () => {
    const names = allSurfaces([])
      .map((s) => s.name)
      .sort();
    expect([...PROFILES.full.surfaces].sort()).toEqual(names);
  });
});
