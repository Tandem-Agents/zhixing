import { isProtocolIdentifier } from '@zhixing/core/protocol';
import type { SchedulerFacadeEvent } from '@zhixing/core/scheduler';
import type { CoreHostNotificationLink } from '../runtime/core-host-connection.js';
import type { RpcSchedulerFacade } from '../runtime/rpc-scheduler-facade.js';
import { PublishResultPresenter } from '../runtime/publish-result-presenter.js';
import { boundedControlProjection } from '../runtime/control-projection.js';
import { stripAnsi } from '../tui/ansi.js';

export interface TerminalTaskNotice {
  readonly kind: 'schedule' | 'publish';
  readonly message: string;
  readonly conversationId?: string;
  readonly taskId?: string;
}
export interface TerminalTaskNoticeDelivery {
  readonly signal: AbortSignal;
  /** The display owner checks this before committing an awaited append. */
  isCurrent(): boolean;
}
export interface TerminalTaskNoticesOptions {
  readonly link: CoreHostNotificationLink;
  readonly scheduler: Pick<RpcSchedulerFacade, 'onEvent'>;
  readonly signal: AbortSignal;
  /** Same controller.isWatching/startup-target policy as the existing surface. */
  readonly watching: (conversationId: string) => boolean;
  readonly emit: (notice: TerminalTaskNotice, delivery: TerminalTaskNoticeDelivery) => Promise<void>;
  /** One finite gap notice per failed/overflowed connection generation. */
  readonly gap: (message: string) => void;
}
interface QueuedNotice { readonly notice: TerminalTaskNotice; readonly generation: number; readonly bytes: number; readonly signal: AbortSignal }
const MAX_QUEUE = 32;
const MAX_BYTES = 128 * 1024;

/** Passive notification adaptation, never a scheduler, current-conversation
 * owner or renderer. All writes use one bounded queue and the caller's sink. */
