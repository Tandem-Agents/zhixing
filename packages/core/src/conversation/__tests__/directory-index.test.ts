import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createTempDir } from '@zhixing/test-utils';
import { ConversationRepository } from '../repository.js';
import { ConversationDirectoryIndex } from '../directory-index.js';
import type { Conversation } from '../types.js';

afterEach(() => vi.restoreAllMocks());
async function fixture(count: number) {
  const home = await createTempDir('directory-index');
  const root = path.join(home, 'conversations'), repo = new ConversationRepository({ kind: 'user' }, home);
  for (let n = 0; n < count; n++) await repo.ensure('c-' + String(n).padStart(4, '0'));
  return { home, root, repo, index: new ConversationDirectoryIndex(root) };
}
it.each([32, 128])('reads a finite page/latest and publishes one mutation with %i real conversations', async count => {
  const h = await fixture(count); await h.index.prepare();
  const open = vi.spyOn(fs, 'opendir');
  const read = vi.spyOn(fs, 'readFile');
  const first = await h.repo.listPage({ limit: 8 });
  expect(first.records).toHaveLength(8);
  expect(read.mock.calls.filter(args => String(args[0]).endsWith('meta.json')).length).toBe(9);
  read.mockClear();
  await h.repo.findLatest();
  expect(read.mock.calls.filter(args => String(args[0]).endsWith('meta.json')).length).toBeLessThanOrEqual(2);
  await h.repo.rename('c-0000', 'NEEDLE');
  await h.repo.touch('c-0000', '2090-01-01T00:00:00.000Z');
  expect((await h.repo.listPage({ limit: 8 })).records[0]?.id).toBe('c-0000');
  expect((await h.repo.listPage({ limit: 8, query: 'needle' })).records.map(item => item.id)).toEqual(['c-0000']);
  await h.repo.archive('c-0000', true);
  expect((await h.repo.listPage({ limit: 8, query: 'needle' })).records).toEqual([]);
  await h.repo.archive('c-0000', false); await h.repo.delete('c-0000');
  expect((await h.repo.listPage({ limit: 8, query: 'needle' })).records).toEqual([]);
  expect(open).not.toHaveBeenCalled();
  const all: string[] = []; let after;
  do { const page = await h.repo.listPage({ limit: 8, after }); all.push(...page.records.map(item => item.id)); after = page.next; } while (after);
  expect(all).toEqual((await h.repo.list()).map(item => item.id));
  expect(new Set(all).size).toBe(count - 1);
}, 30000);

it('repairs durable intent after metadata succeeded but publication was interrupted', async () => {
  const h = await fixture(3); await h.index.prepare();
  const file = path.join(h.root, 'c-0000', 'meta.json');
  const metadata = JSON.parse(await fs.readFile(file, 'utf8')) as Conversation;
  await expect(h.index.mutate(async () => ({ segment: 'c-0000', apply: async () => {
    await fs.writeFile(file, JSON.stringify({ ...metadata, name: 'AFTER-CRASH', lastActiveAt: '2091-01-01T00:00:00.000Z' }));
    throw new Error('synthetic owner interruption after metadata');
  } }))).rejects.toThrow('synthetic owner interruption');
  const cold = new ConversationDirectoryIndex(h.root);
  expect((await cold.page({ limit: 1 })).records[0]).toMatchObject({ id: 'c-0000', name: 'AFTER-CRASH' });
});

it('resumes completed metadata batches after cancellation without rescanning them', async () => {
  const h = await fixture(150), abort = new AbortController(); let reads = 0;
  const reader = async (segment: string) => {
    if (++reads === 70) abort.abort(new Error('cancel-initial-directory'));
    return JSON.parse(await fs.readFile(path.join(h.root, segment, 'meta.json'), 'utf8')) as Conversation;
  };
  await expect(h.index.prepare(reader, abort.signal)).rejects.toThrow('cancel-initial-directory');
  expect(reads).toBe(70);
  reads = 0;
  await new ConversationDirectoryIndex(h.root).prepare(async segment => {
    reads++; return JSON.parse(await fs.readFile(path.join(h.root, segment, 'meta.json'), 'utf8')) as Conversation;
  });
  expect(reads).toBe(86);
  expect(await h.repo.list()).toHaveLength(150);
}, 30000);

