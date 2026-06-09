/**
 * 当前 run 用户消息的上下文注入。
 *
 * onBeforeRun 订阅者经 ctx.injectUserContext 贡献「要注入当前 run 用户消息」的内容；
 * 运行体收齐全部贡献后由本模块拼成一个 <context> 块、前缀到最后一条 user message。
 *
 * 注入对象是当前 run 的用户消息（最后一条 user message，用户本次新输入），与
 * agent-loop 注入的 <turn-context> 块共存、互不剥离（标签不同、各注各位）。每个
 * run 各注各的、贡献随 run 进入发送视图但不落盘（持久化只存用户原始输入），无跨
 * run 重复，故不做去重剥离。
 */

import {
  type Message,
  extractFirstText,
  findLastUserIndex,
  replaceFirstText,
} from "@zhixing/core";

const CONTEXT_TAG = "<context>";
const CONTEXT_TAG_END = "</context>";

/**
 * 把订阅者贡献拼成一个 <context> 块、前缀到最后一条 user message。
 * 无有效贡献（空 / 全空白）或消息里没有 user message 时，原样返回（浅拷贝）。
 */
export function prependContextBlock(
  messages: readonly Message[],
  contributions: readonly string[],
): Message[] {
  const sections = contributions
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
  if (sections.length === 0) return [...messages];

  const block = `${CONTEXT_TAG}\n${sections.join("\n\n")}\n${CONTEXT_TAG_END}`;
  const result = [...messages];
  const idx = findLastUserIndex(result);
  if (idx === -1) return result;

  const current = extractFirstText(result[idx]!);
  const injected = current ? `${block}\n\n${current}` : block;
  result[idx] = replaceFirstText(result[idx]!, injected);
  return result;
}
