import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { captureCliCommandDescriptor } from "../packages/cli/src/index.ts";
import {
  buildWorkspaceOwnerExposure,
  captureS7EntryCoverage,
  collectCleanupRegistrationsFromSource,
  collectSlashCommandsFromRegistrar,
  discoverSlashRegistrars,
  inspectProductionManifest,
  inspectProductionSource,
  parseLandingRowIds,
  validateCoverage,
  validateInboundRouterAssembly,
  validateSchedulerCurrentArchitecture,
} from "./s7-entry-coverage.mjs";

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
  assert.deepEqual(Object.keys(catalog.roleConfigurations), [
    "anchor-executor",
    "anchor-only",
    "anchor-surface",
    "executor-only",
  ]);
  const anchorExecutor = catalog.roleConfigurations["anchor-executor"].entryKeys;
  const anchorOnly = catalog.roleConfigurations["anchor-only"].entryKeys;
  const anchorSurface = catalog.roleConfigurations["anchor-surface"].entryKeys;
  const executorOnly = catalog.roleConfigurations["executor-only"].entryKeys;
  assert.ok(anchorExecutor.includes("rpc:session.send"));
  assert.ok(anchorExecutor.includes("tool:builtin:memory"));
  assert.ok(anchorOnly.includes("rpc:session.send"));
  assert.ok(!anchorOnly.includes("tool:builtin:memory"));
  assert.ok(anchorSurface.includes("rpc:session.send"));
  assert.ok(!anchorSurface.includes("tool:builtin:memory"));
  assert.ok(!executorOnly.includes("rpc:session.send"));
  assert.ok(executorOnly.includes("tool:builtin:memory"));
});

