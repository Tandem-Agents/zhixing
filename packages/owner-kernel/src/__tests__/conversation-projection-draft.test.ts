import { expect, it } from "vitest";
import { deserialize, serialize } from "node:v8";
import { createConversationProjectionDraft } from "../conversation-projection-draft.js";

it("isolates failed mutations and publishes ordinary serializable collections without copying untouched payloads", () => {
  const retained = { input: "old immutable input ".repeat(5000) };
  const base = {
    revision: 1,
    entries: new Map([['retained', retained], ['active', { input: 'pending' }]]),
    ids: new Set(['retained']),
    facts: [{ id: 'immutable-fact' }],
    current: { nested: { status: 'pending' } },
  };
  const abandoned = createConversationProjectionDraft(base);
  abandoned.state.entries.get('active')!.input = 'uncommitted';
  abandoned.state.ids.add('uncommitted');
  abandoned.state.facts.push({ id: 'uncommitted' });
  abandoned.state.current.nested.status = 'uncommitted';
  expect(base.entries.get('active')!.input).toBe('pending');
  expect(base.ids.has('uncommitted')).toBe(false);
  expect(base.facts).toHaveLength(1);
  expect(base.current.nested.status).toBe('pending');

  const draft = createConversationProjectionDraft(base);
  draft.state.entries.delete('active');
  draft.state.entries.set('new', { input: 'committed' });
  draft.state.ids.add('new');
  draft.state.revision = 2;
  const published = draft.finish();
  expect(published.entries.constructor).toBe(Map);
  expect(published.ids.constructor).toBe(Set);
  expect(published.entries.get('retained')).toBe(retained);
  expect(base.entries.has('new')).toBe(false);
  expect(base.revision).toBe(1);
  expect(deserialize(serialize(published))).toEqual(published);
});

it("isolates values reached through iteration and preserves collection deletion and clearing", () => {
  const base = { entries: new Map([['a', { value: 1 }], ['b', { value: 2 }]]), ids: new Set(['a', 'b']) };
  const draft = createConversationProjectionDraft(base);
  for (const value of draft.state.entries.values()) value.value += 10;
  expect([...base.entries.values()].map(value => value.value)).toEqual([1, 2]);
  expect(draft.state.entries.delete('missing')).toBe(false);
  draft.state.ids.clear();
  expect(base.ids.size).toBe(2);
  const result = draft.finish();
  expect([...result.entries.values()].map(value => value.value)).toEqual([11, 12]);
  expect(result.ids.size).toBe(0);
});
