/**
 * MCP 接入引导编排测试 —— 事实驱动解析（预设 / URL / 命令确定性 + 裸包名查源 grounded）
 * + discovery（mock probe）。
 *
 * 全程注入 mock 依赖（fetchSource + llm），无真实联网、无真实 LLM、无定时器。
 * 重点验证"源里没有就不编"：查不到 / 无 README 给诚实失败，提取只认源文本。
 */

import { describe, expect, it, vi } from "vitest";
import type { McpServerSpec, McpSourceResult, ProbeResult } from "@zhixing/mcp";
import {
  applyMcpSetup,
  deriveServerId,
  extractMcpCandidate,
  presetToCandidate,
  resolveMcpSetup,
  validateMcpSetup,
  type McpResolveDeps,
  type McpSetupCandidate,
} from "../mcp-setup.js";
import { findMcpPreset } from "../../registries/index.js";

// 据 README 抽取的 grounded 输出（无 transport——裸包名恒为 stdio）；含从 README 取到的 docUrl
const EXTRACTED = JSON.stringify({
  command: "npx",
  args: ["-y", "@foo/bar-mcp"],
  secretFields: [
    { key: "FOO_TOKEN", label: "Foo Token", hint: "在 foo 后台创建", docUrl: "https://foo.dev/keys" },
  ],
});

const found = (readme: string): McpSourceResult => ({ kind: "found", readme });

/** 组装注入依赖；缺省 search 返回 []、fetchSource 返回 not-found、llm 返回空对象。 */
function makeDeps(over: Partial<McpResolveDeps> = {}): McpResolveDeps {
  return {
    fetchSource: over.fetchSource ?? vi.fn(async (): Promise<McpSourceResult> => ({ kind: "not-found" })),
    search: over.search ?? vi.fn(async () => []),
    llm: over.llm ?? vi.fn(async () => "{}"),
  };
}

describe("resolveMcpSetup — 预设 / 确定性输入，不查源不调 LLM", () => {
  it("按 id 命中预设，不查源、不调 LLM", async () => {
    const deps = makeDeps();
    const result = await resolveMcpSetup("github", deps);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.candidate.source).toBe("preset");
    expect(deps.fetchSource).not.toHaveBeenCalled();
    expect(deps.llm).not.toHaveBeenCalled();
  });

  it("按名称（大小写不敏感）命中预设", async () => {
    const result = await resolveMcpSetup("GitHub", makeDeps());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.candidate.serverId).toBe("github");
  });

  it("空输入直接报错", async () => {
    const result = await resolveMcpSetup("   ", makeDeps());
    expect(result.ok).toBe(false);
  });

  it("URL → http 候选：地址原样，不查源、不调 LLM", async () => {
    const deps = makeDeps();
    const result = await resolveMcpSetup("https://mcp.example.com/sse", deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidate.entry).toEqual({ type: "http", url: "https://mcp.example.com/sse" });
      expect(result.candidate.serverId).toBe("mcp-example-com");
      expect(result.candidate.secretFields).toEqual([]);
    }
    expect(deps.fetchSource).not.toHaveBeenCalled();
    expect(deps.llm).not.toHaveBeenCalled();
  });

  it("完整命令（含空格）→ stdio 候选：按空格拆，server 名取末段包名，不查源、不调 LLM", async () => {
    const deps = makeDeps();
    const result = await resolveMcpSetup("npx -y @foo/bar-mcp", deps);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidate.entry).toEqual({
        type: "stdio",
        command: "npx",
        args: ["-y", "@foo/bar-mcp"],
      });
      expect(result.candidate.serverId).toBe("bar-mcp");
    }
    expect(deps.fetchSource).not.toHaveBeenCalled();
    expect(deps.llm).not.toHaveBeenCalled();
  });

  it("命令带路径参数 → server 名取首个非 flag 实参（包名），不取末参路径", async () => {
    const result = await resolveMcpSetup(
      "npx -y @mcp/server-filesystem /some/path",
      makeDeps(),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidate.serverId).toBe("server-filesystem");
      expect(result.candidate.entry).toEqual({
        type: "stdio",
        command: "npx",
        args: ["-y", "@mcp/server-filesystem", "/some/path"],
      });
    }
  });
});

