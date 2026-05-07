/**
 * AI 输出区公共导出。
 *
 * createOutputRenderer 是主入口——repl / run-agent 用它替代原 createRenderer。
 * speaker-state 锚字符工厂供工具行 / 闪烁等下游模块复用。
 */

export {
  createOutputRenderer,
  type OutputRenderer,
} from "./output-renderer.js";

export {
  ANCHOR_AI_DONE,
  ANCHOR_AI_RUNNING,
  ANCHOR_TOOL,
  ANCHOR_SUB_AGENT,
  aiTextAnchor,
  toolRunningAnchor,
  toolDoneAnchor,
} from "./speaker-state.js";

export { TextStream } from "./text-stream.js";

export {
  getLlmChunkDump,
  attachChunkDumpToBus,
  type LlmChunkDump,
} from "./llm-chunk-dump.js";
