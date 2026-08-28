import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { captureCliCommandDescriptor } from "../packages/cli/src/index.ts";
import {
  buildWorkspaceOwnerExposure,
  buildWorkspaceSymbolExposure,
  buildServeRoleConfigurations,
  captureS7EntryCoverage,
  collectCleanupRegistrationsFromSource,
  collectSlashCommandsFromRegistrar,
  discoverSlashRegistrars,
  inspectProductionManifest,
  inspectProductionSource,
  inspectCleanupRegistryConstructions,
  inspectConversationAdoptionAssembly,
  inspectDeviceLifecycleAssembly,
  inspectLocalConversationOwnerIsolation,
  inspectManagedHostAssembly,
  inspectPlannedAnchorTransferAssembly,
  inspectRecoveryBackupAssembly,
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

function replaceExactlyOnce(text, pattern, replacement, label) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const matches = [...text.matchAll(new RegExp(pattern.source, flags))];
  if (matches.length !== 1) {
    throw new Error(`${label}: expected exactly one mutation match, found ${matches.length}`);
  }
  return text.replace(pattern, replacement);
}

test("required source mutations reject zero and multiple matches", () => {
  assert.throws(
    () => replaceExactlyOnce("unchanged", /missing/u, "changed", "required-order"),
    /required-order: expected exactly one mutation match, found 0/,
  );
  assert.throws(
    () => replaceExactlyOnce("needle\nneedle", /needle/gu, "changed", "required-order"),
    /required-order: expected exactly one mutation match, found 2/,
  );
});

test("production descriptors form a complete exact-set coverage catalog", async () => {
  const catalog = await captureS7EntryCoverage();
  assert.ok(catalog.rowIds.length > 0);
  assert.ok(catalog.entries.length > 0);
  assert.deepEqual(catalog.entries, [...catalog.entries].sort((a, b) => a.key.localeCompare(b.key, "en-US")));
  assert.deepEqual(Object.keys(catalog.roleConfigurations), [
    "anchor-executor",
    "anchor-executor-surface",
    "anchor-only",
    "anchor-surface",
    "executor-only",
    "executor-surface",
    "disabled-empty",
    "surface-only",
  ]);
  const anchorExecutor = catalog.roleConfigurations["anchor-executor"].entryKeys;
  const anchorExecutorSurface = catalog.roleConfigurations["anchor-executor-surface"].entryKeys;
  const anchorOnly = catalog.roleConfigurations["anchor-only"].entryKeys;
  const anchorSurface = catalog.roleConfigurations["anchor-surface"].entryKeys;
  const executorOnly = catalog.roleConfigurations["executor-only"].entryKeys;
  const executorSurface = catalog.roleConfigurations["executor-surface"].entryKeys;
  const disabledEmpty = catalog.roleConfigurations["disabled-empty"].entryKeys;
  const surfaceOnly = catalog.roleConfigurations["surface-only"].entryKeys;
  assert.deepEqual(anchorExecutorSurface, anchorExecutor);
  assert.deepEqual(anchorSurface, anchorOnly);
  assert.deepEqual(executorSurface, executorOnly);
  assert.deepEqual(surfaceOnly, disabledEmpty);
  for (const [roleName, configuration] of Object.entries(catalog.roleConfigurations)) {
    assert.ok(
      !configuration.entryKeys.includes("tool:builtin:memory"),
      `${roleName} must not register the retired builtin memory tool`,
    );
  }
  assert.ok(anchorExecutor.includes("rpc:session.send"));
  assert.ok(anchorExecutor.includes(
    "cleanup:anchor-local-executor:runtime:executorDataPlane.close",
  ));
  assert.ok(anchorOnly.includes("rpc:session.send"));
  assert.ok(!anchorOnly.includes(
    "cleanup:anchor-local-executor:runtime:executorDataPlane.close",
  ));
  assert.ok(anchorSurface.includes("rpc:session.send"));
  assert.ok(!executorOnly.includes("rpc:session.send"));
  assert.ok(!executorOnly.some((key) => key.startsWith("cleanup:")));
  assert.ok(!disabledEmpty.some((key) => key.startsWith("cleanup:")));
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
        'registerCleanup(registry, { owner: "anchor-host", role: "runtime", id: "meshRuntime.stop" }, async () => {',
        'registry.register("meshRuntime.stop", async () => {',
      ),
    ),
    /bypasses registerCleanup descriptor/,
  );
  assert.throws(
    () => collectCleanupRegistrationsFromSource(
      "packages/cli/src/serve/command.ts",
      command.replace(
        'registerCleanup(registry, { owner: "anchor-host", role: "runtime", id: "meshRuntime.stop" }, async () => {',
        'const shutdowns = registry; shutdowns.register("meshRuntime.stop", async () => {',
      ),
    ),
    /bypasses registerCleanup descriptor/,
  );
  assert.throws(
    () => collectCleanupRegistrationsFromSource(
      "packages/cli/src/serve/command.ts",
      command.replace('owner: "anchor-host", role: "runtime", id: "meshRuntime.stop"', 'role: "runtime", id: "meshRuntime.stop"'),
    ),
    /owner\/role\/id must be literal/,
  );
  assert.throws(
    () => collectCleanupRegistrationsFromSource(
      "packages/cli/src/serve/command.ts",
      command.replace('owner: "anchor-host", role: "runtime", id: "meshRuntime.stop"', 'owner: "unknown-host", role: "runtime", id: "meshRuntime.stop"'),
    ),
    /unknown cleanup owner unknown-host/,
  );
  const roleEntries = descriptors.map((item) => ({
    ...item,
    key: `cleanup:${item.owner}:${item.role}:${item.id}`,
    category: "cleanup",
  })).sort((left, right) => left.key.localeCompare(right.key, "en-US"));
  const roles = buildServeRoleConfigurations(roleEntries);
  assert.ok(roles["anchor-only"].entryKeys.includes(
    "cleanup:anchor-host:runtime:meshRuntime.stop",
  ));
  assert.ok(!roles["anchor-only"].entryKeys.includes(
    "cleanup:anchor-local-executor:runtime:executorDataPlane.close",
  ));
  assert.ok(roles["anchor-executor"].entryKeys.includes(
    "cleanup:anchor-local-executor:runtime:executorDataPlane.close",
  ));
  assert.equal(roles["executor-only"].entryKeys.length, 0);
  const channels = await readFile("packages/cli/src/serve/channels.ts", "utf8");
  validateInboundRouterAssembly(channels);
  assert.throws(
    () => validateInboundRouterAssembly(
      channels.replace("new InboundRouter(", "new MissingInboundRouter("),
    ),
    /assembly count must be 1/,
  );
});

async function cleanupConstructionRecords() {
  const paths = [
    "packages/server/src/cleanup-registry.ts",
    "packages/server/src/index.ts",
    "packages/cli/src/serve/command.ts",
    "packages/server/src/lifecycle.ts",
  ];
  return Promise.all(paths.map(async (relative) => ({
    relative,
    text: await readFile(relative, "utf8"),
  })));
}

test("all production CleanupRegistry constructions bind exact topology owners", async () => {
  const records = await cleanupConstructionRecords();
  assert.deepEqual(await inspectCleanupRegistryConstructions(records), []);
  const mutate = (relative, transform, additions = []) => [
    ...records.map((record) => record.relative === relative
      ? { ...record, text: transform(record.text) }
      : record),
    ...additions,
  ];
  assert.deepEqual(await inspectCleanupRegistryConstructions(mutate(
    "packages/cli/src/serve/command.ts",
    (text) => text.replace("new CleanupRegistry({", "new (CleanupRegistry)({"),
  )), []);
  assert.match(
    (await inspectCleanupRegistryConstructions(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(/    activeOwners: plan\.activeCleanupOwners,\r?\n/u, ""),
    ))).join("\n"),
    /activeOwners must appear exactly once/,
  );
  assert.match(
    (await inspectCleanupRegistryConstructions(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace("activeOwners: plan.activeCleanupOwners", 'activeOwners: ["anchor-host"]'),
    ))).join("\n"),
    /must come from a ServeTopologyPlan parameter/,
  );
  assert.match(
    (await inspectCleanupRegistryConstructions(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(/  ServeTopologyPlan,\r?\n/u, ""),
    ))).join("\n"),
    /must come from a ServeTopologyPlan parameter/,
  );
  assert.match(
    (await inspectCleanupRegistryConstructions(mutate(
      "packages/server/src/lifecycle.ts",
      (text) => text.replace('activeOwners: ["standalone-server"]', 'activeOwners: ["anchor-host"]'),
    ))).join("\n"),
    /must be exactly standalone-server/,
  );
  assert.match(
    (await inspectCleanupRegistryConstructions(mutate(
      "packages/server/src/lifecycle.ts",
      (text) => text.replace(
        'activeOwners: ["standalone-server"],',
        'activeOwners: ["standalone-server"], activeOwners: ["standalone-server"],',
      ),
    ))).join("\n"),
    /activeOwners must appear exactly once/,
  );
  assert.match(
    (await inspectCleanupRegistryConstructions(mutate(
      "packages/server/src/lifecycle.ts",
      (text) => text.replace(
        'activeOwners: ["standalone-server"]',
        '[ownerKey]: ["standalone-server"]',
      ),
    ))).join("\n"),
    /computed properties|activeOwners must appear exactly once/,
  );
  assert.match(
    (await inspectCleanupRegistryConstructions(mutate(
      "packages/server/src/lifecycle.ts",
      (text) => text.replace(
        'activeOwners: ["standalone-server"],',
        'activeOwners: ["standalone-server"], ...extraOptions,',
      ),
    ))).join("\n"),
    /cannot use spread assignment/,
  );
  assert.match(
    (await inspectCleanupRegistryConstructions([
      ...records,
      {
        relative: "packages/cli/src/runtime/unregistered-cleanup.ts",
        text: 'import { CleanupRegistry as Registry } from "@zhixing/server"; new Registry({ activeOwners: ["anchor-host"] });',
      },
    ])).join("\n"),
    /unregistered production CleanupRegistry construction/,
  );
  assert.match(
    (await inspectCleanupRegistryConstructions([
      ...records,
      {
        relative: "packages/cli/src/runtime/namespace-cleanup.ts",
        text: 'import * as server from "@zhixing/server"; new server.CleanupRegistry({ activeOwners: ["anchor-host"] });',
      },
    ])).join("\n"),
    /unregistered production CleanupRegistry construction/,
  );
  assert.match(
    (await inspectCleanupRegistryConstructions([
      ...records,
      {
        relative: "packages/cli/src/runtime/cleanup-bridge.ts",
        text: 'import { CleanupRegistry as Local } from "@zhixing/server"; export { Local as Registry };',
      },
      {
        relative: "packages/cli/src/runtime/transduced-cleanup.ts",
        text: 'import { Registry as Alias } from "./cleanup-bridge.js"; const Constructor = Alias; new Constructor({ activeOwners: ["anchor-host"] });',
      },
    ])).join("\n"),
    /unregistered production CleanupRegistry construction/,
  );
});

