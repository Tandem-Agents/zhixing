/** Client and process discovery contract; importing it never loads the server assembly. */
export * from "./client/index.js";
export * from "./rpc/protocol.js";
export * from "./paths.js";
export * from "./process-lock.js";
export type { ServerShutdownParams, ServerShutdownResult } from "./rpc/methods/server.js";
