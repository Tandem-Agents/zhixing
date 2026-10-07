import type { LogRpcClient } from '@zhixing/rpc';
import type { ConversationController } from '../runtime/conversation-controller.js';
import type { RuntimePrimaryModelDisplayProjection } from '../runtime/runtime-configuration-provider.js';
import { boundedControlProjection } from '../runtime/control-projection.js';
import { configureLogs } from '../logging/configuration.js';
import { chooseTerminalSelection, type TerminalSelectionPort } from './selection.js';
import { INFORMATION_TEXT_BYTES, informationText, informationLines, informationModelLines,
  informationUsageLines, informationContextLines, informationCompactLines } from './information-presentation.js';

export type TerminalInformationController = Pick<ConversationController<string>, 'usage' | 'contextBudget' | 'compact'> & {
  readonly current: { readonly conversationId: string };
};
export interface TerminalInformationScope {
  readonly controller: TerminalInformationController;
  readonly conversationId: string;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  /** Recheck immediately before committing an asynchronously queued display. */
  assertCurrent(): void;
}
export interface TerminalInformationResult {
  readonly title: string;
  readonly message: string;
  readonly error?: boolean;
  readonly busy?: boolean;
}
export interface TerminalInformationOptions {
  /** Undefined while disconnected; invalidate on every connection/context change. */
  readonly controller: () => TerminalInformationController | undefined;
  readonly getPrimaryModel: () => RuntimePrimaryModelDisplayProjection;
  readonly logs: Pick<LogRpcClient, 'status' | 'applyPolicy'>;
  readonly signal: AbortSignal;
  readonly choose: TerminalSelectionPort;
  readonly publish: (result: TerminalInformationResult, scope: TerminalInformationScope) => Promise<void>;
}
export const TERMINAL_INFORMATION_COMMANDS = ['model', 'usage', 'context', 'compact'] as const;
class ExpiredInformation extends Error { constructor() { super('页面或对话已变化，请重新查看。'); } }

/** One lazily loaded command operation. The application still owns selection,
 * draft settlement, configuration edits, connections and the active controller. */
export class TerminalInformationCommands {
  #generation = 0;
  #running = false;
  #disposed = false;
  #abort?: AbortController;
  constructor(readonly options: TerminalInformationOptions) {}
  invalidate(): void { ++this.#generation; this.#abort?.abort(new ExpiredInformation()); }
  dispose(): void { if (this.#disposed) return; this.#disposed = true; this.invalidate(); }

  async run(name: string, argument = ''): Promise<void> {
    if (name !== 'config' && !TERMINAL_INFORMATION_COMMANDS.some(command => command === name)) throw Error('未知信息命令。');
    if (typeof argument !== 'string' || Buffer.byteLength(argument) > 8192) throw Error('命令参数过长。');
    const args = argument.trim();
    if (name === 'config' && args !== 'logs' && !args.startsWith('logs ')) throw Error('用法：/config 或 /config logs');
    if (this.#running) throw Error('另一个信息页面尚未结束。');
    const controller = this.options.controller();
    if (!controller || this.#disposed || this.options.signal.aborted) throw Error('连接不可用，请重新连接后查看。');
    const generation = ++this.#generation, conversationId = controller.current.conversationId;
    const abort = new AbortController(); this.#abort = abort; this.#running = true;
    const scope: TerminalInformationScope = {
      controller, conversationId, signal: AbortSignal.any([this.options.signal, abort.signal]),
      isCurrent: () => !this.#disposed && !scope.signal.aborted && generation === this.#generation &&
        this.options.controller() === controller && controller.current.conversationId === conversationId,
      assertCurrent: () => { if (!scope.isCurrent()) throw new ExpiredInformation(); },
    };
    const choose: TerminalSelectionPort = async page => {
      scope.assertCurrent(); const response = await this.options.choose(page); scope.assertCurrent(); return response;
    };
    const publish = async (result: TerminalInformationResult) => {
      scope.assertCurrent(); await this.options.publish(result, scope); scope.assertCurrent();
    };
    const title = name === 'model' ? '当前模型' : name === 'usage' ? 'Token 用量' : name === 'context' ? '上下文窗口' : name === 'compact' ? '压缩上下文' : '日志策略';
    let mutationReceipt = false;
    try {
      let lines: readonly string[];
      scope.assertCurrent();
      if (name === 'model') lines = informationModelLines(this.options.getPrimaryModel());
      else if (name === 'usage') {
        const view = await controller.usage(); scope.assertCurrent(); lines = informationUsageLines(view);
      } else if (name === 'context') {
        const view = await controller.contextBudget(); scope.assertCurrent(); lines = informationContextLines(view.budget);
      } else if (name === 'compact') {
        await publish({ title, message: '正在压缩上下文…', busy: true });
        // Publishing the progress view can yield: never start a mutation in a successor context.
        scope.assertCurrent(); const result = await controller.compact(); scope.assertCurrent(); mutationReceipt = true;
        lines = informationCompactLines(result);
        await publish({ title, message: lines.join('\n'), busy: false });
      } else {
        const collected: string[] = []; let bytes = 0;
        await configureLogs(args.slice(4), {
          status: async () => {
            scope.assertCurrent(); const value = await this.options.logs.status(); scope.assertCurrent();
            return boundedControlProjection(value, 1024 * 1024);
          },
          applyPolicy: async request => {
            // configureLogs awaits the baseline read before this CAS. No stale baseline may authorize a new submission.
            scope.assertCurrent(); const value = await this.options.logs.applyPolicy(request); scope.assertCurrent(); mutationReceipt = true;
            return boundedControlProjection(value, 1024 * 1024);
          },
        }, { line: value => {
          scope.assertCurrent(); bytes += Buffer.byteLength(value) + 64;
          if (bytes > INFORMATION_TEXT_BYTES) throw Error('日志策略结果超过当前展示容量。');
          collected.push(value);
        } });
        scope.assertCurrent(); lines = informationLines(collected);
      }
      scope.assertCurrent();
      await chooseTerminalSelection({ title, body: lines, options: [{ value: 'done', label: '返回输入' }] }, choose);
    } catch (error) {
      if (!scope.isCurrent()) return;
      const prefix = mutationReceipt ? '操作已有回执，但结果显示未完成' : name === 'usage' ? '用量信息不可用' : name === 'context' ? '上下文信息不可用'
        : name === 'compact' ? '压缩失败' : name === 'model' ? '模型信息不可用' : '日志策略操作未完成';
      try {
        await publish({ title, error: true, busy: false,
          message: `${prefix}：${informationText(error instanceof Error ? error.message : String(error)).slice(0, 1024)}${mutationReceipt ? '\n不会自动重试或回滚，请重新查询核对当前状态。' : ''}` });
      } catch (deliveryError) {
        // Invalidation during the error view is still a stale operation, not a new global failure.
        if (scope.isCurrent()) throw deliveryError;
      }
    } finally {
      abort.abort(); if (this.#abort === abort) this.#abort = undefined; this.#running = false;
    }
  }
}
