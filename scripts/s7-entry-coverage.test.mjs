import assert from "node:assert/strict";
import test from "node:test";
import { captureS7EntryCoverage, inspectProductionSource, validateCoverage } from "./s7-entry-coverage.mjs";

const rowIds = ["known-row"];
const entry = { key: "rpc:one", category: "rpc" };

function fails(input, message) {
  assert.throws(() => validateCoverage(input), message);
}

test("production descriptors form a complete exact-set coverage catalog", async () => {
  const catalog = await captureS7EntryCoverage();
  assert.ok(catalog.rowIds.length > 0);
  assert.ok(catalog.entries.length > 0);
  assert.deepEqual(catalog.entries, [...catalog.entries].sort((a, b) => a.key.localeCompare(b.key, "en-US")));
});

test("empty, duplicate, unmapped and double-mapped inputs fail deterministically", () => {
  fails({ entries: [], mappings: {}, rowIds }, /entry set is empty/);
  fails({ entries: [entry, entry], mappings: { "rpc:one": { rowId: "known-row" } }, rowIds }, /duplicate entry key/);
  fails({ entries: [entry], mappings: {}, rowIds }, /unmapped entry/);
  fails({ entries: [entry], mappings: { "rpc:one": [{ rowId: "known-row" }, { exclusion: "connection" }] }, rowIds }, /exactly one target/);
});

test("unknown rows, invalid exclusions and stale mappings fail", () => {
  fails({ entries: [entry], mappings: { "rpc:one": { rowId: "deleted-row" } }, rowIds }, /unknown rowId/);
  fails({ entries: [entry], mappings: { "rpc:one": { exclusion: "unknown", reason: "x" } }, rowIds }, /invalid exclusion/);
  fails({ entries: [entry], mappings: { "rpc:one": { rowId: "known-row" }, "rpc:stale": { rowId: "known-row" } }, rowIds }, /stale mapping/);
});

test("unstable ordering fails", () => {
  fails({
    entries: [{ key: "rpc:z", category: "rpc" }, { key: "rpc:a", category: "rpc" }],
    mappings: { "rpc:z": { rowId: "known-row" }, "rpc:a": { rowId: "known-row" } },
    rowIds,
  }, /not stably sorted/);
});

test("command descriptors fail on name conflicts, unsafe dynamic skills and actionless mappings", () => {
  fails({
    entries: [
      { key: "slash:one", category: "slash", name: "same" },
      { key: "slash:two", category: "slash", name: "same" },
    ],
    mappings: {
      "slash:one": { rowId: "known-row" },
      "slash:two": { rowId: "known-row" },
    },
    rowIds,
  }, /duplicate slash command name/);
  fails({
    entries: [{ key: "slash:skill:<catalog-id>", category: "slash", name: "<catalog-id>", execution: "local" }],
    mappings: { "slash:skill:<catalog-id>": { rowId: "known-row" } },
    rowIds,
  }, /builtin-first collision policy/);
  fails({
    entries: [{ key: "cli:actionless", category: "cli", hasAction: false }],
    mappings: { "cli:actionless": { rowId: "known-row" } },
    rowIds,
  }, /mapped CLI command has no action/);
});

test("retired entry, writable Store and reverse package dependency mutations fail", () => {
  assert.match(
    inspectProductionSource("packages/orchestrator/src/mutation.ts", 'import { MemoryStore } from "@zhixing/core";')[0],
    /forbidden writable owner import MemoryStore/,
  );
  assert.match(
    inspectProductionSource("packages/server/src/bad.ts", 'import "@zhixing/executor";')[0],
    /server imports executor/,
  );
  assert.match(
    inspectProductionSource(
      "packages/cli/src/runtime/rpc-bad.ts",
      'client.request("session.notRegistered");',
    )[0],
    /CLI forwards to unknown RPC session\.notRegistered/,
  );
  assert.match(
    inspectProductionSource("packages/cli/src/bad.ts", 'const name = "LegacyDeliveryDrainer";')[0],
    /retired token LegacyDeliveryDrainer/,
  );
});
