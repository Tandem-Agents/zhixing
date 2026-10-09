/** The one stdin reader owns both mode discovery and the admitted renderer. */
import { TERMINAL_MODES, admitTerminalModes, type TerminalModeBaseline } from './mode-policy.js';
const modes = TERMINAL_MODES.map(mode => mode.id);
const EARLY_BYTES = 4096;

export class TerminalInputOwner {
  #early = Buffer.alloc(0);
  #queued?: (chunk: Buffer) => void;
  #cancel?: () => void;

  constructor(readonly failure: (reason: string) => void) {}

  query(signal: AbortSignal): Promise<TerminalModeBaseline> {
    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0), received = 0, done = false;
      const values = new Map<number, number>();
      const finish = (error?: Error) => {
        if (done) return;
        done = true; clearTimeout(timer);
        process.stdin.off('data', data);
        signal.removeEventListener('abort', abort);
        this.#cancel = undefined;
        if (error) { this.#early = Buffer.alloc(0); reject(error); return; }
        this.#early = buffer;
        this.#queued = chunk => {
          if (chunk.length > EARLY_BYTES - this.#early.length) { this.cancel(); this.failure('terminal-early-input-capacity'); return; }
          this.#early = Buffer.concat([this.#early, chunk]);
        };
        process.stdin.on('data', this.#queued);
        resolve(admitTerminalModes(values));
      };
      const abort = () => finish(Error('terminal-mode-query-cancelled'));
      const timer = setTimeout(() => finish(Error('terminal-mode-query-timeout')), 800);
      const data = (chunk: Buffer) => {
        if (done) return;
        if (chunk.length > EARLY_BYTES - received) { finish(Error('terminal-mode-query-capacity')); return; }
        received += chunk.length;
        buffer = Buffer.concat([buffer, chunk]);
        let contradictory = false;
        const retained = buffer.toString('latin1').replace(/\x1b\[\?(\d+);(\d+)\$y/g, (reply, key, state) => {
          const id = Number(key), status = Number(state);
          if (!(modes as readonly number[]).includes(id)) return reply;
          if (values.has(id) && values.get(id) !== status) contradictory = true;
          values.set(id, status); return '';
        });
        buffer = Buffer.from(retained, 'latin1');
        if (contradictory) { finish(Error('terminal-mode-query-contradictory')); return; }
        if (!modes.every(mode => values.has(mode))) return;
        try { admitTerminalModes(values); } catch (error) { finish(error as Error); return; }
        finish();
      };
      this.#cancel = abort;
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) { abort(); return; }
      if (!process.stdin.isTTY || !process.stdout.isTTY) { finish(Error('terminal-tty-required')); return; }
      process.stdin.setRawMode(true);
      process.stdin.on('data', data);
      process.stdin.resume();
      process.stdout.write(modes.map(mode => `\x1b[?${mode}$p`).join(''));
    });
  }

  handoff(renderer: { setupInput(): void }): void {
    if (this.#queued) process.stdin.off('data', this.#queued);
    this.#queued = undefined;
    const early = this.#early; this.#early = Buffer.alloc(0);
    renderer.setupInput();
    if (early.length) process.stdin.emit('data', early);
  }

  cancel(): void {
    this.#cancel?.(); this.#cancel = undefined;
    if (this.#queued) process.stdin.off('data', this.#queued);
    this.#queued = undefined; this.#early = Buffer.alloc(0);
  }
}
