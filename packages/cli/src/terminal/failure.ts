import { logFailureEvidence, type LogRecordPort } from '@zhixing/core/logging';
import { failureSourceFrames } from '../logging/failure-location.js';

/** 终端实例存储账户的确定错误码：S 记录、回给 N，N 以它拒绝并据此呈现。 */
export const TERMINAL_ASSET_FAILURE_CODES: readonly string[] = [
  'terminal-assets-unavailable', 'terminal-assets-result-unknown', 'terminal-assets-request-capacity', 'terminal-assets-no-reservation',
  'terminal-instance-not-admitted', 'terminal-instance-owner-changed', 'terminal-instance-reclaiming', 'terminal-instance-directory-changed',
  'terminal-instance-display-capacity', 'terminal-root-capacity', 'terminal-disk-capacity', 'terminal-root-busy', 'terminal-root-changing',
  'terminal-root-inventory-incomplete', 'terminal-assets-inventory-size', 'terminal-storage-step-size', 'terminal-storage-reservation-slots',
  'terminal-storage-settlement', 'terminal-storage-release-size', 'terminal-storage-release-underflow', 'terminal-assets-capacity-backpressured',
  'terminal-assets-capacity-gap', 'terminal-assets-capacity-step', 'terminal-assets-deadline',
  'terminal-assets-directory-changed', 'terminal-assets-size', 'terminal-assets-unknown-depth', 'terminal-assets-unknown-entry',
  'terminal-root-operation-capacity', 'terminal-root-unknown-residue', 'terminal-instance-record-capacity', 'terminal-instance-record-size',
  'terminal-instance-record-unknown', 'terminal-publication-capacity', 'terminal-publication-predecessor-changed',
  'terminal-publication-predecessor-unknown', 'terminal-publication-unknown',
];

/** 真实的存储容量不足：按哪一层满了如实告诉用户可行的出路；不重试、不扩配额。其余原因返回 undefined。 */
export function terminalStorageFullMessage(code: string | undefined): string | undefined {
  switch (code) {
    case 'terminal-instance-display-capacity': return '本终端窗口的显示存储已达上限，草稿已保留；新开一个终端窗口可继续。';
    case 'terminal-root-capacity': return '本机终端存储总量已达上限，草稿已保留；关闭其他终端窗口后重试。';
    case 'terminal-disk-capacity': return '磁盘可用空间不足，草稿已保留；释放磁盘空间后重试。';
    default: return undefined;
  }
}

// Only source-owned literals may cross into logs. Unknown error messages,
// request values and stacks can contain credentials or conversation content.
const codes = new Set([
  'terminal-application-request-capacity', 'terminal-application-request', 'terminal-application-hello',
  'terminal-display-cursor', 'terminal-history-scope-changed', 'terminal-history-generation-changed',
  'terminal-history-source-changed', 'terminal-history-source-range', 'terminal-history-range',
  'terminal-history-cancelled', 'terminal-channel-closed', 'terminal-surface-retired',
  'terminal-control-capacity', 'terminal-body-capacity', 'terminal-input-reference-busy',
  'terminal-frame-too-large', 'terminal-selection-expired', 'terminal-editor-not-open',
  'terminal-confirmation-expired', 'terminal-delivery-timeout',
  'terminal-input-reference-expired', 'terminal-input-references-superseded',
  'terminal-helper-executable-not-found', 'terminal-helper-executable-format',
  'terminal-helper-script-line-break',
  'terminal-clipboard-timeout', 'terminal-clipboard-size', 'terminal-clipboard-busy',
  'terminal-clipboard-incomplete', 'terminal-clipboard-unavailable', 'terminal-clipboard-encoding',
  'terminal-clipboard-read-failed', 'terminal-clipboard-aborted', 'terminal-clipboard-output-capacity',
  // 终端实例存储账户（S）与 N 侧请求
  ...TERMINAL_ASSET_FAILURE_CODES,
]);
const actions = new Set([
  'clipboard-read', 'clipboard-write', 'startup', 'exit', 'interrupt', 'display-page', 'history-previous', 'history-open', 'history-close',
  'display-retry', 'retry-connection', 'input-window', 'input-history-next', 'configuration-action',
  'configuration-open', 'secret-value', 'selection', 'confirmation', 'submit', 'paste',
  'input-submit', 'input-references', 'skills-open', 'skills-action', 'skills-refresh',
]);
export function recordTerminalFailure(records: LogRecordPort | undefined, error: unknown, reason: string,
  context: { action?: string; requestId?: number; active?: number; pending?: number; queued?: number; durationMs?: number;
    /** 通道另一端的进程角色（S 记录角色通道失败时给出） */ role?: 'ui' | 'application' | 'host' | 'recovery';
    /** 实例存储账户的操作（S 记录资产失败时给出）：bytes 为请求字节，attempts 为期限内的尝试次数，capacity 为容量仲裁未授予时的结论，
     * retriedOn 为期限内最后一次接续所针对的原因码 */
    asset?: { readonly operation: 'reserve' | 'settle' | 'released'; readonly bucket?: 'display' | 'input'; readonly bytes: number; readonly attempts: number;
      readonly capacity?: { readonly kind: string; readonly blockedBy?: string; readonly retryAfterMs?: number }; readonly retriedOn?: string } } = {}): void {
  try {
    const message = error instanceof Error ? error.message : undefined;
    const failure = typeof message === 'string' && codes.has(message) ? { category: 'terminal', code: message } : logFailureEvidence(error);
    const sourceFrames = failureSourceFrames(error);
    const asset = context.asset;
    records?.record({ event: 'terminalFailure', result: 'failure', data: { reason, failure,
      ...(sourceFrames.length ? { sourceFrames } : {}),
      ...Object.fromEntries(Object.entries(context).filter(([key, value]) => key !== 'action' && typeof value === 'number' && Number.isFinite(value))),
      action: context.action === undefined ? undefined : actions.has(context.action) ? context.action : 'other',
      ...(context.role ? { role: context.role } : {}),
      ...(asset ? { asset: { operation: asset.operation, ...(asset.bucket ? { bucket: asset.bucket } : {}), bytes: asset.bytes, attempts: asset.attempts,
        ...(asset.capacity ? { capacity: { kind: asset.capacity.kind.slice(0, 32),
          ...(asset.capacity.blockedBy ? { blockedBy: asset.capacity.blockedBy.slice(0, 48) } : {}),
          ...(asset.capacity.retryAfterMs !== undefined ? { retryAfterMs: asset.capacity.retryAfterMs } : {}) } } : {}),
        ...(asset.retriedOn && TERMINAL_ASSET_FAILURE_CODES.includes(asset.retriedOn) ? { retriedOn: asset.retriedOn } : {}) } } : {}),
    } });
  } catch { /* Logging cannot replace cleanup or the original failure. */ }
}
