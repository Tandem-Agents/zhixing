/**
 * 占位符 expand 与 alive id 提取——纯函数，不持有 registry。
 *
 * `expandPastes`：提交时把 buffer.draft 里的占位符还原为原文喂给 agent。
 * `extractAliveIds`：buffer 改动后取 draft 仍存活的占位符 id 集合，喂给
 * `registry.cleanup` 做 orphan 回收。
 *
 * 共用 PASTE_TOKEN_PATTERN（registry 模块导出）作为单一格式真相源——
 * 不在此文件或别处独立定义 regex，避免格式漂移。
 */

import { PASTE_TOKEN_PATTERN, type PasteRegistry } from "./paste-registry.js";

/**
 * 把 draft 里的所有占位符替换为对应 registry 内容。倒序替换保证多个占位符
 * 场景下前面的 match offset 不被后面的替换扰动。
 *
 * unknown id（registry 中没有该 id，例如用户字面输入 `[Pasted #999 ...]`）
 * 保留字面字符串作 fallback，避免崩溃。
 */
export function expandPastes(draft: string, registry: PasteRegistry): string {
  // matchAll 每次都要 fresh state——PASTE_TOKEN_PATTERN 有 `g` flag，
  // matchAll 内部会重置 lastIndex，安全
  const matches = Array.from(draft.matchAll(PASTE_TOKEN_PATTERN));
  if (matches.length === 0) return draft;

  let result = draft;
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i]!;
    const id = parseInt(m[1]!, 10);
    const entry = registry.get(id);
    if (!entry) continue;
    const start = m.index!;
    const end = start + m[0].length;
    result = result.slice(0, start) + entry.content + result.slice(end);
  }
  return result;
}

/**
 * 抽出 draft 中所有有效占位符的 id 集合。喂给 `registry.cleanup`：
 * registry 中不在此 set 的 id 视为 orphan 删除。
 *
 * 注意：损坏的占位符（用户编辑后字符串不再 match regex）不会进 alive set —— 此时
 * registry 自动 GC 对应内容，与"占位符破坏 = 内容回收"语义一致。
 */
export function extractAliveIds(draft: string): Set<number> {
  const ids = new Set<number>();
  for (const m of draft.matchAll(PASTE_TOKEN_PATTERN)) {
    ids.add(parseInt(m[1]!, 10));
  }
  return ids;
}
