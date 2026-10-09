import { createTerminalOwnedProcessFactory } from './host-launch.js';
import { TerminalClipboardWriter } from './clipboard-write.js';

type Create = ReturnType<typeof createTerminalOwnedProcessFactory>;
const CLIPBOARD_TIMEOUT_MS = 1500;
const commandList = (platform: NodeJS.Platform): readonly [string, string[]][] => platform === 'win32'
  ? [['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::Out.Write((Get-Clipboard -Raw))']]]
  : platform === 'darwin' ? [['pbpaste', []]]
  : [['wl-paste', ['--no-newline']], ['xclip', ['-selection', 'clipboard', '-out']], ['xsel', ['--clipboard', '--output']]];

/** Invoked only by an explicit paste gesture. Native helpers remain owned by S;
 * original text streams into the existing input store, never into a UI reply. */
export class TerminalClipboard {
  #busy = false;
  #writer?: TerminalClipboardWriter;
  constructor(readonly signal: AbortSignal, readonly create: Create = createTerminalOwnedProcessFactory('clipboard'), readonly platform = process.platform) {}
  write(text: string) { return (this.#writer ??= new TerminalClipboardWriter(this.signal, this.create, this.platform)).write(text); }
  async close(): Promise<void> { await this.#writer?.close(); }
  async read(write: (text: string) => Promise<void>, limit = 16 * 1024 * 1024): Promise<boolean> {
    this.signal.throwIfAborted();
    if (this.#busy) throw Error('terminal-clipboard-busy');
    this.#busy = true;
    const deadline = Date.now() + CLIPBOARD_TIMEOUT_MS;
    try {
      for (const [executable, args] of commandList(this.platform)) {
        this.signal.throwIfAborted();
        if (Date.now() >= deadline) throw Error('terminal-clipboard-timeout');
        let bytes = 0, failure: unknown, fatalFailure = false, timer: ReturnType<typeof setTimeout> | undefined;
        const env = { ...process.env };
        for (const key of ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key];
        const owner = this.create(executable, args, { env, signal: this.signal, deadline });
        const stop = (error: unknown, fatal = true) => { failure ??= error; fatalFailure ||= fatal; owner.child.kill('SIGTERM'); };
        const creationFailure = (error: unknown) => stop(error, false);
        const abort = () => stop(this.signal.reason ?? Error('terminal-clipboard-aborted'));
        this.signal.addEventListener('abort', abort, { once: true });
        if (this.signal.aborted) abort();
        owner.child.once('error', creationFailure);
        owner.child.stderr.on('data', (chunk: Buffer) => chunk.fill(0));
        const read = (async () => {
          const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
          for await (const chunk of owner.child.stdout) {
            if (failure) { chunk.fill(0); continue; }
            try {
              bytes += chunk.length;
              if (bytes > limit) throw Error('terminal-clipboard-size');
              for (let offset = 0; offset < chunk.length; offset += 8192) {
                const text = decoder.decode(chunk.subarray(offset, offset + 8192), { stream: true });
                if (text) await write(text);
              }
            } catch (error) { stop(error); }
            finally { chunk.fill(0); }
          }
          if (!failure) { const tail = decoder.decode(); if (tail) await write(tail); }
        })().catch(stop);
        // Creation and fallback share the original command budget; cancellation
        // still waits for the owner's real close receipt before returning.
        timer = setTimeout(() => stop(Error('terminal-clipboard-timeout')), Math.max(0, deadline - Date.now()));
        try {
          try { await owner.ready; owner.child.stdin.end(); } catch (error) { creationFailure(error); }
          const result = await owner.closed; // Unknown completion does not permit fallback.
          await read;
          this.signal.throwIfAborted();
          if (fatalFailure) throw failure;
          if (result.code === 0) { if (failure) throw failure; return bytes > 0; }
          // A partially delivered command cannot be combined with another reader.
          if (bytes) throw Error('terminal-clipboard-incomplete');
        } finally { clearTimeout(timer); this.signal.removeEventListener('abort', abort); }
      }
      throw Error('terminal-clipboard-unavailable');
    } finally { this.#busy = false; }
  }
}
