/**
 * task_list 工具 + TaskListService —— LLM 自我组织的任务列表
 *
 * 规格引用：
 *
 * 设计意图：
 *   - LLM 通过 `task_list.set(items)` 主动维护"当前进行中要做什么"
 *   - 列表跨段切换保留（非 transcript 内容、非段窗口管辖）；只受 LLM 主动 set 或
 *     用户 `/task` 命令改变；`/clear` 时清空
 *   - 段切换路径读 `getInProgressTasks(conversationId)` 作为"无 in-progress 任务"
 *     判定来源——有任务时段切换会被延后（避免在任务执行中段重启上下文）
 *
 * 三层分离（顶级架构）：
 *   - Layer 1 持久化（可插拔）：`TaskListStore` 接口
 *   - Layer 2 业务服务：`TaskListService` 提供 per-conversation cache + 原子 set +
 *     工具工厂
 *   - Layer 3 LLM 接口：`service.createTool(getConversationId)` 返回 ToolDefinition
 *
 * 核心契约：
 *   - **per-conversation 隔离**：state 按 conversationId key in cache，多 conversation
 *     在同一 service 内互不污染（修复"定时任务污染主对话"类 bug）
 *   - **原子 set**：store.save throw 时回滚 cache，保内存与磁盘要么同时更新要么同时
 *     不变（无 split-brain）
 *   - **ephemeral 拒绝**：工具 call 时若 getConversationId 返回 undefined，直接
 *     isError 不改 state（一次性 run / 定时任务无 conversation 上下文 → task_list
 *     不可用）
 */

import { randomUUID } from "node:crypto";
import type {
  TaskItem,
  TaskListState,
  ToolDefinition,
  ToolResult,
} from "@zhixing/core";

// ─── Layer 1: 持久化抽象 ───

/**
 * task_list 持久化协议 —— 实现方决定如何落地（conversation meta / 独立 json /
 * 远端服务等）。
 *
 * 契约：
 *   - `load` 返回 undefined 表示"无持久化记录"（正常状态，非错误）
 *   - `save` 必须在持久化失败时 throw —— service 据此拒绝改 cache，保 split-brain-free
 *   - `delete` 必须幂等
 *
 * 串行化由 store 实现方保证（如 ConversationRepository per-id metaLock）。
 * service 层不重复加锁。
 */
export interface TaskListStore {
  load(conversationId: string): Promise<TaskListState | undefined>;
  save(conversationId: string, state: TaskListState): Promise<void>;
  delete(conversationId: string): Promise<void>;
}

// ─── Layer 2 订阅事件类型 ───

/**
 * task_list 状态变化事件 —— set 成功后 + clear 时触发。
 *
 * `state=null` 表示 cache 已清空 / 驱逐，与"cache miss"等价 —— UI 模块据此
 * 隐藏视图。订阅者无需区分"未加载"与"已清空"，两者对显示语义一致。
 */
export interface TaskListStateEvent {
  readonly conversationId: string;
  readonly state: TaskListState | null;
}

export type TaskListStateListener = (event: TaskListStateEvent) => void;

// ─── Layer 2: 业务服务 ───

/**
 * task_list 业务服务 —— process-wide 单例，所有 runtime 共享。
 *
 * 生命周期：
 *   - 一个 cli 进程一个 service 实例（store 注入决定持久化层）
 *   - cli REPL 模式：1 个 session 1 个 service，跨 conversation 复用（cache 按
 *     conversationId 分桶）
 *   - cli serve 模式：N 个 session 共享 1 个 service，每个 sessionId 一份 cache 槽
 *
 * cache 策略：
 *   - 简单 Map，无 LRU（cli 场景下 active conversation 数量极少）
 *   - prime() 显式加载到 cache；getCached() 同步读 cache miss 返回 null
 *   - clear(convId) 主动驱逐单个 cache 项（/clear 路径用）
 *   - 不实现 Resettable —— Resettable 是 runtime-bound 视图层协议，service 是
 *     conversation-scoped 服务，语义层级不同
 */
