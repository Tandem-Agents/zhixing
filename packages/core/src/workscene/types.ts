/**
 * 工作场景类型
 *
 * 工作场景 = 用户进入具体工作语境时的一组运行配置归属（独立记忆域 + 会话域 +
 * 元信息）。粒度、组织、生命周期由用户决定，系统只提供 CRUD 机制原语。
 */

/**
 * 工作场景记录 —— 持久化在该场景的 meta.json（权威）。
 *
 * index.json 只存"已注册 id 集合"（成员关系），所有可变字段以本记录为准；
 * 二者分工避免双写分歧。
 */
export interface WorkScene {
  /** 用户可读稳定 id（由 name slug 化），创建后不可改。 */
  id: string;
  /** 显示名，可重命名。 */
  name: string;
  /**
   * 工作目录 —— 仅"工作内容涉及本地文件"的场景指定（开发 / 写作）；
   * 浏览器 / 对话 / 规划类无此属性。创建时绑定，要换须重建场景。
   */
  workdir?: string;
  createdAt: string;
  lastActiveAt: string;
  /** 仅影响 list 默认过滤，不影响 main 能否检索其记忆。 */
  archived?: boolean;
}

/**
 * 工作场景登记 CRUD 原语 —— **唯一**写入入口。
 *
 * 持久化并发安全沿用 conversation repository 的成熟实现：per-id meta 锁 +
 * 单一 index 锁 + 原子写。
 */
export interface IWorkSceneRegistry {
  list(opts?: { includeArchived?: boolean }): Promise<WorkScene[]>;
  get(id: string): Promise<WorkScene | null>;
  add(opts: { name: string; workdir?: string }): Promise<WorkScene>;
  /**
   * 移除登记。`purgeData:true` 连带删该场景全部数据（记忆域 + 会话域）；
   * 不传仅摘身份（出 index）、磁盘数据保留 —— 此时 list 不再列出，但 main
   * 仍可按 id 检索其记忆域。
   */
  remove(id: string, opts?: { purgeData?: boolean }): Promise<void>;
  rename(id: string, name: string): Promise<WorkScene>;
  setArchived(id: string, archived: boolean): Promise<WorkScene>;
  /** 刷新 lastActiveAt —— 进入工作场景时调用。 */
  touch(id: string): Promise<void>;
}
