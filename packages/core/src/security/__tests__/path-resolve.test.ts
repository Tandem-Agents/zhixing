import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PathResolveMiddleware } from "../path-resolve.js";
import { SecurityPipeline } from "../security-pipeline.js";
import type {
  SecurityMiddlewareContext,
  SecurityMiddlewareResult,
} from "../types.js";

const next = async (): Promise<SecurityMiddlewareResult> => ({ allowed: true });

function makeCtx(
  toolName: string,
  toolInput: Record<string, unknown>,
  cwd: string,
  seedPaths?: string[],
): SecurityMiddlewareContext {
  return {
    request: {
      tool: toolName,
      arguments: toolInput,
      context: { cwd, workspace: cwd, sessionType: "interactive" },
      ...(seedPaths ? { resolvedAccess: { paths: seedPaths } } : {}),
    },
    toolName,
    toolInput,
    workingDirectory: cwd,
    state: {},
  };
}

describe("PathResolveMiddleware", () => {
  let root: string;
  let ws: string;
  let symlinkOk = false;

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pr-")));
    ws = path.join(root, "ws");
    fs.mkdirSync(ws, { recursive: true });
    // 模拟 ~/.zhixing/credentials.json（路径段匹配 bi-zhixing-credentials-block）
    fs.mkdirSync(path.join(root, ".zhixing"), { recursive: true });
    fs.writeFileSync(path.join(root, ".zhixing", "credentials.json"), "{}");
    try {
      fs.symlinkSync(
        path.join(root, ".zhixing", "credentials.json"),
        path.join(ws, "innocent.txt"),
      );
      symlinkOk = true;
    } catch {
      symlinkOk = false;
    }
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  const mw = new PathResolveMiddleware();

  describe("中间件单元", () => {
    it("从标准 key 提取路径并 realpath 填入 resolvedAccess.paths + state", async () => {
      const ctx = makeCtx("write", { path: "a.txt" }, ws);
      await mw.execute(ctx, next);
      expect(ctx.request.resolvedAccess?.paths).toEqual([path.join(ws, "a.txt")]);
      expect(ctx.state.resolvedPaths).toEqual([path.join(ws, "a.txt")]);
    });

    it("symlink 被解析为真实目标（决策将基于 realpath 后路径）", async () => {
      if (!symlinkOk) return;
      const ctx = makeCtx("read", { path: "innocent.txt" }, ws);
      await mw.execute(ctx, next);
      expect(ctx.request.resolvedAccess?.paths).toEqual([
        path.join(root, ".zhixing", "credentials.json"),
      ]);
    });

    it("无路径参数时不设 resolvedPaths、直接放行", async () => {
      const ctx = makeCtx("bash", { command: "echo hi" }, ws);
      const r = await mw.execute(ctx, next);
      expect(r.allowed).toBe(true);
      expect(ctx.state.resolvedPaths).toBeUndefined();
    });

    it("realpath 并去重 CommandAnalyzer 已填的命令路径", async () => {
      const ctx = makeCtx("bash", { command: "cat ./x" }, ws, ["./x"]);
      await mw.execute(ctx, next);
      expect(ctx.request.resolvedAccess?.paths).toEqual([path.join(ws, "x")]);
    });
  });

  describe("S1 端到端回归：symlink 不再绕过 bypassImmune 凭证保护", () => {
    it("read 指向 .zhixing/credentials.json 的 symlink → 被 block", async () => {
      if (!symlinkOk) return;
      const pipeline = new SecurityPipeline({ workspace: ws });
      const result = await pipeline.evaluate("read", { path: "innocent.txt" }, ws);
      // 修复前：matchPath 看到未解析的 "innocent.txt"、匹配不上凭证规则，read 又被判 observe → 放行
      // 修复后：PathResolve 先 realpath 出真实凭证路径 → bi-zhixing-credentials-block 命中 → block
      expect(result.allowed).toBe(false);
    });
  });
});