test("local conversation owner remains isolated from anchor capabilities by construction", async () => {
  const paths = [
    "packages/cli/src/serve/conversation-owner-runtime.ts",
    "packages/cli/src/serve/conversation-protocol-runtime.ts",
    "packages/cli/src/serve/local-conversation-owner.ts",
    "packages/cli/src/serve/anchor-scheduler-runtime.ts",
    "packages/cli/src/serve/access-surfaces.ts",
    "packages/cli/src/serve/executor-role-runtime.ts",
    "packages/cli/src/setup-delivery.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: (await readFile(relative, "utf8")).replaceAll("\r\n", "\n"),
  })));
  assert.deepEqual(inspectLocalConversationOwnerIsolation(records), []);
  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );
  assert.match(
    inspectLocalConversationOwnerIsolation(mutate(
      "packages/cli/src/serve/conversation-owner-runtime.ts",
      (text) => text.replace("readonly globalState?: never;", "readonly globalState?: GlobalStatePort;"),
    )).join("\n"),
    /globalState must remain never/,
  );
  assert.match(
    inspectLocalConversationOwnerIsolation(mutate(
      "packages/cli/src/serve/local-conversation-owner.ts",
      (text) => text.replace(
        "readonly owner: LocalConversationOwnerRuntimeStack;",
        "readonly authority: AuthorityRuntimeStack;",
      ),
    )).join("\n"),
    /narrowed local owner contract|cannot receive the anchor authority stack/,
  );
  assert.match(
    inspectLocalConversationOwnerIsolation(mutate(
      "packages/cli/src/serve/local-conversation-owner.ts",
      (text) => text.replace(
        "  readonly sessionState: LocalConversationSessionReadPort;",
        "  readonly manager: ConversationManager;\n  readonly sessionState: LocalConversationSessionReadPort;",
      ),
    )).join("\n"),
    /must not expose raw manager/,
  );
  assert.match(
    inspectLocalConversationOwnerIsolation(mutate(
      "packages/cli/src/serve/local-conversation-owner.ts",
      (text) => text.replace(
        /    \| "readAdvancementState"\r?\n  >\r?\n>;/u,
        '    | "readAdvancementState"\n    | "mutate"\n  >\n>;',
      ),
    )).join("\n"),
    /frozen read set/,
  );
  assert.match(
    inspectLocalConversationOwnerIsolation(mutate(
      "packages/cli/src/serve/local-conversation-owner.ts",
      (text) => `import type { GlobalStatePort } from "@zhixing/core/contracts";\n${text}`,
    )).join("\n"),
    /forbidden capability GlobalStatePort/,
  );
  assert.match(
    inspectLocalConversationOwnerIsolation(mutate(
      "packages/cli/src/serve/access-surfaces.ts",
      (text) => text.replace(
        "      ConversationAssignmentLedger:\n        ctx.executorRoleModule.ConversationAssignmentLedger,",
        "      globalState: ctx.authorityRuntime.globalState,\n      ConversationAssignmentLedger:\n        ctx.executorRoleModule.ConversationAssignmentLedger,",
      ),
    )).join("\n"),
    /forbidden or duplicate capability globalState/,
  );
  assert.match(
    inspectLocalConversationOwnerIsolation(mutate(
      "packages/cli/src/serve/executor-role-runtime.ts",
      (text) => text.replace(
        "owner: localOwnerRuntime,",
        "owner: authority,",
      ),
    )).join("\n"),
    /must receive the single local runtime construction/,
  );
  assert.match(
    inspectLocalConversationOwnerIsolation(mutate(
      "packages/cli/src/serve/conversation-owner-runtime.ts",
      (text) => text.replace(
        "    executionAssetCatalog: deps.executionAssetCatalog,\n    storageMaintenance: deps.storageMaintenance,\n    globalPublishing: false,",
        "    executionAssetCatalog: deps.executionAssetCatalog,\n    storageMaintenance: deps.storageMaintenance,\n    globalState: deps.globalState,\n    globalPublishing: false,",
      ),
    )).join("\n"),
    /constructs forbidden capability globalState/,
  );
  assert.match(
    inspectLocalConversationOwnerIsolation(mutate(
      "packages/cli/src/serve/conversation-owner-runtime.ts",
      (text) => text.replace(
        "  deps: LocalConversationOwnerRuntimeDependencies,",
        "  deps: AuthorityRuntimeStack,",
      ),
    )).join("\n"),
    /must take LocalConversationOwnerRuntimeDependencies/,
  );
  assert.match(
    inspectLocalConversationOwnerIsolation(mutate(
      "packages/cli/src/serve/conversation-owner-runtime.ts",
      (text) => text.replace('  | "verifier"\n>;', ">;"),
    )).join("\n"),
    /must be exactly the frozen key set/,
  );
  assert.match(
    inspectLocalConversationOwnerIsolation(mutate(
      "packages/cli/src/serve/access-surfaces.ts",
      (text) => text.replace(
        "        verifier: ctx.authorityRuntime.verifier,\n      }),",
        "        verifier: ctx.authorityRuntime.verifier,\n        globalState: ctx.authorityRuntime.globalState,\n      }),",
      ),
    )).join("\n"),
    /forbidden or duplicate dependency globalState/,
  );
  assert.match(
    inspectLocalConversationOwnerIsolation(mutate(
      "packages/cli/src/serve/access-surfaces.ts",
      (text) => text.replace("        verifier: ctx.authorityRuntime.verifier,\n", ""),
    )).join("\n"),
    /missing dependency verifier/,
  );
  assert.match(
    inspectLocalConversationOwnerIsolation(mutate(
      "packages/cli/src/serve/access-surfaces.ts",
      (text) => text.replace(
        "        deviceId: ctx.authorityRuntime.deviceId,",
        "        deviceId: ctx.authorityRuntime.executorId,",
      ),
    )).join("\n"),
    /dependency deviceId must bind ctx\.authorityRuntime\.deviceId/,
  );
  assert.match(
    inspectLocalConversationOwnerIsolation(mutate(
      "packages/cli/src/serve/executor-role-runtime.ts",
      (text) => text.replace(
        /(const localOwnerRuntime = localConversationOwnerRuntime\(\{[\s\S]*?deviceId:\s*)authority\.deviceId/,
        "$1injectedDeviceId",
      ),
    )).join("\n"),
    /dependency deviceId must bind authority\.deviceId/,
  );
  assert.match(
    inspectLocalConversationOwnerIsolation(mutate(
      "packages/cli/src/serve/access-surfaces.ts",
      (text) => text.replace(
        "      owner: localConversationOwnerRuntime({\n",
        "      owner: localConversationOwnerRuntime({\n        ...ctx.authorityRuntime,\n",
      ),
    )).join("\n"),
    /spread or shorthand/,
  );
  assert.match(
    inspectLocalConversationOwnerIsolation(mutate(
      "packages/cli/src/serve/access-surfaces.ts",
      (text) => text
        .replace(
          "      owner: localConversationOwnerRuntime({\n",
          "      owner: localConversationOwnerRuntime(Object.assign(ctx.authorityRuntime, {\n",
        )
        .replace(
          "        verifier: ctx.authorityRuntime.verifier,\n      }),",
          "        verifier: ctx.authorityRuntime.verifier,\n      })),",
        ),
    )).join("\n"),
    /must receive one explicit dependency object literal/,
  );
  assert.match(
    inspectLocalConversationOwnerIsolation(mutate(
      "packages/cli/src/serve/executor-role-runtime.ts",
      (text) => text.replace(
        "authority: localOwnerRuntime,",
        "authority: localConversationOwnerRuntime({}),",
      ),
    )).join("\n"),
    /exactly one local runtime construction, got 2/,
  );
  assert.match(
    inspectLocalConversationOwnerIsolation(mutate(
      "packages/cli/src/serve/executor-role-runtime.ts",
      (text) => text.replace(
        "authority: localOwnerRuntime,",
        "authority: driftedLocalRuntime,",
      ),
    )).join("\n"),
    /executor ledger must receive the same single local runtime construction/,
  );
  assert.match(
    inspectLocalConversationOwnerIsolation(mutate(
      "packages/cli/src/serve/access-surfaces.ts",
      (text) => text.replace("    await assembly.start(", "    await Promise.resolve("),
    )).join("\n"),
    /assembly must start exactly once, got 0/,
  );
  assert.match(
    inspectLocalConversationOwnerIsolation(mutate(
      "packages/cli/src/serve/executor-role-runtime.ts",
      (text) => text.replace(
        "    await localConversationOwner?.close();",
        "    await Promise.resolve();",
      ),
    )).join("\n"),
    /assembly must close exactly once, got 0/,
  );
  assert.match(
    inspectLocalConversationOwnerIsolation(mutate(
      "packages/cli/src/serve/local-conversation-owner.ts",
      (text) => text.replace(
        "    const scheduleIntents = new DeferredScheduleIntentProducer({ intents });",
        "    const duplicateIntents = new DeferredGlobalIntentRepository({});\n    const scheduleIntents = new DeferredScheduleIntentProducer({ intents });",
      ),
    )).join("\n"),
    /expected exactly one bound local intent repository/,
  );
  assert.match(
    inspectLocalConversationOwnerIsolation(mutate(
      "packages/cli/src/serve/local-conversation-owner.ts",
      (text) => text.replace(
        "new DeferredScheduleIntentProducer({ intents })",
        "new DeferredScheduleIntentProducer({ intents: otherIntents })",
      ),
    )).join("\n"),
    /DeferredScheduleIntentProducer must share the single local intent repository/,
  );
  assert.match(
    inspectLocalConversationOwnerIsolation(mutate(
      "packages/cli/src/serve/anchor-scheduler-runtime.ts",
      (text) => text.replace('      mode: "anchor",', '      mode: "local",'),
    )).join("\n"),
    /anchor intent repository must use anchor mode/,
  );
  assert.match(
    inspectLocalConversationOwnerIsolation(mutate(
      "packages/cli/src/serve/local-conversation-owner.ts",
      (text) => text.replace(
        "conversationAuthority: protocol.deferredIntentAuthority,",
        "conversationAuthority: driftedIntentAuthority,",
      ),
    )).join("\n"),
    /local intent repository conversationAuthority must bind protocol\.deferredIntentAuthority/,
  );
  assert.match(
    inspectLocalConversationOwnerIsolation(mutate(
      "packages/cli/src/serve/anchor-scheduler-runtime.ts",
      (text) => text.replace(
        "conversationAuthority: options.protocol.deferredIntentAuthority,",
        "conversationAuthority: driftedIntentAuthority,",
      ),
    )).join("\n"),
    /anchor intent repository conversationAuthority must bind options\.protocol\.deferredIntentAuthority/,
  );
  assert.match(
    inspectLocalConversationOwnerIsolation(mutate(
      "packages/cli/src/serve/conversation-protocol-runtime.ts",
      (text) => text.replace(
        "protocol.#journal(input.conversationId).transactDeferredIntent(input)",
        "driftedJournal.transactDeferredIntent(input)",
      ),
    )).join("\n"),
    /intent authority adapter must route the current conversation journal narrow transaction/,
  );
  assert.match(
    inspectLocalConversationOwnerIsolation(mutate(
      "packages/cli/src/serve/access-surfaces.ts",
      (text) => `${text}\nconst publicDeferredIntent = deferSchedule;\n`,
    )).join("\n"),
    /deferred intent capability is exposed outside its internal owner seam/,
  );
});

