/**
 * 上下文压缩 / I/O 边界净化的 LLM 调用工厂
 *
 * 把 light 角色的"消费流式响应、拼接 text_delta"模式抽成独立可测单元——
 * 让 ContextEngine 的 callLLM 注入点和角色路由解耦:
 *
 *   ContextEngine ←─ callLLM (CompactLLMFn) ─── createCompactionFlush(roles)
 *                                                      │
 *                                                      └─→ roles.light.chat({...})
 *
 * 路由决策(走 light 而非 main)的核心价值是"调用上下文隔离"—— 抽出此 helper
 * 让该承诺在单测中可以反向 assert(roles.main.chat 不应被调用),防止未来 refactor
 * 把 callsite 错绑到 main 而无人发现。
 *
 * 返回类型采用 core 单源契约 `CompactLLMFn` —— 所有 ContextEngine 注入点(含
 * MemoryFlush / LLMSummarize 内部)共享同一签名,避免重复定义带来的类型漂移。
 */

import type { CompactLLMFn, LLMRoles } from "@zhixing/core";

/**
 * 绑定 LLMRoles 后返回压缩用的 CompactLLMFn。
 *
 * **关键契约**:实现固定走 `roles.light.chat`。light 角色的核心价值是
 * **调用上下文隔离** —— 把"压缩历史消息"这次专门调用与主对话物理隔离开,让
 * 摘要 prompt 不出现在 main 的 conversation history、工具结果里的噪音/prompt
 * injection 不污染 main。任务专门化(用更适合摘要的模型)和 cost 优化是派生收益,
 * 不是核心价值。
 *
 * light 兜底机制(resolveAuxRole):用户没显式配 llm.light 时,
 * light 自动用 main 实例 + main.model。隔离价值仍保留 —— createCompactionFlush
 * 无需也不应该自己做 fallback 决策。
 *
 * 返回的函数无状态,可在多个 ContextEngine / 多个 strategy 间共享。
 */
export function createCompactionFlush(roles: LLMRoles): CompactLLMFn {
  return async (messages, opts) => {
    const chunks: string[] = [];
    for await (const event of roles.light.chat({
      messages,
      tools: [],
      abortSignal: opts?.abortSignal,
    })) {
      if (event.type === "text_delta") {
        chunks.push(event.text);
      }
    }
    // 空响应回 "[]" 是为给 LLMSummarize / MemoryFlush 的 JSON 解析路径一个安全
    // 兜底——这些策略期望 LLM 返回 JSON 数组;空字符串会触发 parse 错。
    return chunks.join("") || "[]";
  };
}
