/**
 * parseTaskUsageFromMessages —— 从 transcript messages 中解析 Task 工具的 <usage> trailer
 *
 * 数据来源:Task 工具(orchestrator/src/tools/task.ts)在 tool_result.content 末尾
 * 输出 <usage> 标签作为子 agent 资源消耗的 LLM 可读 trailer。本模块以纯函数形式
 * 把这些 trailer 解析回结构化 SubAgentUsageEntry,供 /usage 命令渲染拆分视图。
 *
 * 与上游 task.ts 的契约绑定(任一改动需双向同步,否则解析静默退化为空 entries):
 *   - tool name "Task"           ← task.ts 的 ToolDefinition.name(单一真相源)
 *   - input.description 字段名    ← task.ts 的 TASK_INPUT_SCHEMA.properties.description
 *   - <usage> trailer 格式        ← task.ts 的 formatUsageTag()(由 task.ts 单测守护契约)
 *   - failed / aborted 文本前缀   ← task.ts 的 formatChildResultAsToolResult() switch case
 *
 * 跨包反向解析的可接受性:
 *   - cli → 解析 orchestrator 产出的文本 trailer,语义上是"读取协议输出"而非"反向调
 *     orchestrator 内部 API",符合分层(Task 工具的 LLM 可读 trailer 本就是公开协议)
 *   - 任何契约不匹配走 best-effort 跳过(graceful 降级为 entries 空 / 字段空),
 *     /usage 命令仍能展示主用量,不影响产品功能
 *
 * 设计要点:
 *   - 纯函数零副作用 —— 输入 messages 数组,输出 entries 数组,无状态 / 无 IO
 *   - best-effort 解析 —— 格式不匹配的 tool_result 跳过(不抛异常,不污染上层
 *     /usage 命令的体验);Task 工具的 trailer 格式作为协议契约由 orchestrator
 *     单元测试守护,本层只做容错读
 *   - 关注点分离 —— 解析与渲染分两个文件,渲染层在 render.ts 内;
 *     未来若 RPC 端 / 飞书端也想呈现子 usage,直接复用本解析器
 *
 * 与 spec §12.2 的对齐:
 *   - 主 Turn.usage 仍由现有 /usage 显示主 agent 用量
 *   - 本模块产出的 entries 作为"子 agent 拆分用量"段追加到 /usage 输出
 *   - text 解析是 best-effort,不是协议层 truth(spec 同款表述)
 */

import type { Message } from "@zhixing/core";

// ─── 公共类型 ───

export interface SubAgentUsageEntry {
  /** Task 工具调用顺序索引(1-based,按 messages 遍历顺序赋值) */
  index: number;
  /** Task 工具入参 description(从 tool_use input 提取),空串若入参字段缺失 */
  description: string;
  /** <usage> 标签解析出的总 token(input + output,不含 cache —— 与 task.ts 同语义) */
  tokens: number;
  /** completed 状态才有(成功路径 trailer 含 tool_uses 字段;failed/aborted 省略) */
  toolUses?: number;
  /** 子 dispatch 持续时间(ms),所有状态都有 */
  durationMs?: number;
  /** 子 agent id 前 6 字符(审计追溯用,所有状态都有) */
  subId?: string;
  /**
   * 由 tool_result.content 前缀模式推断:
   *   - `[Task "..." failed:` → "failed"
   *   - `[Task "..." aborted:` → "aborted"
   *   - 其他(完整 finalAssistantText 直接开头)→ "succeeded"
   */
  status: "succeeded" | "failed" | "aborted";
}

// ─── 实现 ───

// <usage>tokens: N[, tool_uses: M], duration_ms: D, sub_id: XYZABC</usage>
//   - tool_uses 字段可选(failed/aborted 无)
//   - sub_id 是 6 位 hex(UUID 前 6 字符,task.ts 截断)
const USAGE_REGEX =
  /<usage>tokens:\s*(\d+)(?:,\s*tool_uses:\s*(\d+))?,\s*duration_ms:\s*(\d+),\s*sub_id:\s*([0-9a-f]+)<\/usage>/;