test("conversation adoption stays bound to the two production roots and ordered recovery", async () => {
  const paths = [
    "packages/cli/src/serve/mesh-runtime-assembly.ts",
    "packages/cli/src/serve/access-surfaces.ts",
    "packages/cli/src/serve/executor-role-runtime.ts",
    "packages/cli/src/serve/conversation-evidence-authority.ts",
    "packages/cli/src/serve/conversation-transfer-mesh.ts",
    "packages/cli/src/serve/first-party-conversation-mesh.ts",
    "packages/cli/src/serve/local-conversation-rpc.ts",
    "packages/cli/src/serve/post-adoption-review.ts",
    "packages/cli/src/serve/command.ts",
    "packages/cli/src/runtime/rpc-confirmation-broker.ts",
    "packages/cli/src/repl.ts",
    "packages/rpc/src/confirmation-bridge.ts",
    "packages/server/src/context.ts",
    "packages/server/src/rpc/handlers.ts",
    "packages/server/src/rpc/methods/index.ts",
    "packages/server/src/rpc/methods/session.ts",
    "packages/server/src/rpc/methods/confirmation.ts",
    "packages/owner-kernel/src/conversation-run-contracts.ts",
    "packages/owner-kernel/src/conversation-transfer.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: await readFile(relative, "utf8"),
  })));
  assert.deepEqual(inspectConversationAdoptionAssembly(records), []);
  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );

  assert.match(
    inspectConversationAdoptionAssembly(mutate(
      "packages/cli/src/serve/mesh-runtime-assembly.ts",
      (text) => text.replace('this.#transferTarget = roles.has("anchor")', 'this.#transferTarget = roles.has("executor")'),
    )).join("\n"),
    /owned only by the active anchor role/,
  );
  assert.match(
    inspectConversationAdoptionAssembly(mutate(
      "packages/cli/src/serve/mesh-runtime-assembly.ts",
      (text) => text.replace(
        "storageMaintenance: options.authority.storageMaintenance,",
        "storageMaintenance: undefined,",
      ),
    )).join("\n"),
    /must use private staging and the authority governor\/lifecycle abort/,
  );
  assert.match(
    inspectConversationAdoptionAssembly(mutate(
      "packages/cli/src/serve/mesh-runtime-assembly.ts",
      (text) => text.replace(
        "      await this.#restoreCommittedTransfers();",
        "      await this.#startControl();\n      await this.#restoreCommittedTransfers();",
      ),
    )).join("\n"),
    /restore before mesh admission opens/,
  );
  assert.match(
    inspectConversationAdoptionAssembly(mutate(
      "packages/cli/src/serve/access-surfaces.ts",
      (text) => text.replace("verifyCurrentOwner: createConversationEvidenceAuthorityVerifier({", "verifyCurrentOwner: async () => {"),
    )).join("\n"),
    /current-owner evidence verifier injection/,
  );
  assert.match(
    inspectConversationAdoptionAssembly(mutate(
      "packages/cli/src/serve/executor-role-runtime.ts",
      (text) => text.replace("      conversationRpc,", "      conversationRpc: undefined,"),
    )).join("\n"),
    /first-party ownership composite injection/,
  );
  assert.match(
    inspectConversationAdoptionAssembly(mutate(
      "packages/cli/src/serve/local-conversation-rpc.ts",
      (text) => text.replaceAll(
        "this.input.owner.currentAuthority(conversationId)",
        "this.input.owner.cachedAuthority(conversationId)",
      ),
    )).join("\n"),
    /must share current-owner resolution and canonical local dispatch/,
  );
  assert.match(
    inspectConversationAdoptionAssembly(mutate(
      "packages/cli/src/serve/local-conversation-rpc.ts",
      (text) => text.replace(
        "if (LOCAL_METHODS.has(input.method)) return this.input.local.dispatch(input);",
        "if (false) return this.input.local.dispatch(input);",
      ),
    )).join("\n"),
    /method ownership exact-set drifted/,
  );
  assert.match(
    inspectConversationAdoptionAssembly(mutate(
      "packages/cli/src/serve/first-party-conversation-mesh.ts",
      (text) => text.replaceAll("METHODS.has(command.method)", "true"),
    )).join("\n"),
    /must remain finite, peer-bound and single-generation/,
  );
  assert.match(
    inspectConversationAdoptionAssembly(mutate(
      "packages/cli/src/serve/conversation-transfer-mesh.ts",
      (text) => text.replace(
        "result.requestId !== command.requestId || result.transferId !== command.transferId",
        "false",
      ),
    )).join("\n"),
    /strict originating-command correlation and signed abort facts/,
  );
  assert.match(
    inspectConversationAdoptionAssembly(mutate(
      "packages/owner-kernel/src/conversation-transfer.ts",
      (text) => text.replace('{ obligation: "committed" }', '{ obligation: "cleanup" }'),
    )).join("\n"),
    /transfer-private staging, shared promotion and committed cleanup/,
  );
  assert.match(
    inspectConversationAdoptionAssembly(mutate(
      "packages/cli/src/serve/conversation-evidence-authority.ts",
      (text) => text.replace("current.ownerEpoch !== request.ownerEpoch", "false"),
    )).join("\n"),
    /bind both owner identity and owner epoch/,
  );
  assert.match(
    inspectConversationAdoptionAssembly(mutate(
      "packages/owner-kernel/src/conversation-run-contracts.ts",
      (text) => `${text}\ntype PostAdoptionMemory = unknown;\n`,
    )).join("\n"),
    /retired post-adoption memory production or durable record semantics must stay absent/,
  );
  assert.match(
    inspectConversationAdoptionAssembly(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace("await ctx.meshRuntime.bindPostAdoptionReview(", "await Promise.resolve("),
    )).join("\n"),
    /anchor post-adoption review binding/,
  );
  assert.match(
    inspectConversationAdoptionAssembly(mutate(
      "packages/server/src/rpc/methods/session.ts",
      (text) => text.replace("ctx.server.conversationAdoptionReview?.({", "Promise.resolve({"),
    )).join("\n"),
    /session resume must bind the authenticated observer before adoption review/,
  );
  assert.match(
    inspectConversationAdoptionAssembly(mutate(
      "packages/cli/src/runtime/rpc-confirmation-broker.ts",
      (text) => text.replace('"confirmation.list"', '"confirmation.missing"'),
    )).join("\n"),
    /must recover missed pending requests/,
  );
  assert.match(
    inspectConversationAdoptionAssembly(mutate(
      "packages/rpc/src/confirmation-bridge.ts",
      (text) => text.replace("origin.triggeredBy === conn.surfacePrincipal", "false"),
    )).join("\n"),
    /must follow the stable authenticated surface across reconnects/,
  );
});

