import { randomUUID } from 'node:crypto';
import { ConfigurationEditPendingError } from '@zhixing/providers/configuration';
import type { TerminalAction, TerminalChoice, TerminalView } from '@zhixing/terminal-ui/protocol';
import type { ConfigurationEditResult, NodeConfigurationEditSession } from '../runtime/configuration-edit.js';
import type { ConfigModelContext, ConfigEditorRuntime, PanelAction, PanelDescriptor, SectionId, WorkingState } from '../config-editor/types.js';
import { createInitialState, setInputBuffer, isMcpServerEnabled, readMcpServer } from '../config-editor/state.js';
import { buildOptions, collectAllIssues, handleMainPanelKey } from '../config-editor/model/main.js';
import { resolveListMeta, handleListPanelKey } from '../config-editor/model/list.js';
import { resolveEntityMeta, handleEntityPanelKey } from '../config-editor/model/entity.js';
import { resolveInputField, resolveBudgetRange, handleInputPanelKey, handleAddModelPanelKey, handleThinkingBudgetPanelKey } from '../config-editor/model/input.js';
import { describeStatus, findStatus, handleMcpServerPanelKey, handleMcpAddPanelKey, handleMcpAddInputPanelKey, handleMcpChoicesPanelKey } from '../config-editor/model/mcp.js';
import type { KeyEvent } from '../tui/key-event.js';
import { findSupportedChannel, listSupportedChannels } from '../registries/channels.js';
import { textFragments } from './history-segments.js';

type EditIntent = Extract<TerminalAction, { kind: 'configuration-action' | 'secret-value' }>;
type SurfaceView = Omit<TerminalView, 'generation'>;
const PAGE_ITEMS = 24;
const FIELD_BYTES = 8 * 1024;
const MESSAGE_CHARS = 4096;
function boundMessage(value: string): string {
  return value.length > MESSAGE_CHARS ? `${value.slice(0, MESSAGE_CHARS)}…` : value;
}

/** The editor transaction, credentials and asynchronous effects remain in N.
 * U receives one page of labels and a dedicated empty secret field. */
export class TerminalConfigurationEditor {
  readonly #id = randomUUID();
  readonly #context: ConfigModelContext;
  readonly #result: Promise<ConfigurationEditResult>;
  #resolve!: (result: ConfigurationEditResult) => void;
  #reject!: (error: unknown) => void;
  #state: WorkingState;
  #stack: PanelDescriptor[] = [{ kind: 'main' }];
  #revision = 0;
  #page = 0;
  #done = false;
  #saving = false;
  #disposed = false;
  #loading?: AbortController;
  #current?: SurfaceView;
  #error?: string;
  #fieldId?: string;
  #fieldSecret = false;
  #probeBlocked = false;
  #choices = new Set<string>();