export class TaskListService {
  private readonly cache = new Map<string, TaskListState>();
  private readonly subscribers = new Set<TaskListStateListener>();

  constructor(private readonly store: TaskListStore) {}

  // ─── 同步查询（SegmentManager 等热路径调） ───

  /** cache miss 返回 null；命中返回 state（含 items 数组） */
  getCached(conversationId: string): TaskListState | null {
    return this.cache.get(conversationId) ?? null;
  }

  /**
   * 同步过滤 in_progress 任务 —— SegmentManager 在 turn 边界评估段切换时调。
   * cache miss 返回空数组（与"无 in-progress 任务"语义等价，让段切换可继续）。
   */
  getInProgressTasks(conversationId: string): readonly TaskItem[] {
    const state = this.cache.get(conversationId);
    if (!state) return [];
    return state.items.filter((t) => t.status === "in_progress");
  }

  /** 获取所有任务（UI 渲染等场景）；cache miss 返回空数组 */
  getAllTasks(conversationId: string): readonly TaskItem[] {
    return this.cache.get(conversationId)?.items ?? [];
  }

  // ─── cache 生命周期 ───

  /**
   * 异步加载持久化状态到 cache —— cli 启动 / `/new` / `/resume` 路径调用。
   *
   * 加载失败不抛错（退化为空列表 cache 项），保 cli 启动不被磁盘错误阻塞。
   * 已 cache 时跳过 load（避免重复 I/O，但允许显式 clear() 后重新 prime）。
   */
  async prime(conversationId: string): Promise<void> {
    if (this.cache.has(conversationId)) return;
    try {
      const loaded = await this.store.load(conversationId);
      this.cache.set(conversationId, loaded ?? { items: [] });
    } catch {
      this.cache.set(conversationId, { items: [] });
    }
  }

  /**
   * 清空指定 conversation 的 cache 项 —— `/clear` 路径调用。
   *
   * 仅清 cache；磁盘端清除由调用方独立处理（cli 通常已通过
   * `ConversationRepository.clearViewLayerState` 完成 meta 字段清空）。
   * 分层避免双重职责。
   *
   * 同步触发 emit(state=null) —— 让订阅者（UI 模块）感知 cache 已清空。
   */
  clear(conversationId: string): void {
    this.cache.delete(conversationId);
    this.emit(conversationId, null);
  }

  // ─── 原子写 ───

  /**
   * 原子 set —— 先 save 后 cache 模式。
   *
   * 流程：await store.save → cache.set → emit。store.save 失败直接 throw 上抛，
   * cache 不动 —— 保 cache 永远反映"已持久化"状态，不存在乐观更新的中间态。
   *
   * 写入串行化由 store 实现方保证（如 ConversationRepository per-id metaLock）。
   * 异常上抛 —— 工具层捕获后转为 isError ToolResult，LLM 收到明确失败信号。
   */
  async set(
    conversationId: string,
    items: readonly TaskItem[],
  ): Promise<TaskListState> {
    const next: TaskListState = { items: [...items] };
    await this.store.save(conversationId, next);
    this.cache.set(conversationId, next);
    this.emit(conversationId, next);
    return next;
  }

  /**
   * Read-modify-write 便利方法 —— cli 命令（add / done）路径专用。
   *
   * 流程：ensure prime（从磁盘加载到 cache）→ 读 cache 快照 → 应用 mutator → 调 set。
   * prime 是 service 层自防御：避免 caller 遗漏 prime 时 mutator 收到空数组，
   * 错误覆盖磁盘已有数据。prime 幂等 + cache 有则 early return，零额外开销。
   *
   * 并发语义：cache 读 + mutator + store.save 之间不持锁；store 串行多次写入时，
   * 结果由最后写入者决定 —— cli 命令的语义不要求"在 LLM 改动前后保持原子读改写"。
   */
  async mutate(
    conversationId: string,
    mutator: (current: readonly TaskItem[]) => readonly TaskItem[],
  ): Promise<TaskListState> {
    await this.prime(conversationId);
    const curr = this.cache.get(conversationId)?.items ?? [];
    return this.set(conversationId, mutator(curr));
  }

