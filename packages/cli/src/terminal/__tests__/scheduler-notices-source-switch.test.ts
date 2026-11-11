import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FileArtifactStore, FileAuthorityCommitLog, type ProjectionTransactionContext } from '@zhixing-ai/core/authority';
import { DELIVERY_AUTHORITY_PROJECTION_ID, DeliveryAuthority } from '@zhixing-ai/core/delivery';
import { createOwnerDeliveryParticipant } from '@zhixing-ai/owner-kernel/delivery';
import { SchedulerUserNoticeJournal } from '@zhixing-ai/owner-kernel/scheduler-user-notices';
import type { SchedulerNoticePage } from '../../runtime/rpc-scheduler-facade.js';
import { schedulerNoticeProgressFile, TerminalSchedulerNotices } from '../scheduler-notices.js';
import { createTempDir } from '@zhixing-ai/test-utils';

// 源端与终端联动：真实通知日志（两代各一份权威日志）、真实终端消费者与真实进度文件
const NOW = '2026-11-03T00:00:00.000Z';

async function source(root: string) {
  const log = new FileAuthorityCommitLog(path.join(root, 'authority'), new FileArtifactStore(path.join(root, 'artifacts')), { clock: () => NOW });
  const delivery = createOwnerDeliveryParticipant({ authority: new DeliveryAuthority({ log, anchorEpoch: 3 }) });
  const notices = new SchedulerUserNoticeJournal({ log, delivery });
  const transaction = <T>(operation: (context: ProjectionTransactionContext) => Promise<T>) =>
    log.transactDurableProjection<never, T>(DELIVERY_AUTHORITY_PROJECTION_ID, async (_view, context) => ({ kind: 'return', value: await operation(context) }))
      .then(result => result.value);
  // 一个信封里的若干条第一方错过汇总
  const summaries = async (...ids: string[]) => {
    const records = await transaction(async context => {
      const all = [];
      for (const id of ids) all.push(...await notices.prepareRecords({ noticeId: id, kind: 'missed-summary', state: 'prepared',
        ref: { kind: 'missed-summary', batchId: id, memberCount: 1 }, reason: `汇总 ${id}`, actions: [], at: NOW, audience: 'first-party' }, context, all));
      return all;
    });
    return log.append(records);
  };
  // 终端读页的真实形状：源端分页按门面同样的字段映射
  const read = async (after: number, skip: number, cursorSource?: string): Promise<SchedulerNoticePage> => {
    const page = await notices.page(after, skip, undefined, cursorSource);
    return { notices: page.notices.map(notice => ({ noticeId: notice.noticeId, revision: notice.revision, kind: notice.kind, reason: notice.reason,
      ...(notice.audience ? { audience: notice.audience } : {}) })), next: page.nextRevision, skip: page.nextSkip, more: page.more,
    source: page.source, ...(page.reset ? { reset: true as const } : {}) };
  };
  return { log, notices, summaries, read };
}

function consumer(read: (after: number, skip: number, source?: string) => Promise<SchedulerNoticePage>, file: string, show = vi.fn(async (_message: string) => true)) {
  const notices = new TerminalSchedulerNotices({ read, subscribe: () => () => {}, progress: schedulerNoticeProgressFile(file), show, signal: new AbortController().signal });
  return { notices, show };
}

async function settle(notices: TerminalSchedulerNotices) {
  notices.catchUp();
  for (let i = 0; i < 20; i++) await notices.idle();
}

describe('scheduler notice cursor across a source switch', () => {
  it('resumes a stale partial cursor on a shorter new source from its start and shows the new summary once', { timeout: 60_000 }, async () => {
    const root = await createTempDir('notice-switch');
    const file = path.join(root, 'home', 'runtime', 'terminal-scheduler-notices.json');
    const a = await source(path.join(root, 'a'));
    const b = await source(path.join(root, 'b'));
    try {
      // 旧代 A 较长：先有多次不含通知的提交，再是一个含两条汇总的信封
      for (let index = 0; index < 20; index++) await a.log.append([{ stream: 'job:noise-fixture', body: { t: 'noise', index } }]);
      const pair = await a.summaries('a-1', 'a-2');
      // 第二条显示前中断：进度停在旧代信封中间
      let budget = 1;
      const first = consumer(a.read, file, vi.fn(async () => budget-- > 0));
      await settle(first.notices);
      const pausedAt = await schedulerNoticeProgressFile(file).load();
      expect(pausedAt).toMatchObject({ watermark: pair.lsn - 1, skip: 1 });
      // 换成较短的新代 B，只有一条新汇总；旧游标按 B 的位置是非法续读
      await b.summaries('b-1');
      await expect(b.notices.page(pausedAt!.watermark, pausedAt!.skip)).rejects.toThrow('continuation');
      const switched = await b.notices.page(pausedAt!.watermark, pausedAt!.skip, undefined, pausedAt!.source);
      expect(switched).toMatchObject({ reset: true, notices: [expect.objectContaining({ noticeId: 'b-1' })] });
      // 同一代的非法续读仍拒收，不当作换代
      await expect(b.notices.page(pausedAt!.watermark, pausedAt!.skip, undefined, switched.source)).rejects.toThrow('continuation');
      // 重开：新代的汇总显示一次；再开：零
      const reopened = consumer(b.read, file);
      await settle(reopened.notices);
      expect(reopened.show.mock.calls.map(([message]) => message)).toEqual(['汇总 b-1']);
      expect(await schedulerNoticeProgressFile(file).load()).toMatchObject({ source: switched.source, skip: 0 });
      const again = consumer(b.read, file);
      await settle(again.notices);
      expect(again.show).not.toHaveBeenCalled();
    } finally {
      await a.log.stopStorageMaintenance?.();
      await b.log.stopStorageMaintenance?.();
    }
  });
});
