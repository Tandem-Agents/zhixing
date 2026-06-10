/**
 * 窗口重建的保尾护栏装配 —— 过渡期助手，预算化启动装填落地后随全量加载
 * 路径一起删除。
 *
 * 为什么需要：原文持久化是 append-only、不因压缩截断，超长对话全量加载
 * 重建的窗口可能超过模型物理上限——届时段评估的摘要调用自身就发不出去，
 * 自愈失效。护栏按模型的风险注意力上限机械保尾（无 LLM、不碰磁盘）。
 *
 * 取值用能力表默认值（未知模型有保守兜底）、估算器用未校准初值——护栏是
 * 应急天花板而非精确预算，保守即可；精确取值属预算化装填的职责。
 */

import { createTokenEstimator, type RestoreTailGuard } from "@zhixing/core";
import { resolveModelCapability } from "@zhixing/providers";

export function makeWindowTailGuard(model: string): RestoreTailGuard {
  const capability = resolveModelCapability(model);
  const estimator = createTokenEstimator();
  return {
    maxTokens: capability.riskMaxTokens,
    estimateMessages: (messages) => estimator.estimateMessages(messages),
  };
}
