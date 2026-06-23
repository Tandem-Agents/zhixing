/**
 * @zhixing/server — 知行常驻服务网关
 *
 * 当前阶段：S2.C — WebSocket + RPC 分发器 + auth/health 方法
 */

export * from "./rpc/protocol.js";
export * from "./rpc/connection.js";
export * from "./rpc/dispatcher.js";
export * from "./rpc/handlers.js";
export * from "./rpc/methods/index.js";
export * from "./rpc/event-bridge.js";
export * from "./rpc/session-events.js";
export * from "./rpc/session-wire.js";
export * from "./rpc/session-broadcast.js";
export {
  createConfirmationBridge,
  CONFIRMATION_NOTIFICATIONS,
  type ConfirmationBridge,
  type ConfirmationBridgeDeps,
} from "./rpc/confirmation-bridge.js";
export * from "./runtime/index.js";
export * from "./system-handlers.js";
export * from "./paths.js";
export * from "./server-log.js";
export * from "./process-lock.js";
export * from "./server-state.js";
export * from "./cleanup-registry.js";
export * from "./lifecycle.js";
export * from "./client/index.js";
export * from "./types.js";
export * from "./context.js";
export * from "./server.js";
export * from "./channels/index.js";
export * from "./confirmation/index.js";
export * from "./intent/index.js";
