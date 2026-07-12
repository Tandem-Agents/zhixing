import { MeshProtocolError } from "./errors.js";

export interface ReplayWindowOptions {
  readonly ttlMs?: number;
  readonly maxEntriesPerPeer?: number;
}

/** Replay fence partitioned by an already authenticated device identity. */
export class HandshakeReplayWindow {
  private readonly entries = new Map<string, Map<string, number>>();
  private readonly ttlMs: number;
  private readonly maxEntriesPerPeer: number;

  constructor(options: ReplayWindowOptions = {}) {
    this.ttlMs = options.ttlMs ?? 5 * 60_000;
    this.maxEntriesPerPeer = options.maxEntriesPerPeer ?? 1_024;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0) {
      throw new TypeError("Replay window ttl must be a positive integer");
    }
    if (!Number.isSafeInteger(this.maxEntriesPerPeer) || this.maxEntriesPerPeer <= 0) {
      throw new TypeError("Replay window peer capacity must be a positive integer");
    }
  }

  claim(authenticatedDeviceId: string, nonce: string, now: number): void {
    if (!authenticatedDeviceId || !nonce) {
      throw new TypeError("Replay claims require an authenticated device and nonce");
    }
    const peerEntries = this.entries.get(authenticatedDeviceId) ?? new Map<string, number>();
    this.prunePeer(authenticatedDeviceId, peerEntries, now);
    if (peerEntries.has(nonce)) {
      throw new MeshProtocolError("replay-detected", "Handshake nonce was already accepted");
    }
    if (peerEntries.size >= this.maxEntriesPerPeer) {
      throw new MeshProtocolError(
        "replay-detected",
        "Handshake replay window is full for this authenticated device",
      );
    }
    peerEntries.set(nonce, now + this.ttlMs);
    this.entries.set(authenticatedDeviceId, peerEntries);
  }

  private prunePeer(
    deviceId: string,
    peerEntries: Map<string, number>,
    now: number,
  ): void {
    for (const [nonce, expiry] of peerEntries) {
      if (expiry <= now) peerEntries.delete(nonce);
    }
    if (peerEntries.size === 0) this.entries.delete(deviceId);
  }
}
