/**
 * 规则命中随交互镜像回到 owner 后的接纳端口与同一指派镜像处理的串行化。
 *
 * 命中是累加：owner 在批次提交前请规则权威写待计数记录，提交后（含重放）接纳，确定不会
 * 提交时清理。同一指派的“检查是否已提交 → 准备 → 提交 → 接纳或清理”必须串行，否则两次
 * 并发投递都读到“未提交”，后到者会在先到者接纳并删除记录之后重新准备，再经重放接纳一次。
 */
import type {
  EnvironmentRequirement,
  TrustRuleHitMirrorEntry,
} from "@zhixing/core/contracts";

/** 命中来自哪本 owner 日志（重开核对时据此查回）。 */
export type TrustRuleHitOrigin =
  | { readonly conversationId: string }
  | { readonly taskId: string };

export interface TrustRuleHitBatchInput {
  readonly origin: TrustRuleHitOrigin;
  readonly assignmentId: string;
  /** 指派已验签清单的环境要求：规则权威据此推导可计数的范围，不收执行端自报范围。 */
  readonly environment: EnvironmentRequirement;
  /** 本批镜像的摘要：重开核对时据此确认命中内容随哪一批被提交。 */
  readonly batchDigest: string;
  readonly entries: readonly TrustRuleHitMirrorEntry[];
}

/**
 * 规则命中的接纳端口（规则权威所在宿主实现）。
 * - `prepare`：批次提交前写待计数记录；写失败上抛，使本批不提交、由执行端按既有义务重发。
 *   规则不在范围内或已撤销的命中不写、不上抛（不堵镜像通道）。
 * - `accept`：批次提交后（含重放）计入；幂等、不上抛。
 * - `discard`：本批确定没有提交（事务被拒或指派已关闭）时清理；幂等、不上抛。
 */
export interface TrustRuleHitPort {
  prepare(input: TrustRuleHitBatchInput): Promise<void>;
  accept(input: TrustRuleHitBatchInput): Promise<void>;
  discard(input: TrustRuleHitBatchInput): Promise<void>;
}

/** owner 对某批命中是否已提交的结论：未知时保留待核，不能当作拒绝。 */
export type TrustRuleHitBatchState = "committed" | "rejected" | "unknown";

/**
 * 按指派串行的短寿命队列：同一指派的工作依次执行，队列空了即释放。只包住镜像处理的整段
 * 流程，不包 owner 自己的事务串行（避免重入死锁）。
 */
export class AssignmentSerialQueue {
  readonly #tails = new Map<string, Promise<void>>();

  run<T>(assignmentId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(assignmentId) ?? Promise.resolve();
    const result = previous.then(work, work);
    const tail = result.then(() => undefined, () => undefined);
    this.#tails.set(assignmentId, tail);
    void tail.then(() => {
      if (this.#tails.get(assignmentId) === tail) this.#tails.delete(assignmentId);
    });
    return result;
  }
}
