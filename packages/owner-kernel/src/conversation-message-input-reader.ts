import { userMessageFromTurnInput } from '@zhixing/core';
import type { ConversationMessageStatus } from '@zhixing/core/conversation/application';
import { awaitAuthorityPreparation, type ArtifactStore, type AuthorityCommitLog } from '@zhixing/core/authority';
import type { ConversationRunState, UserTurnInput } from '@zhixing/core/contracts';
import { validateNonEmptyUserTurnInput } from '@zhixing/core/protocol';
import { currentMaintenanceAbortSignal, isHoldingMaintenanceExclusion, maintenanceRetryDelayMs,
  StorageMaintenanceCancelledError, waitForMaintenanceRetry } from '@zhixing/core/resources';
import { consumedInitialRuns, isMessageDeliveryFact, projectInputDelivery, type MessageDeliveryFacts, type MessageDeliveryRecord } from './conversation-message-delivery.js';
import type { ConversationReadIndex, InputPointer } from './conversation-read-index.js';
import type { ConversationBaseSource } from './conversation-base-source.js';
import { readConversationRunViewMetadata } from './conversation-run-state-view.js';
import { CONVERSATION_RUN_STATE_PROJECTION_ID } from './conversation-run-state-index.js';
import { conversationViewAt } from './conversation-base-registry.js';

/** 历史外输入一次至多返回的条数（uncertain 优先，其余取最近的） */
const OUTSIDE_LIMIT = 200;

type Delivery = ReturnType<typeof projectInputDelivery>;
type Candidate = { readonly key: string; readonly pointer: InputPointer; readonly delivery: Delivery };

/** 内存预载的导入基底（尚未发布为持久基底）的投递事实：记录本身就在内存里，只折叠投递相关的部分 */
export function foldDeliveryFacts(conversationId: string, records: readonly { stream: string; body: unknown }[]) {
  const facts = {
    assignedById: new Map<string, { record: { runId: string } }>(), assignmentByRun: new Map<string, string>(),
    stateByRun: new Map<string, { state: ConversationRunState }>(), cancelOrigins: new Map<string, ConversationRunState>(),
    uncertainOrigins: new Map<string, ConversationRunState>(), supersedeStartedObservations: new Set<string>(),
    committedByAssignment: new Set<string>(), openInputAssignments: new Map<string, string>(),
    closedInputAssignments: new Set<string>(), consumed: new Set<string>(),
  };
  for (const record of records) {
    if (record.stream !== 'run:' + conversationId || !isMessageDeliveryFact(record.body)) continue;
    const body = record.body as MessageDeliveryRecord;
    switch (body.t) {
      case 'assigned': facts.assignedById.set(body.assignmentId, { record: { runId: body.runId } }); facts.assignmentByRun.set(body.runId, body.assignmentId); break;
      case 'cancel-fence': {
        const run = facts.assignedById.get(body.assignmentId)?.record.runId, previous = run && facts.stateByRun.get(run)?.state;
        if (previous) facts.cancelOrigins.set(body.assignmentId, previous);
        break;
      }
      case 'supersede-started-observed': facts.supersedeStartedObservations.add(body.assignmentId); break;
      case 'assignment-superseded': {
        const run = facts.assignedById.get(body.assignmentId)?.record.runId;
        if (run && facts.assignmentByRun.get(run) === body.assignmentId) facts.assignmentByRun.delete(run);
        break;
      }
      case 'state': {
        const previous = facts.stateByRun.get(body.runId)?.state, assignment = facts.assignmentByRun.get(body.runId);
        if (body.state === 'uncertain' && previous && previous !== 'uncertain' && assignment) facts.uncertainOrigins.set(assignment, previous);
        facts.stateByRun.set(body.runId, { state: body.state });
        if (body.state === 'failed' && body.assignmentId !== undefined) facts.assignmentByRun.delete(body.runId);
        break;
      }
      case 'resolution': if (body.fact.resolution && body.fact.subject.execution === 'conversation' &&
          facts.assignmentByRun.get(body.runId) === body.fact.subject.assignmentId) facts.assignmentByRun.delete(body.runId); break;
      case 'committed': facts.committedByAssignment.add(body.assignmentId); break;
      case 'run-input-opened': facts.openInputAssignments.set(body.runId, body.assignmentId); break;
      case 'run-input-closed': facts.openInputAssignments.delete(body.runId); facts.closedInputAssignments.add(body.assignmentId); break;
      case 'run-input-consumed': for (const key of body.ingressKeys) facts.consumed.add(key); break;
    }
  }
  return facts;
}

