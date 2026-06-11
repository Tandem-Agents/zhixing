/**
 * 单发文本 LLM 调用的角色档位装配
 *
 * 把"消费 LLM 流式响应、拼接 text_delta"模式抽成两条独立 callLLM 入口，
 * 按档位分流到不同角色：
 *
 *   main 档（callText "main"）           ←─ createMainCallLLM  ─→ roles.main.chat
 *   light 档（记忆提取 / callText 默认）  ←─ createLightCallLLM ─→ roles.light.chat
 *
 * **职责分工**：
 *
 *   - 质量敏感的单发任务（MCP 接入标识推断、skill 起草等撰写 / 研判类）
 *     产物质量直接面向用户，用 main 档位
 *   - 记忆提取从被摘段消息中抽取 profile / person / journal 写盘，
 *     是 I/O 边界的结构化数据净化，用 light 档位
 *
 * **隔离价值**：两个助手都通过独立 ChatRequest 调用，prompt 不出现在主对话的
 * conversation history——这切断了"工具结果中的 prompt injection 注入主对话"
 * 的攻击向量，并把噪音剥离从模型选择中解耦。即便 light 与 main 是同一
 * provider+model，独立 conversation 调用本身仍有此价值。
 *
 * 返回类型统一为 core 单源契约 `TextCallLLMFn`，全部注入点共享同一签名，
 * 避免重复定义带来的类型漂移。
 */

import type { TextCallLLMFn, LLMRole, LLMRoles, ThinkingConfig } from "@zhixing/core";

/**
 * 把"消费流式响应 → 拼接 text_delta → 返回完整字符串"的模式抽成内部 helper，
 * 让两个对外 helper 复用同一实现，避免代码重复。
 *
 * 返回纯拼接结果（空响应即空字符串），不做任何语义兜底——caller 各自处理：
 * 记忆提取经 parseExtractions try/catch 自然降级为空数组；callText 消费方
 * 对空文本自带容错。
 */
function callLLMText(
  role: LLMRole,
  thinking?: ThinkingConfig,
): TextCallLLMFn {
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
 * 创建 main 档单发调用 —— 走 `roles.main`。
 *
 * `callText(prompt, "main")` 经此通道执行质量敏感的单发任务。`mainThinking`
 * 由装配期按 main 角色的 thinking 配置解析后传入。
 */
export function createMainCallLLM(
  roles: LLMRoles,
  mainThinking?: ThinkingConfig,
): TextCallLLMFn {
  return callLLMText(roles.main, mainThinking);
}

/**
 * 创建 light 档单发调用 —— 走 `roles.light`。
 *
 * 记忆提取（MemoryFlusher）与 `callText` 默认档经此通道执行。`lightThinking`
 * 由装配期按 light 角色的 thinking 配置解析后传入；用户未显式配 `llm.light`
 * 时，light 自动用 main 实例兜底（resolveAuxRole 机制），无需本助手做
 * fallback 决策。
 */
export function createLightCallLLM(
  roles: LLMRoles,
  lightThinking?: ThinkingConfig,
): TextCallLLMFn {
  return callLLMText(roles.light, lightThinking);
}
