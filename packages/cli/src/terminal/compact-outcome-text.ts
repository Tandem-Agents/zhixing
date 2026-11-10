import { isUnusableSummaryError } from '@zhixing/core/context';
import { modelFailureText } from './model-failure.js';

/** 摘要失败给用户的原因：模型返回的摘要不可用单独说明；其余按模型失败的现行规则（已知类映射、未知类保留原文）。 */
export function summaryFailureText(error: string): string {
  return isUnusableSummaryError(error) ? '模型没有按要求返回摘要。' : sentence(modelFailureText(error));
}

/** 应急地板这一次移出了什么：与给模型的截断说明出自同一组事实；替换旧截断说明不算新的内容损失。 */
export interface EmergencyFloorCost {
  readonly droppedTurns: number;
  readonly droppedRunSteps?: number;
  readonly priorContext: 'none' | 'removed' | 'already-truncated';
}

export function emergencyFloorCostText(cost: EmergencyFloorCost): string {
  const removed: string[] = [];
  if (cost.droppedTurns > 0) removed.push(`较早的 ${cost.droppedTurns} 轮对话`);
  if (cost.priorContext === 'removed') removed.push('此前的摘要或恢复内容');
  if ((cost.droppedRunSteps ?? 0) > 0) removed.push(`本次请求中较早的 ${cost.droppedRunSteps} 个执行步骤`);
  const statements: string[] = [];
  if (removed.length > 0) statements.push(`${removed.join('、')}已移出模型上下文`);
  if (cost.priorContext === 'already-truncated') statements.push('更早的对话此前已截断');
  if (statements.length === 0) statements.push('没有移出新的内容');
  return `${statements.join('；')}；完整原文仍在对话历史中。`;
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[。！？.!?]$/u.test(trimmed) ? trimmed : `${trimmed}。`;
}