/**
 * 历史外输入：读目录里按来源分段的候选行直接定位，不折叠会话的全部消息事实。
 * 选取规则与早期实现相同——先取 uncertain 的输入（按位置，超过 200 条取前 200），剩余名额取最近的
 * 其他输入，最后按位置排序；每个候选都先按当前投递状态核对“已提交且已消费”再计入名额。
 * 导入基底与本地两段各自先按可见性过滤（本地 clear、基底遮蔽与基底 clear），再合并、去重。
 */
export class ConversationMessageInputReader {
  #generation = 0;
  #primed: ReturnType<typeof foldDeliveryFacts> | undefined;
  /**
   * deliveryFacts：一批运行的当前投递事实。缺省读运行状态的合并视图；语义差分测试注入同一批记录的折叠结果，
   * 以便与早期的全量折叠实现逐例对照。
   */
  constructor(readonly log: AuthorityCommitLog, readonly directory: ConversationReadIndex,
    readonly artifacts: ArtifactStore, readonly conversationId: string,
    readonly options: { readonly deliveryFacts?: (runs: readonly string[]) => Promise<MessageDeliveryFacts> } = {}) {}

  /** 内存预载的导入基底：候选行由读目录承载，投递状态由这批记录折叠 */
  installBase(records: readonly { stream: string; body: unknown }[]): void {
    this.#primed = foldDeliveryFacts(this.conversationId, records); this.#generation++;
  }
  /** 持久基底：候选行与运行状态都由合并视图承载 */
  installBaseView(_source: ConversationBaseSource): void { this.#primed = undefined; this.#generation++; }

  /** 当前投递状态：只为这一批候选所属的运行读取运行状态 */
  async #deliveries(pointers: readonly InputPointer[], imported: boolean): Promise<readonly Delivery[]> {
    if (!pointers.length) return [];
    if (imported && this.#primed) {
      const primed = this.#primed, consumedRuns = consumedInitialRuns(primed);
      const consumed = await this.directory.consumedInputs(this.conversationId, pointers);
      return pointers.map((pointer, index) => projectInputDelivery(primed, pointer.runId, pointer.initial
        ? consumedRuns.has(pointer.runId) || consumed[index]! : primed.consumed.has(pointer.inputKey) || consumed[index]!));
    }
    const runs = [...new Set(pointers.map(pointer => pointer.runId))];
    const state = this.options.deliveryFacts ? await this.options.deliveryFacts(runs) : (await this.log.transactDurableProjection<never, Awaited<ReturnType<typeof readConversationRunViewMetadata>>['state']>(CONVERSATION_RUN_STATE_PROJECTION_ID,
      async current => ({ kind: 'return', value: (await readConversationRunViewMetadata(await conversationViewAt(this.log, current, this.conversationId), this.conversationId, { current: true, runs })).state }))).value;
    const consumedRuns = consumedInitialRuns(state);
    const consumed = await this.directory.consumedInputs(this.conversationId, pointers);
    return pointers.map((pointer, index) => projectInputDelivery(state, pointer.runId,
      pointer.initial ? consumedRuns.has(pointer.runId) || consumed[index]! : consumed[index]!));
  }

