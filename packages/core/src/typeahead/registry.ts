/**
 * DefaultCommandRegistry — 命令注册表的默认实现
 *
 * 职责：
 *   1. 管理静态命令（直接注册的 `CommandDef`）
 *   2. 管理动态源（`DynamicCommandSource[]`），`refresh()` 时批量拉取
 *   3. `list(ctx)` 按 visibility 过滤后返回（不包括 hidden）
 *   4. `findByName` 按 name / alias 精确匹配（**包括** hidden，作为 escape hatch）
 *   5. `onChange` 订阅变更事件
 *
 * 不做的事：
 *   - 不做 fuzzy 匹配、排序、分类 —— 这是 CommandProvider（Step 3）的职责
 *   - 不持久化 —— registry 是纯内存状态，重启后由 bootstrap 重新注册
 *   - 不验证命令间的语义冲突 —— 只检查 id 唯一性
 *
 * 线程模型：单线程 Node.js，所有方法都是同步或用 Promise 串行。
 * 并发 register/refresh/list 不做锁 —— JS 的事件循环已经保证了原子性。
 */

import type {
  CommandDef,
  DynamicCommandSource,
  ICommandRegistry,
  RuntimeContext,
  Unregister,
  Unsubscribe,
} from "./types.js";

// ─── 选项 ───

export interface CommandRegistryOptions {
  /**
   * 动态源 refresh 失败的日志 hook。用于 CLI 日志 / telemetry。
   * 缺省：silent 忽略失败（避免 registry 吞掉 CLI 的输出）。
   */
  readonly onSourceError?: (sourceId: string, error: Error) => void;
}

// ─── 实现 ───

export class DefaultCommandRegistry implements ICommandRegistry {
  /** id → CommandDef（静态注册 + 动态源缓存合并） */
  private readonly commands = new Map<string, CommandDef>();

  /** 动态源的 id → source 实例 */
  private readonly sources = new Map<string, DynamicCommandSource>();

  /** 动态源当前缓存的命令 id（key = sourceId, value = 该源贡献的 ids） */
  private readonly sourceCommands = new Map<string, Set<string>>();

  /** 变更订阅者 */
  private readonly changeListeners = new Set<() => void>();

  private readonly onSourceError: (sourceId: string, error: Error) => void;

  constructor(options: CommandRegistryOptions = {}) {
    this.onSourceError = options.onSourceError ?? (() => {});
  }

  // ── 静态命令注册 ──

  register(cmd: CommandDef): void {
    if (this.commands.has(cmd.id)) {
      throw new Error(
        `CommandRegistry: duplicate command id "${cmd.id}" (existing name: "${this.commands.get(cmd.id)!.name}", new name: "${cmd.name}")`,
      );
    }
    this.commands.set(cmd.id, cmd);
    this.emitChange();
  }

  unregister(id: string): boolean {
    // 如果是某动态源贡献的 id，也把它从 sourceCommands 里移除以保持一致
    for (const [sourceId, ids] of this.sourceCommands) {
      if (ids.has(id)) {
        ids.delete(id);
        if (ids.size === 0) {
          // 留着空 Set —— 源本身还存在，下次 refresh 可能又产生 commands
          this.sourceCommands.set(sourceId, ids);
        }
      }
    }
    const existed = this.commands.delete(id);
    if (existed) {
      this.emitChange();
    }
    return existed;
  }

  // ── 动态源注册 ──

  registerDynamicSource(source: DynamicCommandSource): Unregister {
    if (this.sources.has(source.id)) {
      throw new Error(
        `CommandRegistry: duplicate dynamic source id "${source.id}"`,
      );
    }
    this.sources.set(source.id, source);
    this.sourceCommands.set(source.id, new Set());
    this.emitChange();

    return () => {
      // 移除源 + 清理它贡献的所有命令
      const contributed = this.sourceCommands.get(source.id);
      if (contributed) {
        for (const id of contributed) {
          this.commands.delete(id);
        }
      }
      this.sources.delete(source.id);
      this.sourceCommands.delete(source.id);
      this.emitChange();
    };
  }

