import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { TerminalChannel, TerminalChannelRetiredError } from '../../../../terminal-ui/src/channel.js';

// Exercise the production reply owner and transport across the close/ACK race.
const source = ts.createSourceFile('application.ts', readFileSync(new URL('../application.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const owner = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'TerminalApplication')!;
const method = owner.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(source) === '#reply')!;
const Fixture = new Function('TerminalChannelRetiredError', 'recordTerminalFailure', ts.transpile(
  'class Fixture { requests = new Set([1]); logging = {records: []}; '+method.getText(source).replace(/#/gu, '')+' } return Fixture;',
  {target: ts.ScriptTarget.ES2022},
))(TerminalChannelRetiredError, (records: any[], error: unknown, reason: string) => records.push({error, reason}));
const settle = async () => { for (let i=0; i<8; i++) await Promise.resolve(); };
function fixture() {
  const target = new Fixture(), packets: any[] = [];
  target.channel = new TerminalChannel('reply-test', (packet, done) => { packets.push(packet); done(); }, () => {}, vi.fn());
  target.close = vi.fn(async () => { target.closing = Promise.resolve(); target.channel.beginClose(); });
  return {target, packets};
}
describe('application replies during terminal retirement', () => {
  it('does not send an accepted exit response after closing starts', async () => {
    const {target, packets} = fixture(); await target.close(); target.close.mockClear();
    target.reply(1, 'control', Promise.resolve({accepted:true}), 'interrupt'); await settle();
    expect(packets).toHaveLength(0); expect(target.requests.size).toBe(0);
    expect(target.logging.records).toEqual([]); expect(target.close).not.toHaveBeenCalled();
    target.channel.close();
  });
  it('retires a sent response awaiting ACK without reporting a failure', async () => {
    const {target, packets} = fixture(); target.reply(1, 'control', Promise.resolve({accepted:true}), 'selection'); await settle();
    expect(packets).toHaveLength(1); await target.close(); target.close.mockClear(); await settle();
    expect(target.logging.records).toEqual([]); expect(target.close).not.toHaveBeenCalled(); target.channel.close();
  });
  it('keeps a late real domain failure recorded without sending to a retired surface', async () => {
    const {target, packets} = fixture(), result = Promise.withResolvers();
    target.reply(1, 'control', result.promise, 'selection'); await target.close(); target.close.mockClear();
    const error = Error('domain-write-failed'); result.reject(error); await settle();
    expect(target.logging.records).toEqual([{error,reason:'terminal-request-failed'}]);
    expect(packets).toHaveLength(0); expect(target.close).not.toHaveBeenCalled(); target.channel.close();
  });
  it.each([false,true])('retains actual send failures when closing=%s', async closing => {
    const {target} = fixture(), delivery = Promise.withResolvers<void>(), error = Error('EPIPE');
    target.channel = {send: () => delivery.promise, beginClose: () => {}};
    target.reply(1, 'control', Promise.resolve({accepted:true}), 'selection'); await settle();
    if (closing) await target.close(); target.close.mockClear(); delivery.reject(error); await settle();
    expect(target.logging.records).toEqual([{error,reason:'application-reply-undelivered'}]);
    expect(target.close).toHaveBeenCalledWith(70,'application-reply-undelivered');
  });
});
