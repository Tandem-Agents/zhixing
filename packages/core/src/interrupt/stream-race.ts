/**
 * `wrapStreamWithAbortRace` —— stream 中断响应的基础层。
 *
 * 保证:被包装 stream 的 `iterator.next()` 在 `controller.signal.aborted`
 * 后短时间内返回 `{ done: true }`,不依赖底层 stream 自身响应 abort。
 *
 * 与 idle-timer 的关系:race 是基础能力,永远生效,无开关;idle-timer 是
 * 可选叠加层。看门狗 facade 根据 policy 组合两层(`idleTimeoutMs <= 0` 时
 * 仅包 race)。这层解耦的关键收益:idle-timer 关闭时 abort 响应延迟保证
 * 不丢失;mock 测试场景下底层 stream 完全不响应 abortSignal,race 是唯一
 * 能让 watchdog disabled 路径也通过测试的机制;真实 SDK 路径下 race 与 SDK
 * 自身的 abort 响应形成双保险,把"abort 响应延迟上界"从"取决于 SDK"提升到
 * "取决于本模块"。
 *
 * 资源回收:每次 `next()` 前注册 abort listener、settle 后立即
 * `removeEventListener`。任何分支(正常 / abort / throw)都过 cleanup。
 */

/**
 * 包装 stream,让 `iterator.next()` race `controller.signal`:
 * abort 触发后立即返回 `{ done: true }`。
 *
 * 不挂任何 timer、不依赖任何 policy——纯粹的 race 能力。
 */
export function wrapStreamWithAbortRace<T>(
  stream: AsyncIterable<T>,
  controller: AbortController,
): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<T, void, undefined> {
      const iterator = stream[Symbol.asyncIterator]();
      while (true) {
        const result = await raceIteratorWithAbort(iterator, controller.signal);
        if (result.done) return;
        yield result.value;
      }
    },
  };
}

/**
 * race `iterator.next()` 与 abort signal。`wrapStreamWithAbortRace` 的内部 helper,
 * 不对外导出——任何 race 实现优化(改用 AbortSignal.any、不用 Promise constructor 等)
 * 都不应成为 breaking change。外部需要 race 行为时通过 `wrapStreamWithAbortRace`
 * 拿到完整的"every next 自动 race"封装。
 *
 * 行为:
 * - 进入时若 signal 已 aborted → 立即返回 `{ done: true }`,不消费底层 iterator
 *   (避免 pre-aborted 场景仍读一个 chunk)
 * - 否则注册 once listener,任一方 settle 都立即清理 listener
 *
 * abort 后底层 iterator.next 仍在跑——本函数只让 caller 立即拿到 done,底层
 * iterator 的清理由其自身 abort 响应负责(SDK 通常 destroy 底层 fetch;mock
 * 通常永久 hang——但 hang 不影响 caller 已退出)。
 */
async function raceIteratorWithAbort<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T>> {
  if (signal.aborted) return { done: true, value: undefined };

  return new Promise<IteratorResult<T>>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ done: true, value: undefined });
    };

    signal.addEventListener("abort", onAbort, { once: true });

    iterator.next().then(
      (r) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(r);
      },
      (e) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(e);
      },
    );
  });
}
