import { describe, expect, it } from 'vitest';
import { conversationVisit, historyVisit, operatedVisit, type ReadingVisit } from './reading-visit.js';

describe('进入提醒的访问边界', () => {
  const fresh: ReadingVisit = { operated: false };

  it('启动壳没有 ID 时已提前输入，绑定第一个真实 ID 后仍算同一次访问', () => {
    const typed = operatedVisit(fresh, fresh);
    expect(typed.operated).toBe(true);
    expect(conversationVisit(typed, 'a')).toEqual({ id: 'a', operated: true });
  });

  it('没有 ID 的视图不改变访问；同一会话的重发、换代、重新选中都是同一次访问', () => {
    const visit: ReadingVisit = { id: 'a', operated: true };
    expect(conversationVisit(visit, undefined)).toBe(visit);
    expect(conversationVisit(visit, 'a')).toBe(visit);
  });

  it('A→B→A：换成另一个会话开始新访问，回到 A 也是新访问', () => {
    const a: ReadingVisit = { id: 'a', operated: true };
    const b = conversationVisit(a, 'b');
    expect(b).toEqual({ id: 'b', operated: false });
    expect(conversationVisit(operatedVisit(b, b), 'a')).toEqual({ id: 'a', operated: false });
  });

  it('F2 历史页：进入或换选会话开始新访问，页内重发不变', () => {
    const before: ReadingVisit = { id: 'x', operated: true };
    expect(historyVisit(before, 'x', true)).toEqual({ id: 'x', operated: false });
    const inside: ReadingVisit = { id: 'x', operated: true };
    expect(historyVisit(inside, 'x', false)).toBe(inside);
    expect(historyVisit(inside, undefined, false)).toBe(inside);
    expect(historyVisit(inside, 'y', false)).toEqual({ id: 'y', operated: false });
  });

  it('迟到的输入只作用于发生时的那次访问，不消耗之后的新访问', () => {
    const a: ReadingVisit = { id: 'a', operated: false };
    const b: ReadingVisit = { id: 'b', operated: false };
    expect(operatedVisit(b, a)).toBe(b);
    expect(operatedVisit(a, a)).toEqual({ id: 'a', operated: true });
  });
});
