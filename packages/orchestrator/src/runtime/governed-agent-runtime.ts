import {
  runWithDeviceCapacity,
  type DeviceCapacityArbiterPort,
  type DeviceCapacityBudget,
  type DeviceCapacityClass,
} from "@zhixing/core/resources";
import type { AgentLoopDeps } from "@zhixing/core";

export interface AgentRuntimeCapacityBinding {
  readonly arbiter: DeviceCapacityArbiterPort;
  readonly serviceClass: Extract<DeviceCapacityClass, `workload-${string}`>;
  readonly atomic: DeviceCapacityBudget;
  readonly preferred: DeviceCapacityBudget;
  readonly maxWaitMs: number;
}

/**
 * 把设备容量治理接到工具执行注入点。
 *
 * 工具执行是 agent 运行期间真正占用本机 CPU、内存和磁盘的那一段,也是唯一
 * 无外部等待、可安全检查点化的叶级批次。LLM 调用是网络往返,按容量合同不占
 * permit——把它包进来会在等待响应的整个期间白占设备槽位,恰好是治理要防止的
 * 情形:后台维护因为拿不到槽位而停摆,而占着槽位的一方其实什么也没在做。
 *
 * 每次工具调用各自取得和释放,并发度由并发的工具调用自然表达,不需要一个跨越
 * 整轮对话的长 permit。
 */
export function governToolExecution(
  execute: AgentLoopDeps["executeTool"],
  binding: AgentRuntimeCapacityBinding,
): AgentLoopDeps["executeTool"] {
  const neverAbort = new AbortController().signal;
  return (tool, input, context) =>
    runWithDeviceCapacity(
      binding.arbiter,
      {
        serviceClass: binding.serviceClass,
        atomic: binding.atomic,
        preferred: binding.preferred,
        maxWaitMs: binding.maxWaitMs,
      },
      context.abortSignal ?? neverAbort,
      () => execute(tool, input, context),
    );
}
