import { logFailureEvidence, type LogRecordPort } from '@zhixing/core/logging';
import { failureSourceFrames } from '../logging/failure-location.js';

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
]);
const actions = new Set([
  'clipboard-read', 'clipboard-write', 'startup', 'exit', 'interrupt', 'display-page', 'history-previous', 'history-open', 'history-close',
  'display-retry', 'retry-connection', 'input-window', 'input-history-next', 'configuration-action',
  'configuration-open', 'secret-value', 'selection', 'confirmation', 'submit', 'paste',
  'input-submit', 'input-references', 'skills-open', 'skills-action', 'skills-refresh',
]);
export function recordTerminalFailure(records: LogRecordPort | undefined, error: unknown, reason: string,
  context: { action?: string; requestId?: number; active?: number; pending?: number; queued?: number; durationMs?: number } = {}): void {
  try {
    const message = error instanceof Error ? error.message : undefined;
    const failure = typeof message === 'string' && codes.has(message) ? { category: 'terminal', code: message } : logFailureEvidence(error);
    const sourceFrames = failureSourceFrames(error);
    records?.record({ event: 'terminalFailure', result: 'failure', data: { reason, failure,
      ...(sourceFrames.length ? { sourceFrames } : {}),
      ...Object.fromEntries(Object.entries(context).filter(([key, value]) => key !== 'action' && typeof value === 'number' && Number.isFinite(value))),
      action: context.action === undefined ? undefined : actions.has(context.action) ? context.action : 'other',
    } });
  } catch { /* Logging cannot replace cleanup or the original failure. */ }
}
