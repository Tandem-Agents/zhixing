/**
 * 上下文压缩 / 记忆提取的 LLM 调用助手
 *
 * 把"消费 LLM 流式响应、拼接 text_delta"模式抽成 ContextEngine 注入点的两条
 * 独立 callLLM 入口，按用途分流到不同角色：
 *
 *   主对话压缩 (LLMSummarize) ←─ createSummarizeCallLLM    ─→ roles.main.chat
 *   记忆提取  (MemoryFlush)   ←─ createMemoryFlushCallLLM ─→ roles.light.chat
 *
 * **职责分工**：
 *
 *   - 主对话压缩生成对话摘要替换早期消息——质量直接决定下一轮 LLM 的认知输入，
 *     用 main 档位
 *   - 记忆提取从即将压缩的消息中抽取 profile / person / journal 写盘，
 *     是 I/O 边界的结构化数据净化，用 light 档位
 *
 * **隔离价值**：两个助手都通过独立 ChatRequest 调用，摘要 prompt 与提取 prompt
 * 都不出现在主对话的 conversation history——这切断了"工具结果中的 prompt
 * injection 注入主对话"的攻击向量，并把噪音剥离从模型选择中解耦。即便 light 与
 * main 是同一 provider+model，独立 conversation 调用本身仍有此价值。
 *
 * 返回类型统一为 core 单源契约 `CompactLLMFn`，ContextEngine 注入点共享同一签名，
 * 避免重复定义带来的类型漂移。
 */

import type { CompactLLMFn, LLMRole, LLMRoles, ThinkingConfig } from "@zhixing/core";

/**
 * 把"消费流式响应 → 拼接 text_delta → 返回完整字符串"的模式抽成内部 helper，
 * 让两个对外 helper 复用同一实现，避免代码重复。
 *
 * 返回纯拼接结果（空响应即空字符串），不做任何语义兜底——caller 各自处理：
 * LLMSummarize 经 validateSummary 章节校验自然失败 → 重试 → strategy 退化；
 * MemoryFlush 经 parseExtractions try/catch 自然降级为空数组。
 */
function callLLMText(
  role: LLMRole,
  thinking?: ThinkingConfig,
): CompactLLMFn {
  return async (messages, opts) => {
    const chunks: string[] = [];
    for await (const event of role.chat({
      messages,
      tools: [],
      thinking,
      abortSignal: opts?.abortSignal,
    })) {
      if (event.type === "text_delta") {
        chunks.push(event.text);
      }
    }
    return chunks.join("");
  };
}

/**
 * 创建主对话压缩用的 callLLM —— 走 `roles.main`。
 *
 * LLMSummarize 策略调用此函数得到压缩摘要 LLM 入口。`mainThinking` 由装配期
 * 按 main 角色的 thinking 配置解析后传入。
 */
export function createSummarizeCallLLM(
  roles: LLMRoles,
  mainThinking?: ThinkingConfig,
): CompactLLMFn {
  return callLLMText(roles.main, mainThinking);
}

/**
 * 创建记忆提取用的 callLLM —— 走 `roles.light`。
 *
 * MemoryFlush 策略调用此函数从消息中提取结构化记忆数据。`lightThinking` 由装配期
 * 按 light 角色的 thinking 配置解析后传入；用户未显式配 `llm.light` 时，light
 * 自动用 main 实例兜底（resolveAuxRole 机制），无需本助手做 fallback 决策。
 */
export function createMemoryFlushCallLLM(
  roles: LLMRoles,
  lightThinking?: ThinkingConfig,
): CompactLLMFn {
  return callLLMText(roles.light, lightThinking);
}
