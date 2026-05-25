/**
 * MCP server 搜索引导 —— "关键词 → 搜真实 npm 包 → LLM 挑主流候选" 的场景层。
 *
 * 它是通用「轻量工具循环」的一个使用者：注入两个工具（搜 npm / 读 README）+ 一段任务说明，
 * 让 LLM 自主多轮地搜、判断、挑出候选。事实焊死在两处场景护栏：
 *   - 工具 `run` 把每次真实搜索结果累积进 `seen` 集合；
 *   - `parseFinal` 校验 LLM 给的每个候选包名必须 ∈ `seen`（编不出不存在的包），且最多 5 个。
 * 判断（搜什么、换不换词、挑哪几个）全交给 LLM；框架与本层都不替它臆造事实。
 */

import { runToolLoop, type ToolLoopProgress, type ToolLoopSpec, type ToolLoopTool } from "@zhixing/core";
import type { McpSearchResult, McpSourceResult } from "@zhixing/mcp";

/** 一个呈现给用户的候选 —— 真实包名 + LLM 给的一句话用途 / 选它的理由。 */
export interface McpDiscoveryChoice {
  /** 真实包名（保证 ∈ 本次搜索结果，可直接接入）。 */
  name: string;
  /** 一句话用途（LLM 据真实描述 / README 总结）。 */
  summary: string;
  /** 选它的理由（如"下载量最高的官方实现"）。 */
  reason: string;
}

export type McpDiscoveryResult =
  | { ok: true; choices: McpDiscoveryChoice[] }
  | { ok: false; error: string };

export interface McpDiscoveryDeps {
  /** 搜真实 npm 包（注入 @zhixing/mcp 的 searchMcpServers）。 */
  search: (query: string, signal?: AbortSignal) => Promise<McpSearchResult[]>;
  /** 读包 README（注入 @zhixing/mcp 的 fetchMcpServerSource）。 */
  fetchSource: (packageName: string, signal?: AbortSignal) => Promise<McpSourceResult>;
  /** LLM 文本完成（callText 风格，绑 "main" 档）。 */
  complete: (prompt: string, signal?: AbortSignal) => Promise<string>;
  /** 进度观察（可选）——结构化进度，由调用方经 mcpProgressText 翻译成人话。 */
  onProgress?: (progress: ToolLoopProgress) => void;
}

const MAX_CHOICES = 5;
const MAX_ROUNDS = 6;
/** 喂给 LLM 的单次搜索结果条数上限（控制 prompt 体积；仍是真实数据）。 */
const SEARCH_VIEW_SIZE = 15;
/** 喂给 LLM 的 README 截断长度（够判断"是不是 mcp / 用途"即可）。 */
const README_VIEW_CHARS = 3000;

/**
 * 跑一轮搜索引导。返回 ≤5 个真实候选供用户选，或诚实失败（没找到 / 出错）。
 * 选中候选后的"读 README 提取启动配置"由上层另一入口处理（不在此）。
 */
export async function runMcpDiscovery(
  input: string,
  deps: McpDiscoveryDeps,
  signal?: AbortSignal,
): Promise<McpDiscoveryResult> {
  // seen：本次所有搜索真实返回的包名 → 结果。工具 run 累积，parseFinal 据此校验"不许编造"。
  const seen = new Map<string, McpSearchResult>();

  const searchTool: ToolLoopTool = {
    name: "search_npm",
    description:
      "按关键词搜 npm 上真实存在的包，返回名称 / 描述 / keywords / 下载量。一次没合适就换关键词再搜。",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "搜索关键词" } },
      required: ["query"],
    },
    run: async (rawInput, sig) => {
      const query = asString(rawInput, "query");
      const results = await deps.search(query, sig);
      for (const r of results) seen.set(r.name, r);
      return results.slice(0, SEARCH_VIEW_SIZE).map((r) => ({
        name: r.name,
        description: r.description,
        keywords: r.keywords,
        downloads: r.downloads,
      }));
    },
  };

  const readmeTool: ToolLoopTool = {
    name: "read_readme",
    description: "读取某个包的 README，用于确认它是不是 MCP server、看它的用途。",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "包名" } },
      required: ["name"],
    },
    run: async (rawInput, sig) => {
      const name = asString(rawInput, "name");
      const src = await deps.fetchSource(name, sig);
      if (src.kind === "found") {
        return { readme: src.readme.slice(0, README_VIEW_CHARS), homepage: src.homepage };
      }
      return { error: src.kind === "not-found" ? "包不存在" : "读取失败" };
    },
  };

  const spec: ToolLoopSpec<McpDiscoveryChoice[]> = {
    goal: buildGoal(input),
    tools: [searchTool, readmeTool],
    maxRounds: MAX_ROUNDS,
    parseFinal: (payload) => parseChoices(payload, seen),
  };

  const result = await runToolLoop(spec, { complete: deps.complete, ...(deps.onProgress ? { onProgress: deps.onProgress } : {}) }, signal);

  if (result.kind === "done") {
    return result.result.length > 0
      ? { ok: true, choices: result.result }
      : { ok: false, error: "没找到合适的 MCP server，请换个关键词，或直接输入完整包名 / 远程 URL" };
  }
  if (result.kind === "exhausted") {
    return { ok: false, error: "没能确定合适的候选，请换个关键词，或直接输入完整包名 / 远程 URL" };
  }
  return { ok: false, error: `搜索出错：${result.reason}` };
}

