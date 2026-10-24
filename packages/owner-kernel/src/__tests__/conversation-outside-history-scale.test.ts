/**
 * 历史外输入读取的规模对照：当前义务与返回量固定，只放大已提交且已消费的历史，
 * 新实现的读取量不变，早期全量折叠实现随历史增长。
 */

import { describe, expect, it, vi } from 'vitest';
import { ReferenceMessageInputReader } from './reference-message-input-reader.js';
import { fixture, ID, run, type Body } from './outside-history-test-support.js';

describe('outside-history work with fixed current obligations and growing ended history', () => {
  it('reads the same amount at 10 / 40 / 160 / 640 committed runs while the full fold grows', async () => {
    const rows: { history: number; historyRecords: number; current: string; returned: number; next: Record<string, number>; reference: Record<string, number> }[] = [];
    for (const history of [10, 40, 160, 640]) {
      const f = await fixture();
      // 已结束历史每 16 个运行合成一个信封写入：每次追加有固定的文件开销，与被测的读取无关
      let historyRecords = 0;
      for (let n = 0; n < history; n += 16) {
        const hold: Body[] = [];
        for (let k = n; k < Math.min(history, n + 16); k++) await run(f, 'ended-' + k, 'committed', { appended: k % 4 === 0 ? 1 : 0, consumeAll: true, hold });
        await f.append(...hold); historyRecords += hold.length;
      }
      // 当前义务固定：两个排队的会话来源运行、两个 uncertain、三个取消后留在历史外的输入
      for (let n = 0; n < 2; n++) await run(f, 'queued-' + n, 'queued', { conversation: true });
      for (let n = 0; n < 2; n++) await run(f, 'uncertain-' + n, 'uncertain');
      for (let n = 0; n < 3; n++) await run(f, 'cancelled-' + n, 'cancelled');
      // 计量：日志信封读取的批次、信封数与其中的记录数，读目录的范围扫描与单键读
      const measure = async (read: () => Promise<unknown>) => {
        const envelopes = vi.spyOn(f.log, 'readEnvelopesAt'), scans = vi.spyOn(f.directory.index, 'scan'), gets = vi.spyOn(f.directory.index, 'get');
        try {
          await read();
          const batches = await Promise.all(envelopes.mock.results.map(result => result.value as Promise<readonly { entries: readonly unknown[] }[]>));
          return { envelopeReads: batches.length, envelopes: batches.reduce((sum, batch) => sum + batch.length, 0),
            records: batches.reduce((sum, batch) => sum + batch.reduce((count, envelope) => count + envelope.entries.length, 0), 0),
            scans: scans.mock.calls.length, gets: gets.mock.calls.length };
        } finally { envelopes.mockRestore(); scans.mockRestore(); gets.mockRestore(); }
      };
      const page = await f.compare();
      rows.push({ history, historyRecords, current: '2 queued(conversation) + 2 uncertain + 3 cancelled', returned: page.inputs.length,
        next: await measure(() => f.next.messageInputsOutsideHistory()),
        reference: await measure(() => new ReferenceMessageInputReader(f.log, f.directory, f.artifacts, ID).messageInputsOutsideHistory()) });
    }
    console.log(JSON.stringify(rows));
    for (const row of rows) {
      expect(row.returned).toBe(7);
      expect(row.next).toEqual(rows[0]!.next);
    }
    expect(rows.at(-1)!.reference.records).toBeGreaterThan(rows[0]!.reference.records * 10);
  }, 600_000);
});
