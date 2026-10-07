import type { ConversationController } from '../runtime/conversation-controller.js';
import type { RpcManagementFacade } from '../runtime/rpc-management-facade.js';
import type { CliWriter } from '../screen/cli-writer.js';
import { handleSecurityCommand, handleTrustCommand } from '../security/commands.js';
import { renderAdvancementDetailLines } from '../advancement-presentation.js';
import { stripAnsi } from '../tui/ansi.js';
import { boundedControlProjection } from '../runtime/control-projection.js';
import { chooseTerminalSelection, type TerminalSelectionPort } from './selection.js';

export type TerminalDecisionController = Pick<ConversationController<string>, 'advancementDetail' | 'uncertainRuns' | 'resolveUncertain'> & {
  readonly current: { readonly conversationId: string };
};
export interface TerminalDecisionScope {
  readonly controller: TerminalDecisionController;
  readonly conversationId: string;
  readonly signal: AbortSignal;
  /** Required after every await and immediately before a rubric mutation. */
  assertCurrent(): void;
}
export interface TerminalDecisionResult {
  readonly title: string;
  readonly message: string;
  readonly error?: boolean;
}
export interface TerminalDecisionOptions {
  /** Return undefined while disconnected; invalidate on every context/connection generation change. */
  readonly controller: () => TerminalDecisionController | undefined;
  readonly management: Pick<RpcManagementFacade, 'trustList' | 'trustRevoke' | 'securityStatus'>;
  readonly signal: AbortSignal;
  readonly choose: TerminalSelectionPort;
  readonly publish: (result: TerminalDecisionResult) => Promise<void>;
  /** The existing rubric loop remains the owner of drafts, acceptance and T01–T06. */
  readonly resumeRubric: (scope: TerminalDecisionScope) => Promise<void>;
}
export const TERMINAL_DECISION_COMMANDS = ['trust', 'security', 'advancement', 'resolve'] as const;
const RESULT_BYTES = 256 * 1024;
class ExpiredDecision extends Error { constructor() { super('页面或对话已变化，请重新打开后操作。'); } }

/** Lazily loaded Node adapter. It owns one decision operation, never a business
 * rule, confirmation broker, current conversation, renderer or stdin listener. */
export class TerminalDecisionCommands {
  #generation = 0;
  #running = false;
  #abort?: AbortController;
  constructor(readonly options: TerminalDecisionOptions) {}