  async refresh(): Promise<void> {
    // 所有源并发刷新；单个失败不影响其他源。
    // Promise.allSettled 保证我们总能处理所有结果，不会被第一个 reject 吞掉。
    const refreshJobs = Array.from(this.sources.values()).map(
      async (source) => {
        try {
          const newCommands = await source.list();
          this.applySourceCommands(source.id, newCommands);
        } catch (err) {
          const error =
            err instanceof Error ? err : new Error(String(err));
          this.onSourceError(source.id, error);
          // 失败时**保留旧缓存**（不清），保持上次成功的状态可用
        }
      },
    );
    await Promise.allSettled(refreshJobs);
    this.emitChange();
  }

  /**
   * 把源刚返回的命令列表同步到 commands + sourceCommands。
   * - 先移除源之前贡献的旧 ids
   * - 再把新的 ids 加回去
   * - 冲突检测：如果新 id 已被静态注册或另一个源占用，跳过并记错
   */
  private applySourceCommands(
    sourceId: string,
    newCommands: readonly CommandDef[],
  ): void {
    const oldIds = this.sourceCommands.get(sourceId) ?? new Set<string>();
    for (const id of oldIds) {
      this.commands.delete(id);
    }

    const newIds = new Set<string>();
    for (const cmd of newCommands) {
      if (this.commands.has(cmd.id)) {
        // 冲突：静态注册或另一个源已经占用此 id。
        // 保守策略：跳过此命令（已存在的不动）+ 记错。
        this.onSourceError(
          sourceId,
          new Error(
            `command id "${cmd.id}" already registered (name: "${this.commands.get(cmd.id)!.name}")`,
          ),
        );
        continue;
      }
      this.commands.set(cmd.id, cmd);
      newIds.add(cmd.id);
    }
    this.sourceCommands.set(sourceId, newIds);
  }

  // ── 查询 ──

  list(ctx: RuntimeContext): readonly CommandDef[] {
    const result: CommandDef[] = [];
    for (const cmd of this.commands.values()) {
      if (cmd.hidden === true) continue;
      if (!this.isVisible(cmd, ctx)) continue;
      result.push(cmd);
    }
    return result;
  }

  find(id: string): CommandDef | null {
    return this.commands.get(id) ?? null;
  }

  findByName(name: string): CommandDef | null {
    const target = name.toLowerCase();
    for (const cmd of this.commands.values()) {
      if (cmd.name.toLowerCase() === target) return cmd;
      if (cmd.aliases) {
        for (const alias of cmd.aliases) {
          if (alias.toLowerCase() === target) return cmd;
        }
      }
    }
    return null;
  }

  // ── 可见性判断 ──

  /**
   * 检查命令在给定 RuntimeContext 下是否可见。
   *
   * 规则（严格顺序）：
   *   1. targets 存在且不含 ctx.target → 不可见
   *   2. predicate 存在且返回 false → 不可见
   *   3. predicate 抛异常 → **保守地视为不可见** + 记日志
   *   4. 否则可见
   */
  private isVisible(cmd: CommandDef, ctx: RuntimeContext): boolean {
    const vis = cmd.visibility;
    if (!vis) return true;

    if (vis.targets !== undefined && !vis.targets.includes(ctx.target)) {
      return false;
    }

    if (vis.predicate) {
      try {
        return vis.predicate(ctx) === true;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.onSourceError(`visibility-predicate:${cmd.id}`, error);
        return false; // 保守：predicate 坏了宁可不显示
      }
    }

    return true;
  }

  // ── 变更订阅 ──

  onChange(listener: () => void): Unsubscribe {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  private emitChange(): void {
    // 复制一份再遍历，避免 listener 在回调里 unsubscribe 导致迭代错乱
    const snapshot = Array.from(this.changeListeners);
    for (const listener of snapshot) {
      try {
        listener();
      } catch (err) {
        // listener 抛异常不应影响 registry 本身。通过 onSourceError 上报。
        const error = err instanceof Error ? err : new Error(String(err));
        this.onSourceError("change-listener", error);
      }
    }
  }
}