it('rebuilds a corrupt disposable database and detects a changed selected metadata digest', async () => {
  const h = await fixture(3); await h.index.prepare();
  const directories = await fs.readdir(path.join(h.home, '.directory-index-v1'));
  const database = path.join(h.home, '.directory-index-v1', directories[0]!, 'catalog.sqlite');
  await fs.writeFile(database, 'synthetic corrupted index');
  expect((await h.index.page({ limit: 8 })).records).toHaveLength(3);
  const first = (await h.index.page({ limit: 1 })).records[0]!;
  await fs.writeFile(path.join(h.root, first.id, 'meta.json'), JSON.stringify({ ...first, name: 'external metadata rename' }));
  expect((await h.index.page({ limit: 1 })).records[0]?.name).toBe('external metadata rename');
});

it('serializes distinct repository instances without losing independent metadata fields', async () => {
  const h = await fixture(1), other = new ConversationRepository({ kind: 'user' }, h.home);
  await Promise.all([h.repo.rename('c-0000', 'concurrent-name'), other.touch('c-0000', '2092-01-01T00:00:00.000Z')]);
  expect(await h.repo.get('c-0000')).toMatchObject({ name: 'concurrent-name', lastActiveAt: '2092-01-01T00:00:00.000Z' });
});

it('recovers corruption in an entries page even when the SQLite header and schema still open', async () => {
  const h = await fixture(32); await h.index.prepare();
  const directories = await fs.readdir(path.join(h.home, '.directory-index-v1'));
  const file = path.join(h.home, '.directory-index-v1', directories[0]!, 'catalog.sqlite');
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
  const database = new DatabaseSync(file, { readOnly: true });
  const page = database.prepare("SELECT rootpage FROM sqlite_master WHERE name='entries'").get()!.rootpage as number;
  const pageSize = database.prepare('PRAGMA page_size').get()!.page_size as number;
  database.close();
  const handle = await fs.open(file, 'r+');
  try { await handle.write(Buffer.alloc(16, 0xff), 0, 16, (page - 1) * pageSize); await handle.sync(); }
  finally { await handle.close(); }
  const result = await new ConversationDirectoryIndex(h.root).page({ limit: 8 });
  expect(result.records).toHaveLength(8);
  expect(await h.repo.list()).toHaveLength(32);
}, 30000);

it('browses source facts when an unfinished cache cannot be written, without writing business metadata', async () => {
  const h = await fixture(3), before = await fs.readFile(path.join(h.root, 'c-0000', 'meta.json'), 'utf8');
  const mkdir = fs.mkdir.bind(fs), write = vi.spyOn(fs, 'writeFile');
  vi.spyOn(fs, 'mkdir').mockImplementation(((directory: string, options: unknown) => {
    if (String(directory).includes('.directory-index-v1')) return Promise.reject(Object.assign(new Error('synthetic readonly cache'), { code: 'EACCES' }));
    return mkdir(directory, options as never);
  }) as typeof fs.mkdir);
  const index = new ConversationDirectoryIndex(h.root);
  expect((await index.page({ limit: 2 })).records).toHaveLength(2);
  expect((await index.page({ limit: 2 })).records).toHaveLength(2);
  expect(await fs.readFile(path.join(h.root, 'c-0000', 'meta.json'), 'utf8')).toBe(before);
  expect(write.mock.calls.some(args => String(args[0]).startsWith(h.root))).toBe(false);
});

async function openCatalog(home: string) {
  const folders = await fs.readdir(path.join(home, '.directory-index-v1'));
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
  return new DatabaseSync(path.join(home, '.directory-index-v1', folders[0]!, 'catalog.sqlite'));
}

