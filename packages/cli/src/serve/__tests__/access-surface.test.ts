import { describe, it, expect } from "vitest";
import {
  setupAssemblyUnits,
  type AssemblyUnit,
  type AssemblyContext,
  type SurfacePhase,
} from "../access-surface.js";
import { PROFILES, type ServerProfile } from "../profile.js";

function mockUnit(
  name: string,
  phase: SurfacePhase,
  calls: string[],
  core = false,
): AssemblyUnit {
  return {
    name,
    phase,
    ...(core ? { kind: "core" as const } : {}),
    setup: async () => {
      calls.push(name);
    },
  };
}

// mock 装配集合 —— profile 接入面与声明对账，core 单元独立于 profile，
// 数组序仍是统一依赖拓扑序。
function allUnits(calls: string[]): AssemblyUnit[] {
  return [
    mockUnit("mcp", "pre-server", calls),
    mockUnit("authority-runtime", "pre-server", calls),
    mockUnit("executor-data-plane", "pre-server", calls),
    mockUnit("conversation", "pre-server", calls),
    mockUnit("executor-job-owner", "pre-server", calls, true),
    mockUnit("asset-maintenance", "pre-server", calls),
    mockUnit("mesh-control", "pre-server", calls),
    mockUnit("lossless-data-plane", "pre-server", calls),
    mockUnit("executor-job-owner-start", "pre-server", calls, true),
    mockUnit("channel", "pre-server", calls),
    mockUnit("delivery", "pre-server", calls),
    mockUnit("confirmation-bridge", "post-server", calls),
    mockUnit("conversation-recovery", "post-server", calls),
  ];
}

// 遍历引擎只读 ctx.profile；surface.setup 的 mock 不碰 ctx 其余字段。
function ctx(profile: ServerProfile): AssemblyContext {
  return { profile } as unknown as AssemblyContext;
}

describe("access-surface 数据驱动装配", () => {
  it("full 档 pre-server 按数组序装、post-server 单独装 bridge", async () => {
    const calls: string[] = [];
    const units = allUnits(calls);
    await setupAssemblyUnits(units, ctx("full"), "pre-server");
    expect(calls).toEqual([
      "mcp",
      "authority-runtime",
      "executor-data-plane",
      "conversation",
      "executor-job-owner",
      "asset-maintenance",
      "mesh-control",
      "lossless-data-plane",
      "executor-job-owner-start",
      "channel",
      "delivery",
    ]);

    await setupAssemblyUnits(units, ctx("full"), "post-server");
    expect(calls).toEqual([
      "mcp",
      "authority-runtime",
      "executor-data-plane",
      "conversation",
      "executor-job-owner",
      "asset-maintenance",
      "mesh-control",
      "lossless-data-plane",
      "executor-job-owner-start",
      "channel",
      "delivery",
      "confirmation-bridge",
      "conversation-recovery",
    ]);
  });

  it("phase 过滤：pre-server 装配不触发 post-server 接入面", async () => {
    const calls: string[] = [];
    await setupAssemblyUnits(allUnits(calls), ctx("full"), "pre-server");
    expect(calls).not.toContain("confirmation-bridge");
  });

  it("PROFILES.full.surfaces 与接入面单元集合一致（防集合 / 单元漂移）", () => {
    const names = allUnits([])
      .filter((unit) => unit.kind !== "core")
      .map((unit) => unit.name)
      .sort();
    expect([...PROFILES.full.surfaces].sort()).toEqual(names);
  });
});