test("recovery backup stays bound to one current-anchor owner and finite paired receivers", async () => {
  const paths = [
    "packages/cli/src/serve/command.ts",
    "packages/cli/src/serve/backup-command.ts",
    "packages/cli/src/serve/mesh-bootstrap-store.ts",
    "packages/cli/src/serve/backup-runtime-owner.ts",
    "packages/cli/src/serve/mesh-runtime-bootstrap.ts",
    "packages/cli/src/serve/mesh-control-plane.ts",
    "packages/cli/src/serve/mesh-runtime-assembly.ts",
    "packages/cli/src/serve/mesh-pair-command.ts",
    "packages/cli/src/serve/disaster-recovery-candidate.ts",
    "packages/cli/src/serve/disaster-recovery-command.ts",
    "packages/cli/src/serve/disaster-recovery-installation.ts",
    "packages/cli/src/serve/disaster-recovery-target.ts",
    "packages/cli/src/serve/disaster-recovery-trust-evidence.ts",
    "packages/core/src/authority/artifact-retention.ts",
    "packages/core/src/authority/commit-log.ts",
    "packages/cli/src/serve/recovery-root-lifecycle.ts",
    "packages/cli/src/serve/credential-exposure-authority.ts",
    "packages/cli/src/serve/credential-rotation-publication.ts",
    "packages/cli/src/startup.ts",
    "packages/cli/src/setup-delivery.ts",
    "packages/cli/src/serve/recovery-root-establishment-runtime.ts",
    "packages/cli/src/serve/recovery-root-activation.ts",
    "packages/cli/src/serve/topology-command.ts",
    "packages/cli/src/serve/application-host.ts",
    "packages/mesh/src/checkpoint-service.ts",
    "packages/mesh/src/checkpoint-owner.ts",
    "packages/mesh/src/paired-checkpoint-target.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: await readFile(relative, "utf8"),
  })));
  assert.deepEqual(inspectRecoveryBackupAssembly(records), []);
  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/backup-runtime-owner.ts",
      (text) => text.replace("fullBackupReady: status.fullBackupReady", "fullBackupReady: false"),
    )).join("\n"),
    /durable recovery readiness projector or unavailable consumer drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/backup-command.ts",
      (text) => text.replace("prepared.checkpoint.envelope.recipientKeyId", '"temporary-recipient"'),
    )).join("\n"),
    /freeze package identity before target connection/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/recovery-root-establishment-runtime.ts",
      (text) => text.replace("rootEstablishment: true", "rootEstablishment: false"),
    )).join("\n"),
    /root-establishment receiver exact-set or current-issuer boundary drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/application-host.ts",
      (text) => text.replace("await this.#dependencies.runRecoveryRoot({", "await this.#dependencies.runRoleTopology({"),
    )).join("\n"),
    /finite pre-business topology/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/backup-command.ts",
      (text) => text.replace(
        /(transport: new MeshPairedCheckpointTransport\(control\.connections\.client\(targetDeviceId\)\),\r?\n\s*)storageMaintenance: context\.capacity\.storage/u,
        "$1storageMaintenance: undefined",
      ),
    )).join("\n"),
    /backup-command\.ts: paired checkpoint client must use the device storage governor/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/mesh-pair-command.ts",
      (text) => text.replace("storageMaintenance: input.storageMaintenance", "storageMaintenance: undefined"),
    )).join("\n"),
    /mesh-pair-command\.ts: paired checkpoint client must use the device storage governor/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/backup-runtime-owner.ts",
      (text) => text.replace("storageMaintenance: input.storageMaintenance", "storageMaintenance: undefined"),
    )).join("\n"),
    /backup-runtime-owner\.ts: paired checkpoint client must use the device storage governor/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace("ctx.authorityCheckpointOwner?.start()", "void 0"),
    )).join("\n"),
    /one create\/start\/stop lifecycle/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/backup-runtime-owner.ts",
      (text) => text.replace("currentAnchor: true", "currentAnchor: false"),
    )).join("\n"),
    /missing owner boundary currentAnchor: true/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/mesh-runtime-assembly.ts",
      (text) => text.replaceAll('member.state === "active"', 'member.state === "revoked"'),
    )).join("\n"),
    /active paired backup receiver boundary drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/mesh-pair-command.ts",
      (text) => text.replace("return new PairedRecoveryCheckpointTarget({", "return new UnboundedTarget({"),
    )).join("\n"),
    /onboarding checkpoint must precede business enrollment/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/mesh/src/checkpoint-owner.ts",
      (text) => text.replace('Object.freeze(["daily", "forced"])', 'Object.freeze(["daily", "daily"])'),
    )).join("\n"),
    /recovery owner descriptor exact-set or production binding drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/mesh/src/checkpoint-owner.ts",
      (text) => text.replace("RECOVERY_CHECKPOINT_OWNER_DESCRIPTOR.phases", "[].phases"),
    )).join("\n"),
    /recovery owner descriptor exact-set or production binding drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/mesh/src/paired-checkpoint-target.ts",
      (text) => text.replace('owner: "paired-target"', 'owner: "current-anchor"'),
    )).join("\n"),
    /paired receiver descriptor exact-set or production binding drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/mesh/src/paired-checkpoint-target.ts",
      (text) => text.replace(
        /    "checkpoint\.activate-root",\r?\n  \]\),/u,
        '    "checkpoint.activate-root",\n    "checkpoint.extra",\n  ]),',
      ),
    )).join("\n"),
    /paired receiver descriptor exact-set or production binding drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/mesh-runtime-assembly.ts",
      (text) => text.replace("commitRootActivation:", "missingRootActivationCommit:"),
    )).join("\n"),
    /signed activation replay must remain durably bound/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/backup-command.ts",
      (text) => text.replace(
        "return context.store.loadRecoveryRootActivationReplay({",
        "await context.store.loadTrustEvents();\n  return undefined; // latest-head fallback",
      ),
    )).join("\n"),
    /originating commit and same-LSN historical trust tuple/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/mesh-bootstrap-store.ts",
      (text) => text.replace(
        "verifyHomeTrustRecord(record, historical)",
        "verifyHomeTrustRecord(record, current)",
      ),
    )).join("\n"),
    /originating commit and same-LSN historical trust tuple/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/mesh-bootstrap-store.ts",
      (text) => text.replace(
        "const event = plan.rootEvent;",
        "const event = (await this.loadTrustEvents()).at(-1)!;",
      ),
    )).join("\n"),
    /originating commit and same-LSN historical trust tuple/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/disaster-recovery-target.ts",
      (text) => text.replace('owner: "eligible-recovery-target"', 'owner: "unknown"'),
    )).join("\n"),
    /disaster recovery target owner, inventory, phase or public journey exact-set drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/mesh-runtime-assembly.ts",
      (text) => text.replace(
        "registerDisasterRecoveryTrustEvidenceService(",
        "registerUntrustedRecoveryEvidenceService(",
      ),
    )).join("\n"),
    /no-rollback evidence producer, authenticated cut or candidate binding drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/disaster-recovery-command.ts",
      (text) => text.replace(
        "return createProductionAnchorReadySnapshot({",
        "return createSyntheticAnchorReadySnapshot({",
      ),
    )).join("\n"),
    /shared production snapshot and exact candidate identity/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/disaster-recovery-target.ts",
      (text) => text.replace(
        'candidate.terminal(input.abort.transferId, "aborted", abort)',
        "Promise.resolve({ abort })",
      ),
    )).join("\n"),
    /pre-commit signal or authenticated candidate terminal order drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/disaster-recovery-command.ts",
      (text) => text.replace(
        "openInventoryTargets(context, selection, signal)",
        "openInventoryTargets(context, selection)",
      ),
    )).join("\n"),
    /pre-commit signal or authenticated candidate terminal order drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/disaster-recovery-target.ts",
      (text) => text.replace("if (claimed.verified) {", "if (false) {"),
    )).join("\n"),
    /verified replay, install decision or target-wide terminal order drifted/,
  );
  for (const newline of ["\n", "\r\n"]) {
    const newlineRecords = records.map((record) => ({
      ...record,
      text: record.text.replace(/\r?\n/gu, newline),
    }));
    const mutateNewlineRecords = (transform) => newlineRecords.map((record) =>
      record.relative === "packages/cli/src/serve/disaster-recovery-target.ts"
        ? { ...record, text: transform(record.text) }
        : record
    );
    assert.match(
      inspectRecoveryBackupAssembly(mutateNewlineRecords((text) => replaceExactlyOnce(
        text,
        /^([ \t]*)const activeKey = await loadActiveAnchorIssuerKey\(\r?\n([ \t]*)this\.options\.secretStore,/mu,
        (_match, indent, argumentIndent) =>
          `${indent}await candidate.terminal(transferId, "committed");${newline}` +
          `${indent}const activeKey = await loadActiveAnchorIssuerKey(${newline}` +
          `${argumentIndent}this.options.secretStore,`,
        "candidate-terminal-before-active-key",
      ))).join("\n"),
      /verified replay, install decision or target-wide terminal order drifted/,
    );
    assert.match(
      inspectRecoveryBackupAssembly(mutateNewlineRecords((text) => replaceExactlyOnce(
        text,
        /^([ \t]*)const activeKey = await loadActiveAnchorIssuerKey\(\r?\n([ \t]*)input\.secretStore,/mu,
        (_match, indent, argumentIndent) =>
          `${indent}await candidate.terminal(installation.transferId, "committed");${newline}` +
          `${indent}const activeKey = await loadActiveAnchorIssuerKey(${newline}` +
          `${argumentIndent}input.secretStore,`,
        "installation-terminal-before-active-key",
      ))).join("\n"),
      /verified replay, install decision or target-wide terminal order drifted/,
    );
  }
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/disaster-recovery-candidate.ts",
      (text) => text.replaceAll(
        "disaster-recovery-candidate-install-decided",
        "disaster-recovery-candidate-prepared",
      ),
    )).join("\n"),
    /verified replay, install decision or target-wide terminal order drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/disaster-recovery-candidate.ts",
      (text) => text.replaceAll("verifiedRef", "verifiedJson"),
    )).join("\n"),
    /verified replay, install decision or target-wide terminal order drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/core/src/authority/artifact-retention.ts",
      (text) => text.replaceAll(
        "DisasterRecoveryInstallDecision",
        "UnregisteredDisasterDecision",
      ),
    )).join("\n"),
    /verified replay, install decision or target-wide terminal order drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/core/src/authority/commit-log.ts",
      (text) => text.replace(
        /(projectionId: RETAINED_REFERENCE_PROJECTION_ID,\r?\n\s+reducerVersion: )4,/,
        (_match, prefix) => `${prefix}3,`,
      ),
    )).join("\n"),
    /verified replay, install decision or target-wide terminal order drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/disaster-recovery-target.ts",
      (text) => text.replace(
        "const transferKey = await loadAnchorIssuerKey(",
        "const transferKey = await Promise.resolve(null) || loadAnchorIssuerKey(",
      ),
    )).join("\n"),
    /pre-commit signal or authenticated candidate terminal order drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/disaster-recovery-target.ts",
      (text) => text.replace(
        /      await this\.#deleteFreshIssuerKeyIfAborted\(\{\r?\n        candidate,\r?\n        prepare: input\.prepare,\r?\n        issuerKey,\r?\n      \}\);/u,
        "      void candidate; // omitted creator terminal check",
      ),
    )).join("\n"),
    /pre-commit signal or authenticated candidate terminal order drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/disaster-recovery-target.ts",
      (text) => text.replace(
        "const decided = await candidate.decideInstall(input.transferId, {",
        'await candidate.terminal(input.transferId, "committed");\n' +
          "    const decided = await candidate.decideInstall(input.transferId, {",
      ),
    )).join("\n"),
    /verified replay, install decision or target-wide terminal order drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/recovery-root-lifecycle.ts",
      (text) => text.replace('"domain-reset-establish"', '"domain-reset-bypass"'),
    )).join("\n"),
    /recovery root lifecycle owner, plan exact-set or production binding drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/mesh-pair-command.ts",
      (text) => text.replace('reenrollment: "reenroll"', 'reenrollment: "enroll"'),
    )).join("\n"),
    /pairing enroll and pending-reenroll exact-set drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/credential-exposure-authority.ts",
      (text) => text.replace('"webhook", ', ""),
    )).join("\n"),
    /credential exposure projection, guard or production read route exact-set drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "await publishRequiredCredentialRotations({",
        "await skipRequiredCredentialRotations({",
      ),
    )).join("\n"),
    /credential rotation read-back, service verification or production caller exact-set drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/backup-command.ts",
      (text) => text.replace(
        "await loadDeviceKey(secretStore, deviceId)",
        "await loadOrCreateDeviceKey(secretStore)",
      ),
    )).join("\n"),
    /reset approval minimum-privilege distinct co-signer boundary drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/disaster-recovery-installation.ts",
      (text) => text.replace("input.log.transactProjection<", "Promise.resolve<"),
    )).join("\n"),
    /disaster installation completion, consumer recovery or public-open order drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/mesh-runtime-bootstrap.ts",
      (text) => text.replace(
        "disasterRecoveryPostInstall ?? plannedAnchorPostInstall",
        "plannedAnchorPostInstall",
      ),
    )).join("\n"),
    /disaster installation completion, consumer recovery or public-open order drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/disaster-recovery-command.ts",
      (text) => text.replace(
        "const context = await openRecoveryContext(options, false)",
        "const context = await openRecoveryContext(options)",
      ),
    )).join("\n"),
    /disaster installation completion, consumer recovery or public-open order drifted/,
  );
});

