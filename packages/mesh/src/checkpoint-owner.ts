import { createHash } from "node:crypto";
import type { CheckpointPackage } from "./checkpoint.js";
import type {
  AuthorityCheckpointService,
  RecoveryBackupStatus,
} from "./checkpoint-service.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export interface AuthorityCheckpointOwnerOptions {
  readonly service: AuthorityCheckpointService;
  readonly identitySeed: string;
  readonly clock?: () => Date;
  readonly retryMs?: number;
  readonly onError?: (error: unknown) => void;
}

/** Owns the one daily obligation and the narrow pre-migration forced seam. */
export class AuthorityCheckpointOwner {
  readonly #clock: () => Date;
  readonly #retryMs: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #active: Promise<CheckpointPackage> | undefined;
  #abort: AbortController | undefined;
  #stopped = true;

  constructor(private readonly options: AuthorityCheckpointOwnerOptions) {
    this.#clock = options.clock ?? (() => new Date());
    this.#retryMs = options.retryMs ?? 60 * 60 * 1000;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#schedule(0);
  }

  async ensureDaily(): Promise<CheckpointPackage> {
    const now = this.#clock();
    const day = now.toISOString().slice(0, 10);
    return this.#run(stableCheckpointId(`${this.options.identitySeed}:daily:${day}`, Date.parse(`${day}T00:00:00.000Z`)));
  }

  async force(requestId: string): Promise<CheckpointPackage> {
    if (requestId.length === 0) throw new TypeError("Forced checkpoint request id is required");
    return this.#run(stableCheckpointId(`${this.options.identitySeed}:forced:${requestId}`, 0));
  }

  status(): Promise<RecoveryBackupStatus> {
    return this.options.service.status();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#abort?.abort(new Error("Authority checkpoint owner stopped"));
    await this.#active?.catch(() => undefined);
  }

  #run(checkpointId: string): Promise<CheckpointPackage> {
    if (this.#stopped) return Promise.reject(new Error("Authority checkpoint owner is stopped"));
    if (this.#active) return this.#active;
    const abort = new AbortController();
    this.#abort = abort;
    const promise = this.options.service
      .createAndReplicate({ checkpointId, abort: abort.signal })
      .then(async (checkpoint) => {
        await this.options.service.cleanupExpired();
        return checkpoint;
      });
    this.#active = promise;
    void promise.finally(() => {
      if (this.#active === promise) this.#active = undefined;
      if (this.#abort === abort) this.#abort = undefined;
    }).catch(() => undefined);
    return promise;
  }

  #schedule(delay: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.ensureDaily()
        .catch((error) => this.options.onError?.(error))
        .finally(() => this.#schedule(Math.min(this.#retryMs, DAY_MS)));
    }, delay);
    this.#timer.unref?.();
  }
}

function stableCheckpointId(identity: string, time: number): string {
  if (!Number.isFinite(time) || time < 0) throw new TypeError("Checkpoint identity time is invalid");
  const bytes = createHash("sha256").update(identity).digest();
  let timestamp = Math.floor(time);
  let head = "";
  for (let index = 0; index < 10; index += 1) {
    head = CROCKFORD[timestamp % 32]! + head;
    timestamp = Math.floor(timestamp / 32);
  }
  let tail = "";
  let bits = 0;
  let bitCount = 0;
  for (const byte of bytes) {
    bits = (bits << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5 && tail.length < 16) {
      bitCount -= 5;
      tail += CROCKFORD[(bits >>> bitCount) & 31]!;
      bits &= (1 << bitCount) - 1;
    }
    if (tail.length === 16) break;
  }
  return `${head}${tail}`;
}
