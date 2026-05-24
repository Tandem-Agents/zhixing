/**
 * MCP 接入引导编排测试 —— 预设路径 + 推断路径（mock light LLM）+ discovery（mock probe）。
 *
 * 全程纯函数 / 注入依赖，无真实连接、无定时器。
 */

import { describe, expect, it, vi } from "vitest";
import type { McpServerSpec, ProbeResult } from "@zhixing/mcp";
import {
  applyMcpSetup,
  deriveServerId,
  inferMcpSetup,
  presetToCandidate,
  resolveMcpSetup,
  validateMcpSetup,
  type McpSetupCandidate,
} from "../mcp-setup.js";
import { findMcpPreset } from "../../registries/index.js";

const STDIO_INFERENCE = JSON.stringify({
  transport: "stdio",
  command: "npx",
  args: ["-y", "@foo/bar-mcp"],
  secretFields: [
    { key: "FOO_TOKEN", label: "Foo Token", hint: "从 foo 后台获取", example: "foo_xxx" },
  ],
});

describe("resolveMcpSetup — 预设优先、否则推断", () => {
  it("按 id 命中预设，不调 LLM", async () => {
    const llm = vi.fn();
    const result = await resolveMcpSetup("github", llm);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.candidate.source).toBe("preset");
    expect(llm).not.toHaveBeenCalled();
  });

  it("按名称（大小写不敏感）命中预设", async () => {
    const result = await resolveMcpSetup("GitHub", vi.fn());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.candidate.serverId).toBe("github");
  });

  it("空输入直接报错", async () => {
    const result = await resolveMcpSetup("   ", vi.fn());
    expect(result.ok).toBe(false);
  });

  it("非预设走 LLM 推断", async () => {
    const llm = vi.fn(async () => STDIO_INFERENCE);
    const result = await resolveMcpSetup("@foo/bar-mcp", llm);
    expect(llm).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidate.source).toBe("inferred");
      expect(result.candidate.serverId).toBe("bar-mcp");
      expect(result.candidate.entry).toEqual({
        type: "stdio",
        command: "npx",
        args: ["-y", "@foo/bar-mcp"],
      });
      expect(result.candidate.secretFields[0]?.key).toBe("FOO_TOKEN");
    }
  });
});

describe("inferMcpSetup — LLM 推断解析", () => {
  it("http 推断：取 url、不要 command", async () => {
    const llm = async () =>
      '{"transport":"http","url":"https://mcp.example.com/sse"}';
    const result = await inferMcpSetup("https://mcp.example.com/sse", llm);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidate.entry).toEqual({
        type: "http",
        url: "https://mcp.example.com/sse",
      });
      expect(result.candidate.serverId).toBe("mcp-example-com");
    }
  });

  it("容忍代码围栏 / 前后文字", async () => {
    const llm = async () => "```json\n" + STDIO_INFERENCE + "\n```";
    const result = await inferMcpSetup("@foo/bar-mcp", llm);
    expect(result.ok).toBe(true);
  });

  it("输出不可解析 → graceful 报错", async () => {
    const result = await inferMcpSetup("x", async () => "抱歉我不知道");
    expect(result.ok).toBe(false);
  });

  it("LLM 抛错 → graceful 报错", async () => {
    const result = await inferMcpSetup("x", async () => {
      throw new Error("model timeout");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("model timeout");
  });

  it("stdio 缺 command → 报错", async () => {
    const result = await inferMcpSetup(
      "@foo/bar-mcp",
      async () => '{"transport":"stdio"}',
    );
    expect(result.ok).toBe(false);
  });
});

describe("validateMcpSetup — discovery 带密钥验证", () => {
  const candidate: McpSetupCandidate = {
    serverId: "bar-mcp",
    entry: { type: "stdio", command: "npx", args: ["-y", "@foo/bar-mcp"] },
    secretFields: [{ key: "FOO_TOKEN", label: "Foo Token", hint: "", example: "" }],
    source: "inferred",
  };

  it("填了密钥 → 探测 spec 按 transport 注入（stdio→env），既证启动也证鉴权", async () => {
    let seen: McpServerSpec | undefined;
    const probe = async (spec: McpServerSpec): Promise<ProbeResult> => {
      seen = spec;
      return { ok: true, tools: [{ name: "do", inputSchema: {} }] };
    };

    const result = await validateMcpSetup(candidate, { FOO_TOKEN: "ghp_x" }, probe);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tools.map((t) => t.name)).toEqual(["do"]);
    expect(seen?.env).toEqual({ FOO_TOKEN: "ghp_x" });
    expect(seen?.headers).toBeUndefined();
  });

  it("http 候选填密钥 → 探测 spec 注入 headers（GitHub Bearer 同路径）", async () => {
    const httpCandidate: McpSetupCandidate = {
      serverId: "gh",
      entry: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
      secretFields: [
        { key: "Authorization", label: "PAT", hint: "", example: "", template: "Bearer {value}" },
      ],
      source: "preset",
    };
    let seen: McpServerSpec | undefined;
    const probe = async (spec: McpServerSpec): Promise<ProbeResult> => {
      seen = spec;
      return { ok: true, tools: [] };
    };
    await validateMcpSetup(httpCandidate, { Authorization: "ghp_x" }, probe);
    expect(seen?.headers).toEqual({ Authorization: "Bearer ghp_x" });
    expect(seen?.env).toBeUndefined();
  });

  it("空密钥输入 → 退化为纯启动验证（不注入 env / headers）", async () => {
    let seen: McpServerSpec | undefined;
    const probe = async (spec: McpServerSpec): Promise<ProbeResult> => {
      seen = spec;
      return { ok: true, tools: [] };
    };
    await validateMcpSetup(candidate, {}, probe);
    expect(seen?.env).toBeUndefined();
    expect(seen?.headers).toBeUndefined();
  });

  it("probe 失败透传明确原因", async () => {
    const github = presetToCandidate(findMcpPreset("github")!);
    const result = await validateMcpSetup(github, {}, async () => ({
      ok: false,
      error: "spawn npx ENOENT",
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("ENOENT");
  });
});

describe("applyMcpSetup / deriveServerId", () => {
  it("applyMcpSetup：预设候选 + template 字段产出包裹后的凭证（Bearer 头）", () => {
    const github = presetToCandidate(findMcpPreset("github")!);
    const { entry, secrets } = applyMcpSetup(github, { Authorization: "ghp_x" });
    expect(entry.url).toBe("https://api.githubcopilot.com/mcp/");
    expect(secrets.Authorization).toBe("Bearer ghp_x");
  });

  it("applyMcpSetup：推断候选直接字段、空输入跳过", () => {
    const candidate: McpSetupCandidate = {
      serverId: "x",
      entry: { type: "stdio", command: "npx" },
      secretFields: [
        { key: "A", label: "A", hint: "", example: "" },
        { key: "B", label: "B", hint: "", example: "" },
      ],
      source: "inferred",
    };
    const { secrets } = applyMcpSetup(candidate, { A: "av", B: "" });
    expect(secrets).toEqual({ A: "av" });
  });

  it("deriveServerId：包名取末段、URL 取 host、消毒非法字符", () => {
    expect(deriveServerId("@modelcontextprotocol/server-github")).toBe(
      "server-github",
    );
    expect(deriveServerId("https://mcp.notion.com/mcp")).toBe("mcp-notion-com");
    expect(deriveServerId("Some Weird Name!!")).toBe("some-weird-name");
  });
});
