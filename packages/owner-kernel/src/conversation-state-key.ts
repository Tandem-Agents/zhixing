import { protocolDigest } from '@zhixing/core/protocol';

// 会话状态键摘要只取决于输入值；同一会话、字段与主体在每个事实的工作集读取里被反复求值。
// 有界记忆只省去重复的规范化与 SHA-256，满了整体清空；非原始值照常直接计算。
const textDigests = new Map<string, string>();
const numberDigests = new Map<number, string>();
const MAX_MEMOIZED_KEYS = 16_384;

function remember<K>(digests: Map<K, string>, key: K, value: unknown): string {
  let digest = digests.get(key);
  if (digest === undefined) {
    digest = protocolDigest('ConversationStateKey', 1, value).slice(7);
    if (digests.size >= MAX_MEMOIZED_KEYS) digests.clear();
    digests.set(key, digest);
  }
  return digest;
}

export function conversationStateKeyHash(value: unknown): string {
  if (typeof value === 'string') return remember(textDigests, value, value);
  // -0 与 0 的规范形式相同，Map 也把二者视为同一键。
  if (typeof value === 'number') return remember(numberDigests, value, value);
  return protocolDigest('ConversationStateKey', 1, value).slice(7);
}
