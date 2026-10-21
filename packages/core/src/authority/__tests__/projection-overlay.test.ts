import { expect, it, vi } from "vitest";
import { createDurableProjectionOverlay, type DurableProjectionReadContext } from "../durable-projection-index.js";
import type { JsonValue } from "../../contracts/index.js";

function source(): DurableProjectionReadContext {
  const entries = ["a", "c", "d", "e", "f"].map(key => ({ key, value: key }));
  return {
    get: async key => entries.find(entry => entry.key === key)?.value,
    scan: async (range, limit) => {
      const selected = entries.filter(({ key }) => (range.gte === undefined || key >= range.gte) &&
        (range.gt === undefined || key > range.gt) && (range.lt === undefined || key < range.lt));
      return { entries: selected.slice(0, limit), ...(selected.length > limit ? { continuation: "more" } : {}) };
    },
  };
}

it('keeps candidate masks and duplicate-key order when batching physical reads', async () => {
  const getMany = vi.fn(async (keys: readonly string[]) => keys.map(key => key === 'd' ? 'base-d' : undefined));
  const overlay = createDurableProjectionOverlay({ ...source(), getMany },
    new Map<string, JsonValue | undefined>([['a', 'candidate-a'], ['c', undefined], ['z', 'candidate-z']]));
  expect(await overlay.getMany!(['a', 'c', 'd', 'd', 'missing', 'z']))
    .toEqual(['candidate-a', undefined, 'base-d', 'base-d', undefined, 'candidate-z']);
  expect(getMany).toHaveBeenCalledTimes(1);
  expect(getMany).toHaveBeenCalledWith(['d', 'd', 'missing']);
  await expect(overlay.getMany!(Array(257).fill('a'))).rejects.toThrow();
  expect(getMany).toHaveBeenCalledTimes(1);
});

it("merges candidate inserts, replacements and deletions across finite pages without gaps", async () => {
  const overlay = createDurableProjectionOverlay(source(), new Map<string, JsonValue | undefined>([
    ["a", "updated"], ["b", "new"], ["c", undefined], ["e", undefined], ["z", "last"],
  ]));
  const rows: unknown[] = [];
  let continuation: string | undefined;
  do {
    const page = await overlay.scan({ gte: "a", lt: "zz" }, 2, continuation);
    expect(page.entries.length).toBeLessThanOrEqual(2);
    rows.push(...page.entries);
    continuation = page.continuation;
  } while (continuation);
  expect(rows).toEqual([
    { key: "a", value: "updated" }, { key: "b", value: "new" },
    { key: "d", value: "d" }, { key: "f", value: "f" }, { key: "z", value: "last" },
  ]);
  expect(await overlay.get("c")).toBeUndefined();
  expect(await overlay.get("a")).toBe("updated");
});

it("binds candidate continuations to their original range", async () => {
  const overlay = createDurableProjectionOverlay(source(), new Map());
  const first = await overlay.scan({ gte: "c", lt: "z" }, 1);
  expect(first.continuation).toBeDefined();
  await expect(overlay.scan({ gte: "a", lt: "z" }, 1, first.continuation)).rejects.toThrow("continuation");
  const forged = Buffer.from(JSON.stringify({ range: '{"gte":"c","lt":"z"}', after: "a" })).toString("base64url");
  await expect(overlay.scan({ gte: "c", lt: "z" }, 1, forged)).rejects.toThrow("continuation");
});
