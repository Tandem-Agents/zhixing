/**
 * 事实锚注册表
 *
 * 工具自助注册 AnchorGenerator；ToolResultAnchorStage 通过 registry 按 toolName 派发。
 * 未注册的工具或 generator 返 null 时走通用 fallback 锚。
 */

import type {
  ToolResultBlock,
  ToolUseBlock,
} from "../../../types/messages.js";
import type { AnchorGenerator } from "./types.js";

export class AnchorRegistry {
  private readonly generators = new Map<string, AnchorGenerator>();

  /** 注册（同名重复 register 会覆盖前者，方便测试替换） */
  register(generator: AnchorGenerator): this {
    this.generators.set(generator.toolName, generator);
    return this;
  }

  /** 注册多个 */
  registerAll(generators: readonly AnchorGenerator[]): this {
    for (const g of generators) this.register(g);
    return this;
  }

  /**
   * 生成事实锚。匹配的 generator 返 null 时走 fallback。
   */
  generate(toolUse: ToolUseBlock, toolResult: ToolResultBlock): string {
    const gen = this.generators.get(toolUse.name);
    if (gen) {
      const anchor = gen.generate(toolUse, toolResult);
      if (anchor !== null) return anchor;
    }
    return fallbackAnchor(toolUse, toolResult);
  }
}

/**
 * 通用 fallback 锚 —— 未注册工具或 generator 拒绝时使用。
 * 输出最小语义信息：工具名 / 状态 / 内容长度。
 */
export function fallbackAnchor(
  toolUse: ToolUseBlock,
  toolResult: ToolResultBlock,
): string {
  const status = toolResult.isError ? "error" : "ok";
  return `[${toolUse.name}, ${status}, ${toolResult.content.length} chars]`;
}
