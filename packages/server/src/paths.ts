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
import { getZhixingHome } from "@zhixing/core";

/** ~/.zhixing/server.pid —— 进程锁 + 连接发现 */
export function getDefaultPidPath(): string {
  return join(getZhixingHome(), "server.pid");
}

/** ~/.zhixing/server.port —— 端口文件（shell 脚本友好读取） */
export function getDefaultPortPath(): string {
  return join(getZhixingHome(), "server.port");
}

/** ~/.zhixing/server.state —— 阶段状态 + heartbeat（仅 daemon child 启用） */
export function getDefaultStatePath(): string {
  return join(getZhixingHome(), "server.state");
}

/** ~/.zhixing/server.ready —— ready marker（仅 daemon child 启用） */
export function getDefaultReadyMarkerPath(): string {
  return join(getZhixingHome(), "server.ready");
}

/** ~/.zhixing/logs/server —— 受生命周期治理的后台宿主日志目录 */
export function getDefaultServerLogDirPath(): string {
  return join(getZhixingHome(), "logs", "server");
}

/** ~/.zhixing/logs/server/server.log —— 受生命周期治理的后台宿主活跃日志 */
export function getDefaultServerActiveLogPath(): string {
  return join(getDefaultServerLogDirPath(), "server.log");
}

/** ~/.zhixing/server.log —— 旧版 daemon 日志；只作为迁移 / 兼容来源 */
export function getLegacyServerLogPath(): string {
  return join(getZhixingHome(), "server.log");
}

/** ~/.zhixing/logs/server/server.log —— daemon child stdout/stderr 重定向目标 */
export function getDefaultLogPath(): string {
  return getDefaultServerActiveLogPath();
}

/** ~/.zhixing/server.token —— RPC 客户端认证用共享 token */
export function getDefaultTokenPath(): string {
  return join(getZhixingHome(), "server.token");
}
