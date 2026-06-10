/**
 * 对话窗口的 owner 侧装配 —— "持久化 → 注意力窗口"的 cli 胶水。
 *
 * 启动 / 切换 / 恢复对话时统一经此建窗：core 装填器构建启动装填对
 * （摘要快照 + 预算化倒读的最近原文），窗口以其为起始条目；turnCount
 * 同步从持久层计数（守 clear 边界）。
 *
 * 快照写出口也住这里：窗口折叠（run 接受 / 手动压缩）交出覆盖锚且指令
 * 携结构化摘要时落一个快照文件——写失败只 warn，快照是派生缓存，绝不
 * 反向影响 run record 与窗口。
 */

import {
  buildStartupBootstrap,
  countRuns,
  createAttentionWindow,
  createTokenEstimator,
  type AttentionWindowState,
  type ShardedTranscriptStore,
  type SnapshotStore,
  type WindowCompact,
  type WindowFoldOutcome,
} from "@zhixing/core";
import { resolveModelCapability } from "@zhixing/providers";

export interface OpenConversationWindowDeps {
  readonly store: ShardedTranscriptStore;
  readonly snapshots: SnapshotStore;
  readonly conversationId: string;
  /** 当前模型 —— 装填预算按其注意力优质上限取值 */
  readonly model: string;
}

export interface OpenedConversationWindow {
  readonly window: AttentionWindowState;
  /** 自最近清空以来的 run 数 —— turnCounter 初值 */
  readonly turnCount: number;
}

/** 建窗 + 启动装填 + turn 计数 —— 启动 / resume / workscene 恢复共用 */
export async function openConversationWindow(
  deps: OpenConversationWindowDeps,
): Promise<OpenedConversationWindow> {
  const capability = resolveModelCapability(deps.model);
  const bootstrap = await buildStartupBootstrap({
    conversationId: deps.conversationId,
    store: deps.store,
    snapshots: deps.snapshots,
    capability: { optimalMaxTokens: capability.optimalMaxTokens },
    estimator: createTokenEstimator(),
  });
  const window = createAttentionWindow({
    conversationId: deps.conversationId,
    bootstrap: bootstrap ?? undefined,
  });
  const turnCount = await countRuns(deps.store, deps.conversationId);
  return { window, turnCount };
}

/**
 * 窗口折叠的快照出口 —— 指令携结构化摘要且折叠交出覆盖锚时写一个快照
 * 文件；任一条件缺失不写（宁缺毋滥），写失败只 warn。
 */
export async function writeWindowSnapshot(
  snapshots: SnapshotStore,
  conversationId: string,
  windowCompact: WindowCompact,
  outcome: WindowFoldOutcome,
): Promise<void> {
  if (!windowCompact.structuredSummary) return;
  const covered = outcome.coveredThroughRunIndex;
  if (covered === undefined) return;
  try {
    await snapshots.write(conversationId, {
      coveredThroughRunIndex: covered,
      structuredSummary: windowCompact.structuredSummary,
      tokensBefore: windowCompact.tokensBefore,
      tokensAfter: windowCompact.tokensAfter,
    });
  } catch (err) {
    // allow-direct-stdout: fire-and-forget 持久化诊断，调用点无 writer 可注入
    console.warn(
      `[快照写入失败] conv=${conversationId}（不影响对话与窗口）:`,
      err instanceof Error ? err.message : err,
    );
  }
}
