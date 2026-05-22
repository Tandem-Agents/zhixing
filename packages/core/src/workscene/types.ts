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
}

/**
 * 工作场景登记 CRUD 原语 —— **唯一**写入入口。
 *
 * 持久化并发安全沿用 conversation repository 的成熟实现：per-id meta 锁 +
 * 单一 index 锁 + 原子写。
 */
export interface IWorkSceneRegistry {
  list(): Promise<WorkScene[]>;
  get(id: string): Promise<WorkScene | null>;
  add(opts: { name: string; workdir?: string }): Promise<WorkScene>;
  /**
   * 彻底移除工作场景：从 index 摘 id + 物理删除该场景系统目录
   * (`meta.json` + 记忆域 `me/` + 会话域 `conversations/`)。**不可恢复**。
   *
   * 用户的代码工作目录 (`workdir`) **不动** —— 那是用户的代码资产，归用户自管，
   * 系统从不写也不删。
   *
   * 幂等：id 不在 index / 目录已不存在 都按"删干净"语义处理，不抛错。
   */
  remove(id: string): Promise<void>;
  rename(id: string, name: string): Promise<WorkScene>;
  /** 刷新 lastActiveAt —— 进入工作场景时调用。 */
  touch(id: string): Promise<void>;
}
