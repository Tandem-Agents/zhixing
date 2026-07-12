export type { SecureMeshConnection } from "./session.js";

export interface MeshFrameTransport {
  readonly closed: Promise<void>;
  send(frame: Uint8Array): Promise<void>;
  receive(signal?: AbortSignal): Promise<Uint8Array>;
  close(reason?: Error): Promise<void>;
}
