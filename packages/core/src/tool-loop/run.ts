/**
 * 轻量工具循环执行器 —— 给定目标 + 一组工具，让 LLM 在有限轮内自主调度工具、达成目标。
 *
 * 每轮：报"决策中"进度 → 拼 prompt 调 `complete` → 解析 LLM 的决策 JSON：
 *   - `call`  → 报"调用中"进度 → 执行工具 → 真实结果回灌历史；工具错误也回灌（不终止）
 *   - `final` → 交 `parseFinal`；通过则 done，被拒则把原因回灌、继续
 *   - 不可解析 → 回灌纠错提示、继续
 * 用尽轮数 → exhausted；`complete` 抛错 / abort → error。
 *
 * 事实只来自工具：LLM 要么调工具拿真实数据，要么基于历史里已真实执行过的结果给 final。
 */

import { extractJsonObject } from "../json.js";
import type {
  ToolLoopDeps,
  ToolLoopProgress,
  ToolLoopResult,
  ToolLoopSpec,
} from "./types.js";

export async function runToolLoop<R>(
  spec: ToolLoopSpec<R>,
  deps: ToolLoopDeps,
  signal?: AbortSignal,
): Promise<ToolLoopResult<R>> {
  const toolByName = new Map(spec.tools.map((t) => [t.name, t]));
  const history: string[] = [];

  for (let round = 1; round <= spec.maxRounds; round++) {
    if (signal?.aborted) return { kind: "error", reason: "aborted" };

    report(deps, { round, phase: "deciding" });

    let raw: string;
    try {
      raw = await deps.complete(buildPrompt(spec, history), signal);
    } catch (err) {
      // complete（LLM 调用本身）失败是无法继续的框架级错误
      return { kind: "error", reason: errMsg(err) };
    }

    const decision = parseDecision(raw);

    if (decision.kind === "unparsable") {
      history.push('（你上次的输出无法解析；请只输出 {"call":…} 或 {"final":…} 形式的 JSON。）');
      continue;
    }

    if (decision.kind === "final") {
      const parsed = spec.parseFinal(decision.payload);
      if (parsed.ok) return { kind: "done", result: parsed.result, rounds: round };
      history.push(`（你的最终结果被拒绝：${parsed.reason} 请据此调整后重试。）`);
      continue;
    }

    // call —— 工具相关错误一律回灌、不终止循环（由 LLM + maxRounds 兜底）
    const tool = toolByName.get(decision.tool);
    if (!tool) {
      const names = spec.tools.map((t) => t.name).join(" / ");
      history.push(`（没有名为 "${decision.tool}" 的工具，可用：${names}。）`);
      continue;
    }

    report(deps, { round, phase: "calling", tool: tool.name, input: decision.input });
    if (signal?.aborted) return { kind: "error", reason: "aborted" };

    try {
      const result = await tool.run(decision.input as Record<string, unknown>, signal);
      history.push(`调用 ${tool.name}（${truncate(stringify(decision.input))}）的结果：\n${truncate(stringify(result))}`);
    } catch (err) {
      history.push(`调用 ${tool.name} 失败：${errMsg(err)} 可重试、换个方式或据已知信息收尾。`);
    }
  }

  return { kind: "exhausted", rounds: spec.maxRounds };
}

type Decision =
  | { kind: "call"; tool: string; input: unknown }
  | { kind: "final"; payload: unknown }
  | { kind: "unparsable" };

/** 解析 LLM 决策：抠 JSON → 判 `call` / `final`；任何不符返回 unparsable（由循环回灌纠错）。 */
function parseDecision(raw: string): Decision {
  const json = extractJsonObject(raw);
  if (json === undefined) return { kind: "unparsable" };
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return { kind: "unparsable" };
  }
  if (typeof data !== "object" || data === null) return { kind: "unparsable" };
  const rec = data as Record<string, unknown>;
  if ("final" in rec) return { kind: "final", payload: rec.final };
  if (rec.call && typeof rec.call === "object") {
    const call = rec.call as Record<string, unknown>;
    if (typeof call.tool === "string") {
      return { kind: "call", tool: call.tool, input: call.input ?? {} };
    }
  }
  return { kind: "unparsable" };
}

/** 拼每轮 prompt：目标 + 工具清单 + 输出格式 + 至今历史。站 LLM 视角，无设计者反思。 */
function buildPrompt<R>(spec: ToolLoopSpec<R>, history: string[]): string {
  const toolLines = spec.tools.map(
    (t) => `- ${t.name}：${t.description} 入参：${stringify(t.inputSchema)}`,
  );
  return [
    spec.goal,
    "",
    "可用工具：",
    ...toolLines,
    "",
    "每次只输出一个 JSON，二选一（不要解释、不要代码围栏）：",
    '  调用工具：{"call":{"tool":"工具名","input":{…}}}',
    '  给出最终结果：{"final": <最终结果>}',
    ...(history.length > 0 ? ["", "至今进展：", ...history] : []),
  ].join("\n");
}

/** 进度回调 —— best-effort：吞掉回调抛出的错误，不让进度报告坏掉主循环。 */
function report(deps: ToolLoopDeps, progress: ToolLoopProgress): void {
  if (!deps.onProgress) return;
  try {
    deps.onProgress(progress);
  } catch {
    // 进度是观察通道，报告失败不影响任务本身
  }
}

const MAX_ENTRY_CHARS = 4000;

/** 单条历史超长则截断，控制 prompt 体积（轮数小、不引入摘要 LLM）。 */
function truncate(s: string): string {
  return s.length > MAX_ENTRY_CHARS ? `${s.slice(0, MAX_ENTRY_CHARS)}…（已截断）` : s;
}

function stringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
