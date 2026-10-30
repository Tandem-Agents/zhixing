import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveTerminalChunkTable, readTerminalChunkTables, TERMINAL_CHUNK_TABLE_FORMAT } from '../chunk-table.js';

const MIB = 1024 * 1024;
const content = Buffer.alloc(3 * MIB + 4321);
for (let i = 0; i < content.length; i++) content[i] = (i * 13 + Math.floor(i / MIB) * 5) & 0xff;
const artifact = { name: 'ui.exe', bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') };
const other = { name: 'opentui.dll', bytes: 10, sha256: 'a'.repeat(64) };
const derived = () => JSON.parse(JSON.stringify(deriveTerminalChunkTable(artifact, content, MIB))) as Record<string, unknown> & { chunks: Record<string, unknown>[] };

describe('terminal chunk tables', () => {
  it('derives contiguous chunks bound to the manifest entry and reads them back unchanged', () => {
    const table = deriveTerminalChunkTable(artifact, content, MIB);
    expect(table).toMatchObject({ format: TERMINAL_CHUNK_TABLE_FORMAT, algorithm: 'sha256', asset: 'ui.exe', bytes: artifact.bytes, sha256: artifact.sha256, chunkBytes: MIB });
    expect(table.chunks.map(chunk => [chunk.index, chunk.offset, chunk.length])).toEqual([[0, 0, MIB], [1, MIB, MIB], [2, 2 * MIB, MIB], [3, 3 * MIB, 4321]]);
    expect(table.chunks[3]!.sha256).toBe(createHash('sha256').update(content.subarray(3 * MIB)).digest('hex'));
    const tables = readTerminalChunkTables(JSON.parse(JSON.stringify([table])), [artifact, other]);
    expect([...tables.keys()]).toEqual(['ui.exe']); expect(tables.get('ui.exe')).toEqual(table);
    expect(readTerminalChunkTables(undefined, [artifact]).size).toBe(0);
  });

  it('refuses to derive from a file that does not match its manifest entry', () => {
    expect(() => deriveTerminalChunkTable({ ...artifact, bytes: artifact.bytes + 1 }, content, MIB)).toThrow(/does not match its manifest/);
    const tampered = Buffer.from(content); tampered[MIB + 7]! ^= 1;
    expect(() => deriveTerminalChunkTable(artifact, tampered, MIB)).toThrow(/does not match its manifest/);
  });

  const broken: [string, (table: ReturnType<typeof derived>) => unknown][] = [
    ['an unknown format', table => ({ ...table, format: 'zhixing-terminal-chunks/2' })],
    ['an unknown algorithm', table => ({ ...table, algorithm: 'sha512' })],
    ['an extra table key', table => ({ ...table, note: 'x' })],
    ['a missing table key', ({ chunkBytes: _chunkBytes, ...table }) => table],
    ['an asset outside the manifest', table => ({ ...table, asset: 'other.exe' })],
    ['a different total size', table => ({ ...table, bytes: artifact.bytes - 1 })],
    ['a different whole-file digest', table => ({ ...table, sha256: 'b'.repeat(64) })],
    ['a chunk size that is not whole MiB', table => ({ ...table, chunkBytes: MIB + 1 })],
    ['a chunk size above the bound', table => ({ ...table, chunkBytes: 128 * MIB })],
    ['a missing last chunk', table => ({ ...table, chunks: table.chunks.slice(0, -1) })],
    ['an extra chunk', table => ({ ...table, chunks: [...table.chunks, { ...table.chunks[3]!, index: 4, offset: 4 * MIB }] })],
    ['a renumbered chunk', table => ({ ...table, chunks: table.chunks.map((chunk, i) => i === 1 ? { ...chunk, index: 2 } : chunk) })],
    ['an overlapping offset', table => ({ ...table, chunks: table.chunks.map((chunk, i) => i === 2 ? { ...chunk, offset: 2 * MIB - 1 } : chunk) })],
    ['a gap before a chunk', table => ({ ...table, chunks: table.chunks.map((chunk, i) => i === 2 ? { ...chunk, offset: 2 * MIB + 1 } : chunk) })],
    ['a wrong last length', table => ({ ...table, chunks: table.chunks.map((chunk, i) => i === 3 ? { ...chunk, length: MIB } : chunk) })],
    ['an extra chunk key', table => ({ ...table, chunks: table.chunks.map((chunk, i) => i === 0 ? { ...chunk, note: 1 } : chunk) })],
    ['a malformed chunk digest', table => ({ ...table, chunks: table.chunks.map((chunk, i) => i === 0 ? { ...chunk, sha256: 'Z'.repeat(64) } : chunk) })],
  ];
  it.each(broken)('treats a table with %s as a manifest failure, never as absent', (_case, mutate) => {
    expect(() => readTerminalChunkTables([mutate(derived())], [artifact, other])).toThrow('terminal-package-manifest');
  });

  it('rejects malformed table lists, duplicates and more tables than artifacts', () => {
    expect(() => readTerminalChunkTables({}, [artifact])).toThrow('terminal-package-manifest');
    expect(() => readTerminalChunkTables([derived(), derived()], [artifact, other])).toThrow('terminal-package-manifest');
    expect(() => readTerminalChunkTables([derived(), derived()], [artifact])).toThrow('terminal-package-manifest');
    expect(() => readTerminalChunkTables([null], [artifact])).toThrow('terminal-package-manifest');
  });
});
