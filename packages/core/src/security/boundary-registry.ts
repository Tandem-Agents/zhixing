/**
 * BoundaryRegistry —— `ToolBoundaryRegistry` 接口的可演进实现。
 *
 * 设计目的：让 `BoundaryImpactClassifier` 能按工具自描述的 `boundaries` 字段
 * 判断 OperationClass，避免无声明工具被默认归为 critical。
 *
 * 解耦定位：消费方（`BoundaryImpactClassifier`）只依赖 `ToolBoundaryRegistry`
 * read-only 接口（`getBoundaries(name)`）；本实现额外暴露 `register / unregister`
 * 写入 API 给 caller，支持以下两种使用模式：
 *
 * 1. **静态启动（主用法）**：cli/serve 入口 `BoundaryRegistry.fromTools(tools)`
 *    一次性 snapshot 所有工具的 boundaries 声明
 *
 * 2. **装配期补注册**：`registry.register(name, boundaries)`——如 Task 工具晚于
 *    fromTools 装配。运行时动态增删工具（MCP 连接变更等）走 reload 整体重建后
 *    重新 fromTools，**不**走 in-place 增删
 *
 * 政策（ADR-TPE-006）：现有 8 个 builtin 工具均通过专属 context classifier
 * 接管分类，**不应**声明 boundaries 字段；空声明被本实现直接跳过，避免污染
 * registry。
 */

import type { ToolDefinition } from "../types/tools.js";
import type {
  BoundaryCrossing,
  MutableToolBoundaryRegistry,
} from "./types.js";

/**
 * `BoundaryCrossing` 单元素深拷贝。
 *
 * 字段都是 primitive（`boundaryType` / `access` / `dynamic`），一层 spread 即可——
 * 防御 caller 通过 `getBoundaries(name)[0].access = "MUTATED"` 这类 mutate 污染
 * registry 内部状态。
 */
function cloneCrossing(crossing: BoundaryCrossing): BoundaryCrossing {
  return { ...crossing };
}

/**
 * 可演进的工具边界注册表实现。
 *
 * implements `MutableToolBoundaryRegistry`（其本身 extends `ToolBoundaryRegistry`
 * read-only 接口）—— 消费方（`BoundaryImpactClassifier`）只看到 read-only 视图，
 * caller（cli 入口）持有 mutable 视图调用 register。
 */
export class BoundaryRegistry implements MutableToolBoundaryRegistry {
  private readonly map = new Map<string, BoundaryCrossing[]>();

  /**
   * 从工具列表批量构造（启动时 snapshot 模式）。
   *
   * - 工具未声明 boundaries 或声明为空数组：不注册（getBoundaries 返回 undefined）
   * - 工具名按小写归一化（与 PermissionStore.match / CompositeClassifier 一致）
   */
  static fromTools(tools: readonly ToolDefinition[]): BoundaryRegistry {
    const reg = new BoundaryRegistry();
    for (const tool of tools) {
      if (tool.boundaries && tool.boundaries.length > 0) {
        reg.register(tool.name, tool.boundaries);
      }
    }
    return reg;
  }

  /**
   * 注册或更新一个工具的边界声明。
   *
   * - 重复注册同 toolName：覆盖旧声明
   * - **拒绝空数组**：传入 `[]` 立即 throw（fail-fast）。这与
   *   `ToolArgumentExtractor.register` 拒空 key throw 对偶
   * - 工具名小写归一化
   * - **入站深拷贝**：每个 BoundaryCrossing 通过 `cloneCrossing` 独立拷贝，
   *   防止 caller 后续 mutate 单个 crossing 字段（如 `crossings[0].access`）
   *   污染 registry 内部状态
   */
  register(toolName: string, boundaries: readonly BoundaryCrossing[]): void {
    if (boundaries.length === 0) {
      throw new Error(
        `BoundaryRegistry.register: boundaries 不能为空数组——清除工具应显式调 unregister(toolName) (toolName="${toolName}")`,
      );
    }
    this.map.set(toolName.toLowerCase(), boundaries.map(cloneCrossing));
  }

  /**
   * 查询工具的边界声明。
   *
   * **出站深拷贝**：每个 BoundaryCrossing 独立拷贝——下游消费者（如 `BoundaryImpactClassifier`）
   * 修改返回值不污染 registry 内部状态。`BoundaryCrossing` 数组通常 < 5 元素，
   * 频次为每次工具调用一次，开销可忽略。
   */
  getBoundaries(toolName: string): BoundaryCrossing[] | undefined {
    const entry = this.map.get(toolName.toLowerCase());
    return entry?.map(cloneCrossing);
  }

  /** 调试 / 可观测性：列出当前已注册的工具名（小写）。 */
  list(): string[] {
    return [...this.map.keys()];
  }
}
