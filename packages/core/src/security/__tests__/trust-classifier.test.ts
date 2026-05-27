/**
 * TrustClassifierMiddleware 单元测试
 *
 * 验证信任等级计算：scene 不依赖路径、workspace 看目标是否在工作目录内、global 兜底。
 * 路径判断走真实临时目录以触发 PathGuard 的 realpath 解析。
 */

import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { createDescribeTempDir } from "@zhixing/test-utils";
import { TrustClassifierMiddleware } from "../trust-classifier.js";
import type { SecurityMiddlewareContext, TrustContext } from "../types.js";

function makeCtx(
  trust: TrustContext,
  paths: string[],
  cwd: string,
): SecurityMiddlewareContext {
  return {
    request: {
      tool: "write",
      arguments: {},
      context: { cwd, trust, sessionType: "interactive" },
      ...(paths.length > 0 ? { resolvedAccess: { paths } } : {}),
    },
    toolName: "write",
    toolInput: {},
    workingDirectory: cwd,
    state: {},
  };
}

const next = async () => ({ allowed: true });

describe("TrustClassifierMiddleware", () => {
  const mw = new TrustClassifierMiddleware();
  const wsDir = createDescribeTempDir("trust-ws");
  const outDir = createDescribeTempDir("trust-out");

  it("scene 上下文 → scene（不依赖路径）", async () => {
    const ws = wsDir.getDir();
    const ctx = makeCtx({ kind: "scene", sceneId: "s1" }, [path.join(ws, "a.ts")], ws);
    await mw.execute(ctx, next);
    expect(ctx.state.trustLevel).toBe("scene");
  });

  it("global 上下文 → global", async () => {
    const ctx = makeCtx({ kind: "global" }, [], "/tmp");
    await mw.execute(ctx, next);
    expect(ctx.state.trustLevel).toBe("global");
  });

  it("workspace + 路径全在工作目录内 → workspace", async () => {
    const ws = wsDir.getDir();
    const ctx = makeCtx(
      { kind: "workspace", dir: ws },
      [path.join(ws, "src", "a.ts")],
      ws,
    );
    await mw.execute(ctx, next);
    expect(ctx.state.trustLevel).toBe("workspace");
  });

  it("workspace + 路径逃出工作目录 → global", async () => {
    const ws = wsDir.getDir();
    const out = outDir.getDir();
    const ctx = makeCtx(
      { kind: "workspace", dir: ws },
      [path.join(out, "leak.ts")],
      ws,
    );
    await mw.execute(ctx, next);
    expect(ctx.state.trustLevel).toBe("global");
  });

  it("workspace + 多路径任一逃出 → global", async () => {
    const ws = wsDir.getDir();
    const out = outDir.getDir();
    const ctx = makeCtx(
      { kind: "workspace", dir: ws },
      [path.join(ws, "ok.ts"), path.join(out, "leak.ts")],
      ws,
    );
    await mw.execute(ctx, next);
    expect(ctx.state.trustLevel).toBe("global");
  });

  it("workspace + 无路径操作 → global（workspace 是路径锚，不锚无路径操作）", async () => {
    const ws = wsDir.getDir();
    const ctx = makeCtx({ kind: "workspace", dir: ws }, [], ws);
    await mw.execute(ctx, next);
    expect(ctx.state.trustLevel).toBe("global");
  });
});
