/**
 * ToolSchemaCompilerStage —— view-layer 工具 schema 动态过滤
 *
 * 在每次 LLM call 之前根据 CapabilityState 编排 API tools[] 数组：
 *   - always / hot → 保留完整 schema（暴露给 LLM）
 *   - discoverable → 过滤掉（LLM 仅通过 system prompt 文本知道工具存在）
 *   - cold / 未注册 → 过滤掉
 *
 * 与 ToolResultAnchorStage 完全正交：前者处理 messages 中的 tool_result 锚化，
 * 本 stage 处理 tools 字段的 schema 暴露；两者可独立运行。
 *
 * stage 是纯函数式：不修改输入 tools 数组（仅在过滤发生时返回新数组），
 * messages 字段原样透传。
 *
 * 装配契约：
 *   runtime 装配期对所有可用工具都应调 CapabilityState.initialize(name, layer)
 *   一次。未注册的工具被本 stage 视为 cold（与 spec "cold 工具完全不暴露" 一致），
 *   让装配漏注册的 bug 立即暴露而非默默退化为 always。
 */

import type { ToolDefinition } from "../../../types/tools.js";
import type { CapabilityState } from "../../capability/index.js";
import type { RenderContext, Stage, StageOutput } from "../types.js";

export class ToolSchemaCompilerStage implements Stage {
  readonly id = "tool-schema-compiler";

  constructor(private readonly state: CapabilityState) {}

  render(ctx: RenderContext): StageOutput {
    let stageModified = false;
    const filtered: ToolDefinition[] = [];
    for (const tool of ctx.tools) {
      const layer = this.state.layerOf(tool.name);
      if (layer === "always" || layer === "hot") {
        filtered.push(tool);
      } else {
        stageModified = true;
      }
    }

    return {
      messages: ctx.messages,
      tools: stageModified ? filtered : ctx.tools,
    };
  }
}
