import type { ToolDefinition } from "../types/tools.js";
import type { ProductApiDispatcher } from "../product-api/catalog.js";
import type { LogReadContext } from "./contracts.js";
import { validLogToken } from "./capture.js";
import { publicLogErrorMessage } from "./errors.js";
import {
  LOG_READ,
  LOG_SEARCH,
  parseLogReadRequest,
  parseLogSearchRequest,
} from "./product-api.js";

interface Binding {
  readonly api: Pick<ProductApiDispatcher, "query">;
  readonly context: () => LogReadContext;
  readonly name: string;
}
// Runtime projections may copy the descriptor; the trusted executable closure retains provenance.
const bindings = new WeakMap<ToolDefinition["call"], Binding>();
export function conversationLogScope(conversationId: string): string {
  const scope = `conversation:${conversationId}`;
  if (!validLogToken(scope)) throw Error("日志会话身份无效");
  return scope;
}

/** Canonical definitions, with provenance retained outside model-controlled schemas. */
export function createLogQueryTools(
  api: Pick<ProductApiDispatcher, "query">,
  context: () => LogReadContext,
): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      name: "log_search",
      description:
        "查找本设备可获准读取的运行日志。支持时间、来源、级别及关联身份筛选；结果有界，使用游标续页。缺口表示证据不足，不能推断成功。",
      inputSchema: {
        type: "object",
        properties: {
          filter: {
            type: "object",
            properties: {
              from: { type: "integer" },
              until: { type: "integer" },
              source: { type: "string" },
              level: {
                type: "string",
                enum: ["debug", "info", "warn", "error"],
              },
              id: { type: "string" },
              ref: {
                type: "object",
                properties: {
                  kind: { type: "string" },
                  id: { type: "string" },
                  storeId: { type: "string" },
                },
                required: ["kind", "id"],
                additionalProperties: false,
              },
            },
            additionalProperties: false,
          },
          cursor: { type: "string" },
        },
        additionalProperties: false,
      },
      isReadOnly: true,
      isParallelSafe: false,
      boundaries: [
        { boundaryType: "app-state", access: "read", dynamic: false },
      ],
      async call(input, execution) {
        try {
          const result = await api.query(LOG_SEARCH, {
            request: parseLogSearchRequest(input),
            context: () => {
              execution.abortSignal?.throwIfAborted();
              return context();
            },
          });
          return { content: JSON.stringify(result) };
        } catch (error) {
          return { isError: true, content: publicLogErrorMessage(error) };
        }
      },
    },
    {
      name: "log_read",
      description:
        "按 zxlog://<storeId>/record/<id> 或 /operation/<kind>/<id> 地址读取日志概览、时间线或详情。地址可以交给另一获准主体；远端不可用、过期或缺失不会冒充完整证据。",
      inputSchema: {
        type: "object",
        properties: {
          address: { type: "string" },
          view: { type: "string", enum: ["overview", "timeline", "detail"] },
          cursor: { type: "string" },
        },
        required: ["address"],
        additionalProperties: false,
      },
      isReadOnly: true,
      isParallelSafe: false,
      boundaries: [
        { boundaryType: "app-state", access: "read", dynamic: false },
      ],
      async call(input, execution) {
        try {
          const result = await api.query(LOG_READ, {
            request: parseLogReadRequest(input),
            context: () => {
              execution.abortSignal?.throwIfAborted();
              return context();
            },
          });
          return { content: JSON.stringify(result) };
        } catch (error) {
          return { isError: true, content: publicLogErrorMessage(error) };
        }
      },
    },
  ];
  for (const tool of tools) {
    bindings.set(tool.call, { api, context, name: tool.name });
    Object.freeze(tool);
  }
  return tools;
}

/** Only canonical log tools can cross this boundary; a name or boundary declaration is not proof. */
export function restrictLogQueryTools(
  parentTools: readonly ToolDefinition[],
  input: {
    readonly scope: string;
    readonly subject: string;
    readonly revision: string;
    readonly assertActive: () => void;
  },
): ToolDefinition[] {
  const selected = parentTools.filter(
    (tool) => bindings.get(tool.call)?.name === tool.name,
  );
  if (
    selected.length !== 2 ||
    new Set(selected.map((tool) => tool.name)).size !== 2
  )
    throw Error("当前运行未装配完整日志查询能力");
  return selected.map((tool) => {
    const binding = bindings.get(tool.call)!;
    return createLogQueryTools(binding.api, () => {
      input.assertActive();
      const parent = binding.context();
      return {
        subject: input.subject,
        revision: `${parent.revision}:${input.revision}`,
        manageStorage: false,
        managePolicy: false,
        scopes:
          parent.manageStorage || parent.scopes.includes(input.scope)
            ? [input.scope]
            : [],
      };
    }).find((candidate) => candidate.name === tool.name)!;
  });
}