test("landing rows and mapping tuples preserve multiplicity until validation", () => {
  const specification = `## 八、落点矩阵（入口 / 操作 × 落点）

| rowId | 操作 | 现有入口 | 准入 / 记账 | 执行 | 权威落点 |
|---|---|---|---|---|---|
| \`known-row\` | one | one | one | one | one |

## 九、能力矩阵`;
  assert.deepEqual(parseLandingRowIds(specification), ["known-row"]);
  assert.throws(
    () => parseLandingRowIds(specification.replace(
      "\n\n## 九、能力矩阵",
      "\n| `known-row` | two | two | two | two | two |\n\n## 九、能力矩阵",
    )),
    /duplicate landing matrix rowId/,
  );
  fails({
    entries: [entry],
    mappings: [
      ["rpc:one", { rowId: "known-row" }],
      ["rpc:one", { rowId: "known-row" }],
    ],
    rowIds,
  }, /duplicate mapping target/);
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
  fails({ entries: [entry], mappings: { "rpc:one": { exclusion: "connection", reason: "drifted" } }, rowIds }, /invalid exclusion/);
  fails({ entries: [entry], mappings: { "rpc:one": { rowId: "known-row", extra: true } }, rowIds }, /invalid row target schema/);
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

test("Commander and slash capture consume the actual production registration graph", async () => {
  const command = (name, action) => ({
    name: () => name,
    registeredArguments: [],
    commands: [],
    listeners: () => [],
    ...(action ? { _actionHandler: action } : {}),
  });
  const root = command("root");
  root.commands = [command("actionless"), command("actioned", () => undefined)];
  const commander = captureCliCommandDescriptor(root);
  assert.equal(commander.find((item) => item.path === "root actionless").hasAction, false);
  assert.equal(commander.find((item) => item.path === "root actioned").hasAction, true);

  const repl = await readFile("packages/cli/src/repl.ts", "utf8");
  const registrars = discoverSlashRegistrars(repl);
  assert.deepEqual(
    registrars.map((item) => item.functionName).sort(),
    [
      "registerConfigCommands",
      "registerInfoCommands",
      "registerModeCommands",
      "registerSessionCommands",
      "registerSkillsCommand",
      "registerTaskCommands",
    ],
  );
  assert.throws(
    () => discoverSlashRegistrars(
      repl.replace("tRegistry.registerDynamicSource(", "tRegistry.ignoreDynamicSource("),
    ),
    /SkillCommandSource is not registered/,
  );
  const info = await readFile("packages/cli/src/commands/info-commands.ts", "utf8");
  assert.ok(
    collectSlashCommandsFromRegistrar(
      "packages/cli/src/commands/info-commands.ts",
      info,
      "registerInfoCommands",
    ).some((item) => item.id === "help:repl"),
  );
  assert.throws(
    () => collectSlashCommandsFromRegistrar(
      "packages/cli/src/commands/info-commands.ts",
      info.replace('id: "help:repl"', "id: buildHelpId()"),
      "registerInfoCommands",
    ),
    /non-literal command descriptor/,
  );
});

test("cleanup and channel coverage are bound to actual production calls", async () => {
  const cleanupSources = [
    "packages/server/src/lifecycle.ts",
    "packages/cli/src/serve/command.ts",
    "packages/cli/src/serve/shutdown-chain.ts",
    "packages/cli/src/serve/access-surfaces.ts",
  ];
  const descriptors = [];
  for (const source of cleanupSources) {
    descriptors.push(...collectCleanupRegistrationsFromSource(
      source,
      await readFile(source, "utf8"),
    ));
  }
  assert.ok(descriptors.length >= 20);
  const command = await readFile("packages/cli/src/serve/command.ts", "utf8");
  assert.throws(
    () => collectCleanupRegistrationsFromSource(
      "packages/cli/src/serve/command.ts",
      command.replace(
        'registerCleanup(registry, { role: "runtime", id: "meshRuntime.stop" }, async () => {',
        'registry.register("meshRuntime.stop", async () => {',
      ),
    ),
    /bypasses registerCleanup descriptor/,
  );
  assert.throws(
    () => collectCleanupRegistrationsFromSource(
      "packages/cli/src/serve/command.ts",
      command.replace(
        'registerCleanup(registry, { role: "runtime", id: "meshRuntime.stop" }, async () => {',
        'const shutdowns = registry; shutdowns.register("meshRuntime.stop", async () => {',
      ),
    ),
    /bypasses registerCleanup descriptor/,
  );
  const channels = await readFile("packages/cli/src/serve/channels.ts", "utf8");
  validateInboundRouterAssembly(channels);
  assert.throws(
    () => validateInboundRouterAssembly(
      channels.replace("new InboundRouter(", "new MissingInboundRouter("),
    ),
    /assembly count must be 1/,
  );
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

test("finite dependency syntax and manifests cannot bypass owner or role isolation", () => {
  const guarded = "packages/orchestrator/src/mutation.ts";
  for (const source of [
    'import { MemoryStore as Alias } from "@zhixing/core";',
    'export { MemoryStore as Alias } from "@zhixing/core";',
    'import * as core from "@zhixing/core";',
    'export * from "@zhixing/core";',
    'const core = await import("@zhixing/core");',
    'const core = require("@zhixing/core");',
    'import core = require("@zhixing/core");',
  ]) {
    assert.match(inspectProductionSource(guarded, source).join("\n"), /forbidden writable owner/);
  }
  assert.match(
    inspectProductionSource(
      "packages/server/src/bad-owner.ts",
      'import { MemoryStore } from "@zhixing/core";',
    ).join("\n"),
    /forbidden writable owner import MemoryStore/,
  );
  assert.match(
    inspectProductionSource(guarded, "const core = await import(target);").join("\n"),
    /non-literal production module load/,
  );
  assert.deepEqual(
    inspectProductionSource(
      guarded,
      'import type { SchedulerFacade } from "@zhixing/core";',
    ),
    [],
  );
  assert.match(
    inspectProductionSource(
      "packages/server/src/bad.ts",
      'const executor = await import("@zhixing/executor");',
    ).join("\n"),
    /server imports executor/,
  );
  assert.match(
    inspectProductionManifest("packages/server/package.json", {
      dependencies: { "@zhixing/executor": "workspace:*" },
    }).join("\n"),
    /production dependency on executor/,
  );
  assert.deepEqual(
    inspectProductionManifest("packages/server/package.json", {
      devDependencies: { "@zhixing/executor": "workspace:*" },
    }),
    [],
  );
});

test("workspace re-export aliases resolve back to the writable owner", async () => {
  const records = [
    {
      relative: "packages/core/src/store.ts",
      text: "export class MemoryStore {}",
    },
    {
      relative: "packages/core/src/index.ts",
      text: 'export { MemoryStore } from "./store.js";',
    },
    {
      relative: "packages/bridge/src/index.ts",
      text: 'import { MemoryStore as LocalStore } from "@zhixing/core"; export { LocalStore as WritableMemory };',
    },
  ];
  const resolver = await buildWorkspaceOwnerExposure(records, new Map([
    ["@zhixing/core", "packages/core/src/index.ts"],
    ["@test/bridge", "packages/bridge/src/index.ts"],
  ]));
  assert.match(
    inspectProductionSource(
      "packages/orchestrator/src/bad.ts",
      'import { WritableMemory as Alias } from "@test/bridge";',
      { resolveOwnerExposure: resolver },
    ).join("\n"),
    /MemoryStore as Alias/,
  );
});

test("all public CLI RPC calls are canonical and dynamic forwarders are closed", async () => {
  const stop = await readFile("packages/cli/src/serve/stop.ts", "utf8");
  assert.deepEqual(inspectProductionSource("packages/cli/src/serve/stop.ts", stop), []);
  assert.match(
    inspectProductionSource(
      "packages/cli/src/serve/stop.ts",
      stop.replace('"server.shutdown"', '"server.notRegistered"'),
    ).join("\n"),
    /unknown RPC server\.notRegistered/,
  );
  assert.match(
    inspectProductionSource(
      "packages/cli/src/runtime/rpc-bad.ts",
      "client.request(method);",
    ).join("\n"),
    /non-canonical dynamic RPC method/,
  );
  assert.match(
    inspectProductionSource(
      "packages/cli/src/serve/aliased-client.ts",
      'import { createRpcClient as connect } from "@zhixing/server"; const client = connect({}); client.request(method);',
    ).join("\n"),
    /non-canonical dynamic RPC method/,
  );
  assert.match(
    inspectProductionSource(
      "packages/cli/src/runtime/rpc-public.ts",
      'class PublicFacade { request(method) { return this.client.request(method); } call() { return this.request("session.send"); } }',
    ).join("\n"),
    /non-canonical dynamic RPC method/,
  );
  const conversation = await readFile(
    "packages/cli/src/runtime/rpc-conversation-facade.ts",
    "utf8",
  );
  assert.deepEqual(
    inspectProductionSource(
      "packages/cli/src/runtime/rpc-conversation-facade.ts",
      conversation,
    ),
    [],
  );
});

test("scheduler current section freezes old retirement and new AuthorityDelivery", async () => {
  const scheduler = await readFile(
    "research/design/drafts/scheduler-architecture.md",
    "utf8",
  );
  validateSchedulerCurrentArchitecture(scheduler);
  assert.throws(
    () => validateSchedulerCurrentArchitecture(
      scheduler.replace("已整体退役", "只允许一次性排空迁移，排空后删除"),
    ),
    /missing retirement fact|stale migration wording/,
  );
});
