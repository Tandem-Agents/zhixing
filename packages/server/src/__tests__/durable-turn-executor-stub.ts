/**
 * DurableConversationTurnExecutor 的显式完整测试替身。
 *
 * 端口全方法必需(协议启用与能力完整不可分叉),测试不得以部分对象字面量
 * 冒充实现。本工厂给出 fail-closed 缺省:未被测试显式覆盖的控制/查询能力
 * 一律抛错立即暴露,只有调度回执(confirmScheduled 等)、final 发布与缓存
 * 释放这类正常路径必经的旁路能力给安全 no-op 缺省。
 */

import type { DurableConversationTurnExecutor } from "@zhixing/owner-kernel";

let stubRunCounter = 0;

export function stubDurableTurnExecutor(
  overrides: Partial<DurableConversationTurnExecutor> = {},
): DurableConversationTurnExecutor {
  const reject = (capability: string) => () => {
    throw new Error(
      `Durable turn executor stub does not implement ${capability}; provide an explicit override`,
    );
  };
  return {
    admit: async () => ({
      runId: `stub-run-${(stubRunCounter += 1)}`,
      shouldSchedule: true,
    }),
    confirmScheduled: () => {},
    deferScheduling: () => {},
    cancelAdmitted: reject("cancelAdmitted"),
    cancel: reject("cancel"),
    findRunByIngress: reject("findRunByIngress"),
    findInteractionOutcome: reject("findInteractionOutcome"),
    resolveUncertain: reject("resolveUncertain"),
    writeSession: reject("writeSession"),
    projectSession: reject("projectSession"),
    controlPrincipal: reject("controlPrincipal"),
    run: reject("run") as unknown as DurableConversationTurnExecutor["run"],
    publishPendingFinals: async () => 0,
    releaseConversation: () => {},
    ...overrides,
  };
}
