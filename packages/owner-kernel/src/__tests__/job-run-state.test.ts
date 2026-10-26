/**
 * 装入重做的边界：缺行逐轮装入；轮数耗尽、或缺行属于本组却装了还缺，给出 JobStateExhausted
 * （不是准备或背压类错误，不进入任何自动重试）；缺行都不属于本组时原样交给外层；一次报出的成批缺行照常补齐。
 */
import { AuthorityPreparationRequired, awaitAuthorityPreparation, type DurableProjectionReadContext } from "@zhixing/core/authority";
import type { JsonValue } from "@zhixing/core/contracts";
import { maintenanceRetryDelayMs } from "@zhixing/core/resources";
import { describe, expect, it } from "vitest";
import {
  JobStateBinding,
  JobStateExhausted,
  JobStateRequired,
  JobStateSet,
  KeyedMap,
  MAX_JOB_STATE_ROUNDS,
  runWithJobState,
  type JobStateField,
} from "../job-run-state.js";

const PREFIX = "job/task/m/";
const FIELDS = new Map<string, JobStateField>([["rows", { name: "rows", kind: "map" }]]);

function store(rows = new Map<string, JsonValue>()) {
  const counts = { batches: 0, keys: 0 };
  const read = {
    get: async (key: string) => rows.get(key),
    getMany: async (keys: readonly string[]) => {
      counts.batches += 1;
      counts.keys += keys.length;
      return keys.map((key) => rows.get(key));
    },
    scan: async () => ({ entries: [] }),
  } as unknown as DurableProjectionReadContext;
  return { read, counts };
}

describe("job state redo boundary", () => {
  it("gives up with a non-preparation error once the round limit is spent", async () => {
    const { read, counts } = store();
    const base = new JobStateSet(PREFIX, FIELDS);
    const binding = new JobStateBinding(base);
    let attempts = 0;
    const failure = await runWithJobState([[binding, base]], read, () => {
      attempts += 1;
      const rows = new KeyedMap<string, number>(binding, "rows");
      // 每轮只缺一行：逐行读 80 个不存在的键
      for (let index = 0; index < 80; index++) rows.get(`row-${index}`);
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(JobStateExhausted);
    expect(failure).toMatchObject({
      code: "job-state-exhausted", reason: "rounds", rounds: MAX_JOB_STATE_ROUNDS + 1,
      loaded: { "m:rows": MAX_JOB_STATE_ROUNDS }, missing: { "m:rows": 1 },
    });
    expect(attempts).toBe(MAX_JOB_STATE_ROUNDS + 1);
    expect(counts.keys).toBe(MAX_JOB_STATE_ROUNDS);
    // 任何一层都不会自动重试它：不是准备、也不是背压
    expect(failure).not.toBeInstanceOf(AuthorityPreparationRequired);
    expect(maintenanceRetryDelayMs(failure)).toBeUndefined();
    expect(await awaitAuthorityPreparation(failure)).toBe(false);
    expect(String((failure as Error).message)).toContain("m:rows 64");
  });

  it("reports no progress when the rows it asks for are already loaded", async () => {
    const { read, counts } = store();
    const base = new JobStateSet(PREFIX, FIELDS);
    const key = base.storageKey("rows", "loaded");
    base.loadStored(key, undefined);
    const binding = new JobStateBinding(base);
    const failure = await runWithJobState([[binding, base]], read, () => {
      throw new JobStateRequired([{ key }]);
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: "JobStateExhausted", reason: "no-progress", rounds: 1, missing: { "m:rows": 1 } });
    expect(counts.batches).toBe(0);
  });

  it("hands rows owned by another working set to the layer that owns them", async () => {
    const { read } = store();
    const base = new JobStateSet(PREFIX, FIELDS);
    const binding = new JobStateBinding(base);
    const foreign = new JobStateRequired([{ key: "job/task/g/rows/elsewhere" }]);
    const failure = await runWithJobState([[binding, base]], read, () => { throw foreign; }).catch((error: unknown) => error);
    expect(failure).toBe(foreign);
  });

  it("still fills a large batch of missing rows reported at once", async () => {
    const rows = new Map<string, JsonValue>();
    const base = new JobStateSet(PREFIX, FIELDS);
    const keys = Array.from({ length: 300 }, (_, index) => base.storageKey("rows", `row-${index}`));
    keys.forEach((key, index) => rows.set(key, { k: `row-${index}`, v: index }));
    const { read, counts } = store(rows);
    const binding = new JobStateBinding(base);
    let attempts = 0;
    const total = await runWithJobState([[binding, base]], read, () => {
      attempts += 1;
      binding.store.requireRows(keys);
      const map = new KeyedMap<string, number>(binding, "rows");
      return keys.reduce((sum, _key, index) => sum + map.get(`row-${index}`)!, 0);
    });
    expect(total).toBe((299 * 300) / 2);
    expect(attempts).toBe(2);
    expect(counts.batches).toBe(2);
  });
});
