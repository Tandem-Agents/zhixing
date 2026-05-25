import type { JsonSchema } from "../types/index.js";

/**
 * 轻量工具 —— 只为"喂给 LLM 的描述 + 代码执行"服务。
 *
 * 刻意不复用主 agent 的 `ToolDefinition`：后者带权限 / 边界 / 执行上下文等为"危险工具"
 * 设计的重型字段；这里的工具是调用方注入的可信只读件（查询类），只需描述 + 执行函数。
 */
export interface ToolLoopTool<I = Record<string, unknown>, O = unknown> {
  /** 工具名（LLM 用它指名调用；一个任务内唯一）。 */
  name: string;
  /** 给 LLM 看的说明：这个工具做什么、何时该用。 */
  description: string;
  /** 给 LLM 看的入参结构。 */
  inputSchema: JsonSchema;
  /** 代码执行，返回真实结果。signal 透传以支持取消。 */
  run(input: I, signal?: AbortSignal): Promise<O>;
}

/**
 * 通用进度事件 —— 框架只报"第几轮、正在做什么"这类结构化信息，
 * 不决定给用户看的文案（文案由场景层翻译）。
 */
export interface ToolLoopProgress {
  /** 当前轮次（1-based）。 */
  round: number;
  /** deciding=正在让 LLM 决策下一步；calling=正在执行某工具。 */
  phase: "deciding" | "calling";
  /** phase=calling 时的工具名。 */
  tool?: string;
  /** phase=calling 时传给工具的入参（供场景翻译文案，如取其中的 query / pkg）。 */
  input?: unknown;
}

/**
 * 一次工具循环任务的规格：目标 + 工具集 + 轮数上限 + 最终结果解析。
 *
 * 业务护栏落在 `parseFinal`：reject 会把 reason 回灌给 LLM、驱动它自我修正（计入轮数），
 * 而不是直接失败——这样"违反约束"也能被纠正。
 */
export interface ToolLoopSpec<R> {
  /**
   * 站 LLM 视角写的任务说明：要达成什么、什么样算好、可以怎么做、最终怎么交付。
   * 只含 LLM 需要的指令，不含设计者的反思内容。
   */
  goal: string;
  /** 本次可用的工具集（调用方注入）。 */
  tools: ToolLoopTool[];
  /** 轮数硬上限——防 LLM 无限兜圈；到顶仍无有效 final 则返回 exhausted。 */
  maxRounds: number;
  /** 解析 + 校验 LLM 的最终载荷为结构化结果 R；reject 回灌让 LLM 修正后再来一轮。 */
  parseFinal(payload: unknown): { ok: true; result: R } | { ok: false; reason: string };
}

/** 注入依赖：LLM 文本完成（必填）+ 进度观察（可选）。 */
export interface ToolLoopDeps {
  /**
   * `callText` 风格的纯文本完成，provider 无关。框架自管多轮 prompt 拼接与决策解析。
   * signal 为 best-effort（绑定方如 callText 可能不向底层透传，abort 主要靠循环在轮边界放弃）。
   */
  complete(prompt: string, signal?: AbortSignal): Promise<string>;
  /**
   * 进度观察（可选）。框架在"让 LLM 决策前""调工具前"同步回调，产出通用结构化进度。
   * 框架吞掉本回调抛出的错误——进度是 best-effort 观察，不得因报告失败而坏主循环。
   */
  onProgress?(progress: ToolLoopProgress): void;
}

/**
 * 三态结果，不混淆：
 *   - done      ：parseFinal 通过，带结构化结果
 *   - exhausted ：用尽 maxRounds 仍无有效 final（"试了但没达成"）
 *   - error     ：框架级失败（complete/LLM 调用抛错、abort）——工具的业务错误不在此，已回灌
 */
export type ToolLoopResult<R> =
  | { kind: "done"; result: R; rounds: number }
  | { kind: "exhausted"; rounds: number }
  | { kind: "error"; reason: string };