/** 把 LLM 决策进度翻译成给用户看的当前步骤文案（场景特定，框架只给结构化进度）。 */
export function mcpProgressText(progress: ToolLoopProgress): string {
  if (progress.phase === "deciding") return "正在分析…";
  const input = progress.input as Record<string, unknown> | undefined;
  if (progress.tool === "search_npm") {
    const q = typeof input?.query === "string" ? input.query : "";
    return q ? `正在搜索 “${q}”…` : "正在搜索…";
  }
  if (progress.tool === "read_readme") {
    const n = typeof input?.name === "string" ? input.name : "";
    return n ? `正在读取 ${n} 的说明…` : "正在读取说明…";
  }
  return "处理中…";
}

/** 站 LLM 视角的任务说明（需求 + 预期 + 方法 + 输出契约），无设计者反思内容。 */
function buildGoal(input: string): string {
  return [
    `你在帮用户找到他想接入的 MCP server。用户输入的是：${input}`,
    "目标：在 npm 上找到与用户意图最匹配、且确实是 MCP server 的真实包，挑出最主流的几个给用户选。",
    "怎么做：用 search_npm 搜（一次没合适就换关键词再搜，如加 “mcp”、换近义词、拆词）；",
    "判断“是不是 MCP server”看包的 keywords（含 mcp / modelcontextprotocol）和名字 / 描述；",
    "判断“主不主流”看 downloads（越高越主流）；拿不准某个包就用 read_readme 看它的说明。",
    `最终给出 {"final":{"choices":[{"name":"真实包名","summary":"一句话用途","reason":"为什么选它"}]}}：`,
    `- 最多 ${MAX_CHOICES} 个，按主流度从高到低；name 必须是你用 search_npm 搜到的真实包名，不能编造。`,
    `- 若搜了几次都没有合适的 MCP server，就给 {"final":{"choices":[]}} 表示没找到。`,
  ].join("\n");
}

/** parseFinal：提取候选 + 场景护栏（每个 ∈ seen、≤5）。违反则 reject 回灌让 LLM 修正。 */
function parseChoices(
  payload: unknown,
  seen: Map<string, McpSearchResult>,
): { ok: true; result: McpDiscoveryChoice[] } | { ok: false; reason: string } {
  const raw = Array.isArray(payload)
    ? payload
    : (payload as { choices?: unknown } | null)?.choices;
  if (!Array.isArray(raw)) {
    // 给不出有效 choices 视作"没找到"（空结果，由上层转诚实提示），不强行 reject 纠缠
    return { ok: true, result: [] };
  }

  const choices: McpDiscoveryChoice[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const rec = item as Record<string, unknown>;
    if (typeof rec.name !== "string" || rec.name === "") continue;
    if (!seen.has(rec.name)) {
      return {
        ok: false,
        reason: `候选 “${rec.name}” 不在搜索结果里——只能从 search_npm 搜到的真实包中选。`,
      };
    }
    choices.push({
      name: rec.name,
      summary: typeof rec.summary === "string" ? rec.summary : "",
      reason: typeof rec.reason === "string" ? rec.reason : "",
    });
  }
  if (choices.length > MAX_CHOICES) {
    return { ok: false, reason: `最多 ${MAX_CHOICES} 个，请精选最主流的几个。` };
  }
  return { ok: true, result: choices };
}

function asString(input: unknown, key: string): string {
  if (typeof input !== "object" || input === null) return "";
  const v = (input as Record<string, unknown>)[key];
  return typeof v === "string" ? v : "";
}
