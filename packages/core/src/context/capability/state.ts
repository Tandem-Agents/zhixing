/**
 * CapabilityState —— 会话级演化的工具能力分层状态机。
 *
 * 设计原则：
 * - 状态是 mutable in-memory，session-scoped，**不持久化跨 process**
 * - 所有变换是显式方法（initialize / promoteToHot / recordToolUse / advanceTurn），
 *   不通过对外暴露 records 让消费方"自己改"
 * - 装配期 initialize 注册所有可用工具到初始 layer；启动 / 切换 conversation 时
 *   由 rebuildCapabilityFromHistory 从 transcript 历史现学现用；运行时由
 *   promoteToHot / recordToolUse 推进；onTurnComplete 钩 advanceTurn 做 LRU 降级
 *
 * 不持久化的设计哲学：
 * - tool_use 历史的权威源是 transcript，capability 是其衍生视图
 * - 同一信息单源（transcript），避免 snapshot 与 transcript 双源不一致
 * - 重启后 rebuild 的 hot 集合 = 上次 session 最近 7 轮 hot 集合（信息等价）
 * - /clear / /switch / 重启 全部走 reset + rebuild 同一路径，行为一致
 *
 * 与 ContextCompiler 的契约：
 * - layerOf(toolName) 是 stage 过滤 tools[] 的唯一查询入口
 * - 未注册的工具名 layerOf 返 undefined；stage 应将其视为"不可用 / cold"
 *
 * 不变量：
 * - always 工具一旦 initialize 就永不降级（advanceTurn 跳过它）
 * - hot 工具连续 HOT_RETENTION_TURNS 轮未被 recordToolUse → 降级 discoverable
 * - cold 工具不能被 promoteToHot；想暴露需重新 initialize
 */

import type { CapabilityLayer, CapabilityRecord } from "./types.js";
import { HOT_RETENTION_TURNS } from "./types.js";

export class CapabilityState {
  private readonly records = new Map<string, CapabilityRecord>();
  private currentTurn = 0;

  // ─── 装配 ───

  /**
   * 注册工具到初始 layer。装配期由 runtime 对所有内置 + extra 工具调用一次。
   *
   * 同名重复 initialize 覆盖前者（用于切换 always / discoverable 配置场景）。
   * lastUseTurn 不在 initialize 设置 —— 只有 recordToolUse 才推进它。
   */
  initialize(toolName: string, layer: CapabilityLayer): void {
    this.records.set(toolName, { toolName, layer });
  }

  // ─── 查询 ───

  /**
   * 当前 layer。未注册的工具返 undefined（消费方按"不可用"处理）。
   */
  layerOf(toolName: string): CapabilityLayer | undefined {
    return this.records.get(toolName)?.layer;
  }

  /**
   * 所有 layer === target 的工具名（按注册序）。供 stage 批量过滤 / 调试 dump 用。
   */
  toolsAt(target: CapabilityLayer): string[] {
    const names: string[] = [];
    for (const record of this.records.values()) {
      if (record.layer === target) names.push(record.toolName);
    }
    return names;
  }

  /** 当前 turn 序号 —— 写诊断 / 测试断言。 */
  get turn(): number {
    return this.currentTurn;
  }

  // ─── 状态推进 ───

  /**
   * 升级到 hot —— 由 LLM tool_use 命中触发（自动升级路径）或
   * request_capabilities 元工具触发（强模型批量预热路径）。
   *
   * 行为：
   *   - 未注册：no-op（无法凭空升级 cold / 未知工具）
   *   - already always：保持 always（more permissive 不被降级）
   *   - cold：no-op（cold 是显式排除，必须重新 initialize 才能进 hot）
   *   - discoverable / hot：升级到 hot 并刷新 lastUseTurn = currentTurn
   *
   * 返回是否真正发生了 layer 跃迁（false = 已经是 always 或 cold/未注册）。
   */
  promoteToHot(toolName: string): boolean {
    const record = this.records.get(toolName);
    if (!record) return false;
    if (record.layer === "always") {
      // always 工具的 lastUseTurn 仍刷新（诊断价值）但 layer 不变
      record.lastUseTurn = this.currentTurn;
      return false;
    }
    if (record.layer === "cold") return false;
    const promoted = record.layer !== "hot";
    record.layer = "hot";
    record.lastUseTurn = this.currentTurn;
    return promoted;
  }

  /**
   * 记录工具被 tool_use 命中。语义上等同 promoteToHot（discoverable → hot），
   * 但同时把 always 工具的 lastUseTurn 也刷新（为未来可能的诊断 / 统计）。
   *
   * 与 promoteToHot 区别：promoteToHot 是"我想用 X，预热它"；recordToolUse
   * 是"X 已经被用了"。当前实现等价但语义清晰区分让消费方表达意图。
   */
  recordToolUse(toolName: string): void {
    this.promoteToHot(toolName);
  }

  /**
   * 推进 turn 序号 + LRU 降级评估。runtime 在 onTurnComplete 钩子调一次。
   *
   * 降级规则：hot 工具的 lastUseTurn 距 currentTurn 超过 HOT_RETENTION_TURNS
   *   → 降级回 discoverable。always / cold / discoverable 不参与。
   *
   * 顺序：先 currentTurn += 1，再做降级评估；保证"本轮命中"的工具不会立即被降级。
   */
  advanceTurn(): void {
    this.currentTurn += 1;
    for (const record of this.records.values()) {
      if (record.layer !== "hot") continue;
      const lastUse = record.lastUseTurn ?? 0;
      if (this.currentTurn - lastUse > HOT_RETENTION_TURNS) {
        record.layer = "discoverable";
      }
    }
  }

  /**
   * 重置状态 —— `/clear` 等会话级重置触发。
   *
   * 行为：
   *   - currentTurn 归零
   *   - 所有 hot 工具降级回 discoverable（保留 always / cold 配置）
   *   - 清除 lastUseTurn（避免重置后第一次 advanceTurn 立即把刚升级的工具降级）
   *
   * 不删除 records 本身（initialize 阶段确定的层归属和工具集仍然有效）。
   */
  reset(): void {
    this.currentTurn = 0;
    for (const record of this.records.values()) {
      if (record.layer === "hot") record.layer = "discoverable";
      record.lastUseTurn = undefined;
    }
  }
}