test("planned duty migration stays bound to two production roots and a finite owner/receiver exact-set", async () => {
  const paths = [
    "packages/cli/src/serve/access-surfaces.ts",
    "packages/cli/src/serve/executor-role-runtime.ts",
    "packages/cli/src/serve/mesh-runtime-assembly.ts",
    "packages/cli/src/serve/planned-anchor-transfer.ts",
    "packages/cli/src/serve/planned-anchor-transfer-mesh.ts",
    "packages/cli/src/serve/first-party-conversation-mesh.ts",
    "packages/cli/src/serve/connection-lifetime-obligation.ts",
    "packages/cli/src/serve/local-conversation-rpc.ts",
    "packages/cli/src/serve/mesh-runtime-bootstrap.ts",
    "packages/cli/src/serve/command.ts",
    "packages/cli/src/serve/channels.ts",
    "packages/cli/src/serve/conversation-protocol-runtime.ts",
    "packages/cli/src/serve/surface-asset-authority.ts",
    "packages/cli/src/setup-delivery.ts",
    "packages/core/src/delivery/authority-pipeline.ts",
    "packages/core/src/authority/surface-assets.ts",
    "packages/cli/src/runtime/rpc-management-facade.ts",
    "packages/cli/src/runtime/duty-migration-command.ts",
    "packages/server/src/rpc/methods/server.ts",
    "packages/server/src/rpc/methods/index.ts",
    "packages/server/src/channels/inbound-router.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: (await readFile(relative, "utf8")).replaceAll("\r\n", "\n"),
  })));
  assert.deepEqual(inspectPlannedAnchorTransferAssembly(records), []);
  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/serve/planned-anchor-transfer-mesh.ts",
      (text) => text.replace('"anchor-only"', '"executor-only"'),
    )).join("\n"),
    /phase exact-set drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/serve/access-surfaces.ts",
      (text) => text.replace("plannedAnchorIssuerKey: bootstrap.anchorIssuerKey", "missingIssuerKey: bootstrap.anchorIssuerKey"),
    )).join("\n"),
    /two production roots exact-set drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/serve/executor-role-runtime.ts",
      (text) => `${text}\nvoid new PlannedAnchorTransferOwner({});`,
    )).join("\n"),
    /owner\/receiver topology exact-set drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/serve/access-surfaces.ts",
      (text) => text.replace(
        "ctx.meshRuntime?.currentAnchorDeviceId()",
        "ctx.meshBootstrap.trust.issuer.deviceId",
      ),
    )).join("\n"),
    /current-owner resolver exact-set drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/serve/mesh-runtime-assembly.ts",
      (text) => text.replace(
        "this.#plannedCommittedTargetDeviceId ??",
        "undefined ??",
      ),
    )).join("\n"),
    /current-owner resolver exact-set drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "conversationRpc: new CurrentAnchorFirstPartyRpcRouter({",
        "conversationRpc: undefined,",
      ),
    )).join("\n"),
    /first-party current-owner relay drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/serve/first-party-conversation-mesh.ts",
      (text) => text.replace(
        "stopSignal: active.abort.signal,",
        "connectionClosed: Promise.resolve(),\n        stopSignal: active.abort.signal,",
      ),
    )).join("\n"),
    /first-party current-owner relay drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/serve/connection-lifetime-obligation.ts",
      (text) => text.replace(
        "readonly connectionClosed?: Promise<unknown>;",
        "readonly connectionClosed: Promise<unknown>;",
      ),
    )).join("\n"),
    /first-party current-owner relay drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/serve/first-party-conversation-mesh.ts",
      (text) => text.replace(
        "captureCurrentAnchorRelayMethods(),",
        '["dutyMigration.targets"],',
      ),
    )).join("\n"),
    /first-party current-owner relay drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/serve/first-party-conversation-mesh.ts",
      (text) => text.replace(
        "fulfillConnectionLifetimeObligation({",
        "Promise.resolve({",
      ),
    )).join("\n"),
    /first-party current-owner relay drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/serve/planned-anchor-transfer.ts",
      (text) => text.replace(
        "const candidate = await this.#candidates.claimCandidate(identity);",
        "const context = this.#context(identity.transferId);\n    const candidate = await this.#candidates.claimCandidate(identity);",
      ).replace(
        "    const context = this.#context(identity.transferId);\n    const existing = await context.journal.state(identity.transferId);",
        "    const existing = await context.journal.state(identity.transferId);",
      ),
    )).join("\n"),
    /candidate durable single-flight or claim-before-effect drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/serve/planned-anchor-transfer.ts",
      (text) => text.replace(
        "const state = await this.#journal.prepareCandidate(preparedRecord(command));",
        "const state = await this.#journal.append(preparedRecord(command));",
      ),
    )).join("\n"),
    /terminal\/prepared durable ordering drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/serve/planned-anchor-transfer.ts",
      (text) => text.replace(
        "readonly prepared?: PlannedAnchorPreparedRecord;",
        "readonly prepared?: true;",
      ),
    )).join("\n"),
    /signed abort or candidate terminal recovery drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/serve/planned-anchor-transfer.ts",
      (text) => text.replace(
        "const decision = await this.#candidates.decideRemoteAbort(",
        "const decision = await this.#candidates.terminal(",
      ),
    )).join("\n"),
    /signed abort or candidate terminal recovery drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/serve/planned-anchor-transfer.ts",
      (text) => text.replace(
        "for (const candidate of (await this.#candidates.states()).values())",
        "for (const candidate of [])",
      ),
    )).join("\n"),
    /signed abort or candidate terminal recovery drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/serve/planned-anchor-transfer.ts",
      (text) => text.replace(
        "const phase = await context.journal.state(release.identity.transferId);",
        "const phase = undefined;",
      ),
    )).join("\n"),
    /terminal\/prepared durable ordering drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/serve/mesh-runtime-bootstrap.ts",
      (text) => text.replace(
        "await completePlannedAnchorInstallationBeforeBootstrap({",
        "await Promise.resolve(undefined as never)({",
      ),
    )).join("\n"),
    /pre-bootstrap\/post-install completion closure drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/setup-delivery.ts",
      (text) => text.replace('  "delivery-authority",\n', ""),
    )).join("\n"),
    /installed authority generation rebind exact-set drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/serve/mesh-runtime-bootstrap.ts",
      (text) => text.replace(
        "installedAuthorityGeneration: anchorPostInstall.installedGeneration",
        "installedAuthorityGeneration: undefined",
      ),
    )).join("\n"),
    /installed authority generation rebind exact-set drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "const receipt = await ctx.authorityRuntime!.rebindInstalledAuthority(generation);",
        "const receipt = { generation };",
      ),
    )).join("\n"),
    /installed authority generation rebind exact-set drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "await ctx.deliveryStack?.quiesceForAuthorityTransfer();",
        "await ctx.deliveryStack?.recoverInstalledAuthority();",
      ),
    )).join("\n"),
    /source quiesce or installed consumer read-back order drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace("return obligations;", "return [];"),
    )).join("\n"),
    /source quiesce or installed consumer read-back order drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/serve/mesh-runtime-assembly.ts",
      (text) => text.replace(
        "const readBack = await readBackPlannedAnchorPostInstallObligations({",
        "const readBack = await Promise.resolve([{",
      ),
    )).join("\n"),
    /source quiesce or installed consumer read-back order drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/serve/access-surfaces.ts",
      (text) => text.replace(
        "isCurrentOwner: isCurrentChannelOwner,",
        "isCurrentOwner: () => true,",
      ),
    )).join("\n"),
    /channel current-owner connection or final guard drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/server/src/channels/inbound-router.ts",
      (text) => text.replace(
        "if (!this.isCurrentOwner())",
        "if (false)",
      ),
    )).join("\n"),
    /channel current-owner connection or final guard drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/serve/channels.ts",
      (text) => text.replace(
        "if (isCurrentOwner?.() === false)",
        "if (false)",
      ),
    )).join("\n"),
    /channel current-owner connection or final guard drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/serve/mesh-runtime-assembly.ts",
      (text) => text.replace(
        'const roleEnabled = this.options.configuration.enabledRoles.includes("anchor")',
        'const roleEnabled = this.options.configuration.enabledRoles.includes("executor")',
      ),
    )).join("\n"),
    /owner\/receiver topology exact-set drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/serve/mesh-runtime-assembly.ts",
      (text) => text.replace(
        "await this.#plannedAnchorOwner?.recoverBeforeAdmission()",
        "void this.#plannedAnchorOwner?.recoverBeforeAdmission()",
      ),
    )).join("\n"),
    /recovery\/commit\/admission order drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/serve/mesh-runtime-assembly.ts",
      (text) => text.replace(
        "await this.#plannedTransferRuntime.run(async () => {\n              await this.#plannedAnchorOwner?.recoverBeforeAdmission();\n            });",
        "await this.#plannedAnchorOwner?.recoverBeforeAdmission();",
      ),
    )).join("\n"),
    /recovery\/commit\/admission order drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/serve/mesh-runtime-assembly.ts",
      (text) => text.replace(
        "await this.#plannedTransferRuntime.run(async () => {\n        await this.#plannedAnchorTarget?.recoverBeforeAdmission();\n        await this.#plannedAnchorOwner?.recoverBeforeAdmission();\n      });",
        "await this.#plannedAnchorTarget?.recoverBeforeAdmission();\n      await this.#plannedAnchorOwner?.recoverBeforeAdmission();",
      ),
    )).join("\n"),
    /recovery\/commit\/admission order drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/serve/mesh-runtime-assembly.ts",
      (text) => text.replace(
        "await this.#plannedAnchorTarget?.recoverBeforeAdmission()",
        "void this.#plannedAnchorTarget?.recoverBeforeAdmission()",
      ),
    )).join("\n"),
    /recovery\/commit\/admission order drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/serve/mesh-runtime-assembly.ts",
      (text) => text.replace(
        "await reconcilePlannedAnchorTrustFromPeer(",
        "await reconcileSomeOtherTrustFromPeer(",
      ),
    )).join("\n"),
    /recovery\/commit\/admission order drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/setup-delivery.ts",
      (text) => text.replace(
        "plannedAnchorReadiness: plannedAnchorReadiness.port",
        "plannedAnchorReadiness: plannedAnchorReadinessSnapshot",
      ),
    )).join("\n"),
    /readiness reservation assembly drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/serve/planned-anchor-transfer-mesh.ts",
      (text) => text.replace(
        "options.lifecycle.run(() => target.summary())",
        "target.summary()",
      ),
    )).join("\n"),
    /readiness reservation assembly drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/runtime/rpc-management-facade.ts",
      (text) => text.replace('"dutyMigration.commit"', '"dutyMigration.unregistered"'),
    )).join("\n"),
    /public journey or canonical RPC exact-set drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/serve/mesh-runtime-assembly.ts",
      (text) => text.replace(
        "return this.#plannedTransferRuntime.run(async () => {",
        "return (async () => {",
      ),
    )).join("\n"),
    /stop gate or strict product identity drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/runtime/duty-migration-command.ts",
      (text) => text.replace(
        "return `xfer-${encoded}`;",
        "return `duty-${encoded}`;",
      ),
    )).join("\n"),
    /stop gate or strict product identity drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/runtime/duty-migration-command.ts",
      (text) => text.replace("值班设备迁移完成", "anchor 迁移完成"),
    )).join("\n"),
    /leaks internal topology terms/,
  );
});

