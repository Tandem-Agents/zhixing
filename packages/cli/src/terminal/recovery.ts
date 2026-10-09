import { randomUUID } from 'node:crypto';
import { RecoveryInputReceiver, RECOVERY_INPUT_BYTES } from '@zhixing/terminal-ui/recovery-input';
import type { TerminalAction, TerminalMessage, TerminalView } from '@zhixing/terminal-ui/protocol';

const PAGE_UNITS = 8192;
/** One volatile secret page/read-back. Values never enter body/history/log/result sinks. */
export class TerminalRecovery {
  get active(): boolean { return !!this.#current; }
  #current?: { id: string; title: string; value: string; input: boolean; retainResult?: boolean; dismiss?: () => void; receiver?: RecoveryInputReceiver;
    resolve?: (value: string) => void; reject?: (error: Error) => void };
  constructor(readonly ports: {
    signal: AbortSignal;
    publish(view: Omit<TerminalView, 'generation'>): Promise<void>;
    send(message: TerminalMessage): Promise<void>;
  }) { ports.signal.addEventListener('abort', () => this.close(), { once: true }); }

  async show(value: string, title = '请保存恢复码', retainResult = false): Promise<void> {
    this.ports.signal.throwIfAborted();
    if (Buffer.byteLength(value) > RECOVERY_INPUT_BYTES) throw Error('保密显示超过允许长度。');
    this.close(); this.#current = { id: randomUUID(), title, value, input: false, retainResult };
    await this.#publish();
  }
  async read(): Promise<string> {
    this.ports.signal.throwIfAborted();
    const current = this.#current ??= { id: randomUUID(), title: '输入恢复包', value: '', input: false };
    if (current.receiver) throw Error('保密回读正在进行。');
    current.input = true; current.receiver = new RecoveryInputReceiver(current.id);
    const result = new Promise<string>((resolve, reject) => { current.resolve = resolve; current.reject = reject; });
    // Attach a handler before asynchronous transport; cancellation may arrive while publishing.
    void result.catch(() => {});
    try { await this.#publish(); return await result; }
    finally { if (this.#current === current) this.close(); }
  }
  async act(action: Extract<TerminalAction, { kind: 'recovery-part' | 'recovery-page' | 'recovery-cancel' }>): Promise<void> {
    const current = this.#current;
    this.ports.signal.throwIfAborted();
    if (!current || action.requestId !== current.id) throw Error('保密页面已失效。');
    if (action.kind === 'recovery-cancel') { this.close(); return; }
    if (action.kind === 'recovery-page') { await this.#page(action.page); return; }
    if (!current.receiver || !current.input) throw Error('当前没有保密回读请求。');
    try {
      const value = current.receiver.accept(action.requestId, action.index, action.encoded, action.final);
      if (value !== undefined) { current.resolve?.(value); current.resolve = undefined; current.reject = undefined; }
    } catch (error) { this.close(); throw error; }
  }
  close(): void {
    const current = this.#current; this.#current = undefined;
    if (!current) return;
    current.receiver?.close(); current.value = '';
    current.dismiss?.(); current.dismiss = undefined;
    current.reject?.(new Error('保密输入已取消。')); current.resolve = undefined; current.reject = undefined;
  }
  async finishDisplay(): Promise<void> {
    const current = this.#current;
    if (!current?.retainResult || current.input || this.ports.signal.aborted) return;
    const dismissed = new Promise<void>(resolve => { current.dismiss = resolve; });
    await this.ports.publish({ kind: 'recovery', title: '确认码已生成', requestId: current.id,
      message: '请把确认码交给当前主设备完成重置。可选择复制；Esc 关闭并返回终端。',
      recovery: { requestId: current.id, input: false, pages: Math.max(1, Math.ceil(current.value.length / PAGE_UNITS)), settled: true } });
    if (this.#current === current) await this.#page(0);
    await dismissed;
  }
  async #publish(): Promise<void> {
    const current = this.#current; if (!current) return;
    await this.ports.publish({ kind: 'recovery', title: current.title, requestId: current.id,
      message: current.input ? '请保存上方内容，再实际粘贴或输入恢复包回读。Enter 提交；Esc 取消。' : '保密内容仅在当前页面显示。可选择复制，PgUp/PgDn 翻页。',
      recovery: { requestId: current.id, input: current.input, pages: Math.max(1, Math.ceil(current.value.length / PAGE_UNITS)) } });
    if (this.#current === current) await this.#page(0);
  }
  async #page(page: number): Promise<void> {
    const current = this.#current; if (!current) return;
    const pages = Math.max(1, Math.ceil(current.value.length / PAGE_UNITS));
    if (!Number.isSafeInteger(page) || page < 0 || page >= pages) throw Error('保密页面无效。');
    let start = page * PAGE_UNITS, end = Math.min(current.value.length, start + PAGE_UNITS);
    if (start && /[\udc00-\udfff]/u.test(current.value[start]!)) start--;
    if (end < current.value.length && /[\udc00-\udfff]/u.test(current.value[end]!)) end--;
    await this.ports.send({ type: 'recovery-page', requestId: current.id, page, text: current.value.slice(start, end) });
  }
}
