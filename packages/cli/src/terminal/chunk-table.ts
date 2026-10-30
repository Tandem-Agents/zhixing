import { createHash } from 'node:crypto';

/**
 * 固定制品的分块摘要表：由 cli 构建在拷贝终端制品后，从与原清单整文件摘要一致的那份文件派生，写入 dist 清单的
 * chunkTables。表带格式与算法身份，绑定资产名、总字节、原整文件摘要与块尺寸，块按序号连续、偏移与长度确定。
 * S 据此用多个线程并行核验同一份已核大小的文件的全部字节；没有表的制品仍按整文件摘要核验。
 */
export const TERMINAL_CHUNK_TABLE_FORMAT = 'zhixing-terminal-chunks/1';
export const TERMINAL_CHUNK_BYTES = 8 * 1024 * 1024;
/** 大于它的制品才派生块表；更小的制品并行收益抵不过多起线程的成本。 */
export const TERMINAL_CHUNK_TABLE_MIN_BYTES = 2 * TERMINAL_CHUNK_BYTES;
const MIN_CHUNK_BYTES = 1024 * 1024, MAX_CHUNK_BYTES = 64 * 1024 * 1024, MAX_CHUNKS = 256;
const TABLE_KEYS = 'algorithm,asset,bytes,chunkBytes,chunks,format,sha256', CHUNK_KEYS = 'index,length,offset,sha256';

export interface TerminalChunk { readonly index: number; readonly offset: number; readonly length: number; readonly sha256: string }
export interface TerminalChunkTable {
  readonly format: typeof TERMINAL_CHUNK_TABLE_FORMAT; readonly algorithm: 'sha256';
  readonly asset: string; readonly bytes: number; readonly sha256: string;
  readonly chunkBytes: number; readonly chunks: readonly TerminalChunk[];
}
interface Artifact { readonly name: string; readonly bytes: number; readonly sha256: string }

const digest = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** 构建派生：内容的大小与整文件摘要必须先与原清单一致，否则失败，绝不改写原摘要迁就文件。 */
export function deriveTerminalChunkTable(artifact: Artifact, content: Buffer, chunkBytes = TERMINAL_CHUNK_BYTES): TerminalChunkTable {
  if (content.length !== artifact.bytes || digest(content) !== artifact.sha256) {
    throw Error(`Terminal artifact ${artifact.name} does not match its manifest`);
  }
  const chunks: TerminalChunk[] = [];
  for (let index = 0, offset = 0; offset < content.length; index++, offset += chunkBytes) {
    const length = Math.min(chunkBytes, content.length - offset);
    chunks.push({ index, offset, length, sha256: digest(content.subarray(offset, offset + length)) });
  }
  return { format: TERMINAL_CHUNK_TABLE_FORMAT, algorithm: 'sha256', asset: artifact.name, bytes: artifact.bytes,
    sha256: artifact.sha256, chunkBytes, chunks };
}

const plain = (value: unknown, keys: string): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys;

/**
 * 运行时读表：清单没有 chunkTables 时返回空集；有表但格式、算法、绑定、块序列任何一处不对，或表多于制品、
 * 同一制品重复、指向清单外的制品，一律按清单失败抛出，不当作缺失处理。
 */
export function readTerminalChunkTables(raw: unknown, artifacts: readonly Artifact[]): ReadonlyMap<string, TerminalChunkTable> {
  const tables = new Map<string, TerminalChunkTable>();
  if (raw === undefined) return tables;
  const invalid = () => Error('terminal-package-manifest');
  if (!Array.isArray(raw) || raw.length > artifacts.length) throw invalid();
  for (const table of raw) {
    if (!plain(table, TABLE_KEYS) || table.format !== TERMINAL_CHUNK_TABLE_FORMAT || table.algorithm !== 'sha256') throw invalid();
    const artifact = artifacts.find(item => item.name === table.asset);
    const chunkBytes = table.chunkBytes;
    if (!artifact || tables.has(artifact.name) || table.bytes !== artifact.bytes || table.sha256 !== artifact.sha256 ||
      !Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0 || typeof chunkBytes !== 'number' || !Number.isSafeInteger(chunkBytes) ||
      chunkBytes < MIN_CHUNK_BYTES || chunkBytes > MAX_CHUNK_BYTES || chunkBytes % MIN_CHUNK_BYTES !== 0 || !Array.isArray(table.chunks)) throw invalid();
    const count = Math.ceil(artifact.bytes / chunkBytes);
    if (count > MAX_CHUNKS || table.chunks.length !== count) throw invalid();
    // 块必须从 0 起按序号连续、首尾相接地恰好覆盖全部字节：没有缺口、重叠或多余
    const chunks = table.chunks.map((chunk: unknown, index: number): TerminalChunk => {
      const offset = index * chunkBytes, length = Math.min(chunkBytes, artifact.bytes - offset);
      if (!plain(chunk, CHUNK_KEYS) || chunk.index !== index || chunk.offset !== offset || chunk.length !== length ||
        typeof chunk.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(chunk.sha256)) throw invalid();
      return { index, offset, length, sha256: chunk.sha256 };
    });
    tables.set(artifact.name, { format: TERMINAL_CHUNK_TABLE_FORMAT, algorithm: 'sha256', asset: artifact.name,
      bytes: artifact.bytes, sha256: artifact.sha256, chunkBytes, chunks });
  }
  return tables;
}
