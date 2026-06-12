/**
 * 对话全域键的 scope 编码 —— 对话归属是身份的一部分,不是查表状态。
 *
 * 场景对话的全域键 `ws:<sceneId>:<localId>` 把归属编进 id(渠道会话
 * `dm:<channel>:<peer>` 的同构先例):send 路由(按场景发放 power 实例)、
 * 持久化路由(per-scope store)、目录路由全部由 id 纯函数派生——静态属性
 * 由结构保证,零状态、零同步。
 *
 * localId 是对话在所属 scope 库内的目录名(场景库内仍用裸 id);全域键只在
 * 跨库标识(ConversationManager 键 / RPC 参数)时使用。
 */

import type { ConversationScope } from "./types.js";

export const WORKSCENE_CONVERSATION_PREFIX = "ws:";

export interface ParsedConversationId {
  scope: ConversationScope;
  /** scope 库内的对话目录名 */
  localId: string;
}

/** 构造场景对话的全域键 */
export function worksceneConversationId(
  sceneId: string,
  localId: string,
): string {
  return `${WORKSCENE_CONVERSATION_PREFIX}${sceneId}:${localId}`;
}

/**
 * 解析全域键 → 归属 scope + 库内 id。
 *
 * 非 `ws:` 前缀(裸 id / 渠道会话 id)一律归 user scope,localId 即原 id——
 * 渠道会话现状就落在 user 对话目录,id 整体作目录名。`ws:` 前缀但缺段的
 * 异形 id 同样回落 user(防御:不让坏 id 路由进场景库)。
 */
export function parseConversationId(id: string): ParsedConversationId {
  if (id.startsWith(WORKSCENE_CONVERSATION_PREFIX)) {
    const rest = id.slice(WORKSCENE_CONVERSATION_PREFIX.length);
    const sep = rest.indexOf(":");
    if (sep > 0 && sep < rest.length - 1) {
      return {
        scope: { kind: "workscene", sceneId: rest.slice(0, sep) },
        localId: rest.slice(sep + 1),
      };
    }
  }
  return { scope: { kind: "user" }, localId: id };
}
