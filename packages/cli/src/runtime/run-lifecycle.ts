/**
 * 当前对话里各运行的权威生命周期与当前执行尝试身份（有界，只供表面投影）。
 *
 * 生命周期只取权威事实：状态事实（状态通知与恢复页的状态事实）与 final 帧；回执只证明耐久接纳，过程帧一律不改变生命周期。
 * 两类证据各有计数域：状态事实按每个运行自己的 statusRevision 去重；final 帧的 commitRevision 属于会话提交侧，
 * 只说明该运行已提交，不与 statusRevision 比较。已确认的终态不会被晚到的状态事实或回执复活；uncertain 不是终态。
 */
import type { ConversationStatusNotice } from '@zhixing-ai/core/contracts';

export type RunLifecycleState = 'unknown' | 'queued' | 'dispatched' | 'running' | 'cancel-requested' | 'uncertain' | 'terminal';

export interface RunLifecycle {
  readonly conversationId: string;
  readonly runId: string;
  readonly state: RunLifecycleState;
  /** 状态事实计数域；只有回执或 final 帧时为 0 */
  readonly statusRevision: number;
  /** 当前执行尝试（派发）身份：只在 dispatched、running、cancel-requested 且由权威状态带来时存在 */
  readonly assignmentId?: string;
  /** 本接入面接纳的输入（回执给出） */
  readonly local: boolean;
  readonly turnId?: string;
  /** 进入跟踪的先后，用于在多条输入中选主体 */
  readonly order: number;
}

/**
 * 过程帧的准入：
 * - accept：属于已确证的当前尝试；
 * - drop：已确证当前尝试，而帧来自别的尝试；
 * - restart：帧属于已确证的新尝试，而已有过程条目来自旧尝试，旧条目作废后按新尝试重新开始；
 * - unconfirmed：尚未确证当前尝试，沿用原有来源校验，展示由表面按生命周期决定。
 */
export type ProcessAdmission = 'accept' | 'drop' | 'restart' | 'unconfirmed';

const ATTEMPT_STATES: ReadonlySet<RunLifecycleState> = new Set(['dispatched', 'running', 'cancel-requested']);
const LIMIT = 64;
const IDENTITY_LIMIT = 1024;

function carriedAttempt(notice: ConversationStatusNotice): string | undefined {
  const value = (notice as { assignmentId?: unknown }).assignmentId;
  return typeof value === 'string' && value.length > 0 && value.length <= IDENTITY_LIMIT ? value : undefined;
}

function lifecycleState(notice: ConversationStatusNotice): RunLifecycleState {
  switch (notice.state) {
    // 待确认关闭按实际结果：重新排队开始新一次尝试，其余都是终态
    case 'uncertain-closed': return notice.resultingState === 'queued' ? 'queued' : 'terminal';
    case 'cancelled': case 'failed': case 'expired': return 'terminal';
    default: return notice.state;
  }
}

export class RunLifecycleTracker {
  readonly #runs = new Map<string, RunLifecycle>();
  /** 每个运行最近一次确证的执行尝试，跨排队与待确认保留：再次确证到不同尝试时即为新尝试 */
  readonly #lastAttempt = new Map<string, string>();
  #order = 0;

  get(runId: string): RunLifecycle | undefined { return this.#runs.get(runId); }

  snapshot(conversationId: string): readonly RunLifecycle[] {
    return [...this.#runs.values()].filter((run) => run.conversationId === conversationId);
  }

  clear(): void { this.#runs.clear(); this.#lastAttempt.clear(); }

  /**
   * 本接入面的接纳归属：没有任何状态事实时记为“未知”；不覆盖已有状态，也不复活终态。
   * order 是本接入面的接纳先后（取自本地跟随记录），切换回来重建时用它恢复原有顺序。返回是否有变化。
   */
  receipt(conversationId: string, runId: string, turnId: string, order?: number): boolean {
    const current = this.#runs.get(runId);
    if (current && (current.conversationId !== conversationId ||
      current.local && current.turnId === turnId && (order === undefined || current.order === order))) return false;
    this.#put({ ...(current ?? { conversationId, runId, state: 'unknown' as const, statusRevision: 0 }), local: true, turnId,
      order: order ?? current?.order ?? ++this.#order });
    if (order !== undefined && order > this.#order) this.#order = order;
    return true;
  }

  /**
   * 状态事实：只接受同一运行更高的 statusRevision。返回是否有变化、当前尝试身份是否随之改变，
   * 以及是否确证到了与此前不同的新尝试（旧尝试的展示须作废）。
   */
  status(notice: ConversationStatusNotice): { readonly changed: boolean; readonly attemptChanged: boolean; readonly newAttempt: boolean } {
    const { conversationId, runId } = notice.ref;
    const current = this.#runs.get(runId);
    if (current && (current.conversationId !== conversationId || current.state === 'terminal' || notice.statusRevision <= current.statusRevision)) {
      return { changed: false, attemptChanged: false, newAttempt: false };
    }
    const state = lifecycleState(notice);
    // 取消中仍是同一次尝试：状态没带身份时沿用此前确证的；进入排队、待确认或终态时旧身份作废
    const assignmentId = !ATTEMPT_STATES.has(state) ? undefined
      : carriedAttempt(notice) ?? (state === 'cancel-requested' ? current?.assignmentId : undefined);
    this.#put({
      conversationId, runId, state, statusRevision: notice.statusRevision,
      ...(assignmentId ? { assignmentId } : {}),
      local: current?.local ?? false, ...(current?.turnId ? { turnId: current.turnId } : {}),
      order: current?.order ?? ++this.#order,
    });
    const previous = this.#lastAttempt.get(runId);
    if (assignmentId) this.#lastAttempt.set(runId, assignmentId);
    return { changed: true, attemptChanged: assignmentId !== current?.assignmentId,
      newAttempt: !!assignmentId && previous !== undefined && previous !== assignmentId };
  }

  /** final 帧：该运行的提交终态，不论两类计数的数字大小。返回是否有变化。 */
  final(conversationId: string, runId: string): boolean {
    const current = this.#runs.get(runId);
    if (current && (current.conversationId !== conversationId || current.state === 'terminal')) return false;
    this.#put({
      conversationId, runId, state: 'terminal', statusRevision: current?.statusRevision ?? 0,
      local: current?.local ?? false, ...(current?.turnId ? { turnId: current.turnId } : {}),
      order: current?.order ?? ++this.#order,
    });
    return true;
  }

  /** 过程帧准入；frameAssignmentId 是帧的来源派发，entryAssignmentId 是已有过程条目的来源派发 */
  admitProcess(runId: string, frameAssignmentId: string | undefined, entryAssignmentId: string | undefined): ProcessAdmission {
    const attempt = this.#runs.get(runId)?.assignmentId;
    if (!attempt) return 'unconfirmed';
    if (frameAssignmentId !== attempt) return 'drop';
    return entryAssignmentId !== undefined && entryAssignmentId !== attempt ? 'restart' : 'accept';
  }

  #put(run: RunLifecycle): void {
    this.#runs.delete(run.runId);
    this.#runs.set(run.runId, run);
    if (this.#runs.size <= LIMIT) return;
    // 有界：先逐出已结束的，再逐出最早进入的
    const evict = [...this.#runs.values()].find((item) => item.state === 'terminal') ?? this.#runs.values().next().value!;
    this.#runs.delete(evict.runId); this.#lastAttempt.delete(evict.runId);
  }
}