// 兼容两种 failed format(task.ts formatChildResultAsToolResult 输出):
//   - `[Task "..." failed: <msg>]`                  (error 字段缺失兜底,理论不可达)
//   - `[Task "..." failed (<type>): <msg>]`         (含 SubAgentErrorType tag,常态)
// type tag 内的字符可能含字母 / 下划线(如 "provider_error" / "context_overflow"),
// 用 `[^)]*` 通配,避免对具体 type 形态做强假设(SubAgentErrorType 联合未来若新增
// 类型,本 regex 自动兼容)。
//
// ABORTED 当前只有 `aborted: <reason>` 一种 format,故 regex 不预加 type tag 兼容
// (按事实写规则,不超前防御;未来若 aborted 也加 tag,在此处同步升级 + contract test)。
//
// 同步契约:这两个 regex 与 task.ts 的 format 字符串绑定。同步保护机制见
// `parse-task-usage.test.ts` 末尾的 contract test —— 用真实 formatChildResultAsToolResult
// 生成 ToolResult.content,断言 parse 能正确推断 status。task.ts format 任何改动
// 都会让 contract test 失败,强制开发者同步更新本 regex。
const FAILED_PREFIX = /^\[Task "[^"]*" failed(?:\s*\([^)]*\))?:/;
const ABORTED_PREFIX = /^\[Task "[^"]*" aborted:/;

/**
 * 主入口 —— 扫 messages 数组配对所有 Task tool_use ↔ tool_result,产出 entries。
 *
 * 算法:
 *   1. 第一遍扫 assistant messages 收集 Task tool_use,以 id 为 key 缓存
 *      description + 调用顺序(1-based index 来源)
 *   2. 第二遍扫 user messages 找到对应 tool_result(toolUseId 匹配),
 *      解析 <usage> 标签 + 推断 status,折成 SubAgentUsageEntry
 *   3. 按 index 排序返回(用户期待"调用先后顺序"展示,而非 messages 出现顺序)
 *
 * 没有 Task 调用 / 解析全部失败时返回空数组,调用方据此跳过子 usage 段渲染。
 */
export function parseTaskUsageFromMessages(
  messages: readonly Message[],
): SubAgentUsageEntry[] {
  // 第一遍:收集 Task tool_use ↔ description / order 映射
  const taskCalls = new Map<string, { description: string; order: number }>();
  let nextOrder = 0;
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (block.type !== "tool_use" || block.name !== "Task") continue;
      const desc =
        typeof block.input?.description === "string"
          ? block.input.description
          : "";
      taskCalls.set(block.id, { description: desc, order: nextOrder });
      nextOrder++;
    }
  }

  if (taskCalls.size === 0) return [];

  // 第二遍:从 tool_result 配对解析 usage trailer + 推断 status
  const entries: SubAgentUsageEntry[] = [];
  for (const msg of messages) {
    if (msg.role !== "user") continue;
    for (const block of msg.content) {
      if (block.type !== "tool_result") continue;
      const taskCall = taskCalls.get(block.toolUseId);
      if (!taskCall) continue;

      const usageMatch = USAGE_REGEX.exec(block.content);
      if (!usageMatch) continue;

      const status: SubAgentUsageEntry["status"] = FAILED_PREFIX.test(
        block.content,
      )
        ? "failed"
        : ABORTED_PREFIX.test(block.content)
          ? "aborted"
          : "succeeded";

      entries.push({
        index: taskCall.order + 1,
        description: taskCall.description,
        tokens: Number.parseInt(usageMatch[1]!, 10),
        toolUses:
          usageMatch[2] !== undefined
            ? Number.parseInt(usageMatch[2], 10)
            : undefined,
        durationMs: Number.parseInt(usageMatch[3]!, 10),
        subId: usageMatch[4],
        status,
      });
    }
  }

  entries.sort((a, b) => a.index - b.index);
  return entries;
}