  constructor(readonly options: {
    session: NodeConfigurationEditSession;
    title: string;
    sections: SectionId[];
    runtime?: ConfigEditorRuntime;
    headerDetails?: readonly string[];
    publish(view: SurfaceView): Promise<void>;
  }) {
    this.#state = { ...createInitialState(options.session.initialConfig, options.session.initialCredentials),
      channelCatalog: options.session.channelCatalog, channelSetup: options.session.channelSetup, channelStates: options.session.channelStates };
    this.#context = { sections: options.sections, runtime: options.runtime };
    this.#result = new Promise((resolve, reject) => { this.#resolve = resolve; this.#reject = reject; });
  }

  get editId(): string { return `${this.#id}:${this.#revision}`; }
  async run(): Promise<ConfigurationEditResult> { await this.#publish(); return this.#result; }
  cancel(): void {
    if (this.#done || this.#saving) return;
    this.#finish({ kind: 'cancelled' });
  }
  dispose(): void {
    this.#disposed = true;
    this.#loading?.abort();
    // A close does not turn an already submitted durable save into cancellation.
    // Its owner result still settles the operation, with no further UI publish.
    if (!this.#saving) this.#finish({ kind: 'cancelled' });
  }

  async act(intent: EditIntent): Promise<void> {
    if (this.#done || intent.editId !== this.editId) throw Error('配置页面已更新，请在当前页面操作。');
    if (this.#saving) throw Error('正在保存配置，请等待结果。');
    const operation = intent.kind === 'secret-value' ? 'field' : intent.action;
    if (operation === 'cancel') { this.cancel(); return; }
    if (this.#loading) {
      if (operation !== 'back') throw Error('正在处理，可按 Esc 返回。');
      this.#loading.abort(); this.#loading = undefined;
      if (this.#stack.length > 1) this.#stack.pop();
      this.#state = setInputBuffer(this.#state, '');
      await this.#publish(); return;
    }
    if (operation === 'next' || operation === 'previous') {
      if (!this.#choices.has(operation)) throw Error('配置选项已失效。');
      this.#page += operation === 'next' ? 1 : -1;
      await this.#publish(); return;
    }
    const descriptor = this.#stack.at(-1)!;
    if (this.#probeBlocked && operation !== 'back') throw Error('请先查看完整连接目标，再确认验证。');
    this.#error = undefined;
    let key: KeyEvent = { type: 'enter' };
    let index = 0;
    if (operation === 'back') key = { type: 'escape' };
    else if (operation === 'complete') {
      const result = handleMainPanelKey(this.#context, this.#state, { index: 0 }, { type: 'ctrl-s' });
      this.#error = result.errorMessage;
      if (this.#error) this.#stack = [{ kind: 'main' }];
      await this.#apply(result.action); return;
    } else if (operation === 'field') {
      const value = intent.value;
      if (!this.#fieldId || typeof value !== 'string' || Buffer.byteLength(value) > FIELD_BYTES ||
        (intent.kind === 'secret-value') !== this.#fieldSecret ||
        (intent.kind === 'secret-value' && intent.fieldId !== this.#fieldId)) throw Error('当前字段输入无效或过长。');
      this.#state = setInputBuffer(this.#state, value);
    } else {
      if (!this.#choices.has(operation) || !/^select:\d+$/u.test(operation)) throw Error('配置选项已失效。');
      index = Number(operation.slice(7));
    }

    let action: PanelAction;
    switch (descriptor.kind) {
      case 'main': {
        const result = handleMainPanelKey(this.#context, this.#state, { index }, key);
        this.#error = result.errorMessage; action = result.action; break;
      }
      case 'provider-list': case 'model-list': case 'thinking-config':
        action = handleListPanelKey(this.#state, descriptor, { index }, key).action; break;
      case 'provider-config': case 'channel-config': {
        const result = handleEntityPanelKey(this.#state, descriptor, { index }, key);
        this.#error = result.errorMessage; action = result.action; break;
      }
      case 'input': action = handleInputPanelKey(this.#state, descriptor, key); break;
      case 'add-model': action = handleAddModelPanelKey(this.#state, descriptor, key); break;
      case 'thinking-budget': action = handleThinkingBudgetPanelKey(this.#state, descriptor, key); break;
      case 'mcp-server': action = handleMcpServerPanelKey(this.#state, descriptor, { index }, key).action; break;
      case 'mcp-add': action = handleMcpAddPanelKey(this.#context, this.#state, descriptor, key); break;
      case 'mcp-add-input': action = handleMcpAddInputPanelKey(this.#context, this.#state, descriptor, key); break;
      case 'mcp-choices': action = handleMcpChoicesPanelKey(this.#context, this.#state, { ...descriptor, selectedIndex: index }, key); break;
    }
    await this.#apply(action);
  }

  async #apply(action: PanelAction): Promise<void> {
    if (this.#done) return;
    this.#page = 0;
    if (action.type === 'loading') {
      const abort = new AbortController(); this.#loading = abort;
      this.#state = action.state;
      await this.#loadingView(action.message);
      // The action reply acknowledges acceptance; user waiting never consumes
      // an IPC request slot. This generation alone may publish the result.
      void action.run(abort.signal, message => {
        if (this.#loading === abort && !abort.signal.aborted) void this.#loadingView(message).catch(() => this.dispose());
      }).then(async next => {
        if (this.#loading !== abort || abort.signal.aborted || this.#done) return;
        this.#loading = undefined; await this.#apply(next);
      }).catch(async () => {
        if (this.#loading !== abort || abort.signal.aborted || this.#done) return;
        this.#loading = undefined; this.#error = '操作未完成，请重试或返回。'; await this.#publish();
      }).catch(() => this.dispose());
      return;
    }
    if (action.type === 'exit') {
      if (action.result.kind !== 'completed') { this.#finish(action.result); return; }
      this.#saving = true;
      try {
        await this.#loadingView('正在保存配置…');
        await this.options.session.writers.save(action.result);
        this.#finish(action.result);
      } catch (error) {
        this.#saving = false;
        if (error instanceof ConfigurationEditPendingError) {
          this.#done = true; this.#choices.clear(); this.#stack.length = 0;
          this.#state = createInitialState({}, {}); this.#current = undefined;
          this.#reject(error); return;
        }
        if (this.#disposed) { this.#finish({ kind: 'cancelled' }); return; }
        this.#error = '配置未完成保存；请检查运行记录后重试或取消。';
        this.#stack = [{ kind: 'main' }]; await this.#publish();
      }
      return;
    }
    this.#state = action.state;
    if (action.type === 'navigate') {
      if (this.#stack.length >= 12) throw Error('配置导航层级超限。');
      this.#stack.push(action.panel);
    } else if (action.type === 'replace') this.#stack[this.#stack.length - 1] = action.panel;
    else if (action.type === 'pop') {
      if (this.#stack.length > 1) this.#stack.pop(); else { this.cancel(); return; }
    }
    await this.#publish();
  }

  #finish(result: ConfigurationEditResult): void {
    if (this.#done) return;
    this.#done = true; this.#loading?.abort(); this.#loading = undefined;
    this.#choices.clear(); this.#stack.length = 0;
    this.#state = createInitialState({}, {}); this.#current = undefined;
    this.#resolve(result);
  }

  async #loadingView(message: string): Promise<void> {
    this.#revision++;
    this.#fieldId = undefined; this.#choices.clear();
    this.#current = { kind: 'configuration', editId: this.editId, title: this.options.title,
      message: this.#safe(message), busy: true, choices: this.#saving ? [] : [{ id: 'back', label: '取消当前操作并返回' }] };
    await this.options.publish(this.#current);
  }

  async #publish(): Promise<void> {
    if (this.#done || this.#disposed) return;
    this.#revision++;
    const panel = this.#stack.at(-1)!;
    this.#probeBlocked = false;
    const choices: TerminalChoice[] = [];
    let targetPaging = false;
    let title = this.options.title, message = '', chromeDescription = '', field: TerminalView['field'];
    const add = (label: string, detail?: string, danger?: boolean) => choices.push({ id: `select:${choices.length}`, label, detail, danger });
    switch (panel.kind) {
      case 'main': {
        const { sections, options } = buildOptions(this.#context, this.#state);
        const pending = collectAllIssues(sections).length;
        for (const option of options) {
          add(option.kind === 'button' ? option.action === 'complete' ? '完成' : '取消' : option.label,
            option.kind === 'section-entry' ? option.status.text : option.action === 'cancel' ? '退出' : pending ? '请先补全必填项' : '保存并启动');
          const choice = choices[choices.length - 1]!;
          choices[choices.length - 1] = { ...choice,
            ...(option.kind === 'section-entry'
              ? { section: sections.find(item => item.section.id === option.sectionId)?.section.title,
                  sectionDescription: sections.find(item => item.section.id === option.sectionId)?.section.description, status: option.status.level }
              : { section: '操作', presentation: 'button' as const, primary: option.action === 'complete' && pending === 0,
                  shortcut: option.action === 'complete' ? 'Ctrl+S' : 'Esc' }) };
        }
        break;
      }
      case 'provider-list': case 'model-list': case 'thinking-config': {
        const meta = resolveListMeta(this.#state, panel)!;
        title = meta.title; chromeDescription = meta.description;
        for (const item of meta.items) add(`${item.current ? '● ' : ''}${item.label}`, item.description);
        break;
      }
      case 'provider-config': case 'channel-config': {
        const meta = resolveEntityMeta(this.#state, panel)!;
        title = meta.title; chromeDescription = meta.description;
        for (const row of meta.rows) {
          // Probe the pure transition only; never project masked secret tails.
          const target = row.onEnter(this.#state).action;
          const input = target.type === 'navigate' && target.panel.kind === 'input' ? resolveInputField(target.panel.fieldId, this.#state) : undefined;
          add(row.label, input ? (input.currentValue(this.#state) ? '已设置 · 可替换' : '待填写') : row.status.text);
          choices[choices.length - 1] = { ...choices[choices.length - 1]!, status: row.status.level };
        }
        for (const button of meta.buttons) { add(button.label, button.hint); choices[choices.length - 1] = { ...choices[choices.length - 1]!, presentation: 'button', primary: button.primary }; }
        break;
      }
      case 'input': {
        const meta = resolveInputField(panel.fieldId, this.#state);
        if (!meta) throw Error('未知配置字段。');
        title = meta.title; chromeDescription = meta.hint; message = [meta.example, meta.docUrl].filter(Boolean).join('\n');
        field = { id: panel.fieldId, label: meta.title, secret: meta.sensitive, configured: !!meta.currentValue(this.#state),
          ...(!meta.sensitive ? { value: this.#state.inputBuffer || meta.currentValue(this.#state) || '' } : {}) };
        break;
      }
      case 'add-model':
        title = '添加自定义模型'; message = '输入服务商提供的完整 model id。';
        field = { id: 'model', label: 'Model ID', secret: false, value: this.#state.inputBuffer }; break;
      case 'thinking-budget': {
        const range = resolveBudgetRange(panel.providerId, panel.model);
        title = '思考预算'; message = range ? `官方建议区间：${range[0]}–${range[1]} token` : '输入思考 token 预算（整数）。';
        field = { id: 'budget', label: 'Token 预算', secret: false, value: this.#state.inputBuffer }; break;
      }
      case 'mcp-server': {
        const entry = readMcpServer(this.#state, panel.serverId);
        title = `MCP · ${panel.serverId}`;
        message = [entry?.type === 'http' ? `地址：${entry.url}` : `命令：${[entry?.command, ...(entry?.args ?? [])].filter(Boolean).join(' ')}`,
          describeStatus(isMcpServerEnabled(this.#state, panel.serverId), findStatus(panel.serverId, this.options.runtime))].join('\n');
        add(isMcpServerEnabled(this.#state, panel.serverId) ? '停用' : '启用'); add('删除', '完成保存后删除此连接及凭据', true); break;
      }
      case 'mcp-add-input':
        title = '接入 MCP'; message = panel.error ?? '输入预设名、包名、网址、启动命令或描述。';
        field = { id: 'mcp-source', label: '来源', secret: false, value: this.#state.inputBuffer }; break;
      case 'mcp-choices':
        title = '选择 MCP 候选'; message = panel.error ?? '仅从选中的确切来源提取接入信息。';
        for (const choice of panel.choices) add(choice.name, `${choice.summary}\n${choice.reason}`); break;
      case 'mcp-add': {
        title = `接入 · ${panel.label ?? panel.candidate.serverId}`;
        const entry = panel.candidate.entry;
        const target = entry.type === 'http' ? `将连接：${entry.url}` : `将在本机运行：${[entry.command, ...(entry.args ?? [])].filter(Boolean).join(' ')}`;
        // Page the complete target through the same bounded view. Never let
        // an ellipsis authorize the hidden remainder of a command or URL.
        targetPaging = true;
        let targetPart = '', targetPages = 0;
        // Redact before paging: replacement text can be longer than the secret.
        // Reserve space for the page header and instructions under the message cap.
        for (const part of textFragments(this.#safe(target, false), 3 * 1024)) {
          if (targetPages === this.#page) targetPart = part.text;
          targetPages++;
        }
        this.#probeBlocked = this.#page + 1 < targetPages;
        const secret = panel.candidate.secretFields[panel.fieldIndex];
        const instructions = [panel.error ?? panel.description ?? '填写后验证连接，完成后保存。',
          ...(this.#probeBlocked ? ['查看完全部目标后才能验证连接。'] : secret ? [`密钥 ${panel.fieldIndex + 1}/${panel.candidate.secretFields.length}：${secret.label}`, secret.hint,
            secret.docUrl ?? panel.candidate.homepage, secret.example] : ['此连接无需密钥，按 Enter 验证。'])].filter(Boolean).join('\n');
        message = [targetPages > 1 ? `连接目标 · 第 ${this.#page + 1}/${targetPages} 页` : '', targetPart,
          this.#safe(instructions)].filter(Boolean).join('\n');
        if (this.#probeBlocked) choices.push({ id: 'next', label: '继续查看连接目标' });
        else if (secret) field = { id: secret.key, label: secret.label, secret: true, configured: !!panel.inputs[secret.key] };
        else add('验证连接');
        if (this.#page > 0 && !field) choices.push({ id: 'previous', label: '查看上一页目标' });
        break;
      }
    }
    if (!targetPaging) this.#page = Math.min(Math.max(0, this.#page), Math.max(0, Math.ceil(choices.length / PAGE_ITEMS) - 1));
    const visible = targetPaging ? choices : choices.slice(this.#page * PAGE_ITEMS, (this.#page + 1) * PAGE_ITEMS);
    if (!targetPaging && this.#page > 0) visible.unshift({ id: 'previous', label: '上一页' });
    if (!targetPaging && (this.#page + 1) * PAGE_ITEMS < choices.length) visible.push({ id: 'next', label: '下一页' });
    this.#choices = new Set(visible.map(choice => choice.id));
    this.#fieldId = field?.id; this.#fieldSecret = field?.secret ?? false;
    this.#current = { kind: 'configuration', editId: this.editId, title: this.#safe(title), configurationHome: panel.kind === 'main',
      chromeDescription: chromeDescription ? this.#safe(chromeDescription) : undefined,
      chromeDetails: panel.kind === 'main' ? this.options.headerDetails?.map(value => this.#safe(value)) : undefined,
      message: targetPaging ? boundMessage([message, this.#error ? this.#safe(this.#error) : ''].filter(Boolean).join('\n'))
        : this.#safe([message, this.#error].filter(Boolean).join('\n')), field,
      choices: visible.map(choice => ({ ...choice, label: this.#safe(choice.label), detail: choice.detail ? this.#safe(choice.detail) : undefined })) };
    await this.options.publish(this.#current);
  }

  #safe(value: string, bounded = true): string {
    let result = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, '');
    const redact = (object: unknown): void => {
      if (typeof object === 'string' && object.length > 0) result = result.split(object).join('[已设置]');
      else if (object && typeof object === 'object') for (const child of Object.values(object)) redact(child);
    };
    for (const provider of Object.values(this.#state.credentials.providers ?? {})) redact(provider.apiKey);
    for (const [id, credentials] of Object.entries(this.#state.credentials.channels ?? {})) {
      const channel = findSupportedChannel(this.#state.channelCatalog ?? listSupportedChannels(), id,
        this.#state.config.messaging?.[id]?.type ?? this.#state.channelStates?.[id]?.type);
      for (const field of channel?.requiredFields ?? []) if (field.sensitive) redact(credentials[field.id]);
    }
    redact(this.#state.credentials.mcp);
    for (const panel of this.#stack) if (panel.kind === 'mcp-add') redact(panel.inputs);
    return bounded ? boundMessage(result) : result;
  }
}
