import path from "node:path";

import {
  buildGuidanceMessagePair,
  loadLayeredGuidance,
  type Message,
} from "@zhixing/core";
import type { LifecycleWindowOpenContext } from "@zhixing/orchestrator/runtime";
import { describe, expect, it, vi } from "vitest";

import { createZhixingGuidanceLifecycle } from "../zhixing-guidance-lifecycle.js";

describe("createZhixingGuidanceLifecycle", () => {
  it("conversation 窗口入口先清空，再把裸 payload 包成 guidance message pair", async () => {
    const deps = makeDeps({ payload: "全局约定" });
    const ctx = makeWindowOpenContext();

    await createZhixingGuidanceLifecycle(deps).onWindowOpen?.(ctx);

    expect(ctx.prefixes).toEqual([null, buildGuidanceMessagePair("全局约定")]);
    expect(deps.loadLayeredGuidance).toHaveBeenCalledWith({
      roots: { homeDir: "/home" },
      readGuidanceFile: deps.readGuidanceFile,
      reportWarning: expect.any(Function),
    });
    expect(deps.getWorkscene).not.toHaveBeenCalled();
  });

  it("work runtime 使用绝对 workdir 加载场景层", async () => {
    const workdir = path.resolve("workscene-project");
    const deps = makeDeps({
      payload: "场景约定",
      scene: { workdir },
    });
    const ctx = makeWindowOpenContext({ mode: "work", sceneId: "scene-1" });

    await createZhixingGuidanceLifecycle(deps).onWindowOpen?.(ctx);

    expect(deps.getWorkscene).toHaveBeenCalledWith("scene-1");
    expect(deps.loadLayeredGuidance).toHaveBeenCalledWith({
      roots: { homeDir: "/home", workdir },
      readGuidanceFile: deps.readGuidanceFile,
      reportWarning: expect.any(Function),
    });
    expect(ctx.prefixes.at(-1)).toEqual(buildGuidanceMessagePair("场景约定"));
  });

  it("场景查询失败时保留全局层并上报降级诊断", async () => {
    const deps = makeDeps({
      payload: "全局约定",
      getWorksceneError: new Error("db down"),
    });
    const ctx = makeWindowOpenContext({ mode: "work", sceneId: "scene-1" });

    await createZhixingGuidanceLifecycle(deps).onWindowOpen?.(ctx);

    expect(deps.loadLayeredGuidance).toHaveBeenCalledWith({
      roots: { homeDir: "/home" },
      readGuidanceFile: deps.readGuidanceFile,
      reportWarning: expect.any(Function),
    });
    expect(ctx.warnings).toEqual([
      { message: "工作场景约定查询失败，已降级为仅全局约定：db down" },
    ]);
    expect(ctx.prefixes.at(0)).toBeNull();
    expect(ctx.prefixes.at(-1)).toEqual(buildGuidanceMessagePair("全局约定"));
  });

  it("相对 workdir 降级为全局层，不继承旧 prefix", async () => {
    const deps = makeDeps({
      payload: "全局约定",
      scene: { workdir: "relative/project" },
    });
    const ctx = makeWindowOpenContext({ mode: "work", sceneId: "scene-1" });

    await createZhixingGuidanceLifecycle(deps).onWindowOpen?.(ctx);

    expect(deps.loadLayeredGuidance).toHaveBeenCalledWith({
      roots: { homeDir: "/home" },
      readGuidanceFile: deps.readGuidanceFile,
      reportWarning: expect.any(Function),
    });
    expect(ctx.prefixes.at(0)).toBeNull();
    expect(ctx.warnings[0]?.message).toContain("不是绝对路径");
  });

  it("无内容或加载异常时保持本窗 prefix 为空", async () => {
    const emptyDeps = makeDeps({ payload: null });
    const emptyCtx = makeWindowOpenContext();
    await createZhixingGuidanceLifecycle(emptyDeps).onWindowOpen?.(emptyCtx);
    expect(emptyCtx.prefixes).toEqual([null, null]);

    const errorDeps = makeDeps({ loadError: new Error("boom") });
    const errorCtx = makeWindowOpenContext();
    await createZhixingGuidanceLifecycle(errorDeps).onWindowOpen?.(errorCtx);
    expect(errorCtx.prefixes).toEqual([null, null]);
    expect(errorCtx.warnings).toEqual([
      { message: "约定加载失败，已跳过本窗约定：boom" },
    ]);
  });

  it("真实 layered guidance 读取降级会透传 scope、path 与 error 到诊断出口", async () => {
    const ctx = makeWindowOpenContext();
    const guidancePath = path.join("/home", "ZHIXING.md");
    const deps = {
      getZhixingHome: () => "/home",
      getWorkscene: vi.fn(async () => null),
      readGuidanceFile: vi.fn(async ({ path: filePath, reportWarning }) => {
        reportWarning({
          message: `EACCES: permission denied, open '${filePath}'`,
        });
        return null;
      }),
      loadLayeredGuidance,
    };

    await createZhixingGuidanceLifecycle(deps).onWindowOpen?.(ctx);

    expect(ctx.prefixes).toEqual([null, null]);
    expect(ctx.warnings).toEqual([
      {
        message: `全局约定：EACCES: permission denied, open '${guidancePath}'`,
      },
    ]);
  });

  it("ephemeral runtime 只清空本窗贡献并跳过 guidance", async () => {
    const deps = makeDeps({ payload: "不应读取" });
    const ctx = makeWindowOpenContext({ runtimeKind: "ephemeral" });

    await createZhixingGuidanceLifecycle(deps).onWindowOpen?.(ctx);

    expect(ctx.prefixes).toEqual([null]);
    expect(deps.loadLayeredGuidance).not.toHaveBeenCalled();
    expect(deps.getWorkscene).not.toHaveBeenCalled();
  });
});

function makeDeps(opts: {
  payload?: string | null;
  scene?: { readonly workdir?: string } | null;
  getWorksceneError?: Error;
  loadError?: Error;
}) {
  return {
    getZhixingHome: () => "/home",
    getWorkscene: vi.fn(async () => {
      if (opts.getWorksceneError) throw opts.getWorksceneError;
      return opts.scene ?? null;
    }),
    readGuidanceFile: vi.fn(async () => null),
    loadLayeredGuidance: vi.fn(async () => {
      if (opts.loadError) throw opts.loadError;
      return opts.payload ?? null;
    }),
  };
}

function makeWindowOpenContext(
  overrides: Partial<LifecycleWindowOpenContext> = {},
): LifecycleWindowOpenContext & {
  prefixes: Array<readonly Message[] | null>;
  warnings: Array<{ message: string }>;
} {
  const prefixes: Array<readonly Message[] | null> = [];
  const warnings: Array<{ message: string }> = [];
  return {
    runtimeId: "runtime-1",
    runtimeKind: "conversation",
    mode: "main",
    providerId: "mock",
    model: "mock-model",
    reason: "instance-start",
    windowIndex: 0,
    updateSystemPromptSegment: () => {},
    contributeMessagePrefix: (messages) => prefixes.push(messages),
    reportLifecycleWarning: (event) => warnings.push(event),
    prefixes,
    warnings,
    ...overrides,
  };
}
