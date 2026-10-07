import type { ArgChoice, ArgChoiceProvider, ArgQueryContext, CommandDef, SuggestionItem } from '@zhixing/core/typeahead';
import type { RpcManagementFacade } from '../runtime/rpc-management-facade.js';
import { createTrustRuleArgProvider } from '../security/trust-rule-arg-provider.js';
import { BUILTIN_COMMANDS } from '../commands/builtin-definitions.js';
import { boundedControlProjection } from '../runtime/control-projection.js';
import { stripAnsi } from '../tui/ansi.js';

export interface TerminalTrustController { readonly current: { readonly conversationId: string } }
export interface TerminalTrustCandidateOptions {
  readonly controller: () => TerminalTrustController | undefined;
  readonly management: Pick<RpcManagementFacade, 'trustList' | 'trustRevoke'>;
  readonly signal: AbortSignal;
}
interface Context {
  readonly controller: TerminalTrustController;
  readonly conversationId: string;
  readonly generation: number;
}
interface Listed extends Context { readonly ids: ReadonlySet<string>; readonly signal: AbortSignal }
interface Retained extends Context { readonly revision: number; readonly items: ReadonlyMap<string, string> }
export interface TerminalTrustRevokeResult { readonly revoked: boolean; readonly message: string }

/** Query formatting stays in the existing provider; authority and context
 * selection stay in Trust Administration. Only bounded candidate identities
 * survive a query, and only a retained N-side row can authorize revocation. */
export class TerminalTrustCandidates {
  readonly provider: ArgChoiceProvider;
  readonly command: CommandDef;
  #generation = 0;
  #query = 0;
  #listed?: Listed;
  #retained?: Retained;
  #writing = false;
  constructor(readonly options: TerminalTrustCandidateOptions) {
    const original = createTrustRuleArgProvider(async () => []);
    this.provider = { mode: original.mode, inlineActions: original.inlineActions, emptyHint: original.emptyHint,
      list: (context, signal) => this.#list(context, signal) };
    this.command = { ...BUILTIN_COMMANDS['trust:repl'], args: [{ kind: 'async-enum', name: 'rule',
      description: '已沉淀的信任规则', required: true, provider: this.provider }] };
  }

  invalidate(): void { ++this.#generation; ++this.#query; this.#listed = undefined; this.#retained = undefined; }

  /** Call with the final bounded SuggestionItems kept by TerminalCandidatesOwner. */
  retain(revision: number, items: readonly SuggestionItem[]): void {
    this.#retained = undefined;
    const listed = this.#listed;
    if (!Number.isSafeInteger(revision) || revision < 0 || !listed || listed.signal.aborted) throw Error('信任候选已失效，请刷新。');
    this.#assertCurrent(listed);
    boundedControlProjection(items, 96 * 1024);
    if (items.length > 100) throw Error('信任候选超过当前展示容量。');
    const retained = new Map<string, string>();
    for (const item of items) {
      const metadata = item.acceptPayload.metadata;
      const id = metadata?.argValue;
      if (item.providerId !== 'argument' || metadata?.commandId !== 'trust:repl' || metadata.argName !== 'rule' ||
          typeof id !== 'string' || !listed.ids.has(id) || retained.has(item.id)) throw Error('信任候选身份不匹配。');
      retained.set(item.id, id);
    }
    this.#retained = { controller: listed.controller, conversationId: listed.conversationId,
      generation: listed.generation, revision, items: retained };
  }

  async revoke(revision: number, id: string): Promise<TerminalTrustRevokeResult> {
    const retained = this.#retained, ruleId = retained?.items.get(id);
    if (this.#writing || !retained || retained.revision !== revision || !ruleId) throw Error('信任候选已变化，请刷新后重新选择。');
    this.#assertCurrent(retained);
    this.#writing = true; this.#retained = undefined; this.#listed = undefined; ++this.#query;
    try {
      // No await may substitute a new current conversation for this identity.
      const revoked = await this.options.management.trustRevoke(ruleId, retained.conversationId);
      this.#assertCurrent(retained);
      this.#retained = undefined; this.#listed = undefined;
      return { revoked, message: revoked ? '已撤销信任规则。' : '规则已不存在；请刷新当前列表。' };
    } finally { this.#writing = false; }
  }

  async #list(context: ArgQueryContext, signal: AbortSignal): Promise<readonly ArgChoice[]> {
    const query = ++this.#query; this.#listed = undefined; this.#retained = undefined;
    if (this.#writing) throw Error('正在撤销规则，请稍后刷新。');
    const controller = this.options.controller();
    if (!controller || signal.aborted || this.options.signal.aborted) throw Error('连接不可用，信任规则尚未读取。');
    const scope: Context = { controller, conversationId: controller.current.conversationId, generation: this.#generation };
    let failed = false, failure: unknown;
    const original = createTrustRuleArgProvider(async () => {
      try {
        this.#assertCurrent(scope);
        const rules = await this.options.management.trustList(scope.conversationId);
        this.#assertCurrent(scope); boundedControlProjection(rules, 1024 * 1024);
        return rules;
      } catch (error) { failed = true; failure = error; throw error; }
    });
    // The legacy provider converts failure to []; preserve that failure at this
    // edge so the new root renders an error management panel, never an empty success.
    const choices = await original.list(context, signal);
    this.#assertCurrent(scope);
    if (signal.aborted || query !== this.#query) throw Error('信任候选已失效，请刷新。');
    if (failed) throw failure;
    const retained: ArgChoice[] = []; const ids = new Set<string>(); let bytes = 0;
    for (const originalChoice of choices) {
      const choice = typeof originalChoice === 'string' ? originalChoice : { ...originalChoice,
        label: displayText(originalChoice.label),
        ...(originalChoice.description === undefined ? {} : { description: displayText(originalChoice.description) }) };
      const id = typeof choice === 'string' ? choice : choice.value;
      if (ids.has(id)) throw Error('信任规则标识重复，请刷新核对。');
      const charge = Buffer.byteLength(JSON.stringify(choice)) + 256;
      if (retained.length >= 100 || bytes + charge > 80 * 1024) break;
      retained.push(choice); ids.add(id); bytes += charge;
    }
    if (choices.length > 0 && retained.length === 0) throw Error('信任规则描述超过当前展示容量，请使用 /trust 查看。');
    this.#listed = { ...scope, signal, ids };
    return retained;
  }

  #assertCurrent(context: Context): void {
    if (this.options.signal.aborted || context.generation !== this.#generation || this.options.controller() !== context.controller ||
        context.controller.current.conversationId !== context.conversationId) throw Error('页面或对话已变化，请重新打开信任管理。');
  }
}

function displayText(value: string): string {
  return stripAnsi(value).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, ' ');
}