  invalidate(): void { ++this.#generation; this.#abort?.abort(new ExpiredDecision()); }

  async run(name: string, argument = ''): Promise<void> {
    if (!TERMINAL_DECISION_COMMANDS.some(command => command === name)) throw Error('未知决策命令。');
    if (typeof argument !== 'string' || Buffer.byteLength(argument) > 8192) throw Error('命令参数过长。');
    if (this.#running) throw Error('另一个决策页面尚未结束。');
    const controller = this.options.controller();
    if (!controller || this.options.signal.aborted) throw Error('连接不可用，请重新连接后操作。');
    const generation = ++this.#generation, conversationId = controller.current.conversationId;
    const abort = new AbortController(); this.#abort = abort; this.#running = true;
    const scope: TerminalDecisionScope = {
      controller, conversationId, signal: AbortSignal.any([this.options.signal, abort.signal]),
      assertCurrent: () => {
        if (generation !== this.#generation || scope.signal.aborted || this.options.controller() !== controller ||
            controller.current.conversationId !== conversationId) throw new ExpiredDecision();
      },
    };
    const choose: TerminalSelectionPort = async page => {
      scope.assertCurrent();
      const response = await this.options.choose(page);
      scope.assertCurrent(); return response;
    };
    try {
      if (name === 'security' || name === 'trust') {
        const collected = collectText(scope);
        if (name === 'security') await handleSecurityCommand(argument, {
          writer: collected.writer,
          status: async () => {
            scope.assertCurrent();
            const result = await this.options.management.securityStatus(conversationId);
            scope.assertCurrent(); return boundedControlProjection(result, 1024 * 1024);
          },
        });
        else await handleTrustCommand(argument, {
          writer: collected.writer,
          listRules: async () => {
            scope.assertCurrent();
            const result = await this.options.management.trustList(conversationId);
            scope.assertCurrent(); return boundedControlProjection(result, 1024 * 1024);
          },
          revokeRule: async id => {
            // A typed revoke also checks current authority membership; candidate
            // revocation additionally uses TerminalTrustCandidates' retained row.
            scope.assertCurrent();
            const rules = await this.options.management.trustList(conversationId);
            scope.assertCurrent(); boundedControlProjection(rules, 1024 * 1024);
            if (!rules.some(rule => rule.id === id)) return false;
            scope.assertCurrent();
            const revoked = await this.options.management.trustRevoke(id, conversationId);
            scope.assertCurrent(); return revoked;
          },
        });
        await chooseTerminalSelection({ title: name === 'trust' ? '信任规则' : '安全状态',
          body: collected.lines, options: [{ value: 'done', label: '返回输入' }] }, choose);
        return;
      }
      if (name === 'advancement') {
        const detail = await controller.advancementDetail();
        scope.assertCurrent(); boundedControlProjection(detail, RESULT_BYTES);
        if (detail.conversationId !== conversationId) throw Error('推进详情的对话身份不一致，请重新读取。');
        const lines = renderAdvancementDetailLines(detail, RESULT_BYTES).map(plainText);
        boundedControlProjection(lines, RESULT_BYTES);
        const pending = detail.detail?.status === 'awaiting-rubric-confirmation';
        const selected = await chooseTerminalSelection({
          title: '任务推进', body: lines,
          options: [...(pending ? [{ value: 'resume', label: '继续确认任务', description: '查看、修改、确认、直接执行或取消原任务' }] : []),
            { value: 'done', label: '返回输入' }],
        }, choose);
        if (selected?.value === 'resume') {
          scope.assertCurrent(); await this.options.resumeRubric(scope); scope.assertCurrent();
        }
        return;
      }
      const pending = await controller.uncertainRuns();
      scope.assertCurrent(); boundedControlProjection(pending, 1024 * 1024);
      if (!pending.length) {
        await this.options.publish({ title: '处理待确认结果', message: '当前对话没有结果待确认的运行。' }); return;
      }
      for (const notice of pending) {
        scope.assertCurrent();
        if (notice.ref.conversationId !== conversationId) throw Error('待确认运行的对话身份不一致，请重新读取。');
        const selected = await chooseTerminalSelection({
          id: `resolve:${notice.ref.runId}`, title: '处理结果待确认的运行',
          body: [`时间：${new Date(notice.at).toLocaleString()}`, '这次运行的最终结果尚未确认，文件修改等操作可能已经发生。',
            '结束运行不会撤销已有操作；重新执行可能产生重复效果。'],
          options: [
            { value: 'return', label: '暂不处理', tone: 'muted' },
            { value: 'user-abandoned', label: '结束这次运行', description: '保留已有操作，不再执行本轮', tone: 'primary' },
            { value: 'user-verified-side-effects', label: '我已检查已有操作，结束本轮', description: '记录已核实的裁决，不重做操作' },
            { value: 'user-retry-acknowledged', label: '接受重复风险，重新执行', description: '仅在确认可以重复操作后选择', tone: 'danger' },
          ], initialValue: 'return', submitLabel: '确认', cancelLabel: '返回',
        }, choose);
        if (!selected || selected.value === 'return') return;
        scope.assertCurrent();
        await controller.resolveUncertain(notice, selected.value);
        scope.assertCurrent();
        await this.options.publish({ title: '处理待确认结果', message: selected.value === 'user-retry-acknowledged'
          ? '已提交重新执行。' : '本次运行已结束，可以继续对话。' });
      }
    } catch (error) {
      // A completed old request cannot display into, or act in, a successor page.
      try { scope.assertCurrent(); } catch { return; }
      await this.options.publish({ title: '操作暂未完成', error: true,
        message: `${plainText(error instanceof Error ? error.message : String(error)).slice(0, 1024)}\n请刷新核对当前状态；不会自动重试或撤销已经提交的操作。` });
    } finally {
      abort.abort(); if (this.#abort === abort) this.#abort = undefined; this.#running = false;
    }
  }
}

function plainText(text: string): string {
  return stripAnsi(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, ' ');
}
function collectText(scope: TerminalDecisionScope): { writer: CliWriter; lines: string[] } {
  const lines: string[] = []; let bytes = 0;
  const line = (value: string) => {
    scope.assertCurrent();
    if (Buffer.byteLength(value) > RESULT_BYTES - bytes) throw Error('结果超过当前展示容量，请缩小请求后重试。');
    const text = plainText(value); bytes += Buffer.byteLength(text) + 64;
    if (bytes > RESULT_BYTES) throw Error('结果超过当前展示容量，请缩小请求后重试。');
    lines.push(text);
  };
  return { lines, writer: { line, notify: line, appendInline: line, ensureSegmentBreak() {} } };
}
