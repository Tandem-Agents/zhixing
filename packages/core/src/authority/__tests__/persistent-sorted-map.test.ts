import { expect, it } from "vitest";
import { PersistentSortedMap } from "../persistent-sorted-map.js";

/** 可复现的伪随机序列，避免测试依赖运行时随机数。 */
function sequence(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (state * 1_664_525 + 1_013_904_223) >>> 0; return state / 0x1_0000_0000; };
}

function sortedEntries(map: Map<string, number>): [string, number][] {
  return [...map].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
}

it("matches an ordinary map under random writes, overwrites and ordered range reads", () => {
  const random = sequence(7);
  const expected = new Map<string, number>();
  let map = PersistentSortedMap.empty<number>();
  for (let step = 0; step < 6_000; step++) {
    const key = "k/" + Math.floor(random() * 2_500).toString(36).padStart(3, "0");
    expected.set(key, step);
    map = map.withEntries([[key, step]]);
    if (step % 997 === 0) {
      expect(map.size).toBe(expected.size);
      expect([...map]).toEqual(sortedEntries(expected));
    }
  }
  expect(map.size).toBe(expected.size);
  for (const [key, value] of expected) expect(map.get(key)).toBe(value);
  expect(map.get("k/absent")).toBeUndefined();
  expect(map.has("k/absent")).toBe(false);
  const all = sortedEntries(expected);
  for (const probe of ["", "k/", "k/1", "k/5z", "k/zzz", "l"]) {
    expect([...map.entriesFrom(probe)]).toEqual(all.filter(([key]) => key >= probe));
  }
});

it("keeps every earlier version readable after later writes", () => {
  const versions: PersistentSortedMap<number>[] = [];
  let map = PersistentSortedMap.empty<number>();
  for (let n = 0; n < 1_000; n++) {
    map = map.withEntries([["key/" + String(n % 300).padStart(4, "0"), n]]);
    if (n % 100 === 99) versions.push(map);
  }
  for (const [index, version] of versions.entries()) {
    const last = index * 100 + 99;
    expect(version.size).toBe(Math.min(300, last + 1));
    for (let slot = 0; slot < Math.min(300, last + 1); slot++) {
      const latest = slot + 300 * Math.floor((last - slot) / 300);
      expect(version.get("key/" + String(slot).padStart(4, "0"))).toBe(latest);
    }
  }
});

it("applies a batch in order, returns the same map for an empty batch and orders by UTF-16 code units", () => {
  const empty = PersistentSortedMap.empty<string>();
  expect(empty.withEntries([])).toBe(empty);
  const map = empty.withEntries([["b", "1"], ["a", "2"], ["b", "3"], ["￿", "4"], ["é", "5"], ["Z", "6"]]);
  expect([...map]).toEqual([["Z", "6"], ["a", "2"], ["b", "3"], ["é", "5"], ["￿", "4"]]);
  expect([...map.values()]).toEqual(["6", "2", "3", "5", "4"]);
  expect(map.size).toBe(5);
  expect([...empty]).toEqual([]);
});
