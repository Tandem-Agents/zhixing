import { assertProtocolIdentifier } from "./validation.js";
import type { ConversationCommitSummary } from "../contracts/conversation-recovery.js";

/** 提交读摘要的结构校验：契约文件只承载类型，校验逻辑住在协议层。 */
export function validateConversationCommitSummary(value: unknown): asserts value is ConversationCommitSummary {
  assertRecordKeys(value, ['runIndex', 'handedOff', 'conflict'], ['usage', 'navigation', 'controlRecovery'], 'Committed read summary');
  assertNonNegativeSafeInteger(value.runIndex, 'Committed run index');
  if (typeof value.handedOff !== 'boolean' || typeof value.conflict !== 'boolean') throw new TypeError('Committed control summary must contain boolean facts');
  if (value.controlRecovery !== undefined && typeof value.controlRecovery !== 'boolean') throw new TypeError('Committed recovery summary must be boolean');
  if (value.usage !== undefined) {
    assertRecordKeys(value.usage, ['inputTokens', 'outputTokens'], ['totalInputTokens', 'cacheReadTokens', 'cacheWriteTokens'], 'Committed usage');
    for (const [key, number] of Object.entries(value.usage)) if (number !== undefined) assertNonNegativeSafeInteger(number, `Committed usage ${key}`);
    if (value.usage.totalInputTokens !== undefined && (Number(value.usage.totalInputTokens) < Number(value.usage.inputTokens) ||
        Number(value.usage.totalInputTokens) < Number(value.usage.cacheReadTokens ?? 0) + Number(value.usage.cacheWriteTokens ?? 0))) throw new TypeError('Committed total input usage is inconsistent');
  }
  if (value.navigation !== undefined) {
    assertPlainRecord(value.navigation, 'Committed navigation');
    const nav = value.navigation;
    if (value.handedOff) throw new TypeError('Handed-off commit cannot navigate the client');
    if (nav.kind === 'exit') assertExactRecordKeys(nav, ['kind'], 'Committed navigation');
    else if (nav.kind === 'enter' || nav.kind === 'set_workdir') {
      assertExactRecordKeys(nav, nav.kind === 'enter' ? ['kind', 'sceneId'] : ['kind', 'sceneId', 'workspace'], 'Committed navigation');
      assertIdentifier(nav.sceneId, 'Committed scene');
      if (nav.kind === 'set_workdir' && nav.workspace !== null) {
        assertExactRecordKeys(nav.workspace, ['deviceId', 'bindingRef'], 'Committed workspace');
        assertIdentifier(nav.workspace.deviceId, 'Committed workspace device');
        assertIdentifier(nav.workspace.bindingRef, 'Committed workspace binding');
      }
    } else throw new TypeError('Unknown committed navigation');
  }
}

function assertRecordKeys(value: unknown, required: readonly string[], optional: readonly string[], label: string): asserts value is Record<string, unknown> {
  assertPlainRecord(value, label);
  const allowed = new Set([...required, ...optional]);
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !allowed.has(key))) throw new TypeError(`${label} fields are incomplete or unknown`);
}
function assertExactRecordKeys(value: unknown, keys: readonly string[], label: string): asserts value is Record<string, unknown> { assertRecordKeys(value, keys, [], label); }
function assertPlainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) throw new TypeError(`${label} must be a plain object`);
}
function assertNonNegativeSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new TypeError(`${label} must be a nonnegative safe integer`);
}
function assertIdentifier(value: unknown, label: string): asserts value is string { assertProtocolIdentifier(value, label); }
