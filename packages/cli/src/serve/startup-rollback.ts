export interface StartupCleanupHandle {
  readonly name: string;
  run(): Promise<void>;
}

interface StartupCleanupEntry {
  readonly handle: StartupCleanupHandle;
}

/**
 * 启动阶段的逆序补偿事务。
 *
 * 它只负责“资源已经取得、正常停机链尚未完整接管”这一窗口。正常停机仍由
 * CleanupRegistry 决定顺序；两条路径共享同一个幂等 handle，资源只会释放一次。
 */
export class StartupRollback {
  readonly #entries: StartupCleanupEntry[] = [];
  readonly #handles = new WeakSet<StartupCleanupHandle>();
  #committed = false;

  register(
    name: string,
    cleanup: () => void | Promise<void>,
  ): StartupCleanupHandle {
    if (this.#committed) {
      throw new Error("Startup rollback transaction is already committed");
    }
    const handle = createCleanupHandle(name, cleanup);
    this.#handles.add(handle);
    this.#entries.push({ handle });
    return handle;
  }

  owns(handle: StartupCleanupHandle): boolean {
    return this.#handles.has(handle);
  }

  commit(): void {
    this.#committed = true;
    this.#entries.length = 0;
  }

  async rollback(): Promise<void> {
    if (this.#committed) return;
    const failures: unknown[] = [];
    for (const { handle } of this.#entries.splice(0).reverse()) {
      try {
        await handle.run();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Startup rollback failed");
    }
  }
}

function createCleanupHandle(
  name: string,
  cleanup: () => void | Promise<void>,
): StartupCleanupHandle {
  let result: Promise<void> | undefined;
  return {
    name,
    run() {
      result ??= Promise.resolve().then(cleanup);
      return result;
    },
  };
}
