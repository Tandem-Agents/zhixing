import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { parseConversationId } from '@zhixing/core/conversation';

// 待确认任务的推进快照按会话作用域读取：场景会话不能经普通对话目录的 session.resume
const source = ts.createSourceFile('application.ts', readFileSync(new URL('../application.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const owner = source.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === 'TerminalApplication')!;
const method = owner.members.find(node => ts.isMethodDeclaration(node) && node.name.getText(source) === '#advancementSnapshot')!;
const Fixture = new Function('parseConversationId', ts.transpile(
  'class Fixture { ' + method.getText(source).replace(/#/gu, '') + ' } return Fixture;',
  { target: ts.ScriptTarget.ES2022 },
))(parseConversationId);

function fixture(entered: { conversationId: string; advancement?: unknown }) {
  const target = new Fixture();
  target.workscene = { enter: vi.fn(async () => entered) };
  target.conversation = { consumeResume: vi.fn(async (_id: string, consume: (result: unknown) => unknown) => consume({ advancement: { advancementSessionId: 'main-session' } })) };
  return target;
}

describe('pending rubric snapshot by conversation scope', () => {
  it('reads a scene conversation through scene entry, never the ordinary directory resume', async () => {
    const snapshot = { advancementSessionId: 'scene-session', status: 'awaiting-rubric-confirmation' };
    const target = fixture({ conversationId: 'ws:scene-1:primary', advancement: snapshot });
    await expect(target.advancementSnapshot('ws:scene-1:primary', (value: unknown) => value)).resolves.toBe(snapshot);
    expect(target.workscene.enter).toHaveBeenCalledWith('scene-1');
    expect(target.conversation.consumeResume).not.toHaveBeenCalled();
  });

  it('refuses a scene entry that now points at another conversation', async () => {
    const target = fixture({ conversationId: 'ws:scene-1:other' });
    await expect(target.advancementSnapshot('ws:scene-1:primary', (value: unknown) => value)).rejects.toThrow('待确认任务状态已变化');
  });

  it('keeps the ordinary conversation on session resume', async () => {
    const target = fixture({ conversationId: 'unused' });
    await expect(target.advancementSnapshot('chat-1', (value: unknown) => value)).resolves.toEqual({ advancementSessionId: 'main-session' });
    expect(target.conversation.consumeResume).toHaveBeenCalledWith('chat-1', expect.any(Function));
    expect(target.workscene.enter).not.toHaveBeenCalled();
  });
});