it.each(['touch', 'rename', 'archive', 'restore', 'delete'] as const)('overlays the unpublished %s target without taking the writer lock', async operation => {
  const h = await fixture(12);
  if (operation === 'restore') await h.repo.archive('c-0000', true);
  if (operation === 'archive' || operation === 'delete') await h.repo.touch('c-0000', '2090-01-01T00:00:00.000Z');
  await h.index.prepare();
  const file = path.join(h.root, 'c-0000', 'meta.json');
  const before = JSON.parse(await fs.readFile(file, 'utf8')) as Conversation;
  let applied!: () => void, resume!: () => void;
  const ready = new Promise<void>(resolve => { applied = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  const writing = h.index.mutate(async () => ({ segment: 'c-0000', apply: async () => {
    if (operation === 'delete') await fs.unlink(file);
    else {
      const value = { ...before, ...(operation === 'touch' || operation === 'restore' ? { lastActiveAt: '2099-01-01T00:00:00.000Z' } : {}),
        ...(operation === 'rename' ? { name: 'OUTSIDE-PAGE-NEEDLE' } : {}),
        ...(operation === 'archive' || operation === 'restore' ? { archived: operation === 'archive' } : {}) };
      await fs.writeFile(file + '.pending', JSON.stringify(value)); await fs.rename(file + '.pending', file);
    }
    applied(); await gate;
  } }));
  await ready;
  try {
    const page = await new ConversationDirectoryIndex(h.root).page({ limit: 2, ...(operation === 'rename' ? { query: 'outside-page-needle' } : {}) });
    if (operation === 'archive' || operation === 'delete') expect(page.records.map(value => value.id)).not.toContain('c-0000');
    else expect(page.records[0]?.id).toBe('c-0000');
  } finally { resume(); await writing; }
});

it('retries a changed publication while reading, without mixing old rows and new metadata', async () => {
  const h = await fixture(6); await h.index.prepare();
  let changed = false;
  const page = await h.index.page({ limit: 2 }, async segment => {
    if (!changed) { changed = true; await h.repo.touch('c-0000', '2098-01-01T00:00:00.000Z'); }
    return JSON.parse(await fs.readFile(path.join(h.root, segment, 'meta.json'), 'utf8')) as Conversation;
  });
  expect(page.records[0]?.id).toBe('c-0000');
});

it.each([32,128])('reads the published primary after repeated writer updates with %i rows and no writable cache', async count => {
  const h = await fixture(count); await h.index.prepare();
  const mkdir = fs.mkdir.bind(fs), open = vi.spyOn(fs, 'opendir'), read = vi.spyOn(fs, 'readFile');
  for (let n = 0; n < 4; n++) {
    await h.repo.touch('c-0000', `209${n}-01-01T00:00:00.000Z`);
    const deny = vi.spyOn(fs, 'mkdir').mockImplementation(((directory: string, options: unknown) => {
      if (String(directory).includes('.directory-index-v1')) return Promise.reject(Object.assign(new Error('read-only primary'), { code: 'EACCES' }));
      return mkdir(directory, options as never);
    }) as typeof fs.mkdir);
    read.mockClear();
    expect((await new ConversationDirectoryIndex(h.root).page({ limit: 2 })).records[0]?.id).toBe('c-0000');
    expect(read.mock.calls.filter(args => String(args[0]).endsWith('meta.json')).length).toBe(3);
    expect(deny).not.toHaveBeenCalled(); deny.mockRestore();
  }
  expect(open).not.toHaveBeenCalled();
},30000);

it.each(['entries','inventory','pending'] as const)('rejects a malicious %s locator before invoking any reader and rebuilds only derived data', async table => {
  const h = await fixture(4); await h.index.prepare();
  const db = await openCatalog(h.home);
  if (table === 'entries') db.prepare("UPDATE entries SET segment='../foreign',active=99999999999999 WHERE segment='c-0000'").run();
  if (table === 'inventory') { db.exec("UPDATE state SET ready=0,phase='metadata'; DELETE FROM inventory"); db.exec("INSERT INTO inventory VALUES(1,'../foreign',0)"); }
  if (table === 'pending') db.exec("INSERT INTO pending VALUES(1,'../foreign')");
  db.close();
  const seen: string[] = [];
  const page = await h.index.page({ limit: 4 }, async segment => {
    seen.push(segment);
    return JSON.parse(await fs.readFile(path.join(h.root, segment, 'meta.json'), 'utf8')) as Conversation;
  });
  expect(page.records).toHaveLength(4);
  expect(seen).not.toContain('../foreign');
});

it('checks metadata business identity for repository readers and never hides source permission failures', async () => {
  const h = await fixture(3); await h.index.prepare();
  const top = (await h.repo.listPage({ limit: 1 })).records[0]!;
  const file = path.join(h.root,top.id,'meta.json');
  await fs.writeFile(file,JSON.stringify({ ...top,id:'another-conversation' }));
  await expect(h.repo.listPage({ limit: 1 })).rejects.toThrow('identity');
  await fs.writeFile(file,JSON.stringify(top));
  const read = fs.readFile.bind(fs);
  vi.spyOn(fs,'readFile').mockImplementation(((name: string, options: unknown) => String(name) === file
    ? Promise.reject(Object.assign(new Error('source denied'),{ code:'EACCES' })) : read(name,options as never)) as typeof fs.readFile);
  await expect(h.repo.listPage({ limit: 1 })).rejects.toThrow('source denied');
});

it('fails before source mutation when durable intent cannot be recorded', async () => {
  const h = await fixture(1), original = await h.repo.get('c-0000');
  const mkdir = fs.mkdir.bind(fs);
  vi.spyOn(fs,'mkdir').mockImplementation(((directory: string,options:unknown) => String(directory).includes('.directory-index-v1')
    ? Promise.reject(Object.assign(new Error('intent denied'),{code:'EACCES'})) : mkdir(directory,options as never)) as typeof fs.mkdir);
  await expect(h.repo.rename('c-0000','must-not-persist')).rejects.toThrow('cannot be written');
  expect(await h.repo.get('c-0000')).toEqual(original);
});

// 只为保存失败回执而建的会话：导航（分页、最近、列表、降级直读、未发布覆盖）都不列出，精确读取与责任型读取照常；显现单向
const receipt = { createdFor: 'submission-receipt' } as const;
const ids = (records: readonly { id: string }[]) => records.map(item => item.id);
it('keeps a receipt-only conversation out of navigation until it is revealed', async () => {
  const h = await fixture(2);
  await h.repo.ensure('shell', receipt);
  await h.repo.touch('shell', '2095-01-01T00:00:00.000Z');
  await h.index.prepare();
  expect(ids((await h.repo.listPage({ limit: 8 })).records)).not.toContain('shell');
  expect(await h.repo.findLatest()).not.toBe('shell');
  expect(ids(await h.repo.list())).not.toContain('shell');
  expect(ids(await h.repo.list({ includeArchived: true }))).not.toContain('shell');
  expect(ids(await h.repo.list({ includeHidden: true }))).toContain('shell');
  expect((await h.repo.get('shell'))?.createdFor).toBe('submission-receipt');
  // 已存在的会话不因创建用途被改成隐藏；隐藏的会话也不因普通 ensure 显现
  await h.repo.ensure('c-0000', receipt);
  expect(ids((await h.repo.listPage({ limit: 8 })).records)).toContain('c-0000');
  await h.repo.ensure('shell');
  expect(await h.repo.findLatest()).not.toBe('shell');
  await h.repo.reveal('shell');
  expect(await h.repo.findLatest()).toBe('shell');
  // 单向：显现后再按创建用途 ensure 也不会隐藏
  await h.repo.ensure('shell', receipt);
  expect(await h.repo.findLatest()).toBe('shell');
  expect((await h.repo.get('shell'))?.createdFor).toBeUndefined();
});

it('applies the same navigation predicate to an unpublished overlay and to the direct fallback', async () => {
  const h = await fixture(3); await h.index.prepare();
  const file = path.join(h.root, 'c-0000', 'meta.json');
  const before = JSON.parse(await fs.readFile(file, 'utf8')) as Conversation;
  let applied!: () => void, resume!: () => void;
  const ready = new Promise<void>(resolve => { applied = resolve; }), gate = new Promise<void>(resolve => { resume = resolve; });
  const writing = h.index.mutate(async () => ({ segment: 'c-0000', apply: async () => {
    await fs.writeFile(file + '.pending', JSON.stringify({ ...before, ...receipt, lastActiveAt: '2099-01-01T00:00:00.000Z' }));
    await fs.rename(file + '.pending', file);
    applied(); await gate;
  } }));
  await ready;
  try { expect(ids((await new ConversationDirectoryIndex(h.root).page({ limit: 8 })).records)).not.toContain('c-0000'); }
  finally { resume(); await writing; }
  // 缓存不可写时只按本次可读事实直读：同一谓词
  const fresh = await fixture(2);
  await fresh.repo.ensure('shell', receipt);
  const mkdir = fs.mkdir.bind(fs);
  vi.spyOn(fs, 'mkdir').mockImplementation(((directory: string, options: unknown) => String(directory).includes('.directory-index-v1')
    ? Promise.reject(Object.assign(new Error('synthetic readonly cache'), { code: 'EACCES' })) : mkdir(directory, options as never)) as typeof fs.mkdir);
  const direct = await new ConversationDirectoryIndex(fresh.root).page({ limit: 8 });
  expect(ids(direct.records).sort()).toEqual(['c-0000', 'c-0001']);
});

it.each([4, 64])('reads the first page and latest without visiting %i hidden receipt shells', async hidden => {
  const h = await fixture(2);
  for (let n = 0; n < hidden; n++) {
    await h.repo.ensure('shell-' + String(n).padStart(4, '0'), receipt);
    await h.repo.touch('shell-' + String(n).padStart(4, '0'), `2095-01-01T00:00:${String(n % 60).padStart(2, '0')}.000Z`);
  }
  await h.index.prepare();
  const read = vi.spyOn(fs, 'readFile');
  const page = await h.repo.listPage({ limit: 2 });
  expect(ids(page.records).sort()).toEqual(['c-0000', 'c-0001']);
  expect(await h.repo.findLatest()).toMatch(/^c-/u);
  // 隐藏条目在 SQL 里按索引排除：读取的元数据只有返回的可见条目，不随隐藏条目数增长
  expect(read.mock.calls.filter(args => String(args[0]).endsWith('meta.json')).length).toBeLessThanOrEqual(4);
}, 60000);

it('reads a prepared directory of the previous layout by adding the visibility column, without rebuilding', async () => {
  const h = await fixture(1);
  await h.repo.findLatest();
  const directories = await fs.readdir(path.join(h.home, '.directory-index-v1'));
  const file = path.join(h.home, '.directory-index-v1', directories[0]!, 'catalog.sqlite');
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
  const epochOf = () => {
    const db = new DatabaseSync(file);
    try {
      const columns = (db.prepare('PRAGMA table_info(entries)').all() as Array<{ name: string }>).map(column => column.name);
      return { epoch: (db.prepare('SELECT epoch FROM state').get() as { epoch: number }).epoch, hidden: columns.includes('hidden') };
    } finally { db.close(); }
  };
  const before = epochOf().epoch;
  // 前一版布局：没有导航可见性列与对应索引
  const db = new DatabaseSync(file);
  try { db.exec('DROP INDEX visible; ALTER TABLE entries DROP COLUMN hidden'); } finally { db.close(); }
  const fresh = new ConversationRepository({ kind: 'user' }, h.home);
  expect(await fresh.findLatest()).toBe('c-0000');
  expect(epochOf()).toEqual({ epoch: before, hidden: true });
});