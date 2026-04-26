/**
 * WebFetch distill 模式的 prompt 模板与流式收集器。
 *
 * 切分目的:
 * - prompt 模板独立可调(未来可加多语言/风格变体),与工具主体解耦
 * - collectStream 是通用的 text_delta 累积器,可被其他 secondary LLM consumer 复用
 *   (如未来 WebSearch 的搜索结果摘要)
 */

import type { StreamEvent } from "@zhixing/core";

export const DISTILL_SYSTEM_PROMPT = `You extract specific information from web content based on a user's prompt.

Guidelines:
- Be concise and focused on the prompt's intent
- Quote relevant passages from the source when helpful
- If the prompt cannot be answered from the content, say so explicitly
- Output as Markdown
- Do not invent information not present in the content`;

/**
 * 拼接发送给 secondary LLM 的 user message。
 * 结构: prompt + 分隔 + 源信息 + 内容。把用户意图放最前以提示模型聚焦。
 */
export function buildDistillPrompt(url: string, content: string, prompt: string): string {
  return `${prompt}\n\n---\nSource URL: ${url}\n\nContent:\n${content}`;
}

/**
 * 累积 LLM 流式响应的 text_delta,返回完整文本。
 *
 * 忽略 thinking_delta / tool_call_* 等其他事件——distill 不期望工具调用,
 * 思考内容不应混入返回给主 agent 的 summary。
 *
 * 中止: 上游通过 chat() 时传入的 abortSignal 控制——signal abort 会让 generator
 * 的下一次 next() 抛错,本函数 for-await-of 自然中断,异常向上抛由 caller 处理。
 */
export async function collectStream(
  stream: AsyncGenerator<StreamEvent, void, undefined>,
): Promise<string> {
  const chunks: string[] = [];
  for await (const event of stream) {
    if (event.type === "text_delta") {
      chunks.push(event.text);
    }
  }
  return chunks.join("");
}