test("managed host stays bound to the finite launch plans, triggers and one serve root", async () => {
  const paths = [
    "packages/cli/src/serve/managed-service-reconciler.ts",
    "packages/cli/src/serve/managed-service.ts",
    "packages/cli/src/serve/managed-service-runtime.ts",
    "packages/mesh/src/bootstrap.ts",
    "packages/cli/src/serve/mesh-pair-command.ts",
    "packages/cli/src/runtime/config-command.ts",
    "packages/cli/src/serve/command.ts",
    "packages/cli/src/serve/anchor-internal-stop.ts",
    "packages/cli/src/serve/executor-role-runtime.ts",
    "packages/cli/src/serve/executor-internal-stop.ts",
    "packages/cli/src/serve/topology-command.ts",
    "packages/cli/src/serve/application-host.ts",
    "packages/cli/src/runtime/core-host-connection.ts",
    "packages/cli/src/repl.ts",
    "packages/cli/src/runtime/surface-core-host-link.ts",
    "packages/secrets/src/platform-secret-store.ts",
    "packages/cli/src/serve/status.ts",
    "packages/server/src/managed-host-status.ts",
    "packages/server/src/routes.ts",
    "packages/cli/src/serve/anchor-scheduler-runtime.ts",
    "packages/core/src/protocol/manifest.ts",
    "packages/server/src/context.ts",
    "packages/server/src/rpc/methods/server.ts",
    "packages/server/src/lifecycle.ts",
    "packages/server/src/server.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: (await readFile(relative, "utf8")).replaceAll("\r\n", "\n"),
  })));
  assert.deepEqual(inspectManagedHostAssembly(records), []);
  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/managed-service-reconciler.ts",
      (text) => text.replace('"host-missing",', '"health-read",'),
    )).join("\n"),
    /descriptor exact-set drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/runtime/core-host-connection.ts",
      (text) => text.replace('reconcileCurrentManagedService("host-missing")', 'spawnDaemon({})'),
    )).join("\n"),
    /production trigger exact-set drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/runtime/config-command.ts",
      (text) => text.replace(
        "const reconcile = input.launchSelectionChanged",
        "const reconcile = true",
      ),
    )).join("\n"),
    /production trigger exact-set drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/managed-service.ts",
      (text) => text.replace("<UserId>${osUser}</UserId>", "<UserId>other</UserId>"),
    )).join("\n"),
    /OS user or current-state intent exact-set drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/managed-service.ts",
      (text) => text.replace(
        'Buffer.from(spec.definition, "utf16le")',
        'Buffer.from(spec.definition, "utf8")',
      ),
    )).join("\n"),
    /Windows bytes, strict projection or HRESULT classifier drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/managed-service.ts",
      (text) => text.replace(
        "projection.enabled !== projection.settings.enabled",
        "false",
      ),
    )).join("\n"),
    /Windows bytes, strict projection or HRESULT classifier drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/managed-service-reconciler.ts",
      (text) => text.replace(
        "input.adapter.disableFuture(initial.spec, input.signal)",
        "input.adapter.disable(initial.spec, input.signal)",
      ),
    )).join("\n"),
    /accepted-work drain or generation-safe turnover order drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "return stop.requestStop(request);",
        "serverCtx.requestShutdown?.(request.reason); return Promise.resolve();",
      ),
    )).join("\n"),
    /internal stop durable owner drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace("beforeActivate: async (openingRunner) =>", "afterActivate: async (openingRunner) =>"),
    )).join("\n"),
    /entry-last activation or publication order drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text
        .replace("ctx.deliveryStack?.activate()", "void openingRunner.server.port")
        .replace(
          "publishReady: async (openingRunner) => {",
          "publishReady: async (openingRunner) => {\n      ctx.deliveryStack?.activate();",
        ),
    )).join("\n"),
    /entry-last activation or publication order drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/server/src/server.ts",
      (text) => text.replace(
        "await opts.activationGate?.(server);\n    boundServer.activate({",
        "boundServer.activate({\n      config, requestHandler, upgradeHandler, cleanup: cleanupActive,\n    });\n    await opts.activationGate?.(server);\n    boundServer.activate({",
      ),
    )).join("\n"),
    /entry-last activation or publication order drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => `${text}\nconst shadowBinding = await bindServer({});`,
    )).join("\n"),
    /entry-last activation or publication order drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "publishReady: async (openingRunner) =>",
        "publishBeforeActivate: async (openingRunner) =>",
      ),
    )).join("\n"),
    /entry-last activation or publication order drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/anchor-internal-stop.ts",
      (text) => text.replace("await dependencies.prepare({", "void ({"),
    )).join("\n"),
    /internal stop durable owner drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/executor-internal-stop.ts",
      (text) => text.replace("await dependencies.prepare({", "void ({"),
    )).join("\n"),
    /Executor trust\/idle durable stop owner drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/executor-role-runtime.ts",
      (text) => text.replace("onTrustApplied,", ""),
    )).join("\n"),
    /production trigger exact-set drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/executor-role-runtime.ts",
      (text) => text.replace("mesh!.connections.has(anchorDeviceId)", "false"),
    )).join("\n"),
    /Executor trust\/idle durable stop owner drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => `${text}\ncreateAnchorInternalStopPort({});`,
    )).join("\n"),
    /internal stop durable owner drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/managed-service.ts",
      (text) => text.replace('args: [...args, "/HRESULT"]', "args"),
    )).join("\n"),
    /Windows bytes, strict projection or HRESULT classifier drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/managed-service.ts",
      (text) => text.replace("hresult === 0x80070002", "hresult === 1"),
    )).join("\n"),
    /Windows bytes, strict projection or HRESULT classifier drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/managed-service.ts",
      (text) => text.replace("projection.triggers.length === 1", "projection.triggers.length > 0"),
    )).join("\n"),
    /Windows bytes, strict projection or HRESULT classifier drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/runtime/core-host-connection.ts",
      (text) => text
        .replace("    await opts.beforeTurnover?.();\n", "")
        .replace(
          "    await this.waitForEndpointTurnover(staleEndpoint, opts);\n",
          "    await this.waitForEndpointTurnover(staleEndpoint, opts);\n    await opts.beforeTurnover?.();\n",
        ),
    )).join("\n"),
    /accepted-work drain or generation-safe turnover order drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/status.ts",
      (text) => text.replace('loadCurrentManagedServiceState("inspect")', 'loadCurrentManagedServiceState("activate")'),
    )).join("\n"),
    /OS user or current-state intent exact-set drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "coordinateManagedHostTrustTransition({",
        "Promise.resolve({",
      ),
    )).join("\n"),
    /production trigger exact-set drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/application-host.ts",
      (text) => text.replace("await this.#dependencies.runRoleTopology(", "await this.#dependencies.runSecondRoleTopology("),
    )).join("\n"),
    /unique composition root drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/server/src/managed-host-status.ts",
      (text) => text.replace("export function projectManagedHostStatus(", "function projectRawHostStatus("),
    )).join("\n"),
    /public status or executor queue wake drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/runtime/surface-core-host-link.ts",
      (text) => text.replace("isCurrentAnchorRelayMethod(method)", "true"),
    )).join("\n"),
    /finite current-anchor surface relay drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/server/src/routes.ts",
      (text) => text.replace("ctx.managedHostPublicStatus?.()", "undefined"),
    )).join("\n"),
    /public status or executor queue wake drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/managed-service-reconciler.ts",
      (text) => text.replace(
        "return reconcileOrJoin(key, input, false);",
        "return reconcileOrJoin(key, input, true);",
      ),
    )).join("\n"),
    /bounded successor or start classifier drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/managed-service.ts",
      (text) => text.replace(
        "await this.requireCommand(startCommand(spec), signal);",
        "await this.command(startCommand(spec), signal);",
      ),
    )).join("\n"),
    /bounded successor or start classifier drifted/,
  );
});

