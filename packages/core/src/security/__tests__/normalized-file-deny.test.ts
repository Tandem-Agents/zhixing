import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { createTempDir } from "@zhixing-ai/test-utils";
import {
  PermissionStore,
  SecurityPipeline,
  ToolFilePathExtractor,
  bindPermissionRuleExecutionSource,
} from "../index.js";
import type { ToolDefinition } from "../../types/tools.js";

function dummyTool(overrides: Partial<ToolDefinition> & { name: string }): ToolDefinition {
  return {
    description: overrides.name,
    inputSchema: { type: "object", properties: {} },
    call: async () => ({ content: "ok" }),
    ...overrides,
  };
}

describe("Normalized /trust deny across all levels, path forms, and filePathArgumentKeys", () => {
  it("ToolFilePathExtractor only reads path keys & declared filePathArgumentKeys, ignoring url/command/sceneId/action", () => {
    const tools: ToolDefinition[] = [
      dummyTool({
        name: "web_fetch",
        permissionArgumentKey: "url",
      }),
      dummyTool({
        name: "workmode_enter",
        permissionArgumentKey: "sceneId",
      }),
      dummyTool({
        name: "extension_connect",
        permissionArgumentKey: "candidatePath",
        filePathArgumentKeys: ["candidatePath"],
      }),
    ];
    const extractor = ToolFilePathExtractor.fromTools(tools);

    expect(
      extractor.extract("web_fetch", { url: "https://forbidden-dir/secret", prompt: "read" }, "/ws"),
    ).toEqual([]);
    expect(
      extractor.extract("workmode_enter", { sceneId: "forbidden-dir", action: "switch" }, "/ws"),
    ).toEqual([]);
    expect(
      extractor.extract("extension_connect", { candidatePath: "./cand/ext.json" }, "/ws"),
    ).toEqual(["./cand/ext.json"]);
    expect(extractor.extract("glob", { pattern: "**/*" }, "/ws")).toEqual(["/ws"]);
    expect(extractor.extract("grep", { pattern: "token", path: "" }, "/ws")).toEqual(["/ws"]);
  });

  it("blocks all 5 path forms (abs, ./, sub/.., symlink, windows \\) on both observe and write tools without false positives on url/command/sceneId", async () => {
    const root = await createTempDir("norm-trust-deny");
    const ws = path.join(root, "workspace");
    const forbiddenDir = path.join(ws, "forbidden-dir");
    const subDir = path.join(ws, "sub");
    const secretFile = path.join(forbiddenDir, "secret.txt");
    const outsideAllowedDir = path.join(ws, "public");
    const publicFile = path.join(outsideAllowedDir, "readme.md");

    await fs.promises.mkdir(forbiddenDir, { recursive: true });
    await fs.promises.mkdir(subDir, { recursive: true });
    await fs.promises.mkdir(outsideAllowedDir, { recursive: true });
    await fs.promises.writeFile(secretFile, "SYNTHETIC_TEST_ONLY_SECRET", "utf8");
    await fs.promises.writeFile(publicFile, "hello", "utf8");

    const symlinkPath = path.join(ws, "link-to-secret.txt");
    let hasSymlink = false;
    try {
      await fs.promises.symlink(secretFile, symlinkPath);
      hasSymlink = true;
    } catch {
      // Fallback: directory junction if file symlink lacks privilege on Windows
      const junctionDir = path.join(ws, "link-dir");
      try {
        await fs.promises.symlink(forbiddenDir, junctionDir, "junction");
        hasSymlink = true;
      } catch {
        hasSymlink = false;
      }
    }

    const store = new PermissionStore({ rootDir: null });
    const ctxId = { kind: "workspace" as const, hash: "ws-norm" };
    await store.create(
      ctxId,
      PermissionStore.createRule({
        pattern: { tool: "*", argument: "forbidden-dir/**" },
        decision: "deny",
        scope: "context",
        contextId: ctxId,
      }),
    );

    const pipeline = new SecurityPipeline({
      sessionType: "interactive",
      trustContext: { kind: "workspace", dir: ws },
      permissionRuleSource: bindPermissionRuleExecutionSource(store, ctxId),
      filePathExtractor: ToolFilePathExtractor.fromTools([
        dummyTool({ name: "web_fetch", permissionArgumentKey: "url" }),
        dummyTool({ name: "workmode", permissionArgumentKey: "sceneId" }),
        dummyTool({ name: "extension_connect", filePathArgumentKeys: ["candidatePath"] }),
      ]),
    });

    const variants = [
      secretFile,
      "./forbidden-dir/secret.txt",
      "sub/../forbidden-dir/secret.txt",
      "forbidden-dir\\secret.txt",
      ...(hasSymlink
        ? [fs.existsSync(symlinkPath) ? symlinkPath : path.join(ws, "link-dir", "secret.txt")]
        : []),
    ];

    for (const candidate of variants) {
      // observe 等级读工具被 deny 短路
      const readRes = await pipeline.evaluate("read", { path: candidate }, ws);
      expect(readRes.allowed).toBe(false);
      expect(readRes.decision?.action).toBe("block");

      // 写工具也被 deny 短路
      const writeRes = await pipeline.evaluate("write", { path: candidate, content: "x" }, ws);
      expect(writeRes.allowed).toBe(false);
      expect(writeRes.decision?.action).toBe("block");

      // filePathArgumentKeys 工具也被 deny 短路
      const extRes = await pipeline.evaluate("extension_connect", { candidatePath: candidate }, ws);
      expect(extRes.allowed).toBe(false);
    }

    // 省略 path 的 glob 在禁区目录运行也会被禁读
    const globRes = await pipeline.evaluate("glob", { pattern: "*.txt" }, forbiddenDir);
    expect(globRes.allowed).toBe(false);

    // 正常文件照常放行
    expect((await pipeline.evaluate("read", { path: publicFile }, ws)).allowed).toBe(true);

    // url / command / sceneId 包含 "forbidden-dir" 字符串时，非文件工具不误伤
    const webRes = await pipeline.evaluate(
      "web_fetch",
      { url: "https://example.com/forbidden-dir/doc" },
      ws,
    );
    expect(webRes.decision?.action).not.toBe("block");
    expect((await pipeline.evaluate("workmode", { sceneId: "forbidden-dir" }, ws)).decision?.action).not.toBe(
      "block",
    );
  });

  it("evaluateNormalizedFileAccess skips rate-limiter quota across >150 calls and honors frozen permissionRules", async () => {
    const root = await createTempDir("norm-file-quota");
    const ws = path.join(root, "ws");
    const deniedDir = path.join(ws, "denied-sub");
    await fs.promises.mkdir(deniedDir, { recursive: true });
    await fs.promises.writeFile(path.join(ws, "ok.txt"), "ok", "utf8");
    await fs.promises.writeFile(path.join(deniedDir, "secret.txt"), "x", "utf8");

    const frozenRules = [
      PermissionStore.createRule({
        pattern: { tool: "*", argument: "denied-sub/**" },
        decision: "deny",
        scope: "global",
      }),
    ];

    const store = new PermissionStore({ rootDir: null });
    const pipeline = new SecurityPipeline({
      sessionType: "interactive",
      trustContext: { kind: "workspace", dir: ws },
      permissionRuleSource: bindPermissionRuleExecutionSource(store, { kind: "main" }),
      executionGuard: { rateLimitMaxCalls: 10, rateLimitWindowMs: 60_000 },
    });

    for (let i = 0; i < 150; i += 1) {
      const ok = await pipeline.evaluateNormalizedFileAccess({
        toolName: "glob",
        path: path.join(ws, "ok.txt"),
        access: "read",
        workingDirectory: ws,
        permissionRules: frozenRules,
      });
      expect(ok.allowed).toBe(true);
    }

    const blocked = await pipeline.evaluateNormalizedFileAccess({
      toolName: "skill_admit",
      path: "./denied-sub/secret.txt",
      access: "read",
      workingDirectory: ws,
      permissionRules: frozenRules,
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.decision?.action).toBe("block");
  });
});