describe("extractMcpCandidate — 选中真实包后查源 grounded 提取（阶段2）", () => {
  const deps = (
    fetchSource: McpResolveDeps["fetchSource"],
    llm: McpResolveDeps["llm"],
  ) => ({ fetchSource, llm });
  // 取候选（extractMcpCandidate 只会返回 candidate / error，断言时收窄）
  const cand = (r: Awaited<ReturnType<typeof extractMcpCandidate>>) =>
    r.ok && "candidate" in r ? r.candidate : undefined;

  it("找到 + 有 README → 调 LLM 据源抽取，产出 stdio 候选 + 源里的密钥/docUrl", async () => {
    const fetchSource = vi.fn(async () => found("# bar-mcp\n设置：在 foo 后台拿 FOO_TOKEN"));
    const llm = vi.fn(async () => EXTRACTED);
    const r = await extractMcpCandidate("@foo/bar-mcp", deps(fetchSource, llm));
    expect(fetchSource).toHaveBeenCalledOnce();
    expect(llm).toHaveBeenCalledOnce();
    const c = cand(r);
    expect(c?.source).toBe("inferred");
    expect(c?.serverId).toBe("bar-mcp");
    expect(c?.entry).toEqual({ type: "stdio", command: "npx", args: ["-y", "@foo/bar-mcp"] });
    expect(c?.secretFields[0]?.key).toBe("FOO_TOKEN");
    expect(c?.secretFields[0]?.docUrl).toBe("https://foo.dev/keys");
  });

  it("提示词带上真实 README 文本，且约束只用给定文本", async () => {
    let seenPrompt = "";
    const fetchSource = vi.fn(async () => found("READMETOKEN_设置说明在这里"));
    const llm = vi.fn(async (prompt: string) => {
      seenPrompt = prompt;
      return EXTRACTED;
    });
    await extractMcpCandidate("@foo/bar-mcp", deps(fetchSource, llm));
    expect(seenPrompt).toContain("READMETOKEN_设置说明在这里");
    expect(seenPrompt).toContain("禁止用你自己的知识");
  });

  it("无法推导合法 server 名（纯符号）→ 诚实早退，不查源、不调 LLM", async () => {
    const fetchSource = vi.fn();
    const llm = vi.fn();
    const r = await extractMcpCandidate("@@@", deps(fetchSource, llm));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("无法从");
    expect(fetchSource).not.toHaveBeenCalled();
    expect(llm).not.toHaveBeenCalled();
  });

  it("包确不存在（not-found）→ 诚实报错，不调 LLM", async () => {
    const fetchSource = vi.fn(async (): Promise<McpSourceResult> => ({ kind: "not-found" }));
    const llm = vi.fn();
    const r = await extractMcpCandidate("@foo/does-not-exist", deps(fetchSource, llm));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("没找到");
    expect(llm).not.toHaveBeenCalled();
  });

  it("查询失败（error）→ 诚实报错并引导改输命令 / URL，不调 LLM", async () => {
    const fetchSource = vi.fn(
      async (): Promise<McpSourceResult> => ({ kind: "error", reason: "ECONNRESET" }),
    );
    const llm = vi.fn();
    const r = await extractMcpCandidate("@foo/bar-mcp", deps(fetchSource, llm));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("暂时查不到");
      expect(r.error).toContain("ECONNRESET");
    }
    expect(llm).not.toHaveBeenCalled();
  });

  it("找到但 README 为空 → 诚实报错（无设置说明），不调 LLM", async () => {
    const fetchSource = vi.fn(async () => found("   "));
    const llm = vi.fn();
    const r = await extractMcpCandidate("@foo/bar-mcp", deps(fetchSource, llm));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("没有可用的设置说明");
    expect(llm).not.toHaveBeenCalled();
  });

  it("LLM 输出不可解析 → 回落基线 npx -y <包名>（非硬失败，由实连证伪）", async () => {
    const fetchSource = vi.fn(async () => found("# bar-mcp"));
    const llm = vi.fn(async () => "抱歉我不确定");
    const r = await extractMcpCandidate("@foo/bar-mcp", deps(fetchSource, llm));
    expect(cand(r)?.entry).toEqual({ type: "stdio", command: "npx", args: ["-y", "@foo/bar-mcp"] });
    expect(cand(r)?.secretFields).toEqual([]);
  });

  it("容忍代码围栏 / 前后文字", async () => {
    const fetchSource = vi.fn(async () => found("# bar-mcp"));
    const llm = vi.fn(async () => "```json\n" + EXTRACTED + "\n```");
    const r = await extractMcpCandidate("@foo/bar-mcp", deps(fetchSource, llm));
    expect(cand(r)?.secretFields[0]?.key).toBe("FOO_TOKEN");
  });

  it("LLM 抛错 → graceful 报错", async () => {
    const fetchSource = vi.fn(async () => found("# bar-mcp"));
    const llm = vi.fn(async () => {
      throw new Error("model timeout");
    });
    const r = await extractMcpCandidate("@foo/bar-mcp", deps(fetchSource, llm));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("model timeout");
  });

  it("README 里没提密钥 → secretFields 为空（不臆造密钥）", async () => {
    const fetchSource = vi.fn(async () => found("# bar-mcp 无需密钥"));
    const llm = vi.fn(async () =>
      JSON.stringify({ command: "npx", args: ["-y", "@foo/bar-mcp"], secretFields: [] }),
    );
    const r = await extractMcpCandidate("@foo/bar-mcp", deps(fetchSource, llm));
    expect(cand(r)?.secretFields).toEqual([]);
  });

  it("查源带回主页 → 透传到候选（作密钥无 docUrl 时的诚实兜底）", async () => {
    const fetchSource = vi.fn(
      async (): Promise<McpSourceResult> => ({ kind: "found", readme: "# bar", homepage: "https://bar.dev" }),
    );
    const llm = vi.fn(async () => EXTRACTED);
    const r = await extractMcpCandidate("@foo/bar-mcp", deps(fetchSource, llm));
    expect(cand(r)?.homepage).toBe("https://bar.dev");
  });

  it("查源无主页 → 候选不带 homepage（不臆造）", async () => {
    const fetchSource = vi.fn(async () => found("# bar"));
    const llm = vi.fn(async () => EXTRACTED);
    const r = await extractMcpCandidate("@foo/bar-mcp", deps(fetchSource, llm));
    expect(cand(r)?.homepage).toBeUndefined();
  });

  it("docUrl 为 null（README 没给链接）→ 不带 docUrl（不臆造链接）", async () => {
    const fetchSource = vi.fn(async () => found("# bar-mcp"));
    const llm = vi.fn(async () =>
      JSON.stringify({
        command: "npx",
        args: ["-y", "@foo/bar-mcp"],
        secretFields: [{ key: "FOO_TOKEN", label: "Token", hint: "见后台", docUrl: null }],
      }),
    );
    const r = await extractMcpCandidate("@foo/bar-mcp", deps(fetchSource, llm));
    expect(cand(r)?.secretFields[0]?.docUrl).toBeUndefined();
  });
});