  // ─── 订阅 ───

  /**
   * 订阅 task_list 状态变化 —— UI 模块感知数据更新的唯一入口。
   *
   * 触发时机：set 成功后 emit({state}) + clear 时 emit({state: null})。
   * 监听器抛错被 try-catch swallow，不影响其他订阅者也不传染 service。
   *
   * 返回的 unsubscribe 函数幂等；调用后 listener 从订阅集合移除，闭包引用释放，
   * TaskTail 等订阅者实例可被 GC。
   */
  subscribe(listener: TaskListStateListener): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  private emit(conversationId: string, state: TaskListState | null): void {
    for (const listener of this.subscribers) {
      try {
        listener({ conversationId, state });
      } catch {
        // 隔离 listener 异常 —— 不影响其他订阅者，不传染 service
      }
    }
  }

  // ─── 工具工厂 ───

  /**
   * 创建 LLM 视角的 task_list 工具实例。
   *
   * `getConversationId` 是依赖反转的注入点 —— 装配方决定如何取（cli 装配走
   * `runContextStorage.getStore()?.conversationId` 拿 per-run ALS）。
   * 返回 undefined 时工具 call 直接 isError 不改 state（ephemeral / scheduled
   * 路径无 conversation 绑定）。
   *
   * 每次调用返回一个新 ToolDefinition 实例（不共享对象引用），但都闭包引用同一
   * service —— runtime swap 后调用方拿新 ToolDefinition，行为一致。
   */
  createTool(getConversationId: () => string | undefined): ToolDefinition {
    const service = this;
    return {
      name: "task_list",
      description: TASK_LIST_TOOL_DESCRIPTION,
      inputSchema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            description:
              "The complete task list after this update. Each call REPLACES the entire list — include all tasks you want to keep, not just the changed ones.",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description:
                    "Optional stable identifier for this task. Reuse the same id across set() calls to update an existing task; omit for new tasks (a uuid will be assigned).",
                },
                content: {
                  type: "string",
                  description:
                    "Short task description (≤ 80 chars). Use imperative form, e.g., 'Read src/index.ts'.",
                },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed"],
                  description:
                    "Task state. Keep ONE in_progress at a time. Use 'completed' once done — do not delete completed tasks within the same conversation segment.",
                },
              },
              required: ["content", "status"],
            },
          },
        },
        required: ["items"],
      },
      isReadOnly: false,
      isParallelSafe: false,
      needsPermission: false,
      async call(input): Promise<ToolResult> {
        // ─── Step 1: ephemeral 拒绝 ───
        // 一次性 run（定时任务等 ephemeral）的 ALS 中 conversationId === undefined，
        // task_list 无 conversation 绑定可落 —— 拒绝调用且不改 state，避免污染
        // 其他 conversation 的 cache（PR-C1 审查 Bug-1）。
        const conversationId = getConversationId();
        if (!conversationId) {
          return {
            content:
              "task_list is unavailable in this run: no conversation context bound. " +
              "This tool only works in persistent conversations — not in one-shot runs " +
              "(ephemeral) or scheduled task executions.",
            isError: true,
          };
        }

        // ─── Step 2: 输入校验 + normalize ───
        const validated = validateAndNormalize(input);
        if (!validated.ok) {
          return { content: validated.error, isError: true };
        }

        // ─── Step 3: 原子 set ───
        try {
          const updated = await service.set(conversationId, validated.items);
          return { content: renderSummary(updated) };
        } catch (err) {
          return {
            content:
              `Failed to persist task list: ${err instanceof Error ? err.message : String(err)}. ` +
              `Previous state preserved.`,
            isError: true,
          };
        }
      },
    };
  }
}

