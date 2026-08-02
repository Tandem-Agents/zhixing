export interface ManualJobSurfaceSession {
  close(reason?: Error): Promise<void>;
}

export interface ManualJobSurfaceRegistration {
  readonly assignmentId: string;
  readonly jobRunId: string;
  readonly open: () => Promise<ManualJobSurfaceSession>;
}

type ManualJobSurfacePhase =
  | "pending"
  | "opening"
  | "open"
  | "closing"
  | "retired";

interface ManualJobSurfaceEntry {
  readonly assignmentId: string;
  readonly jobRunId: string;
  open: () => Promise<ManualJobSurfaceSession>;
  phase: ManualJobSurfacePhase;
  opening?: Promise<void>;
  session?: ManualJobSurfaceSession;
}

/** Owns one manual data-plane session for each durable job assignment. */
export class ManualJobSurfaceLifecycle {
  readonly #entries = new Map<string, ManualJobSurfaceEntry>();
  readonly #terminalJobRuns = new Set<string>();
  readonly #retryMs: number;
  readonly #onError?: (error: Error) => void;
  #ready = false;
  #stopped = false;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: {
    readonly retryMs?: number;
    readonly onError?: (error: Error) => void;
  } = {}) {
    this.#retryMs = options.retryMs ?? 1_000;
    if (!Number.isSafeInteger(this.#retryMs) || this.#retryMs <= 0) {
      throw new TypeError("Manual surface retry interval must be positive");
    }
    this.#onError = options.onError;
  }

  register(registration: ManualJobSurfaceRegistration): void {
    if (this.#stopped) return;
    const current = this.#entries.get(registration.assignmentId);
    if (current) {
      if (current.jobRunId !== registration.jobRunId) {
        throw new Error("Manual surface assignment changed its job identity");
      }
      current.open = registration.open;
      if (this.#ready && current.phase === "pending") {
        void this.#ensureAndReport(current);
      }
      return;
    }
    const entry: ManualJobSurfaceEntry = {
      assignmentId: registration.assignmentId,
      jobRunId: registration.jobRunId,
      open: registration.open,
      phase: this.#terminalJobRuns.has(registration.jobRunId)
        ? "closing"
        : "pending",
    };
    this.#entries.set(registration.assignmentId, entry);
    if (this.#ready && entry.phase === "pending") {
      void this.#ensureAndReport(entry);
    }
  }

  async resume(): Promise<void> {
    if (this.#stopped) return;
    this.#ready = true;
    await Promise.all(
      [...this.#entries.values()]
        .filter((entry) => entry.phase === "pending")
        .map((entry) => this.#ensureAndReport(entry)),
    );
  }

  async markJobTerminal(jobRunId: string): Promise<void> {
    this.#terminalJobRuns.add(jobRunId);
    await Promise.all(
      [...this.#entries.values()]
        .filter((entry) => entry.jobRunId === jobRunId)
        .map(async (entry) => {
          if (entry.phase === "retired") return;
          entry.phase = "closing";
          await this.#closeCurrent(entry);
        }),
    );
  }

  async retire(assignmentId: string, jobRunId: string): Promise<void> {
    const entry = this.#entries.get(assignmentId);
    if (!entry) {
      this.#forgetTerminalJob(jobRunId);
      return;
    }
    entry.phase = "retired";
    await entry.opening?.catch(() => undefined);
    await this.#closeCurrent(entry);
    this.#entries.delete(assignmentId);
    this.#forgetTerminalJob(entry.jobRunId);
  }

  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#ready = false;
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    const entries = [...this.#entries.values()];
    for (const entry of entries) entry.phase = "retired";
    await Promise.all(
      entries.map(async (entry) => {
        await entry.opening?.catch(() => undefined);
        await this.#closeCurrent(entry);
      }),
    );
    this.#entries.clear();
    this.#terminalJobRuns.clear();
  }

  async #ensureAndReport(entry: ManualJobSurfaceEntry): Promise<void> {
    try {
      await this.#ensure(entry);
    } catch (error) {
      this.#onError?.(asError(error));
      this.#scheduleRetry();
    }
  }

  async #ensure(entry: ManualJobSurfaceEntry): Promise<void> {
    if (this.#stopped || !this.#ready || entry.phase !== "pending") return;
    if (entry.opening) return entry.opening;
    entry.phase = "opening";
    const opening = (async () => {
      try {
        const session = await entry.open();
        if (entry.phase !== "opening" || this.#stopped) {
          await session.close(
            new Error("Manual job surface finished before opening completed"),
          );
          return;
        }
        entry.session = session;
        entry.phase = "open";
      } catch (error) {
        if (entry.phase === "opening") entry.phase = "pending";
        throw error;
      }
    })();
    entry.opening = opening;
    try {
      await opening;
    } finally {
      if (entry.opening === opening) entry.opening = undefined;
    }
  }

  async #closeCurrent(entry: ManualJobSurfaceEntry): Promise<void> {
    const session = entry.session;
    if (!session) return;
    entry.session = undefined;
    try {
      await session.close(new Error("Manual job surface reached a terminal state"));
    } catch (error) {
      this.#onError?.(asError(error));
    }
  }

  #scheduleRetry(): void {
    if (this.#stopped || !this.#ready || this.#retryTimer) return;
    if (![...this.#entries.values()].some((entry) => entry.phase === "pending")) {
      return;
    }
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      void Promise.all(
        [...this.#entries.values()]
          .filter((entry) => entry.phase === "pending")
          .map((entry) => this.#ensureAndReport(entry)),
      ).then(() => {
        if ([...this.#entries.values()].some((entry) => entry.phase === "pending")) {
          this.#scheduleRetry();
        }
      });
    }, this.#retryMs);
    this.#retryTimer.unref?.();
  }

  #forgetTerminalJob(jobRunId: string): void {
    if (![...this.#entries.values()].some((entry) => entry.jobRunId === jobRunId)) {
      this.#terminalJobRuns.delete(jobRunId);
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
