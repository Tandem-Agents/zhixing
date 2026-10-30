import { createHash } from "node:crypto";

/** 大于它的终端制品必须有块表（cli 构建派生，S 据此并行核验）。与 packages/cli/src/terminal/chunk-table.ts 一致。 */
export const TERMINAL_CHUNK_TABLE_MIN_BYTES = 16 * 1024 * 1024;

function assert(value, message) { if (!value) throw new Error(message); }

/**
 * 包检查的块表核对：格式与算法身份、绑定原清单条目、同一制品不重复、从 0 起连续覆盖全部字节，
 * 每块摘要按文件内容独立重算；大于阈值的制品必须有表。readArtifact(name) 返回该制品的完整字节。
 */
export async function verifyTerminalChunkTables(id, manifest, readArtifact) {
  const chunkTables = manifest.chunkTables ?? [];
  assert(Array.isArray(chunkTables), `${id} terminal 块表格式不正确`);
  const tabled = new Set();
  for (const table of chunkTables) {
    const artifact = manifest.artifacts.find(item => item.name === table?.asset);
    assert(table?.format === "zhixing-terminal-chunks/1" && table.algorithm === "sha256" && artifact !== undefined && !tabled.has(artifact.name) &&
      table.bytes === artifact.bytes && table.sha256 === artifact.sha256 && Number.isSafeInteger(table.chunkBytes) && table.chunkBytes > 0 &&
      Array.isArray(table.chunks) && table.chunks.length === Math.ceil(artifact.bytes / table.chunkBytes), `${id} terminal 块表 ${table?.asset} 绑定或格式不符`);
    tabled.add(artifact.name);
    const content = await readArtifact(artifact.name);
    table.chunks.forEach((chunk, index) => {
      const offset = index * table.chunkBytes, length = Math.min(table.chunkBytes, artifact.bytes - offset);
      assert(chunk?.index === index && chunk.offset === offset && chunk.length === length &&
        createHash("sha256").update(content.subarray(offset, offset + length)).digest("hex") === chunk.sha256, `${id}/${artifact.name} 第 ${index} 块与块表不符`);
    });
  }
  for (const artifact of manifest.artifacts) assert(artifact.bytes <= TERMINAL_CHUNK_TABLE_MIN_BYTES || tabled.has(artifact.name), `${id}/${artifact.name} 缺少块表`);
}
