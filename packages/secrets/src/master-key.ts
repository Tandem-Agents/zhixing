import { randomBytes } from "node:crypto";

export type MasterKeyState = "unlocked" | "locked" | "unavailable";

export interface MasterKeyProvider {
  state(): Promise<MasterKeyState>;
  /** Opens the already-bound key without creating or replacing any backing fact. */
  loadExisting(): Promise<Buffer>;
  loadOrCreate(): Promise<Buffer>;
}

export class MemoryMasterKeyProvider implements MasterKeyProvider {
  private readonly key: Buffer;

  constructor(key: Uint8Array = randomBytes(32)) {
    if (key.byteLength !== 32) throw new TypeError("Secret vault master key must be 32 bytes");
    this.key = Buffer.from(key);
  }

  async state(): Promise<MasterKeyState> {
    return "unlocked";
  }

  async loadOrCreate(): Promise<Buffer> {
    return Buffer.from(this.key);
  }

  async loadExisting(): Promise<Buffer> {
    return Buffer.from(this.key);
  }
}
