import { AuthorityStorageError } from "@zhixing/core/authority";
import type { AuthorityCallContext, SealedBundle } from "@zhixing/core/contracts";
import { shouldRetryRemoteObligation } from "./remote-obligation-failure.js";

/**
 * conversation/job 两个 assignment worker 共享的底层耐久义务原语。
 * 这里只有与执行域无关的重试、提交与恢复骨架;输入、终态与提交策略
 * 属于各域 worker,不进入本文件。
 */

/** owner 权威给出的不可重试拒绝——重试无意义,必须上抛终止提交义务。 */
export class StableAuthorityRejection extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StableAuthorityRejection";
  }
}

export function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(asError(signal.reason));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(asError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 远端义务的指数退避重试:不可重试的失败立即上抛,worker 停止时以
 * 停止原因终止。isFatal 用于叠加域内致命判定(如权威存储损坏)。
 */
export async function retryRemoteObligation<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
  isFatal?: (error: unknown) => boolean,
): Promise<T> {
  let delayMs = 100;
  while (!signal.aborted) {
    try {
      return await abortableOperation(operation, signal);
    } catch (error) {
      if (signal.aborted) throw asError(signal.reason);
      if (isFatal?.(error) || !shouldRetryRemoteObligation(error)) throw error;
    }
    await abortableDelay(delayMs, signal);
    delayMs = Math.min(delayMs * 2, 5_000);
  }
  throw asError(signal.reason);
}

async function abortableOperation<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) throw asError(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(asError(signal.reason));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(operation)
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
  });
}

export interface BundleAcknowledgementLedger {
  acknowledge(assignmentId: string, commitRevision: number): Promise<unknown>;
}

export interface BundleSubmissionOwner {
  submitBundle(
    bundle: SealedBundle,
    context: AuthorityCallContext,
  ): Promise<
    | { readonly committed: true; readonly commitRevision: number }
    | {
        readonly committed: false;
        readonly error: { readonly retryable: boolean; readonly message: string };
      }
  >;
}

/**
 * 已封包 bundle 的提交义务:重试直至 owner 确认并回写本地确认水位。
 * owner 的稳定拒绝立即终止;确认写失败按可重试义务重投,由 owner 幂等
 * 回放保证不产生第二事实。
 */
export async function submitBundleUntilAcknowledged(input: {
  readonly bundle: SealedBundle;
  readonly owner: BundleSubmissionOwner;
  readonly ledger: BundleAcknowledgementLedger;
  readonly context: AuthorityCallContext;
  readonly signal: AbortSignal;
  /** 稳定拒绝的对外消息前缀,由各执行域给出(如 "Conversation commit rejected")。 */
  readonly rejectionPrefix: string;
}): Promise<void> {
  let delayMs = 100;
  while (!input.signal.aborted) {
    try {
      const committed = await abortableOperation(
        () => input.owner.submitBundle(input.bundle, input.context),
        input.signal,
      );
      if (!committed.committed) {
        if (!committed.error.retryable) {
          throw new StableAuthorityRejection(
            `${input.rejectionPrefix}: ${committed.error.message}`,
          );
        }
      } else {
        await input.ledger.acknowledge(
          input.bundle.assignmentId,
          committed.commitRevision,
        );
        return;
      }
    } catch (error) {
      if (input.signal.aborted) throw asError(input.signal.reason);
      if (
        error instanceof StableAuthorityRejection ||
        !shouldRetryRemoteObligation(error)
      ) {
        throw error;
      }
    }
    await abortableDelay(delayMs, input.signal);
    delayMs = Math.min(delayMs * 2, 5_000);
  }
  throw asError(input.signal.reason);
}

export interface SealedBundleRecoveryLedger extends BundleAcknowledgementLedger {
  sealedBundleForRecovery(
    assignmentId: string,
  ): Promise<
    | { readonly kind: "not-sealed" }
    | { readonly kind: "sealed"; readonly bundle: SealedBundle }
  >;
}

/**
 * 重复接收/重启后的封包恢复:账本已封包则只恢复提交义务,未封包不做
 * 任何执行动作。权威存储损坏是致命错误,不参与重试。
 */
export async function resumeSealedSubmission(input: {
  readonly assignmentId: string;
  readonly ledger: SealedBundleRecoveryLedger;
  readonly owner: BundleSubmissionOwner;
  readonly context: AuthorityCallContext;
  readonly signal: AbortSignal;
  readonly rejectionPrefix: string;
}): Promise<void> {
  const recovered = await retryRemoteObligation(
    () => input.ledger.sealedBundleForRecovery(input.assignmentId),
    input.signal,
    (error) => error instanceof AuthorityStorageError,
  );
  if (recovered.kind === "not-sealed") return;
  await submitBundleUntilAcknowledged({
    bundle: recovered.bundle,
    owner: input.owner,
    ledger: input.ledger,
    context: input.context,
    signal: input.signal,
    rejectionPrefix: input.rejectionPrefix,
  });
}