export class TerminalTaskNotices {
  readonly #publish: PublishResultPresenter;
  readonly #unsubscribeScheduler: () => void;
  #publishConversationId?: string;
  #queue: QueuedNotice[] = [];
  #bytes = 0;
  #generation = 0;
  #abort = new AbortController();
  #active = true;
  #disposed = false;
  #failed = false;
  #gapReported = false;
  #draining?: Promise<void>;
  constructor(readonly options: TerminalTaskNoticesOptions) {
    // One presenter survives reconnects so its real conversation/run/seq
    // dedupe survives too. The link owns rebinding to the current client.
    this.#publish = new PublishResultPresenter({
      link: { onNotification: (method, handler) => options.link.onNotification(method, value => {
        if (!this.#accepting()) return;
        if (!value || typeof value !== 'object' || !('scope' in value) || value.scope !== 'control' ||
            !('event' in value) || value.event !== 'publish:result') return;
        if (!this.#room()) { this.#gap(); return; }
        const previous = this.#publishConversationId;
        try {
          boundedControlProjection(value, 256 * 1024);
          this.#publishConversationId = 'conversationId' in value && isProtocolIdentifier(value.conversationId) ? value.conversationId : undefined;
          handler(value);
        } catch { this.#gap(); }
        finally { this.#publishConversationId = previous; }
      }) },
      filter: envelope => this.#accepting() && options.watching(envelope.conversationId),
      writer: { ensureSegmentBreak() {}, line: message => this.#enqueue({ kind: 'publish', message,
        ...(this.#publishConversationId ? { conversationId: this.#publishConversationId } : {}) }) },
    });
    this.#unsubscribeScheduler = options.scheduler.onEvent(event => {
      if (!this.#accepting()) return;
      try {
        boundedControlProjection(event, 64 * 1024);
        const message = schedulerMessage(event);
        if (message) this.#enqueue({ kind: 'schedule', taskId: event.taskId, message });
      } catch { this.#gap(); }
    });
  }

  /** Call synchronously on disconnect or current conversation/host generation
   * changes. Persistent passive subscriptions remain bound by CoreHostLink. */
  invalidate(): void {
    if (this.#disposed) return;
    const pending = this.#queue.length > 0 || !!this.#draining;
    this.#active = false; ++this.#generation; this.#abort.abort(); this.#abort = new AbortController();
    this.#queue = []; this.#bytes = 0;
    if (pending && !this.options.signal.aborted) this.#gap();
  }
  /** Resume before authority recovery can emit the new generation's notices. */
  resume(): void {
    if (this.#disposed || this.options.signal.aborted) return;
    this.#active = true; this.#failed = false; this.#gapReported = false;
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true; this.#active = false; ++this.#generation; this.#abort.abort();
    this.#queue = []; this.#bytes = 0; this.#publish.dispose(); this.#unsubscribeScheduler();
  }
  /** Useful to the existing close/display owner; never starts another producer. */
  drain(): Promise<void> { return this.#draining ?? Promise.resolve(); }

  #accepting(): boolean { return this.#active && !this.#disposed && !this.#failed && !this.options.signal.aborted; }
  #room(): boolean { return this.#queue.length < MAX_QUEUE && this.#bytes + 8192 <= MAX_BYTES; }
  #enqueue(notice: TerminalTaskNotice): void {
    if (!this.#accepting()) return;
    if (!this.#room()) { this.#gap(); return; }
    const message = plain(notice.message), limited = { ...notice, message: message.slice(0, 2048) + (message.length > 2048 ? '…（详细状态请重新查看）' : '') };
    // Non-message identity fields also share the finite slot, never a hidden
    // retained original event or a second durable notification journal.
    boundedControlProjection(limited, 8192);
    const bytes = Buffer.byteLength(JSON.stringify(limited));
    this.#queue.push({ notice: limited, generation: this.#generation, bytes,
      signal: AbortSignal.any([this.options.signal, this.#abort.signal]) });
    this.#bytes += bytes;
    this.#startDrain();
  }
  #startDrain(): void {
    if (this.#draining) return;
    // Install the single drain slot before invoking a potentially reentrant sink.
    this.#draining = Promise.resolve().then(() => this.#flush()).finally(() => {
      this.#draining = undefined;
      if (this.#queue.length && this.#accepting()) this.#startDrain();
    });
  }
  async #flush(): Promise<void> {
    while (this.#queue.length && this.#accepting()) {
      const item = this.#queue.shift()!; this.#bytes -= item.bytes;
      const isCurrent = () => this.#accepting() && item.generation === this.#generation && !item.signal.aborted &&
        (!item.notice.conversationId || this.options.watching(item.notice.conversationId));
      if (!isCurrent()) continue;
      try { await this.options.emit(item.notice, { signal: item.signal, isCurrent }); }
      catch {
        if (!isCurrent()) continue;
        this.#failed = true; this.#queue = []; this.#bytes = 0; this.#gap();
      }
    }
  }
  #gap(): void {
    if (this.#disposed || this.options.signal.aborted || this.#gapReported) return;
    this.#gapReported = true;
    this.options.gap('任务或发布通知的显示可能不完整；请查看 /tasks 和当前会话状态核对。不会自动重发任务或修改。');
  }
}

function schedulerMessage(event: SchedulerFacadeEvent): string | undefined {
  // started/completed lack a run/sequence identity in the existing contract.
  // Do not hash text or dedupe by taskId: a later genuine run can be identical.
  if (event.kind === 'completed' && event.status === 'ok') return `✓ 定时任务完成: ${event.name} (${Math.round(event.durationMs / 1000)}s)${event.summary ? `\n${event.summary.slice(0, 120)}` : ''}`;
  if (event.kind === 'completed') return `✗ 定时任务失败: ${event.name} (连续 ${event.consecutiveErrors} 次)\n${event.error.slice(0, 120)}${event.nextRunAt ? `\n下次重试: ${new Date(event.nextRunAt).toLocaleTimeString()}` : ''}`;
  if (event.kind === 'disabled') return `⊘ 定时任务已自动停用: ${event.name}\n原因: ${event.reason}${event.lastError ? `\n最后错误: ${event.lastError.slice(0, 120)}` : ''}`;
  return;
}
function plain(text: string): string { return stripAnsi(text).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, ' '); }