describe("resolveMcpSetup — 裸输入走搜索引导（出 choices）", () => {
  it("裸关键词 → 搜真实包 + LLM 挑出候选 → choices", async () => {
    const search = vi.fn(async () => [
      { name: "@upstash/context7-mcp", description: "MCP server", keywords: ["mcp"], downloads: 9 },
    ]);
    const llm = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ call: { tool: "search_npm", input: { query: "context7" } } }))
      .mockResolvedValueOnce(
        JSON.stringify({ final: { choices: [{ name: "@upstash/context7-mcp", summary: "Context7", reason: "唯一" }] } }),
      );
    const result = await resolveMcpSetup("context7", makeDeps({ search, llm }));
    expect(result.ok).toBe(true);
    if (result.ok && "choices" in result) {
      expect(result.choices[0]?.name).toBe("@upstash/context7-mcp");
    }
  });

  it("onStep 收到已翻译的人话步骤", async () => {
    const steps: string[] = [];
    const search = vi.fn(async () => [{ name: "x-mcp", description: "", keywords: ["mcp"], downloads: 1 }]);
    const llm = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({ call: { tool: "search_npm", input: { query: "x" } } }))
      .mockResolvedValueOnce(JSON.stringify({ final: { choices: [{ name: "x-mcp", summary: "s", reason: "r" }] } }));
    await resolveMcpSetup("x", makeDeps({ search, llm }), undefined, (m) => steps.push(m));
    expect(steps).toContain("正在分析…");
    expect(steps.some((s) => s.includes("正在搜索"))).toBe(true);
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
