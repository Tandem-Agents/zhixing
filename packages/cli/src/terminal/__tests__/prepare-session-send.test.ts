import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { InputMaterialRegistry } from '../../input-material-registry.js';
import { prepareUserTurnInput } from '../../user-turn-input.js';
import { prepareSessionSendEngage } from '../../session-engage.js';
import { prepareSessionSendSnapshot } from '../prepare-session-send.js';
import { jsonStringBytes, SessionSendJsonWriter, SESSION_SEND_WIRE_BYTES } from '../session-send-encoding.js';
import { readBoundedInputFile } from '../bounded-input-file.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep) || !basename(directory).startsWith('zhixing-send-source-')) throw Error('Invalid fixture cleanup boundary');
    await rm(directory, { recursive: true, force: true });
  }
});
const identity = { turnId: 'test-turn', conversationId: 'test-conversation', surfaceCapabilities: { postTurnControl: true as const }, acceptLimitedCapabilities: true as const };

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'zhixing-send-source-')); directories.push(directory);
  const registry = new InputMaterialRegistry();
  const file = join(directory, 'note.txt'), image = join(directory, 'picture.png');
  await writeFile(file, 'material first\n内容');
  await writeFile(image, Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex'));
  const textId = registry.registerLocalFile({ kind: 'file', filePath: file, name: 'note.txt', mimeType: 'text/plain', byteSize: 22 });
  const imageId = registry.registerLocalFile({ kind: 'image', filePath: image, name: 'picture.png', mimeType: 'image/png', byteSize: 24 });
  return { directory, file, image, registry, fileToken: registry.format(textId), imageToken: registry.format(imageId) };
}

describe('terminal fixed-schema session.send preparation', () => {
  it('matches existing text/material/file ordering and engage whitespace without a second material read', async () => {
    const h = await fixture();
    const options = { workspaceRoot: h.directory, materialRegistry: h.registry };
    for (const text of [
      '  plain 汉🦞\u0000\\\"\r\nend  ',
      `before ${h.fileToken} between ${h.imageToken} after ${h.fileToken}`,
      `before @file:note.txt after`,
      `before\r\n  @  ${h.fileToken} after  `,
      ` \t@ \n @file:note.txt  `,
      'prefix @  suffix @ again',
      '  @  ',
      `[File #999 · unregistered @file:note.txt] suffix`,
      'a'.repeat(8191) + '🦞' + 'z'.repeat(32_000),
    ]) {
      const expected = await prepareUserTurnInput(text, options);
      const engage = await prepareSessionSendEngage(text, options);
      expect(engage?.kind).not.toBe('invalid');
      const pages: Buffer[] = [];
      const length = await prepareSessionSendSnapshot(text, identity, { ...options, signal: new AbortController().signal }, async bytes => {
        expect(bytes.length).toBeLessThanOrEqual(32 * 1024); pages.push(Buffer.from(bytes));
      });
      const json = Buffer.concat(pages);
      expect(json.length).toBe(length);
      expect(JSON.parse(json.toString())).toEqual({ input: expected!.input, ...identity,
        ...(engage?.kind === 'ready' ? { engage: engage.engage } : {}) });
    }
  });

  it('reuses the first file contents for the original input and engage question', async () => {
    const h = await fixture(); const pages: Buffer[] = []; let changed = false;
    // Make the first part flush before question generation and mutate only our
    // synthetic file. The second scan must use the already resolved snapshot.
    const text = `${h.fileToken} ${'x'.repeat(40_000)} @ explain`;
    await prepareSessionSendSnapshot(text, identity, { workspaceRoot: h.directory, materialRegistry: h.registry, signal: new AbortController().signal }, async bytes => {
      pages.push(Buffer.from(bytes)); if (!changed) { changed = true; await writeFile(h.file, 'material CHANGED'); }
    });
    const params = JSON.parse(Buffer.concat(pages).toString());
    expect(params.input.parts[0].text).toContain('material first');
    expect(params.engage.question).toContain('material first');
    expect(params.engage.question).not.toContain('CHANGED');
  });

  it('rejects non-text engage, cancellation and bounded real-file oversize before publishing', async () => {
    const h = await fixture(); const abort = new AbortController();
    const options = { workspaceRoot: h.directory, materialRegistry: h.registry, signal: abort.signal };
    await expect(prepareSessionSendSnapshot(`@ explain ${h.imageToken}`, identity, options, async () => {})).rejects.toThrow('只支持文本');
    await writeFile(h.file, Buffer.alloc(100 * 1024 + 1));
    await expect(readBoundedInputFile(h.file, 100 * 1024, abort.signal)).rejects.toThrow('文件过大');
    abort.abort();
    await expect(prepareSessionSendSnapshot('text', identity, options, async () => {})).rejects.toThrow();
  });

  it.each([
    ['unclosed material candidates', '[File #1 · missing '.repeat(12_000)],
    ['long material id', '[Image #' + '1'.repeat(140_000) + 'suffix'],
    ['engage whitespace', 'prefix @ ' + ' '.repeat(140_000) + 'suffix'],
  ])('yields %s to the original cancellation', async (_label, text) => {
    const abort = new AbortController();
    const stopped = Error('original request cancelled');
    setImmediate(() => abort.abort(stopped));
    await expect(prepareSessionSendSnapshot(text, identity, { workspaceRoot: '.', materialRegistry: new InputMaterialRegistry(), signal: abort.signal }, async () => {})).rejects.toBe(stopped);
  });
});

