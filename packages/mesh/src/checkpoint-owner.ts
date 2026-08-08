import type { CheckpointPackage } from "./checkpoint.js";
import type { RecoveryCheckpointRequest } from "@zhixing/core/contracts";
import type {
  AuthorityCheckpointService,
  RecoveryBackupStatus,
} from "./checkpoint-service.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export const RECOVERY_CHECKPOINT_OWNER_DESCRIPTOR = Object.freeze({
  owner: "current-anchor",
  roles: Object.freeze(["single-machine", "anchor-executor"]),
  phases: Object.freeze(["daily", "forced"]),
  order: Object.freeze(["recover-pending", "create-replicate", "cleanup-expired"]),
} as const);

export interface AuthorityCheckpointOwnerOptions {
  readonly service: AuthorityCheckpointService;
  readonly identitySeed: string;
  readonly clock?: () => Date;
  readonly retryMs?: number;
  readonly onError?: (error: unknown) => void;
}

export interface AuthorityCheckpointOwnerPort {
  start(schedule?: boolean): void;
  ensureDaily(): Promise<CheckpointPackage>;
  force(requestId: string): Promise<CheckpointPackage>;
  status(): Promise<RecoveryBackupStatus>;
  stop(): Promise<void>;
}

/** Owns the one daily obligation and the narrow pre-migration forced seam. */
export class AuthorityCheckpointOwner implements AuthorityCheckpointOwnerPort {
  readonly #clock: () => Date;
  readonly #retryMs: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #active: {
    readonly candidateKey: string;
    readonly promise: Promise<CheckpointPackage>;
    readonly abort: AbortController;
  } | undefined;
  #stopped = true;

  constructor(private readonly options: AuthorityCheckpointOwnerOptions) {
    this.#clock = options.clock ?? (() => new Date());
    this.#retryMs = options.retryMs ?? 60 * 60 * 1000;
  }

  start(schedule = true): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    if (schedule) this.#schedule(0);
  }

  async ensureDaily(): Promise<CheckpointPackage> {
    const now = this.#clock();
    const day = now.toISOString().slice(0, 10);
    return this.#run({ kind: "daily", day });
  }

  async force(requestId: string): Promise<CheckpointPackage> {
    if (requestId.length === 0) throw new TypeError("Forced checkpoint request id is required");
    return this.#run({ kind: "forced", requestId });
  }

  status(): Promise<RecoveryBackupStatus> {
    return this.options.service.status();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#active?.abort.abort(new Error("Authority checkpoint owner stopped"));
    await this.#active?.promise.catch(() => undefined);
  }

  #run(request: RecoveryCheckpointRequest): Promise<CheckpointPackage> {
    if (!(RECOVERY_CHECKPOINT_OWNER_DESCRIPTOR.phases as readonly string[]).includes(request.kind)) {
      return Promise.reject(new TypeError("Unsupported recovery checkpoint owner phase"));
    }
    if (this.#stopped) return Promise.reject(new Error("Authority checkpoint owner is stopped"));
    const candidateKey = this.options.service.candidateKey(request);
    if (this.#active) {
      return this.#active.candidateKey === candidateKey
        ? this.#active.promise
        : Promise.reject(new Error("checkpoint-candidate-busy"));
    }
    const abort = new AbortController();
    const promise = this.options.service.recoverPending(abort.signal)
      .then(() => this.options.service.createAndReplicate({ request, abort: abort.signal }))
      .then(async (checkpoint) => {
        await this.options.service.cleanupExpired(undefined, abort.signal);
        return checkpoint;
      });
    this.#active = { candidateKey, promise, abort };
    void promise.finally(() => {
      if (this.#active?.promise === promise) this.#active = undefined;
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
