import type { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/** Composition port: the embedding process owns creation and actual exit.
 * MCP retains protocol/environment policy and never imports a CLI lifecycle. */
export type McpStdioProcessFactory = (command: string, args: readonly string[], env: NodeJS.ProcessEnv, signal?: AbortSignal) => {
  readonly child: EventEmitter & { readonly stdin: Writable; readonly stdout: Readable; readonly stderr: Readable; kill(signal?: NodeJS.Signals): unknown };
  readonly ready: Promise<void>;
  readonly closed: Promise<unknown>;
};

export class OwnedMcpStdioTransport implements Transport {
  onclose?: Transport['onclose'];
  onerror?: Transport['onerror'];
  onmessage?: Transport['onmessage'];
  readonly #buffer = new ReadBuffer();
  #owner?: ReturnType<McpStdioProcessFactory>;
  #closing?: Promise<void>;
  #ended = false;
  constructor(private readonly create: () => ReturnType<McpStdioProcessFactory>) {}
  async start(): Promise<void> {
    if (this.#owner || this.#closing || this.#ended) throw Error('MCP transport already started or closed');
    const owner = this.#owner = this.create();
    owner.child.on('error', error => this.onerror?.(error));
    owner.child.stdin.on('error', error => this.onerror?.(error));
    owner.child.stdout.on('error', error => this.onerror?.(error));
    owner.child.stderr.resume();
    owner.child.stdout.on('data', (chunk: Buffer) => {
      if (this.#ended || this.#closing) return;
      this.#buffer.append(chunk);
      for (;;) {
        try { const message = this.#buffer.readMessage(); if (!message) break; this.onmessage?.(message); }
        catch (error) { this.onerror?.(error as Error); }
      }
    });
    void owner.closed.then(() => {
      this.#ended = true; this.#buffer.clear(); this.onclose?.();
    }, error => { this.#ended = true; this.#buffer.clear(); this.onerror?.(error); });
    await owner.ready;
  }
  send(message: JSONRPCMessage): Promise<void> {
    if (!this.#owner || this.#ended || this.#closing) return Promise.reject(Error('MCP transport is closed'));
    return new Promise((resolve, reject) => {
      this.#owner!.child.stdin.write(serializeMessage(message), error => error ? reject(error) : resolve());
    });
  }
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    // Match SDK's two-second stdin grace and two-second TERM escalation,
    // but retain the actual owner receipt after KILL instead of returning early.
    this.#closing = Promise.resolve().then(async () => {
      const owner = this.#owner;
      if (!owner) { this.#ended = true; this.onclose?.(); return; }
      if (!this.#ended) owner.child.stdin.end();
      const term = setTimeout(() => owner.child.kill('SIGTERM'), 2000);
      const kill = setTimeout(() => owner.child.kill('SIGKILL'), 4000);
      try { await owner.closed; } finally { clearTimeout(term); clearTimeout(kill); this.#buffer.clear(); }
    });
    return this.#closing;
  }
}
