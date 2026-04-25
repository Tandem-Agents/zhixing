/**
 * ToolArgumentExtractor —— `PermissionStoreOptions.extractArgument` 的可演进实现。
 *
 * 设计目的：让 `PermissionStore.match` 在做 `pattern.argument` glob 匹配时，
 * 能按每个工具自身声明的 `permissionArgumentKey` 字段提取——避免对多 string
 * 字段工具（`web_fetch { url, prompt }` / `http_request { method, url }` 等）
 * 误用 priority list / 字段顺序导致命中错误字段。
 *
 * 解耦定位：`PermissionStore` 不持有 tools 列表（cohesion——它只负责规则
 * 存储与匹配，不负责参数提取策略）。本类在持有 tools 的入口（cli run-agent）
 * 构建一次注入，store 通过 `PermissionStoreOptions.extractArgument` 函数式消费。
 *
 * 两种使用模式（与 `BoundaryRegistry` 对偶）：
 *
 * 1. **静态启动（当前主用法）**：`ToolArgumentExtractor.fromTools(tools)`
 *    一次性 snapshot 启动时所有工具的 `permissionArgumentKey` 声明
 *
 * 2. **动态扩展（未来路径）**：runtime 调 `extractor.register(toolName, key)`
 *    注册新工具的 argument key，支持 MCP / 插件动态接入
 *
 * 见 [tool-permission-execution.md §4.2](../../../../research/design/specifications/tool-permission-execution.md)
 * 与 ADR-TPE-007（依赖注入而非穿透 tools）。
 */

import type { ToolDefinition } from "../types/tools.js";
import { defaultExtractArgument } from "./permission-store.js";
import type { IToolArgumentExtractor, SecurityRequest } from "./types.js";

/**
 * 可演进的工具参数提取器实现。
 *
 * implements `IToolArgumentExtractor`——caller（cli / MCP / 子 agent）持有接口
 * 类型，未来 swap 实现零成本。注入到 `PermissionStoreOptions.extractArgument` 时
 * 使用 `(req) => extractor.extract(req)` 箭头函数桥接保持 store 端函数式契约。
 */
export class ToolArgumentExtractor implements IToolArgumentExtractor {
  private readonly keys = new Map<string, string>();

  /**
   * 从工具列表批量构造（启动时 snapshot 模式）。
   * 仅声明了 `permissionArgumentKey` 的工具进入 registry。
   */
  static fromTools(tools: readonly ToolDefinition[]): ToolArgumentExtractor {
    const ext = new ToolArgumentExtractor();
    for (const tool of tools) {
      if (tool.permissionArgumentKey) {
        ext.register(tool.name, tool.permissionArgumentKey);
      }
    }
    return ext;
  }

  /**
   * 注册或更新一个工具的 argument key。
   *
   * - 重复注册同 toolName：覆盖旧 key
   * - 工具名小写归一化（与 PermissionStore.match 一致）
   */
  register(toolName: string, key: string): void {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error(
        `ToolArgumentExtractor.register: key 必须是非空字符串 (toolName="${toolName}")`,
      );
    }
    this.keys.set(toolName.toLowerCase(), key);
  }

  /** 注销一个工具的 argument key（动态卸载场景）。 */
  unregister(toolName: string): void {
    this.keys.delete(toolName.toLowerCase());
  }

  /**
   * 提取 SecurityRequest 中用于权限匹配的 argument 字符串。
   *
   * 顺序：
   * 1. 工具显式声明了 `permissionArgumentKey` → 读 `arguments[key]`
   *    - 若是 string → 返回该值
   *    - 若不是 string（缺失 / 非 string 类型）→ 降级到 fallback（不抛错）
   * 2. 否则 → 调用 `defaultExtractArgument`（priority list + 第一字段 fallback）
   */
  extract(request: SecurityRequest): string {
    const explicitKey = this.keys.get(request.tool.toLowerCase());
    if (explicitKey) {
      const val = request.arguments[explicitKey];
      if (typeof val === "string") return val;
    }
    return defaultExtractArgument(request);
  }

  /** 调试 / 可观测性：列出当前已注册的工具名（小写）。 */
  list(): string[] {
    return [...this.keys.keys()];
  }
}
