import { randomUUID } from "node:crypto";
import {
  createLeaseBudgetTracker,
  type AuthorityCallContext,
  type AuthorityError,
  type ControlCompletionPort,
  type ModelCallResourceMeter,
  type ResourceReservationPort,
} from "@zhixing-ai/core/contracts";
import type { LLMRole, ThinkingConfig } from "@zhixing-ai/core/types";
import { meteredProviderCall } from "./create-agent-runtime.js";

export interface ControlCompletionPortOptions {
  /** 未治理的原始角色通道——计量由本端口对调用方租约单点执行。 */
  readonly roles: { readonly main: LLMRole; readonly light: LLMRole };
  readonly thinking?: {
    readonly main?: ThinkingConfig;
    readonly light?: ThinkingConfig;
  };
  /** 租约计量面（reserveUsage / consume）——由组合根注入治理端口。 */
  readonly meter: Pick<ResourceReservationPort, "reserveUsage" | "consume">;
  /** 单次调用输出 token 上界（预占与请求同源口径，可按用途分别指定）。 */
  readonly defaultMaxOutputTokens:
    | number
    | {
        readonly main: number;
        readonly light: number;
      };
  /** 各用途模型的有效上下文窗口（用于按当前请求输入留出安全空间，避免 max_tokens 顶满总窗口）。 */
  readonly contextWindows?:
    | number
    | {
        readonly main: number;
        readonly light: number;
      };
}

/**
 * owner 设备控制补全端口的生产适配器：按角色档位路由到对应 LLM 通道，
 * 真实 provider 调用沿稳定 usageId 对调用方携带的租约做预占 / 消费——
 * 这是该调用唯一的计量链；租约的获取与 settle/release 归调用方
 * （control 终结行），本适配器不持有租约。
 */
export function createControlCompletionPort(
  options: ControlCompletionPortOptions,
): ControlCompletionPort {
  return {
    async complete(request) {
      const role = request.role === "light" ? options.roles.light : options.roles.main;
      const roleMaxOutputTokens =
        typeof options.defaultMaxOutputTokens === "number"
          ? options.defaultMaxOutputTokens
          : request.role === "light"
            ? options.defaultMaxOutputTokens.light
            : options.defaultMaxOutputTokens.main;
      const roleContextWindow =
        typeof options.contextWindows === "number"
          ? options.contextWindows
          : options.contextWindows
            ? request.role === "light"
              ? options.contextWindows.light
              : options.contextWindows.main
            : role.provider.models.find((item) => item.id === role.model)?.contextWindow;
      const ctx: AuthorityCallContext = {
        principal: { kind: "host", component: "control-completion" },
        requestId: `control-completion:${randomUUID()}`,
        deadlineAt: request.deadlineAt,
      };
      const nextCallIndex = (() => {
        let index = 0;
        return () => ++index;
      })();
      const tracker = createLeaseBudgetTracker(request.lease.budget);
      const meter: ModelCallResourceMeter = {
        budgetSnapshot: () => tracker.snapshot(),
        reserve: async ({ callIndex, tokenUpperBound }) => {
          const usageId = `usage:${request.lease.reservationId}:control:${callIndex}`;
          await options.meter.reserveUsage(
            request.lease,
            { usageId, tokens: tokenUpperBound, calls: 1 },
            ctx,
          );
          tracker.recordReserved(usageId, tokenUpperBound);
          return { usageId };
        },
        consume: async ({ usageId, tokens }) => {
          await options.meter.consume(
            request.lease,
            { usageId, ...(tokens === 0 ? {} : { tokens }), calls: 1 },
            ctx,
          );
          tracker.recordConsumed(usageId, tokens);
        },
      };
      try {
        const metered = meteredProviderCall({
          call: (providerRequest) => role.chat(providerRequest),
          meter,
          nextCallIndex,
          defaultMaxOutputTokens: roleMaxOutputTokens,
          ...(role.provider.protocol !== undefined
            ? { protocol: role.provider.protocol }
            : {}),
          ...(roleContextWindow !== undefined
            ? { contextWindow: roleContextWindow }
            : {}),
        });
        const chunks: string[] = [];
        let usage: { inputTokens: number; outputTokens: number } | undefined;
        let toolCall: { name: string; input: object } | undefined;
        const toolArgs = new Map<string, { name: string; fragments: string[] }>();
        const tools = request.schemaToolName
          ? [
              {
                name: request.schemaToolName,
                description: request.schemaToolName,
                inputSchema: { type: "object" } as const,
              },
            ]
          : [];
        for await (const event of metered({
          model: role.model,
          messages: request.messages,
          tools,
          maxTokens: roleMaxOutputTokens,
          thinking:
            request.role === "light"
              ? options.thinking?.light
              : options.thinking?.main,
          abortSignal: request.abort,
        })) {
          if (event.type === "error") {
            return {
              ok: false,
              error: toAuthorityError(event.error),
            };
          } else if (event.type === "text_delta") {
            chunks.push(event.text);
          } else if (event.type === "message_end") {
            usage = event.usage;
          } else if (event.type === "tool_call_start") {
            toolArgs.set(event.id, { name: event.name, fragments: [] });
          } else if (event.type === "tool_call_delta") {
            toolArgs.get(event.id)?.fragments.push(event.argsFragment);
          } else if (event.type === "tool_call_end") {
            const entry = toolArgs.get(event.id);
            if (
              entry &&
              request.schemaToolName !== undefined &&
              entry.name === request.schemaToolName &&
              !toolCall
            ) {
              try {
                toolCall = {
                  name: entry.name,
                  input: JSON.parse(entry.fragments.join("")) as object,
                };
              } catch {
                // 无有效工具提交——调用方按无 toolCall 分支处理。
              }
            }
          }
        }
        return {
          ok: true,
          text: chunks.join(""),
          ...(toolCall ? { toolCall } : {}),
          usage: usage ?? { inputTokens: 0, outputTokens: 0 },
        };
      } catch (error) {
        return {
          ok: false,
          error: toAuthorityError(error),
        };
      }
    },
  };
}

function toAuthorityError(error: unknown): AuthorityError {
  const message = error instanceof Error ? error.message : String(error);
  const transient =
    /rate.?limit|429|timeout|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network|503|502/iu.test(
      message,
    );
  return {
    code: "unavailable-offline",
    message,
    retryable: transient,
  };
}
