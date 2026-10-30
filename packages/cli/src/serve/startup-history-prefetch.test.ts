import { describe, expect, it } from "vitest";
import { AssemblyLifecycleContributions } from "./assembly-lifecycle.js";
import { StartupHistoryPrefetch } from "./startup-history-prefetch.js";
import { StartupRollback } from "./startup-rollback.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** 可控的来源：读取次数、可暂停的读取、可变的来源身份。 */
function source() {
  const state = {
    loads: [] as Array<[string, number | undefined]>,
    identity: "source-1" as string | undefined,
    pause: undefined as ReturnType<typeof deferred> | undefined,
    fail: false,
    settled: 0,
  };
  const prefetch = new StartupHistoryPrefetch<string>({
    load: async (conversationId, committedTurnCount) => {
      state.loads.push([conversationId, committedTurnCount]);
      const read = `${conversationId}:${committedTurnCount}:${state.identity}:${state.loads.length}`;
      try {
        if (state.pause) await state.pause.promise;
        if (state.fail) throw new Error("read failed");
        return read;
      } finally { state.settled++; }
    },
    identity: async (_conversationId, committedTurnCount) =>
      state.identity === undefined ? undefined : `${committedTurnCount}|${state.identity}`,
  });
  return { state, prefetch };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("启动历史预读", () => {
  it("来源未变时同会话的首次装载取用预读结果，不再读取", async () => {
    const { state, prefetch } = source();
    await prefetch.prefetch("c1", 3);
    expect(await prefetch.load("c1", 3)).toBe("c1:3:source-1:1");
    expect(state.loads).toHaveLength(1);
    // 取用即丢弃：再次装载按原路径读取
    expect(await prefetch.load("c1", 3)).toBe("c1:3:source-1:2");
  });

  it("来源身份变化、承诺轮数不同或预读失败时按原路径读取", async () => {
    const changed = source();
    await changed.prefetch.prefetch("c1", 3);
    changed.state.identity = "source-2";
    expect(await changed.prefetch.load("c1", 3)).toBe("c1:3:source-2:2");

    const recount = source();
    await recount.prefetch.prefetch("c1", 3);
    expect(await recount.prefetch.load("c1", 4)).toBe("c1:4:source-1:2");

    const failed = source();
    failed.state.fail = true;
    await failed.prefetch.prefetch("c1", 3);
    failed.state.fail = false;
    expect(await failed.prefetch.load("c1", 3)).toBe("c1:3:source-1:2");
  });

  it("别的会话的装载不取走预读；来源身份未知时不预读", async () => {
    const { state, prefetch } = source();
    await prefetch.prefetch("c1", 3);
    await prefetch.load("c2", 1);
    expect(await prefetch.load("c1", 3)).toBe("c1:3:source-1:1");
    expect(state.loads).toHaveLength(2);

    const unknown = source();
    unknown.state.identity = undefined;
    await unknown.prefetch.prefetch("c1", 3);
    expect(unknown.state.loads).toHaveLength(0);
  });

  it("读取暂停时关闭：等读取结算才返回，之后既不取用也不再发起", async () => {
    const { state, prefetch } = source();
    state.pause = deferred();
    void prefetch.prefetch("c1", 3);
    await tick();
    let closed = false;
    const closing = prefetch.close().then(() => { closed = true; });
    await tick();
    expect(closed).toBe(false);
    state.pause.resolve();
    state.pause = undefined;
    await closing;
    expect(state.settled).toBe(1);
    // 关闭前读完的结果不晚发布
    expect(await prefetch.load("c1", 3)).toBe("c1:3:source-1:2");
    await prefetch.prefetch("c1", 3);
    expect(state.loads).toHaveLength(2);
  });

  it("启动回滚经装配 owner：暂停在读取或元信息上的预读收敛之后才关闭存储，回滚有限完成", async () => {
    for (const pausedAt of ["read", "meta"] as const) {
      const { state, prefetch } = source();
      const rollback = new StartupRollback();
      const contributions = new AssemblyLifecycleContributions(rollback);
      const events: string[] = [];
      // 先登记的存储关闭后执行（与宿主装配同序）
      rollback.register("conversationStorage.close", () => { events.push(`storage-closed:${state.settled}`); });
      const meta = deferred<number>();
      if (pausedAt === "read") state.pause = deferred();
      let stopped = false;
      const task = (async () => {
        const turnCount = await meta.promise;
        if (!stopped) await prefetch.prefetch("c1", turnCount);
      })().catch(() => undefined);
      contributions.acquire("startupHistoryPrefetch.close", async () => {
        stopped = true;
        await Promise.all([task, prefetch.close()]);
      });
      if (pausedAt === "read") { meta.resolve(3); await tick(); }
      let finished = false;
      const rolling = rollback.rollback().then(() => { finished = true; });
      await tick();
      expect(finished).toBe(false);
      expect(events).toEqual([]);
      if (pausedAt === "read") state.pause!.resolve();
      else meta.resolve(3);
      await rolling;
      expect(events).toEqual([`storage-closed:${pausedAt === "read" ? 1 : 0}`]);
      // 停止之后才返回的元信息不再发起读取
      expect(state.loads).toHaveLength(pausedAt === "read" ? 1 : 0);
    }
  });
});
