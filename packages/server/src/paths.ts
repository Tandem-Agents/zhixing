/**
 * Server 运行时的默认文件路径。
 *
 * 统一入口——避免 server-state / daemon / stop / status / logs 各自硬编码
 * 路径导致未来 spec 修改时需要多处同步。所有消费者都必须通过本模块获取默认路径。
 *
 * 所有路径遵循 `ZHIXING_HOME` 覆盖（由 `@zhixing/core` 的 `getZhixingHome()` 提供），
 * 天然支持 test 隔离、多部署目录。
 */

import { join } from "node:path";
import {
  getZhixingHome,
} from "@zhixing/core/paths";

/** ~/.zhixing/server.pid —— 进程锁 + 连接发现 */
export function getDefaultPidPath(zhixingHome: string = getZhixingHome()): string {
  return join(zhixingHome, "server.pid");
}

/** ~/.zhixing/server.port —— 端口文件（shell 脚本友好读取） */
export function getDefaultPortPath(zhixingHome: string = getZhixingHome()): string {
  return join(zhixingHome, "server.port");
}

/** ~/.zhixing/server.state —— 阶段状态 + heartbeat（仅 daemon child 启用） */
export function getDefaultStatePath(zhixingHome: string = getZhixingHome()): string {
  return join(zhixingHome, "server.state");
}

/** ~/.zhixing/server.ready —— ready marker（仅 daemon child 启用） */
export function getDefaultReadyMarkerPath(zhixingHome: string = getZhixingHome()): string {
  return join(zhixingHome, "server.ready");
}

/** Unified runtime log root, shared by foreground and background owners. */
export function getDefaultLogPath(zhixingHome: string = getZhixingHome()): string {
  return join(zhixingHome, "logs", "runtime");
}

/** ~/.zhixing/server.token —— RPC 客户端认证用共享 token */
export function getDefaultTokenPath(zhixingHome: string = getZhixingHome()): string {
  return join(zhixingHome, "server.token");
}
