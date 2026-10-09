import { expect, it } from 'vitest';
import { ConversationDirectoryPageCollector, assertDirectoryPage, type ConversationDirectoryCursor } from '../directory-page.js';
import { ConversationRepository, conversationsDir } from '../repository.js';
import { readConversationDirectoryPage } from '../directory-reader.js';
import { createTempDir } from '@zhixing/test-utils';
import fs from 'node:fs/promises';
import path from 'node:path';

it('shares finite paging between the live repository and the read-only adapter without writing', async () => {
  const home = await createTempDir('directory-page-reader');
  const root = conversationsDir({ kind: 'user' }, home), repo = new ConversationRepository({ kind: 'user' }, home);
  for (const name of ['first', 'second', 'third']) await repo.create({ name });
  const before = await fs.readdir(root, { recursive: true });
  let after: ConversationDirectoryCursor | undefined;
  do {
    const request = { limit: 1, after };
    const page = await readConversationDirectoryPage(root, request);
    expect(page).toEqual(await repo.listPage(request));
    after = page.next;
  } while (after);
  expect(await fs.readdir(root, { recursive: true })).toEqual(before);
  expect(await readConversationDirectoryPage(path.join(home, 'absent'), { limit: 1 })).toEqual({ records: [] });
});

it('uses stable tie-breaking and retains one bounded page while traversing a large directory', () => {
  const source = Array.from({ length: 1200 }, (_, i) => ({ conversationId: `c${String(i).padStart(5, '0')}`, name: `会话 ${i}`, lastActiveAt: new Date(1700000000000 + Math.floor(i / 4)).toISOString() }));
  let after: ConversationDirectoryCursor | undefined;
  let peak = 0;
  const seen = new Set<string>();
  do {
    const page = new ConversationDirectoryPageCollector({ limit: 24, after });
    for (const item of source) { page.add(item); peak = Math.max(peak, page.entries.length); }
    const result = page.result();
    for (const item of result.records) { expect(seen.has(item.conversationId)).toBe(false); seen.add(item.conversationId); }
    after = result.next;
  } while (after);
  expect(seen.size).toBe(source.length);
  expect(peak).toBeLessThanOrEqual(25);
  const search = new ConversationDirectoryPageCollector({ limit: 24, query: '会话 119' });
  for (const item of source) search.add(item);
  expect(search.result().records).toHaveLength(11);
});

it('rejects unbounded and malformed cursors before reading storage', () => {
  for (const request of [{ limit: 0 }, { limit: 101 }, { limit: 10, query: 'x'.repeat(257) }, { limit: 10, after: { lastActiveAt: 'invalid', conversationId: 'x' } }]) {
    expect(() => assertDirectoryPage(request)).toThrow('conversation-directory-page');
  }
});
