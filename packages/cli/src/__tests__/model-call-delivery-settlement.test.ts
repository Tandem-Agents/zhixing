import http from 'node:http';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ModelCallResourceMeter } from '@zhixing/core/contracts';
import type { ChatRequest, StreamEvent } from '@zhixing/core/types';
import { meteredProviderCall } from '@zhixing/orchestrator/runtime';
import { DEFAULT_QUIRKS, createOpenAICompatibleProvider, type ResolvedProvider } from '@zhixing/providers';
import { createAnthropicProvider } from '../../../providers/src/adapters/anthropic-messages.js';

// 真实适配器、真实 SDK、计量包装与合成回环：只有整次调用都没送达才按 0 token 结算（Z101）。
const REQUEST: ChatRequest = { model: 'loop-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] };
const OPENAI_SUCCESS = [
  { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'loop-model', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] },
  { id: 'c', object: 'chat.completion.chunk', created: 0, model: 'loop-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } },
].map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
const ANTHROPIC_SUCCESS = [
  ['message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'loop-model', content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 0 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }],
  ['message_stop', { type: 'message_stop' }],
].map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');

interface Seen { path: string; bytes: number; authorization?: string; apiKey?: string }
let closedPort = 0;
const servers: http.Server[] = [];
async function serve(handler: (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen[]) => void): Promise<{ origin: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let bytes = 0;
    req.on('data', chunk => { bytes += chunk.length; });
    req.on('end', () => { seen.push({ path: req.url ?? '', bytes, ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
      ...(typeof req.headers['x-api-key'] === 'string' ? { apiKey: req.headers['x-api-key'] } : {}) }); handler(req, res, seen); });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`, seen };
}

beforeAll(async () => {
  closedPort = await new Promise<number>(resolve => { const probe = net.createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address() as net.AddressInfo; probe.close(() => resolve(port)); }); });
});
afterAll(async () => { await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))); });

const provider = (kind: 'openai' | 'anthropic', origin: string) => {
  const resolved: ResolvedProvider = { id: 'loop', name: 'Loop', baseUrl: kind === 'openai' ? `${origin}/v1` : origin, apiKey: 'sk-loop',
    protocol: kind === 'openai' ? 'openai-compatible' : 'anthropic', quirks: { ...DEFAULT_QUIRKS }, declaredModels: [] } as ResolvedProvider;
  return kind === 'openai' ? createOpenAICompatibleProvider(resolved) : createAnthropicProvider(resolved);
};

async function settle(kind: 'openai' | 'anthropic', origin: string) {
  const consumed: { usageId: string; tokens: number }[] = [];
  const meter: ModelCallResourceMeter = { reserve: async () => ({ usageId: 'usage:1' }), consume: async usage => { consumed.push(usage); } };
  const chat = provider(kind, origin);
  const events: StreamEvent[] = [];
  for await (const event of meteredProviderCall({ call: request => chat.chat(request), meter, nextCallIndex: () => 1, defaultMaxOutputTokens: 64 })(REQUEST)) events.push(event);
  return { consumed, events };
}

describe.each(['openai', 'anthropic'] as const)('%s adapter · 预占结算', kind => {
  const success = kind === 'openai' ? OPENAI_SUCCESS : ANTHROPIC_SUCCESS;
  const stream = (res: http.ServerResponse) => res.writeHead(200, { 'content-type': 'text/event-stream' });

  it('直连拒绝：整次调用没有送达，按 0 token 结算', async () => {
    const { consumed, events } = await settle(kind, `http://127.0.0.1:${closedPort}`);
    expect(events.map(event => event.type)).toEqual(['message_start', 'error']);
    expect(consumed).toEqual([{ usageId: 'usage:1', tokens: 0 }]);
  });

  it('首跳已收到 POST 并回 307、下一跳拒连：不结算（与直连拒连的错误相同也不行）', async () => {
    const first = await serve((_req, res) => { res.writeHead(307, { location: `http://127.0.0.1:${closedPort}/next` }); res.end(); });
    const { consumed, events } = await settle(kind, first.origin);
    expect(first.seen).toHaveLength(1);
    expect(first.seen[0]!.bytes).toBeGreaterThan(0);
    expect(events.at(-1)?.type).toBe('error');
    expect(consumed).toEqual([]);
  });

  it('收到 HTTP 错误状态：不结算', async () => {
    const failing = await serve((_req, res) => { res.writeHead(502, { 'content-type': 'application/json' }); res.end('{"error":{"message":"bad gateway"}}'); });
    const { consumed, events } = await settle(kind, failing.origin);
    expect(events.at(-1)?.type).toBe('error');
    expect(consumed).toEqual([]);
  });

  it('已出内容再断开：不结算', async () => {
    const partial = await serve((_req, res) => { stream(res); res.write(success.split('\n\n').slice(0, kind === 'openai' ? 1 : 3).join('\n\n') + '\n\n'); setTimeout(() => res.destroy(), 20); });
    const { consumed, events } = await settle(kind, partial.origin);
    expect(events.at(-1)?.type).toBe('error');
    expect(consumed).toEqual([]);
  });

  it('正常成功：按实际用量结算一次', async () => {
    const ok = await serve((_req, res) => { stream(res); res.end(success); });
    const { consumed, events } = await settle(kind, ok.origin);
    expect(events.at(-1)?.type).toBe('message_end');
    expect(consumed).toEqual([{ usageId: 'usage:1', tokens: 7 }]);
  });

  it('同源 307 跳转照常可用：带着原方法、正文与凭据到下一跳，按实际用量结算', async () => {
    const hop = await serve((req, res, seen) => {
      if (seen.length === 1) { res.writeHead(307, { location: `/moved${req.url}` }); res.end(); return; }
      stream(res); res.end(success);
    });
    const { consumed } = await settle(kind, hop.origin);
    expect(hop.seen).toHaveLength(2);
    expect(hop.seen[1]!.path.startsWith('/moved')).toBe(true);
    expect(hop.seen[1]!.bytes).toBe(hop.seen[0]!.bytes);
    // 同源跳转保留认证（合成标记）
    expect(hop.seen[1]!.authorization ?? hop.seen[1]!.apiKey).toContain('sk-loop');
    expect(consumed).toEqual([{ usageId: 'usage:1', tokens: 7 }]);
  });

  it('直接跨源 307：新来源拿不到原来源的认证头', async () => {
    const target = await serve((_req, res) => { stream(res); res.end(success); });
    const first = await serve((req, res) => { res.writeHead(307, { location: `${target.origin}${req.url}` }); res.end(); });
    await settle(kind, first.origin);
    expect(first.seen[0]!.authorization ?? first.seen[0]!.apiKey).toContain('sk-loop');
    expect(target.seen).toHaveLength(1);
    expect(target.seen[0]).not.toHaveProperty('authorization');
    expect(target.seen[0]).not.toHaveProperty('apiKey');
  });

  it('先同源跳转、再跨源：每一次来源变化都不带认证头', async () => {
    const target = await serve((_req, res) => { stream(res); res.end(success); });
    const first = await serve((req, res, seen) => {
      if (seen.length === 1) { res.writeHead(307, { location: `/moved${req.url}` }); res.end(); return; }
      res.writeHead(307, { location: `${target.origin}${req.url}` }); res.end();
    });
    await settle(kind, first.origin);
    expect(first.seen).toHaveLength(2);
    expect(first.seen[1]!.authorization ?? first.seen[1]!.apiKey).toContain('sk-loop');
    expect(target.seen).toHaveLength(1);
    expect(target.seen[0]).not.toHaveProperty('authorization');
    expect(target.seen[0]).not.toHaveProperty('apiKey');
  });
});
