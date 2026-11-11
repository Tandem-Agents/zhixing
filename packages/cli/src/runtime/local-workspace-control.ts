import {
  ImmediateRootReplayTerminalError,
  type AuthorityCallContext,
  type ImmediateRootReservationInspection,
  type LocalEnvironmentControlContext,
  type ResourceReservationPort,
} from "@zhixing-ai/core/contracts";
import {
  WorkspaceControlAttemptSpentError,
  type WorkspaceAdministrationControlPort,
  type WorkspaceAdministrationControlRequest,
} from "@zhixing-ai/core/environment/workspace-administration";
import { protocolDigest } from "@zhixing-ai/core/protocol";

const CONTROL_BUDGET = { maxCalls: 8 };

/** 到期回收是执行器治理器既有的责任；离线临时宿主没有后台恢复，由收敛残留时按需调用。 */
type ControlResources = Pick<
  ResourceReservationPort,
  "acquireRoot" | "settle" | "release" | "inspectImmediateRoot"
> & { reclaimExpired(): Promise<number> };

/**
 * 上一尝试的残留根还没进入终态（例如租约刚过期、治理器的到期判定尚未覆盖到它）。
 * 不推进新尝试，按可重试的基础设施失败交生命周期稍后再收敛。
 */
export class LocalWorkspaceResidualRootPendingError extends Error {
  readonly code = "LOCAL_WORKSPACE_RESIDUAL_ROOT_PENDING";
  constructor(attempt: number, state: string) {
    super(`本机工作区操作第 ${attempt} 次执行尝试的资源根仍是 ${state}，等它收束后再继续`);
    this.name = "LocalWorkspaceResidualRootPendingError";
  }
}

/** Correctness adapter for target-device workspace control admission. */
export class ExecutorWorkspaceAdministrationControl
  implements WorkspaceAdministrationControlPort
{
  readonly #executorId: string;
  readonly #resources: ControlResources;

  constructor(input: {
    readonly executorId: string;
    readonly resources: ControlResources;
  }) {
    this.#executorId = input.executorId;
    this.#resources = input.resources;
  }

  async execute<T>(
    request: WorkspaceAdministrationControlRequest,
    abort: AbortSignal,
    operation: (control: LocalEnvironmentControlContext) => Promise<T>,
  ): Promise<T> {
    const { requestId } = request;
    const workload = {
      kind: "control" as const,
      id: requestId,
      attempt: request.attempt ?? 1,
    };
    const context: AuthorityCallContext = {
      principal: { kind: "host", component: "resource-governor" },
      requestId: governorCallRequestId(requestId),
      deadlineAt: new Date(Date.now() + 30_000).toISOString(),
    };
    // 耐久尝试才可能被先前执行用过；一次性请求每次是新主体，不必核对
    if (request.attempt !== undefined) {
      await this.#convergeUsedAttempt(workload, context);
    }
    let lease;
    try {
      lease = await this.#resources.acquireRoot(
        workload,
        CONTROL_BUDGET,
        { admissionClass: "interactive", entry: "environment-control" },
        context,
        { executorId: this.#executorId },
      );
    } catch (error) {
      if (
        request.attempt !== undefined &&
        error instanceof ImmediateRootReplayTerminalError
      ) {
        throw new WorkspaceControlAttemptSpentError(
          workload.attempt,
          describeUsedRoot(error.inspection),
        );
      }
      throw error;
    }
    let failed = true;
    try {
      const result = await operation({ requestId, lease, abort });
      failed = false;
      return result;
    } finally {
      try {
        await this.#resources.settle(lease, context);
      } finally {
        await this.#resources.release(lease, context).catch((error) => {
          if (!failed) throw error;
        });
      }
    }
  }

  /**
   * 生命周期单写者串行派发，派到这里时同一操作的先前执行都已退出。该尝试的根若没取过或仍在排队，
   * 先前执行没有在它下面运行过，沿用它（排队项由这次取根消化，不留在同类队首）；
   * 若已被用过，先让残留进入终态（活动的结算后释放、已结算的释放；租约已过期的按治理器到期回收），
   * 确认终态后才报用尽。收束失败而租约未过期是未知故障，原样抛出，不当作已交接。
   */
  async #convergeUsedAttempt(
    workload: { readonly kind: "control"; readonly id: string; readonly attempt: number },
    context: AuthorityCallContext,
  ): Promise<void> {
    const inspection = await this.#resources.inspectImmediateRoot(workload);
    if (inspection.kind === "absent" || inspection.kind === "queued") return;
    if (inspection.kind === "reservation" && (inspection.state === "active" || inspection.state === "settled")) {
      const lease = inspection.lease;
      // 调用期限不超过租约到期：临近到期的残留仍能正常结算释放
      const bounded = {
        ...context,
        deadlineAt: new Date(Math.min(Date.parse(context.deadlineAt), Date.parse(lease.expiry))).toISOString(),
      };
      try {
        if (inspection.state === "active") await this.#resources.settle(lease, bounded);
        await this.#resources.release(lease, bounded);
      } catch (error) {
        if (Date.parse(lease.expiry) > Date.now()) throw error;
        await this.#resources.reclaimExpired();
        const after = await this.#resources.inspectImmediateRoot(workload);
        if (after.kind === "reservation" && (after.state === "active" || after.state === "settled")) {
          throw new LocalWorkspaceResidualRootPendingError(workload.attempt, after.state);
        }
        throw new WorkspaceControlAttemptSpentError(workload.attempt, describeUsedRoot(after.kind === "absent" || after.kind === "queued" ? inspection : after));
      }
    }
    throw new WorkspaceControlAttemptSpentError(
      workload.attempt,
      describeUsedRoot(inspection),
    );
  }
}

/**
 * 治理器调用上下文的请求标识上限 256 字符，只作本次调用的校验与记账，不落盘；效果主体按协议标识上限（480）
 * 可以更长（耐久操作主体由设备、outbox、序号、操作与输入摘要拼成，序号到两位数即超过 256）。
 * 超长时给治理器一个由主体导出的定长标识，资源根、作用域与绑定权威看到的主体不变。
 */
function governorCallRequestId(requestId: string): string {
  return requestId.length <= 256
    ? requestId
    : `environment-admin-call:${protocolDigest("LocalEnvironmentControlCall", 1, { requestId })}`;
}

function describeUsedRoot(
  inspection: Exclude<ImmediateRootReservationInspection, { readonly kind: "absent" | "queued" }>,
): string {
  if (inspection.kind === "dequeued") return `资源根已出队（${inspection.reason}）`;
  switch (inspection.state) {
    case "active":
      return "资源根停在活动状态，上次执行已中断";
    case "settled":
      return "资源根已结算但未释放";
    case "released":
      return "资源根已释放";
    case "reclaimed":
      return "资源根已被回收";
  }
}