  /**
   * 按键序依次产出一种候选行在两个来源中的有效项（已提交且已消费的、clear 之前的、被遮蔽的都不产出）。
   * 普通段按位置从新到旧，uncertain 段按位置升序。输入键在基底与本地之间唯一（运行状态重放拒绝重复接纳），
   * 同键只取先产出的一份仅是防御。
   */
  async *#candidates(kind: 'outside' | 'outside-uncertain', visibility: Awaited<ReturnType<ConversationReadIndex['outsideVisibility']>>, signal: AbortSignal): AsyncGenerator<Candidate> {
    const descending = kind === 'outside';
    const sources = [false, true].filter(imported => !imported || !visibility.baseHidden).map(imported => ({
      imported, after: undefined as string | undefined, buffer: [] as Candidate[], done: false,
      floor: imported ? visibility.baseClearedLsn : visibility.localClearedLsn,
    }));
    const fill = async (source: typeof sources[number]) => {
      while (!source.buffer.length && !source.done) {
        if (signal.aborted) throw new StorageMaintenanceCancelledError();
        const page = await this.directory.outsidePage(this.conversationId, kind, source.imported, source.after);
        source.after = page.continuation;
        if (!page.continuation) source.done = true;
        const visible = page.entries.filter(entry => entry.pointer.lsn > source.floor);
        // 从新到旧扫到 clear 之前即可停：更早的位置都在 clear 之前
        if (descending && visible.length < page.entries.length) source.done = true;
        const deliveries = await this.#deliveries(visible.map(entry => entry.pointer), source.imported);
        visible.forEach((entry, index) => {
          const delivery = deliveries[index]!;
          if (delivery.state !== 'committed' || !delivery.consumed) source.buffer.push({ key: entry.key, pointer: entry.pointer, delivery });
        });
      }
    };
    const seen = new Set<string>();
    for (;;) {
      for (const source of sources) await fill(source);
      const ready = sources.filter(source => source.buffer.length);
      if (!ready.length) return;
      const next = ready.reduce((best, source) => {
        const a = source.buffer[0]!.pointer.position, b = best.buffer[0]!.pointer.position;
        return (descending ? a > b : a < b) || a === b && !source.imported ? source : best;
      });
      const candidate = next.buffer.shift()!;
      if (seen.has(candidate.pointer.inputKey)) continue;
      seen.add(candidate.pointer.inputKey);
      yield candidate;
    }
  }

  async #read(): Promise<{ inputs: readonly ConversationMessageStatus[]; truncated: boolean;
    interruptibleRuns: readonly { runId: string; state: ConversationRunState }[] }> {
    const signal = currentMaintenanceAbortSignal(); let deadline: number | undefined;
    let changeDeadline: number | undefined;
    for (;;) {
      if (signal.aborted) throw new StorageMaintenanceCancelledError();
      try {
        const result = await (async () => {
          const generation = this.#generation, head = await this.log.checkpoint();
          const visibility = await this.directory.outsideVisibility(this.conversationId);
          if (visibility.deleted) return { inputs: [], truncated: false, interruptibleRuns: [] };
          // uncertain 优先：按位置升序，多取一条判断是否超出名额
          const uncertain: Candidate[] = [];
          for await (const candidate of this.#candidates('outside-uncertain', visibility, signal)) {
            if (candidate.delivery.state !== 'uncertain') continue;
            uncertain.push(candidate);
            if (uncertain.length > OUTSIDE_LIMIT) break;
          }
          const chosen = new Set(uncertain.map(candidate => candidate.pointer.inputKey));
          const remaining = Math.max(0, OUTSIDE_LIMIT - uncertain.length);
          const recent: Candidate[] = [];
          let more = uncertain.length > OUTSIDE_LIMIT;
          if (!more) {
            for await (const candidate of this.#candidates('outside', visibility, signal)) {
              if (chosen.has(candidate.pointer.inputKey) || candidate.delivery.state === 'uncertain') continue;
              if (recent.length === remaining) { more = true; break; }
              recent.push(candidate);
            }
          }
          const selected = [...uncertain.slice(0, OUTSIDE_LIMIT), ...recent]
            .sort((a, b) => a.pointer.position - b.pointer.position);
          const inputs: ConversationMessageStatus[] = [];
          for (let start = 0; start < selected.length; start += 64) {
            if (signal.aborted) throw new StorageMaintenanceCancelledError();
            const batch = selected.slice(start, start + 64);
            const values = await this.directory.inputsAt(this.conversationId, batch.map(value => value.pointer));
            for (const [index, { delivery }] of batch.entries()) {
              const value = values[index];
              if (!value) throw Error('Message input locator is missing');
              const stored = value.input;
              const decoded = typeof stored === 'object' && stored !== null && Object.keys(stored).length === 1 && 'ref' in stored
                ? JSON.parse(Buffer.from(await this.artifacts.get(stored.ref)).toString('utf8')) as UserTurnInput : stored;
              const userInput = validateNonEmptyUserTurnInput(decoded);
              // 只有接纳时带了消息身份的输入才给出 inputIdentity（与按消息 id 查询不同，不用兜底身份）
              inputs.push({ ...delivery, message: { ...userMessageFromTurnInput(userInput), ...(value.identity ? { inputIdentity: structuredClone(value.identity) } : {}) } });
            }
          }
          // 可中断目标：当前可中断的会话来源运行，按首个输入的位置；有已开始的取前两个，否则取排队的前两个
          const controls = [...await this.directory.controlCandidates(this.conversationId)].sort((a, b) => a.lsn - b.lsn);
          const started = controls.filter(control => control.state !== 'queued');
          const interruptibleRuns = (started.length ? started : controls).slice(0, 2).map(({ runId, state }) => ({ runId, state }));
          if (signal.aborted) throw new StorageMaintenanceCancelledError();
          const current = await this.log.checkpoint(head);
          // 另一个会话或资源侧记录可以在读取期间追加；只有本会话新的消息事实才需要重读。
          const changed = current !== head && (await this.directory.messagePage(this.conversationId, head.lsn)).length > 0;
          if (generation !== this.#generation || changed) return;
          return { inputs, truncated: more, interruptibleRuns };
        })();
        if (result) return result;
        changeDeadline ??= performance.now() + 5_000;
        if (performance.now() >= changeDeadline) throw new Error('Message input source did not stabilize before the read deadline');
      } catch (error) {
        const delay = maintenanceRetryDelayMs(error);
        if (delay === undefined || isHoldingMaintenanceExclusion() || signal.aborted) throw error;
        if (await awaitAuthorityPreparation(error)) continue;
        deadline ??= performance.now() + 5000;
        if (performance.now() >= deadline) throw error;
        await waitForMaintenanceRetry(Math.min(delay, 250, Math.max(1, deadline - performance.now())));
      }
    }
  }

  async messageStatus(id: string): Promise<ConversationMessageStatus | undefined> {
    const signal = currentMaintenanceAbortSignal(); let deadline: number | undefined;
    for (;;) {
      if (signal.aborted) throw new StorageMaintenanceCancelledError();
      try {
        const generation = this.#generation, selected = await this.directory.messageMetadata(this.conversationId, id);
        if (!selected.value) return undefined;
        const { pointer, status, consumed, closed } = selected.value;
        const located = (await this.directory.inputsAt(this.conversationId, [pointer]))[0];
        if (!located) throw Error('Message input locator is missing');
        const { input } = located;
        const decoded = input && typeof input === 'object' && 'ref' in input
          ? JSON.parse(Buffer.from(await this.artifacts.get(input.ref)).toString('utf8')) as UserTurnInput : input;
        const userInput = validateNonEmptyUserTurnInput(decoded);
        if (signal.aborted) throw new StorageMaintenanceCancelledError();
        if (generation !== this.#generation) continue;
        return { runId: pointer.runId, state: status.state, consumed,
          disposition: consumed ? 'consumed' : closed || ['committed', 'failed', 'cancelled'].includes(status.state) ? 'stopped' : 'pending',
          message: { ...userMessageFromTurnInput(userInput), inputIdentity: structuredClone(pointer.identity) } };
      } catch (error) {
        const delay = maintenanceRetryDelayMs(error);
        if (delay === undefined || isHoldingMaintenanceExclusion() || signal.aborted) throw error;
        if (await awaitAuthorityPreparation(error)) continue;
        deadline ??= performance.now() + 5000;
        if (performance.now() >= deadline) throw error;
        await waitForMaintenanceRetry(Math.min(delay, 250));
      }
    }
  }
  messageInputsOutsideHistory() { return this.#read(); }
}
