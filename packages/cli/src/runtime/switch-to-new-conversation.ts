/**
 * 创建一个新对话并切换为 active —— `/new` handler 与 `/resume` 列表"删当前
 * 对话"两条路径共用的同款流程。封装完整链:create + init transcript + 重置
 * state + prime task_list cache + touch + 视图层 reset + notify。
 *
 * 设计原则:
 *
 *   - **接最小可变接口而非高层 ReplState**:helper 与 REPL 状态机解耦,签名
 *     表达"需要 mutate 哪些字段"语义清晰,可独立单测(同 workscene-conversation
 *     helper 风格)
 *   - **视图层 reset(resetConversationState / clearViewLayerState)纳入流程**:
 *     与 `/clear` handler 的视图层 reset 纪律对齐 —— 切到新对话后保证无老对话
 *     runtime cross-conv state 残留
 *   - **非致命降级 swallow**:视图层 reset 抛错不阻塞主流程(与 /clear handler
 *     的"非致命组件失败不影响对话清空"同款),caller 看不到 partial state
 *   - **touch fire-and-forget**:与 /new handler 原实现纪律一致(磁盘元数据
 *     时间戳更新失败不阻塞)
 */

import type {
  AttentionWindowState,
  Conversation,
  IConversationRepository,
  ITranscriptStore,
  Message,
} from "@zhixing/core";
import { createAttentionWindow } from "@zhixing/core";

/**
 * 切换 active conversation 时需要 mutate 的最小字段集合。helper 直接写这些
 * 字段;caller(repl handler / typeahead callback 等)提供 mutable 引用。
 */
export interface MutableConversationState {
  /** 注意力窗口运行态 —— 换对话即换窗（旧窗整体弃置） */
  window: AttentionWindowState;
  /** 一次性输入前缀（工作场景触发句）—— 换对话即作废 */
  pendingInputPrefix: Message[] | null;
  store: ITranscriptStore;
  convRepo: IConversationRepository;
  conversationId: string | null;
  turnCounter: number;
}

/**
 * session runtime 最小接口 —— helper 仅依赖切换 conversation 必需的几个字段,
 * 不耦合 RuntimeSession 具体类。
 */
export interface SwitchToNewConversationSession {
  readonly runtime: {
    readonly model: string;
    readonly providerId: string;
    resetConversationState(): Promise<void>;
    onAttentionWindowChange(reason: "resume"): Promise<void>;
  };
}

/**
 * task_list service 最小接口 —— 仅 prime 一项。conversation 切换时调用让
 * cache 加载新对话的持久化态(新对话 meta.json 无 taskListState 字段 →
 * 走空 items 路径,与启动 + /new 同款语义)。
 */
export interface TaskListServicePrime {
  prime(conversationId: string): Promise<void>;
}

export interface SwitchToNewConversationOptions {
  /** 新对话名;不传则由 repository 自动命名(chat-YYYYMMDD-XXXX) */
  readonly name?: string;
  /**
   * 切换完成后回调,典型用法 cli UI 层刷新(`taskTail.refresh` /
   * `onConversationChanged` 等)。fire-and-forget,helper 不感知 callback 是否
   * 抛错。
   */
  readonly notify?: () => void;
}

export async function switchToNewConversation(
  conv: MutableConversationState,
  session: SwitchToNewConversationSession,
  taskListService: TaskListServicePrime,
  options: SwitchToNewConversationOptions = {},
): Promise<Conversation> {
  const created = await conv.convRepo.create({
    name: options.name,
    preferredModel: session.runtime.model,
    preferredProvider: session.runtime.providerId,
  });
  await conv.store.init(created.id, {
    model: session.runtime.model,
    provider: session.runtime.providerId,
  });
  conv.conversationId = created.id;
  conv.window = createAttentionWindow({ conversationId: created.id });
  conv.pendingInputPrefix = null;
  conv.turnCounter = 0;
  await taskListService.prime(created.id);
  conv.convRepo.touch(created.id).catch(() => {
    /* 时间戳更新失败不阻塞 */
  });
  try {
    await session.runtime.resetConversationState();
  } catch {
    /* 非致命:视图层组件 reset 失败不阻塞切换;runtime 自身仍可用 */
  }
  // /resume 换对话 = 注意力窗口换代 —— 开新窗触发 onWindowClose(resume)→
  // onWindowOpen(resume),更新实例权威 prompt。失败非致命、不阻塞切换。
  try {
    await session.runtime.onAttentionWindowChange("resume");
  } catch {
    /* 非致命:窗口重建失败不阻塞切换;下个 run 仍可用当前 prompt */
  }
  try {
    await conv.convRepo.clearViewLayerState(created.id);
  } catch {
    /* 非致命:新对话 meta.json 视图层字段本就空,失败也无残留风险 */
  }
  options.notify?.();
  return created;
}
