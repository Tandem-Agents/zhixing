/**
 * 工作场景路径解析
 *
 * 全部从 getZhixingHome() 派生、id 经 toSafePathSegment 安全化 —— 工作场景
 * 的物理路径在系统里只在此一处拼接（与 conversation 的路径 helper 局部于
 * repository 同款分层约定；共享 paths.ts 只放跨 domain 原语）。
 *
 * 布局：
 *   <home>/workscenes/index.json              注册表主表（已注册 id 集合）
 *   <home>/workscenes/<id>/meta.json          该工作场景权威记录
 *   <home>/workscenes/<id>/me/                工作场景记忆域（结构同 ~/.zhixing/me/）
 *   <home>/workscenes/<id>/conversations/     工作场景会话域
 */

import path from "node:path";
import { getZhixingHome, toSafePathSegment } from "../paths.js";

/** 工作场景根目录 `<home>/workscenes`。 */
export function getWorkScenesRoot(): string {
  return path.join(getZhixingHome(), "workscenes");
}

/** 注册表主表文件 `<home>/workscenes/index.json`。 */
export function getWorkSceneIndexPath(): string {
  return path.join(getWorkScenesRoot(), "index.json");
}

/** 单个工作场景目录 `<home>/workscenes/<id>`。 */
export function getWorkSceneDir(id: string): string {
  return path.join(getWorkScenesRoot(), toSafePathSegment(id));
}

/** 工作场景记忆域根 `<home>/workscenes/<id>/me` —— power runtime 个人记忆域。 */
export function getWorkSceneMemoryDir(id: string): string {
  return path.join(getWorkSceneDir(id), "me");
}

/** 工作场景会话域根 `<home>/workscenes/<id>/conversations`。 */
export function getWorkSceneConversationsRoot(id: string): string {
  return path.join(getWorkSceneDir(id), "conversations");
}