test("device lifecycle stays on one journal, two production roots and local-only host control", async () => {
  const paths = [
    "packages/core/src/protocol/device-lifecycle.ts",
    "packages/core/src/authority/device-lifecycle-journal.ts",
    "packages/cli/src/serve/device-removal.ts",
    "packages/cli/src/serve/mesh-runtime-assembly.ts",
    "packages/cli/src/serve/command.ts",
    "packages/cli/src/serve/executor-role-runtime.ts",
    "packages/server/src/rpc/methods/index.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: (await readFile(relative, "utf8")).replaceAll("\r\n", "\n"),
  })));
  assert.deepEqual(inspectDeviceLifecycleAssembly(records), []);
  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );
  assert.match(
    inspectDeviceLifecycleAssembly(mutate(
      "packages/core/src/authority/device-lifecycle-journal.ts",
      (text) => text.replace('record.t === "advanced" || record.t === "terminal"', 'record.t === "advanced"'),
    )).join("\n"),
    /retained terminal evidence drifted/,
  );
  assert.match(
    inspectDeviceLifecycleAssembly(mutate(
      "packages/cli/src/serve/executor-role-runtime.ts",
      (text) => text.replace("await mesh.bindDeviceRemovalLifecycle({", "void mesh.bindDeviceRemovalLifecycle({"),
    )).join("\n"),
    /two-root recovery binding drifted/,
  );
  assert.match(
    inspectDeviceLifecycleAssembly(mutate(
      "packages/cli/src/serve/executor-role-runtime.ts",
      (text) => text.replace("const stopCoordinator = new HostStopCoordinator({", "const stopCoordinator = undefined; void ({"),
    )).join("\n"),
    /two-root recovery binding drifted/,
  );
  assert.match(
    inspectDeviceLifecycleAssembly(mutate(
      "packages/cli/src/serve/executor-role-runtime.ts",
      (text) => text.replace("await waitForExecutorRoleTerminal({", "await Promise.resolve({"),
    )).join("\n"),
    /two-root recovery binding drifted/,
  );
  assert.match(
    inspectDeviceLifecycleAssembly(mutate(
      "packages/cli/src/serve/mesh-runtime-assembly.ts",
      (text) => text.replace("log: options.bootstrapStore.authorityLog(),", "log: options.authority.executorLog,"),
    )).join("\n"),
    /local lifecycle authority root/,
  );
  assert.match(
    inspectDeviceLifecycleAssembly(mutate(
      "packages/server/src/rpc/methods/index.ts",
      (text) => text.replace('"server.uninstall.status",', ""),
    )).join("\n"),
    /RPC ownership drifted/,
  );
});

