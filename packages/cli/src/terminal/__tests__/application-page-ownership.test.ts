import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { terminalSelectionActions } from '../selection.js';

// Run the production publisher/selection owner with only its transport replaced.
// In-flight history and IPC delivery are independently controlled at real awaits.
const source = ts.createSourceFile('application.ts', readFileSync(new URL('../application.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const owner = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'TerminalApplication')!;
const methods = ['#publish', '#ownsPage', '#choosePage', '#publishHistoryView'].map(name => {
  const method = owner.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(source) === name);
  if (!method) throw Error(`Missing production method ${name}`);
  return method.getText(source).replace(/#/gu, '');
}).join('\n');
const Fixture = new Function('randomUUID', 'terminalSelectionActions', 'terminalEnvironment', ts.transpile(`class Fixture {
  abort = new AbortController(); generation = 0; mainView = {kind:'conversation',title:'chat'};
  drainConfirmations() {};
  ${methods}
} return Fixture;`, { target: ts.ScriptTarget.ES2022 }))(randomUUID, terminalSelectionActions, () => undefined);
function fixture() {
  const target = new Fixture(), views: any[] = [];
  target.channel = { send: async (message: any) => { views.push(message.view); } };
  return { target, views };
}
describe('foreground terminal page ownership', () => {
  it('retains a WORK input page and its response target when history finishes in the background', async () => {
    const { target, views } = fixture();
    const response = target.choosePage({kind:'selection',title:'WORK',field:{id:'name',label:'名字',value:'',secret:false},choices:[{id:'save',label:'保存'}]});
    await target.publishing;
    const selected = views.at(-1);
    target.history = {hasMore:true};
    await target.publishHistoryView();
    expect(views.at(-1)).toBe(selected);
    expect(target.mainView.historyHasMore).toBe(true);
    const selection = target.selection; target.selection = undefined;
    selection.resolve({itemId:'save',input:'工作'});
    await expect(response).resolves.toEqual({itemId:'save',input:'工作'});
    await target.publish(target.mainView);
    expect(views.at(-1).kind).toBe('conversation');
  });
  it.each(['editor','skills','presentingConfirmation'])('keeps background main updates out of an active %s page', async kind => {
    const { target, views } = fixture(); target[kind] = true;
    await target.publishHistoryView(); expect(views).toHaveLength(0);
    target[kind] = undefined; await target.publishHistoryView();
    expect(views.at(-1).kind).toBe('conversation');
  });
  it('rechecks ownership of an already queued main update before delivering it', async () => {
    const { target, views } = fixture(), delivery = Promise.withResolvers<void>();
    target.channel.send = async (message: any) => { views.push(message.view); await delivery.promise; };
    const pending = target.publish(target.mainView);
    void target.publishHistoryView();
    target.selection = {id:'new-input-page'};
    delivery.resolve(); await pending;
    expect(views).toHaveLength(1);
  });
});
