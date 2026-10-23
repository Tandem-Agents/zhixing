import { AuthorityPreparationRequired, type AuthorityCommitLog, type DurableProjectionReadContext } from '@zhixing/core/authority';
import { conversationStateKeyHash as hash } from './conversation-state-key.js';

/**
 * 会话决定状态（canonical 运行状态与推进待办目录）按会话分区迁移的标记。带历史的旧资料升级时投影从源头部
 * 以空状态起步并写下迁移起点；每个会话在第一次被读写前迁移；完成标记出现之后，投影即与逐事实折叠的结果
 * 一致，不再检查分区。没有迁移起点的投影（新资料或很小的源从起点重建）从不处于迁移中。
 */
export const DECISION_MIGRATION_START = '~migration/start';
export const DECISION_MIGRATION_COMPLETE = '~migration/complete';
/** 跨设备收编的转移事实按转移编号分流，作为一个全局分区。 */
export const TRANSFER_PARTITION = '~transfers';
export const decisionPartitionKey = (partition: string) => '~migration/partition/' + hash(partition);
/** 全库只读扫描得到的会话清单：扫描位置之前出现过事实的会话各占一行。 */
export const DECISION_INDEXED_THROUGH = '~migration/indexed-through';
export const DECISION_CONVERSATION_PREFIX = '~migration/conversation/';
export const decisionConversationKey = (conversationId: string) => DECISION_CONVERSATION_PREFIX + hash(conversationId);

const migrators = new WeakMap<AuthorityCommitLog, (partitions: readonly string[]) => Promise<void>>();
export function installDecisionMigrator(log: AuthorityCommitLog, migrate: (partitions: readonly string[]) => Promise<void>): void {
  migrators.set(log, migrate);
}

/** 分区尚未迁移：放开日志锁，迁移这些分区后整体重做本次读写。 */
export function decisionMigrationRequired(log: AuthorityCommitLog, partitions: readonly string[]): AuthorityPreparationRequired {
  const error = new AuthorityPreparationRequired([]);
  error.prepareOutside = async () => {
    const migrate = migrators.get(log);
    if (!migrate) throw new TypeError('Conversation decision migration is not installed');
    await migrate(partitions);
  };
  return error;
}

export async function decisionMigrationActive(view: DurableProjectionReadContext): Promise<boolean> {
  return await view.get(DECISION_MIGRATION_START) !== undefined && await view.get(DECISION_MIGRATION_COMPLETE) === undefined;
}

/**
 * 分区可直接读写：不在迁移中；已迁移；或会话清单表明它在扫描位置之前没有任何事实（此后的写入都经准入，
 * 投影中已有它的完整状态）。转移分区只能经迁移就绪。
 */
export async function decisionPartitionReady(view: DurableProjectionReadContext, partition: string): Promise<boolean> {
  if (!await decisionMigrationActive(view) || await view.get(decisionPartitionKey(partition)) !== undefined) return true;
  return partition !== TRANSFER_PARTITION && await view.get(DECISION_INDEXED_THROUGH) !== undefined &&
    await view.get(decisionConversationKey(partition)) === undefined;
}