test("retired entry, live writable Store and reverse package dependency mutations fail", () => {
  assert.match(
    inspectProductionSource("packages/orchestrator/src/mutation.ts", 'import { SkillStore } from "@zhixing/core";')[0],
    /forbidden writable owner import SkillStore/,
  );
  assert.match(
    inspectProductionSource("packages/server/src/bad.ts", 'import "@zhixing/executor";')[0],
    /server imports executor/,
  );
  assert.match(
    inspectProductionSource(
      "packages/cli/src/serve/stop.ts",
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
    'import { SkillStore as Alias } from "@zhixing/core";',
    'export { SkillStore as Alias } from "@zhixing/core";',
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
      'import { SkillStore } from "@zhixing/core";',
    ).join("\n"),
    /forbidden writable owner import SkillStore/,
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
      text: "export class SkillStore {}",
    },
    {
      relative: "packages/core/src/index.ts",
      text: 'export { SkillStore } from "./store.js";',
    },
    {
      relative: "packages/bridge/src/index.ts",
      text: 'import { SkillStore as LocalStore } from "@zhixing/core"; export { LocalStore as WritableSkill };',
    },
  ];
  const resolver = await buildWorkspaceOwnerExposure(records, new Map([
    ["@zhixing/core", "packages/core/src/index.ts"],
    ["@test/bridge", "packages/bridge/src/index.ts"],
  ]));
  assert.match(
    inspectProductionSource(
      "packages/orchestrator/src/bad.ts",
      'import { WritableSkill as Alias } from "@test/bridge";',
      { resolveOwnerExposure: resolver },
    ).join("\n"),
    /SkillStore as Alias/,
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
      "packages/cli/src/runtime/rpc-conversation-facade.ts",
      "client.request(method);",
    ).join("\n"),
    /non-canonical dynamic RPC method/,
  );
  assert.match(
    inspectProductionSource(
      "packages/cli/src/serve/aliased-client.ts",
      'import { createRpcClient as connect } from "@zhixing/server"; const client = connect({}); client.request(method);',
    ).join("\n"),
    /raw RPC capability createRpcClient acquired outside owner/,
  );
  assert.match(
    inspectProductionSource(
      "packages/cli/src/runtime/rpc-conversation-facade.ts",
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
  assert.match(
    inspectProductionSource(
      "packages/cli/src/runtime/raw-wrapper.ts",
      'import type { CoreHostRpcLink } from "./core-host-connection.js"; export function leak(link: CoreHostRpcLink) { return link; }',
    ).join("\n"),
    /raw RPC capability CoreHostRpcLink acquired outside owner|raw RPC capability returned/,
  );
  assert.match(
    inspectProductionSource(
      "packages/cli/src/runtime/rpc-leak.ts",
      'export { CoreHostRpcLink as PublicLink } from "./core-host-connection.js";',
    ).join("\n"),
    /raw RPC capability CoreHostRpcLink re-exported/,
  );
  assert.match(
    inspectProductionSource(
      "packages/cli/src/runtime/rpc-extra.ts",
      'import type { CoreHostRpcLink } from "./core-host-connection.js"; class Extra { constructor(private readonly link: CoreHostRpcLink) {} async read() { return this.link.getClient(); } }',
    ).join("\n"),
    /raw RPC capability CoreHostRpcLink acquired outside owner/,
  );
  const eventBus = await readFile(
    "packages/cli/src/runtime/rpc-event-bus.ts",
    "utf8",
  );
  assert.match(
    inspectProductionSource(
      "packages/cli/src/runtime/rpc-event-bus.ts",
      eventBus.replaceAll("CoreHostNotificationLink", "CoreHostRpcLink"),
    ).join("\n"),
    /raw RPC capability CoreHostRpcLink acquired outside owner/,
  );
  assert.match(
    inspectProductionSource(
      "packages/cli/src/runtime/rpc-conversation-facade.ts",
      conversation.replace(
        "constructor(private readonly link: CoreHostRpcLink)",
        "constructor(public readonly link: CoreHostRpcLink)",
      ),
    ).join("\n"),
    /raw RPC capability exposed on parameter property/,
  );
  assert.match(
    inspectProductionSource(
      "packages/cli/src/runtime/rpc-dynamic.ts",
      'const server = await import("@zhixing/server"); server.createRpcClient({});',
    ).join("\n"),
    /raw RPC namespace capability loaded dynamically/,
  );
  assert.match(
    inspectProductionSource(
      "packages/cli/src/runtime/rpc-import-equals.ts",
      'import server = require("@zhixing/server"); server.createRpcClient({});',
    ).join("\n"),
    /raw RPC namespace capability import/,
  );
  assert.match(
    inspectProductionSource(
      "packages/cli/src/runtime/connection-leak.ts",
      'import { CoreHostConnection } from "./core-host-connection.js"; new CoreHostConnection({});',
    ).join("\n"),
    /raw RPC capability CoreHostConnection acquired outside owner/,
  );
  assert.match(
    inspectProductionSource(
      "packages/cli/src/runtime/rpc-conversation-facade.ts",
      'import type { CoreHostRpcLink } from "./core-host-connection.js"; declare const link: CoreHostRpcLink; export = link;',
    ).join("\n"),
    /raw RPC capability exported from assignment/,
  );
  assert.match(
    inspectProductionSource(
      "packages/cli/src/runtime/rpc-conversation-facade.ts",
      'import type { CoreHostRpcLink } from "./core-host-connection.js"; export function leak(link: CoreHostRpcLink) { return { link }; }',
    ).join("\n"),
    /raw RPC capability returned from function/,
  );
  assert.match(
    inspectProductionSource(
      "packages/cli/src/runtime/rpc-conversation-facade.ts",
      'import type { CoreHostRpcLink } from "./core-host-connection.js"; export class Leak { constructor(private readonly raw: CoreHostRpcLink) {} readonly value = { raw: this.raw }; }',
    ).join("\n"),
    /raw RPC capability exposed on instance member/,
  );
  const rpcResolver = await buildWorkspaceSymbolExposure([
    {
      relative: "packages/cli/src/runtime/core-host-connection.ts",
      text: "export interface CoreHostRpcLink { getClient(): unknown }",
    },
    {
      relative: "packages/cli/src/runtime/raw-bridge.ts",
      text: 'import type { CoreHostRpcLink as Local } from "./core-host-connection.js"; export type { Local as ForwardedLink };',
    },
    {
      relative: "packages/cli/src/runtime/consumer.ts",
      text: 'import type { ForwardedLink } from "./raw-bridge.js";',
    },
  ], new Set(["CoreHostRpcLink"]));
  assert.match(
    inspectProductionSource(
      "packages/cli/src/runtime/consumer.ts",
      'import type { ForwardedLink } from "./raw-bridge.js"; class Consumer { constructor(private readonly link: ForwardedLink) {} }',
      { resolveRpcExposure: rpcResolver },
    ).join("\n"),
    /raw RPC capability CoreHostRpcLink acquired outside owner/,
  );
  for (const compositionOwner of [
    "packages/cli/src/repl.ts",
    "packages/cli/src/runtime/workspace-command.ts",
  ]) {
    assert.deepEqual(
      inspectProductionSource(
        compositionOwner,
        await readFile(compositionOwner, "utf8"),
      ),
      [],
    );
  }
  const presenter = await readFile(
    "packages/cli/src/runtime/publish-result-presenter.ts",
    "utf8",
  );
  assert.deepEqual(
    inspectProductionSource(
      "packages/cli/src/runtime/publish-result-presenter.ts",
      presenter,
    ),
    [],
  );
  const mesh = await readFile(
    "packages/cli/src/serve/assignment-mesh-adapter.ts",
    "utf8",
  );
  assert.deepEqual(
    inspectProductionSource(
      "packages/cli/src/serve/assignment-mesh-adapter.ts",
      mesh,
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