// ─── 工具描述 ───

const TASK_LIST_TOOL_DESCRIPTION =
  "Maintain a structured task list to plan and track multi-step work in this conversation.\n\n" +
  "Use this when the user gives you a non-trivial task that requires multiple steps, " +
  "or when you want to communicate a plan to the user.\n\n" +
  "Single action `set(items)`: replaces the entire task list with the provided items. " +
  "Each item has: content (description), status (pending | in_progress | completed), " +
  "and an optional stable id (for tracking the same task across set() calls).\n\n" +
  "Guidelines:\n" +
  "- Keep AT MOST ONE task in_progress at a time — finish or pause before starting the next.\n" +
  "- Each set() REPLACES the full list. To keep a task, include it again with its existing id.\n" +
  "- Use 'completed' to mark finished tasks; do not delete them within the same segment.\n" +
  "- Skip the tool for trivial single-step tasks — it's overhead for the user.\n" +
  "- This tool requires a persistent conversation context. It is unavailable in one-shot runs " +
  "(ephemeral) and scheduled task executions; calls in those contexts will fail with an error.";

// ─── 输入校验 + normalize ───

type TaskItemInput = {
  id?: string;
  content: string;
  status: TaskItem["status"];
};

const VALID_STATUSES: ReadonlySet<TaskItem["status"]> = new Set([
  "pending",
  "in_progress",
  "completed",
]);

type ValidationResult =
  | { ok: true; items: TaskItem[] }
  | { ok: false; error: string };

function validateAndNormalize(input: Record<string, unknown>): ValidationResult {
  const rawItems = input.items;
  if (!Array.isArray(rawItems)) {
    return { ok: false, error: "Invalid input: 'items' must be an array." };
  }

  const normalized: TaskItem[] = [];
  for (let i = 0; i < rawItems.length; i++) {
    const raw = rawItems[i] as TaskItemInput | undefined;
    if (!raw || typeof raw !== "object") {
      return {
        ok: false,
        error: `Invalid input: items[${i}] must be an object.`,
      };
    }
    if (typeof raw.content !== "string" || raw.content.trim() === "") {
      return {
        ok: false,
        error: `Invalid input: items[${i}].content must be a non-empty string.`,
      };
    }
    if (!VALID_STATUSES.has(raw.status)) {
      return {
        ok: false,
        error: `Invalid input: items[${i}].status must be one of "pending" | "in_progress" | "completed".`,
      };
    }
    normalized.push({
      id: typeof raw.id === "string" && raw.id !== "" ? raw.id : randomUUID(),
      content: raw.content,
      status: raw.status,
    });
  }

  return { ok: true, items: normalized };
}

// ─── 工具结果渲染 ───

function renderSummary(state: TaskListState): string {
  if (state.items.length === 0) {
    return "Task list cleared (0 items).";
  }
  const counts = countByStatus(state.items);
  const lines = state.items.map((t, i) => {
    const mark =
      t.status === "completed"
        ? "[x]"
        : t.status === "in_progress"
          ? "[~]"
          : "[ ]";
    return `${i + 1}. ${mark} ${t.content}`;
  });
  return [
    `Task list updated (${state.items.length} items: ${counts.pending} pending, ${counts.inProgress} in progress, ${counts.completed} completed):`,
    ...lines,
  ].join("\n");
}

function countByStatus(items: readonly TaskItem[]): {
  pending: number;
  inProgress: number;
  completed: number;
} {
  let pending = 0;
  let inProgress = 0;
  let completed = 0;
  for (const t of items) {
    if (t.status === "pending") pending++;
    else if (t.status === "in_progress") inProgress++;
    else if (t.status === "completed") completed++;
  }
  return { pending, inProgress, completed };
}
