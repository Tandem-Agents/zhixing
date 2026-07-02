import fsp from "node:fs/promises";
import nodePath from "node:path";
import {
  conversationsDir,
  fromSafePathSegment,
  parseConversationId,
  toSafePathSegment,
} from "@zhixing/core";

/**
 * 推进控制日志孤儿清理的判活谓词。
 *
 * 控制日志目录名是 conversationId（全域键）的安全投影，而对话侧按 scope
 * 布局、目录名是 localId 的投影——workscene 对话两者不同名，目录名跨域
 * 字符串比对会把存活的场景推进数据误判为孤儿。正确语义：目录段无损还原
 * 为 conversationId，解析 scope 后按对话侧真实布局做存在性检查。
 */
export function createConversationAliveCheck(): (
  dirName: string,
) => Promise<boolean> {
  return async (dirName) => {
    const conversationId = fromSafePathSegment(dirName);
    const { scope, localId } = parseConversationId(conversationId);
    try {
      const info = await fsp.stat(
        nodePath.join(conversationsDir(scope), toSafePathSegment(localId)),
      );
      return info.isDirectory();
    } catch {
      return false;
    }
  };
}
