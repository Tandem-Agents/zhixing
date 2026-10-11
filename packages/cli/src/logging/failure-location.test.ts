import { expect, it } from 'vitest';
import { failureSourceFrames } from './failure-location.js';

it('retains only bounded package source positions across wrapped errors', () => {
  const inner = Error('private provider response');
  inner.stack = 'private text\n    at read (file:///C:/private/packages/cli/dist/chunk-A.js:21:4)\n    at /private/credentials.json:3:1';
  const outer = new Error('private outer', { cause: inner });
  outer.stack = 'private outer\n    at file:///C:/private/packages/owner-kernel/dist/state.js:8:9';
  expect(failureSourceFrames(outer)).toEqual(['owner-kernel/state.js:8:9', 'cli/chunk-A.js:21:4']);
  Object.defineProperty(inner, 'stack', { get() { throw Error('hostile getter'); } });
  expect(failureSourceFrames(outer)).toEqual(['owner-kernel/state.js:8:9']);
});
