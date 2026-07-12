import { describe, expect, it } from "vitest";

export interface RuntimeLike<RunInput, RunOptions, Yield, Result, AbortReason> {
  readonly sessionId: string;
  readonly confirmationBroker?: unknown;
  run(input: RunInput, options?: RunOptions): AsyncGenerator<Yield, Result>;
  abort(reason?: AbortReason): boolean;
  dispose(): Promise<void>;
}

export interface RuntimeFactoryLike<
  RunInput,
  RunOptions,
  Yield,
  Result,
  AbortReason,
> {
  create(
    sessionId: string,
  ): Promise<RuntimeLike<RunInput, RunOptions, Yield, Result, AbortReason>>;
}

export interface RuntimeFactoryConformanceHarness<
  RunInput,
  RunOptions,
  Yield,
  Result,
  AbortReason,
> {
  readonly factory: RuntimeFactoryLike<
    RunInput,
    RunOptions,
    Yield,
    Result,
    AbortReason
  >;
  readonly completed: {
    readonly input: RunInput;
    readonly options?: RunOptions;
    readonly yields: readonly Yield[];
    readonly result: Result;
  };
  readonly failed: {
    readonly input: RunInput;
    readonly options?: RunOptions;
    readonly error: unknown;
  };
  readonly interrupted: {
    readonly input: RunInput;
    readonly options?: RunOptions;
    readonly firstYield: Yield;
    readonly reason: AbortReason;
    readonly replacementReason: AbortReason;
    readonly result: Result;
  };
  brokerFor(sessionId: string): unknown;
  expectCompletedInvocation(): void;
  expectDisposed(sessionId: string): void;
}

/** 进程内与远程 adapter 必须复用这组运行、终止和生命周期合同。 */
export function defineRuntimeFactoryConformance<
  RunInput,
  RunOptions,
  Yield,
  Result,
  AbortReason,
>(
  name: string,
  createHarness: () => RuntimeFactoryConformanceHarness<
    RunInput,
    RunOptions,
    Yield,
    Result,
    AbortReason
  >,
): void {
  describe(`${name} runtime factory conformance`, () => {
    it("preserves session identity, broker identity and runtime isolation", async () => {
      const harness = createHarness();
      const first = await harness.factory.create("conversation-a");
      const second = await harness.factory.create("conversation-b");

      expect(first.sessionId).toBe("conversation-a");
      expect(second.sessionId).toBe("conversation-b");
      expect(first).not.toBe(second);
      expect(first.confirmationBroker).toBe(
        harness.brokerFor("conversation-a"),
      );
      expect(second.confirmationBroker).toBe(
        harness.brokerFor("conversation-b"),
      );

      await first.dispose();
      await second.dispose();
      harness.expectDisposed("conversation-a");
      harness.expectDisposed("conversation-b");
    });

    it("preserves yield order and the terminal run result", async () => {
      const harness = createHarness();
      const runtime = await harness.factory.create("conversation-completed");
      const actual = await collect(
        runtime.run(harness.completed.input, harness.completed.options),
      );

      expect(actual.yields).toEqual(harness.completed.yields);
      expect(actual.result).toEqual(harness.completed.result);
      harness.expectCompletedInvocation();

      await runtime.dispose();
      harness.expectDisposed("conversation-completed");
    });

    it("propagates execution failures without inventing a terminal result", async () => {
      const harness = createHarness();
      const runtime = await harness.factory.create("conversation-failed");

      await expect(
        collect(runtime.run(harness.failed.input, harness.failed.options)),
      ).rejects.toBe(harness.failed.error);

      await runtime.dispose();
      harness.expectDisposed("conversation-failed");
    });

    it("aborts only an active run, keeps the first reason and reaches a terminal result", async () => {
      const harness = createHarness();
      const runtime = await harness.factory.create("conversation-interrupted");
      expect(runtime.abort(harness.interrupted.reason)).toBe(false);

      const iterator = runtime.run(
        harness.interrupted.input,
        harness.interrupted.options,
      );
      const first = await iterator.next();
      expect(first).toEqual({
        done: false,
        value: harness.interrupted.firstYield,
      });
      expect(runtime.abort(harness.interrupted.reason)).toBe(true);
      expect(runtime.abort(harness.interrupted.replacementReason)).toBe(false);

      const tail = await collect(iterator);
      expect(tail.yields).toEqual([]);
      expect(tail.result).toEqual(harness.interrupted.result);
      expect(runtime.abort(harness.interrupted.replacementReason)).toBe(false);

      await runtime.dispose();
      harness.expectDisposed("conversation-interrupted");
    });
  });
}

async function collect<Yield, Result>(
  iterator: AsyncGenerator<Yield, Result>,
): Promise<{ yields: Yield[]; result: Result }> {
  const yields: Yield[] = [];
  while (true) {
    const next = await iterator.next();
    if (next.done) return { yields, result: next.value };
    yields.push(next.value);
  }
}
