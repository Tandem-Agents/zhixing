import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { ConversationController } from '../../runtime/conversation-controller.js';
import { makeFakeHostLink } from '../../runtime/__tests__/fake-host-link.js';
import { RpcClientClosedError } from '@zhixing/server';
import { PendingInputReceiptError, RpcConversationFacade } from '../../runtime/rpc-conversation-facade.js';
import { boundedControlProjection } from '../../runtime/control-projection.js';

// Run the production page methods with controlled transport/controller results.
const source = ts.createSourceFile('application.ts', readFileSync(new URL('../application.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const owner = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'TerminalApplication')!;
const methods = ['#resolveRubric', '#loadPendingRubric', '#holdRubricResolution', '#rubricLoop'].map(name => owner.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(source) === name)!.getText(source).replace(/#/gu, '')).join('\n');
const Fixture = new Function('PendingInputReceiptError', 'boundedControlProjection', 'chooseTerminalSelection', 'createAdvancementContractSelectionRequest', 'primaryNearbyCandidate', ts.transpile('class Fixture {' + methods + '} return Fixture;', {target: ts.ScriptTarget.ES2022}))(PendingInputReceiptError, boundedControlProjection, async (_request:any, choose:any)=>choose({}), (draft:unknown)=>draft, ()=>({id:'candidate'}));
const identity = { kind: 'awaiting-rubric-confirmation', conversationId: 'conv-1', turnId: 'turn-1', advancementSessionId: 'adv-1', rubricDraftId: 'draft-old' };
function fixture(result: unknown) {
  const target = new Fixture(), events: string[] = [];
  target.deferredRubric = {...identity}; target.mainView = {connected: true}; target.abort = new AbortController(); target.conversationEpoch = 1;
  target.controller = {current: {conversationId:'conv-1'}, reconcileRubricSubmission: vi.fn(async () => {events.push('reconcile'); return result;})};
  target.conversation = {hasPendingAdvancement: () => true, consumeResume: vi.fn(async (_id: string, consume: (value: unknown) => unknown) => {
    events.push('read-current'); return consume({advancement: {status:'awaiting-rubric-confirmation', advancementSessionId:'adv-1', pendingRubricDraft: {draftId:'draft-new', originalTurnId:'turn-1'}}});
  })};
  target.publish = vi.fn(async () => {}); target.followTurn = vi.fn();
  target.selectionFlow = async (run: () => Promise<void>) => run();
  target.rubricLoop = async (current: () => void) => {events.push('open'); await target.loadPendingRubric(current);};
  return {target, events};
}

describe('rubric page original-submission reconciliation', () => {
  it('settles the saved revision before reading current detail, never restores the old draft', async () => {
    const {target,events} = fixture({...identity,rubricDraftId:'draft-new'});
    await target.resolveRubric();
    expect(events).toEqual(['reconcile','open','read-current']);
    expect(target.pendingRubric.rubricDraftId).toBe('draft-new');
    expect(target.pendingRubric.rubricDraft.draftId).toBe('draft-new');
  });
  it('keeps a reachable retry and the original identity while the receipt is unknown', async () => {
    const {target} = fixture(undefined);
    target.controller.reconcileRubricSubmission.mockRejectedValue(new PendingInputReceiptError());
    await target.resolveRubric();
    expect(target.deferredRubric).toEqual(identity);
    expect(target.mainView.choices).toEqual([{id:'rubric-resume',label:'核对上次操作'}]);
    expect(target.conversation.consumeResume).not.toHaveBeenCalled();
    expect(target.followTurn).not.toHaveBeenCalled();
  });
  it('follows the original accepted turn and clears the obsolete confirmation page', async () => {
    const turn = {conversationId:'conv-1',turnId:'turn-1',outcome:Promise.resolve({})};
    const {target} = fixture({kind:'accepted',turn}); await target.resolveRubric();
    expect(target.followTurn).toHaveBeenCalledWith(turn); expect(target.deferredRubric).toBeUndefined();
    expect(target.conversation.consumeResume).not.toHaveBeenCalled();
  });
  it('does not publish an old reconciliation into a different conversation generation', async () => {
    const {target} = fixture({kind:'cancelled'}), gate = Promise.withResolvers<unknown>();
    target.controller.reconcileRubricSubmission.mockReturnValue(gate.promise);
    const running = target.resolveRubric(); target.conversationEpoch++;
    gate.resolve({kind:'cancelled'});
    await expect(running).rejects.toThrow('对话或连接已变化');
    expect(target.publish).not.toHaveBeenCalled(); expect(target.followTurn).not.toHaveBeenCalled();
    expect(target.pendingRubricResolution.result).toEqual({kind:'cancelled'});
    target.conversation.hasPendingAdvancement = () => false;
    await target.resolveRubric();
    expect(target.controller.reconcileRubricSubmission).toHaveBeenCalledOnce();
    expect(target.mainView.message).toBe('已取消这次任务。');
    expect(target.pendingRubricResolution).toBeUndefined();
  });
});


it('retains a real accepted receipt and cancellation across reconnect before page handoff', async () => {
  const {target} = fixture(undefined), transport = makeFakeHostLink(), facade = new RpcConversationFacade(transport.link);
  const controller = new ConversationController({conversation:facade,workscene:{} as never,onYield:()=>{}}, {conversationId:'conv-1',name:'test',mode:{kind:'main'}});
  target.conversation = facade; target.controller = controller;
  let ready=false, submission='', mutations=0;
  transport.setResponder(async (method, raw:any) => {
    if(method==='session.advancementConfirm'){mutations++;submission=raw.submissionId;throw new RpcClientClosedError();}
    if(method==='session.inputReceipt'){
      if(!ready)throw new RpcClientClosedError();
      target.conversationEpoch++;
      return {status:'settled',conversationId:'conv-1',turnId:submission,result:{conversationId:'conv-1',sessionId:'conv-1',turnId:'turn-1',runId:'original-run'}};
    }
    return {};
  });
  try {
    await expect(controller.confirmRubricContract({...identity,rubricDraft:{}} as never)).rejects.toBeInstanceOf(PendingInputReceiptError);
    const cancellation=controller.abort();ready=true;
    await expect(target.resolveRubric()).rejects.toThrow('对话或连接已变化');
    await cancellation;
    expect(facade.hasPendingAdvancement('conv-1')).toBe(false);
    const retained=target.pendingRubricResolution.result.turn;
    expect(target.followTurn).not.toHaveBeenCalled();
    await target.resolveRubric();
    expect(target.followTurn).toHaveBeenCalledOnce(); expect(target.followTurn).toHaveBeenCalledWith(retained);
    expect(target.pendingRubricResolution).toBeUndefined();expect(mutations).toBe(1);
    expect(transport.requests.filter(item=>item.method==='session.abort')).toHaveLength(1);
  } finally { controller.dispose(); }
});

it.each(['confirm', 'save-new', 'direct', 'cancel', 'edit'])('keeps a recovery action after %s loses its receipt', async action => {
  const {target} = fixture(undefined);
  delete target.rubricLoop;
  target.pendingRubric = {...identity,rubricDraft:{}}; target.deferredRubric = undefined;
  const mutation = vi.fn(async () => {throw new PendingInputReceiptError();});
  target.controller.confirmRubricContract = mutation;
  target.controller.cancelRubricContract = mutation;
  target.conversation.consumeReviseAdvancement = mutation;
  target.choosePage = async () => ({kind:'selected',value:action,input:'revised goal'});
  await target.rubricLoop(() => {});
  expect(mutation).toHaveBeenCalledOnce();
  expect(target.mainView.choices).toEqual([{id:'rubric-resume',label:'核对上次操作'}]);
  expect(target.pendingRubric ?? target.deferredRubric).toMatchObject(identity);
  expect(target.followTurn).not.toHaveBeenCalled();
});

it('keeps cancellation reachable when the authoritative draft cannot be displayed', async () => {
  const {target} = fixture(undefined);
  delete target.rubricLoop;
  target.conversation.consumeResume.mockRejectedValue(Error('body unavailable'));
  target.choose = async () => 'cancel';
  target.controller.cancelRubricContract = vi.fn(async () => {throw new PendingInputReceiptError();});
  await target.rubricLoop(() => {});
  expect(target.controller.cancelRubricContract).toHaveBeenCalledOnce();
  expect(target.mainView.choices).toEqual([{id:'rubric-resume',label:'核对上次操作'}]);
  expect(target.deferredRubric).toEqual(identity);
});

it.each([false,true])('hands off a saved revision across an epoch change (receipt recovery: %s)', async recovery => {
  const {target} = fixture(undefined), transport = makeFakeHostLink(), facade = new RpcConversationFacade(transport.link);
  const controller = new ConversationController({conversation:facade,workscene:{} as never,onYield:()=>{}}, {conversationId:'conv-1',name:'test',mode:{kind:'main'}});
  delete target.rubricLoop;
  target.conversation = facade; target.controller = controller;
  target.pendingRubric = {...identity,rubricDraft:{}}; target.deferredRubric = undefined;
  target.choosePage = async () => ({kind:'selected',value:'edit',input:'revision'});
  const revised = {...identity,rubricDraftId:'draft-new',rubricDraft:{draftId:'draft-new',originalTurnId:'turn-1'}};
  let mutations=0,queries=0;
  transport.setResponder(async (method, raw:any) => {
    if(method==='session.advancementRevise'){
      mutations++; target.conversationEpoch++;
      if(recovery)throw new RpcClientClosedError();
      return revised;
    }
    if(method==='session.inputReceipt'){queries++;return {status:'settled',conversationId:'conv-1',turnId:raw.turnId,result:{...revised,status:'awaiting-rubric-confirmation'}};}
    return {};
  });
  const epoch=target.conversationEpoch;
  try {
    await expect(target.rubricLoop(()=>{if(target.conversationEpoch!==epoch)throw Error('epoch changed');})).rejects.toThrow('epoch changed');
    expect(target.pendingRubricResolution.result).toMatchObject({...identity,rubricDraftId:'draft-new'});
    expect(target.pendingRubricResolution.result).not.toHaveProperty('rubricDraft');
    // Consume the retained identity first; the page must reload authoritative D1.
    target.rubricLoop = vi.fn(async () => {});
    await target.resolveRubric();
    expect(target.deferredRubric.rubricDraftId).toBe('draft-new');
    expect(target.pendingRubric).toBeUndefined();
    expect(mutations).toBe(1);expect(queries).toBe(recovery?1:0);
    expect(facade.hasPendingAdvancement('conv-1')).toBe(false);
  } finally {controller.dispose();}
});