describe('bounded native JSON escaping', () => {
  it('counts controls, quotes, surrogate pairs and lone surrogates exactly', () => {
    const values = ['plain', '\"\\\b\t\n\f\r\u0000\u001f', '汉🦞', '\ud800a\udfff', '\ud800\udfff'];
    for (let unit = 0; unit < 65536; unit += 17) values.push(String.fromCharCode(unit));
    for (const value of values) expect(jsonStringBytes(value)).toBe(Buffer.byteLength(JSON.stringify(value)));
  });

  it('admits the complete wire budget in finite pages and rejects escaped overflow before allocation/write', async () => {
    let written = 0, largest = 0;
    const maximum = SESSION_SEND_WIRE_BYTES - 4096;
    const writer = new SessionSendJsonWriter(async bytes => { written += bytes.length; largest = Math.max(largest, bytes.length); }, new AbortController().signal, maximum);
    const page = '\u0000'.repeat(8192);
    const escaped = jsonStringBytes(page) - 2;
    for (let index = 0; index < Math.floor(maximum / escaped); index++) await writer.stringContent(page);
    await writer.stringContent('x'.repeat(maximum % escaped)); await writer.finish();
    expect(written).toBe(maximum); expect(largest).toBeLessThanOrEqual(32 * 1024);
    await expect(writer.stringContent('\u0000')).rejects.toThrow('工作区不足');
    expect(written).toBe(maximum);
  });
});


it('normalizes only an alias proven in the raw draft, keeping ordinary expanded paste text literal', async () => {
  const registry = new InputMaterialRegistry();
  for (const [original, commandAliasOffset, expected] of [
    ['\u3001custom-skill ask', 0, '/custom-skill ask'],
    ['  \u3001custom-skill a\u3001b', 2, '  /custom-skill a\u3001b'],
    ['\u3001clear\npasted body', undefined, '\u3001clear\npasted body'],
    ['/clear\npasted body', undefined, '/clear\npasted body'],
    ['body\u3001clear', undefined, 'body\u3001clear'],
  ] as const) {
    const parts: Buffer[] = [];
    await prepareSessionSendSnapshot(original, identity, { workspaceRoot: process.cwd(), materialRegistry: registry,
      signal: new AbortController().signal, commandAliasOffset }, async bytes => { parts.push(Buffer.from(bytes)); });
    expect(JSON.parse(Buffer.concat(parts).toString()).input.parts[0].text).toBe(expected);
  }
});
