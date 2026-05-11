// 视图层 ContextCompiler 公开 API

export type {
  RenderContext,
  RenderState,
  Stage,
  StageOutput,
  StateDelta,
} from "./types.js";

export { ContextCompiler } from "./compiler.js";
export type { CompileInput, CompileOutput } from "./compiler.js";

// Anchor 子模块
export type { AnchorGenerator } from "./anchors/index.js";
export {
  AnchorRegistry,
  fallbackAnchor,
  createDefaultAnchorRegistry,
  readAnchor,
  bashAnchor,
  grepAnchor,
  globAnchor,
  editAnchor,
  writeAnchor,
  webFetchAnchor,
} from "./anchors/index.js";

// 内置 Stage
export { ToolResultAnchorStage } from "./stages/tool-result-anchor.js";
