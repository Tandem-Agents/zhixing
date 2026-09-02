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
  inspectConversationExecutorDispatchBoundary,
  inspectAssignmentDataPlaneBoundary,
  inspectAdvancementEvidenceTopologyBoundary,
  inspectAssignmentResourcePortBoundary,
  inspectWorkspaceProbePersistenceBoundary,
  inspectWorkspaceBindingGenerationPersistenceBoundary,
  inspectWorkspaceBindingCatalogPersistenceBoundary,
  inspectMeshBootstrapProjectionBoundary,
  inspectMeshPairingContinuationPersistenceBoundary,
  inspectSurfaceAssetStagingPersistenceBoundary,
  inspectAssignmentArtifactReceiverBoundary,
  inspectConversationStorageBoundary,
  inspectWorksceneStorageCleanupBoundary,
  inspectStorageRemainderBoundary,
  inspectDeviceLifecycleAssembly,
  inspectDeviceAdministrationReadOwnership,
  ADVANCEMENT_APPLICATION_OWNER_EXACT_SET,
  inspectAdvancementDetailApplicationOwnership,
  inspectKernelRunEnvelopeOwnership,
  inspectKernelRunEventOwnership,
  inspectKernelTerminalOwnership,
  inspectKernelConformanceAndAgentRuntimeBudget,
  inspectAgentRuntimeSecurityEncapsulation,
  inspectAgentRuntimeWorkspaceEncapsulation,
  inspectTurnContextProviderAssembly,
  inspectKernelProviderDependencyInversion,
  inspectKernelToolImplementationDependencyInversion,
  inspectAdvancementProviderDependencyInversion,
  inspectRuntimeSecretProjectionBoundary,
  inspectRuntimeConfigurationProjectionBoundary,
  inspectWorksceneRuntimeProjectionBoundary,
  inspectMcpManagementBoundary,
  inspectMcpRuntimeBoundary,
  inspectChannelRuntimeBoundary,
  inspectWorkspaceAdministrationOwnership,
  inspectTrustAdministrationOwnership,
  inspectLocalConversationOwnerIsolation,
  inspectManagedHostAssembly,
  inspectPlannedAnchorTransferAssembly,
  inspectDisasterRecoveryStagingBoundary,
  inspectRecoveryBackupAssembly,
  inspectSkillCatalogApplicationOwnership,
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
    "packages/cli/src/serve/anchor-host-shell-lifecycle.ts",
    "packages/cli/src/serve/access-surfaces.ts",
    "packages/cli/src/serve/assembly-lifecycle.ts",
  ];
  const descriptors = [];
  for (const source of cleanupSources) {
    descriptors.push(...collectCleanupRegistrationsFromSource(
      source,
      await readFile(source, "utf8"),
    ));
  }
  assert.ok(descriptors.length >= 20);
  const assemblyLifecycle = await readFile(
    "packages/cli/src/serve/assembly-lifecycle.ts",
    "utf8",
  );
  assert.throws(
    () => collectCleanupRegistrationsFromSource(
      "packages/cli/src/serve/assembly-lifecycle.ts",
      assemblyLifecycle.replace(
        "registerCleanup(registry, descriptor, () => contribution.handle.run())",
        "registry.register(descriptor.id, () => contribution.handle.run())",
      ),
    ),
    /bypasses registerCleanup descriptor/,
  );
  assert.throws(
    () => collectCleanupRegistrationsFromSource(
      "packages/cli/src/serve/assembly-lifecycle.ts",
      assemblyLifecycle.replace(
        "registerCleanup(registry, descriptor, () => contribution.handle.run())",
        "const shutdowns = registry; shutdowns.register(descriptor.id, () => contribution.handle.run())",
      ),
    ),
    /bypasses registerCleanup descriptor/,
  );
  assert.throws(
    () => collectCleanupRegistrationsFromSource(
      "packages/cli/src/serve/assembly-lifecycle.ts",
      assemblyLifecycle.replace('owner: "anchor-host",\n    role: "runtime",\n    id: "meshRuntime.stop"', 'role: "runtime",\n    id: "meshRuntime.stop"'),
    ),
    /owner\/role\/id must be literal/,
  );
  assert.throws(
    () => collectCleanupRegistrationsFromSource(
      "packages/cli/src/serve/assembly-lifecycle.ts",
      assemblyLifecycle.replace('owner: "anchor-host",\n    role: "runtime",\n    id: "meshRuntime.stop"', 'owner: "unknown-host",\n    role: "runtime",\n    id: "meshRuntime.stop"'),
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
        "      executorDispatch: localExecutorBoundary.application,",
        "      globalState: ctx.authorityRuntime.globalState,\n      executorDispatch: localExecutorBoundary.application,",
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
      (text) => text.replace('  | "verifier"\n> & {', "> & {"),
    )).join("\n"),
    /must be exactly the frozen key set/,
  );
  assert.match(
    inspectLocalConversationOwnerIsolation(mutate(
      "packages/cli/src/serve/access-surfaces.ts",
      (text) => text.replace(
        "      verifier: ctx.authorityRuntime.verifier,\n    });",
        "      verifier: ctx.authorityRuntime.verifier,\n      globalState: ctx.authorityRuntime.globalState,\n    });",
      ),
    )).join("\n"),
    /forbidden or duplicate dependency globalState/,
  );
  assert.match(
    inspectLocalConversationOwnerIsolation(mutate(
      "packages/cli/src/serve/access-surfaces.ts",
      (text) => text.replace(
        "      validateLocalConversationManifest:\n        ctx.authorityRuntime.validateLocalConversationManifest,\n      verifier: ctx.authorityRuntime.verifier,\n    });\n    const localExecutorBoundary",
        "      validateLocalConversationManifest:\n        ctx.authorityRuntime.validateLocalConversationManifest,\n    });\n    const localExecutorBoundary",
      ),
    )).join("\n"),
    /missing dependency verifier/,
  );
  assert.match(
    inspectLocalConversationOwnerIsolation(mutate(
      "packages/cli/src/serve/access-surfaces.ts",
      (text) => text.replace(
        "      deviceId: ctx.authorityRuntime.deviceId,",
        "      deviceId: ctx.authorityRuntime.executorId,",
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
        "    const localOwner = localConversationOwnerRuntime({\n",
        "    const localOwner = localConversationOwnerRuntime({\n      ...ctx.authorityRuntime,\n",
      ),
    )).join("\n"),
    /spread or shorthand/,
  );
  assert.match(
    inspectLocalConversationOwnerIsolation(mutate(
      "packages/cli/src/serve/access-surfaces.ts",
      (text) => text
        .replace(
          "    const localOwner = localConversationOwnerRuntime({\n",
          "    const localOwner = localConversationOwnerRuntime(Object.assign(ctx.authorityRuntime, {\n",
        )
        .replace(
          "      verifier: ctx.authorityRuntime.verifier,\n    });",
          "      verifier: ctx.authorityRuntime.verifier,\n    }));",
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
        "() => localConversationOwner.close(),",
        "() => Promise.resolve(),",
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

test("conversation dispatch application stays separate from the Host topology mechanism", async () => {
  const paths = [
    "packages/cli/src/serve/conversation-executor-dispatch.ts",
    "packages/cli/src/serve/conversation-protocol-runtime.ts",
    "packages/cli/src/serve/access-surfaces.ts",
    "packages/cli/src/serve/executor-role-runtime.ts",
    "packages/cli/src/serve/local-conversation-owner.ts",
    "packages/cli/src/serve/mesh-runtime-assembly.ts",
    "packages/cli/src/serve/command.ts",
    "packages/cli/src/serve/anchor-scheduler-runtime.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: (await readFile(relative, "utf8")).replaceAll("\r\n", "\n"),
  })));
  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );
  assert.deepEqual(inspectConversationExecutorDispatchBoundary(records), []);
  assert.match(
    inspectConversationExecutorDispatchBoundary(mutate(
      "packages/cli/src/serve/conversation-protocol-runtime.ts",
      (text) => text.replace(
        "readonly executorDispatch: ConversationExecutorDispatchApplication;",
        "readonly executorDispatch?: ConversationExecutorDispatchApplication;",
      ),
    )).join("\n"),
    /must be the required ConversationExecutorDispatchApplication/,
  );
  assert.match(
    inspectConversationExecutorDispatchBoundary(mutate(
      "packages/cli/src/serve/conversation-protocol-runtime.ts",
      (text) => `${text}\nconst leaked = bindRemoteExecution;\n`,
    )).join("\n"),
    /topology\/transport responsibility leaked/,
  );
  assert.match(
    inspectConversationExecutorDispatchBoundary(mutate(
      "packages/cli/src/serve/access-surfaces.ts",
      (text) => text.replace(
        "const localExecutorBoundary = createConversationExecutorHostBoundary({",
        "const localExecutorBoundary = createConversationExecutorDispatch({",
      ),
    )).join("\n"),
    /Host boundary construction exact-set drifted/,
  );
  assert.match(
    inspectConversationExecutorDispatchBoundary(mutate(
      "packages/cli/src/serve/mesh-runtime-assembly.ts",
      (text) => text.replace(
        "options.executorTopology!.bindDirectory(this.#remoteDirectory())",
        "options.protocol!.bindRemoteExecution(this.#remoteDirectory())",
      ),
    )).join("\n"),
    /product policy\/application ownership drifted/,
  );
  assert.match(
    inspectConversationExecutorDispatchBoundary(mutate(
      "packages/cli/src/serve/local-conversation-owner.ts",
      (text) => text.replace(
        "executorDispatch: options.executorDispatch",
        "executorDispatch: createConversationExecutorHostBoundary({}).application",
      ),
    )).join("\n"),
    /application\/staging Host injection drifted/,
  );
  assert.match(
    inspectConversationExecutorDispatchBoundary(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => `${text}\nconst leakedLedger = conversationProtocol.executorLedger();\n`,
    )).join("\n"),
    /ledger escaped through a demand or dispatch accessor/,
  );
  assert.match(
    inspectConversationExecutorDispatchBoundary(mutate(
      "packages/cli/src/serve/conversation-executor-dispatch.ts",
      (text) => text.replace(
        "export class ConversationExecutorTopologyAdapter {",
        "export class ConversationExecutorTopologyAdapter {\n  localLedger() { return undefined; }",
      ),
    )).join("\n"),
    /service-locator owner|dispatch accessor/,
  );
  assert.match(
    inspectConversationExecutorDispatchBoundary(mutate(
      "packages/cli/src/serve/conversation-executor-dispatch.ts",
      (text) => text.replace(
        "export interface ConversationExecutorExecutionEffect {",
        "export interface ConversationExecutorExecutionEffect {\n  readonly ledger: ConversationAssignmentLedger;",
      ),
    )).join("\n"),
    /demand contract leaked concrete Executor implementation/,
  );
});

test("assignment data plane exposes finite local and Mesh ports to upper consumers", async () => {
  const paths = [
    "packages/cli/src/serve/executor-data-plane-runtime.ts",
    "packages/cli/src/serve/assignment-data-plane-topology.ts",
    "packages/cli/src/serve/lossless-data-plane-runtime.ts",
    "packages/cli/src/serve/lossless-data-plane-composition.ts",
    "packages/cli/src/serve/channel-interaction-coordinator.ts",
    "packages/cli/src/serve/conversation-protocol-runtime.ts",
    "packages/cli/src/serve/mesh-runtime-assembly.ts",
    "packages/cli/src/serve/access-surfaces.ts",
    "packages/cli/src/serve/executor-role-runtime.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: (await readFile(relative, "utf8")).replaceAll("\r\n", "\n"),
  })));
  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );

  assert.deepEqual(inspectAssignmentDataPlaneBoundary(records), []);
  assert.match(
    inspectAssignmentDataPlaneBoundary(mutate(
      "packages/cli/src/serve/assignment-data-plane-topology.ts",
      (text) => `${text}\ntype ConcreteLeak = ExecutorDataPlaneRuntime;\n`,
    )).join("\n"),
    /topology contract leaked a concrete mechanism/u,
  );
  assert.match(
    inspectAssignmentDataPlaneBoundary(mutate(
      "packages/cli/src/serve/lossless-data-plane-runtime.ts",
      (text) => `${text}\ntype ConcreteLeak = MeshRuntimeAssembly;\n`,
    )).join("\n"),
    /consumer bypassed its finite target port/u,
  );
  assert.match(
    inspectAssignmentDataPlaneBoundary(mutate(
      "packages/cli/src/serve/conversation-protocol-runtime.ts",
      (text) => `${text}\ntype ConcreteLeak = LosslessDataPlaneRuntime;\n`,
    )).join("\n"),
    /upper consumers depend on a concrete runtime/u,
  );
  assert.match(
    inspectAssignmentDataPlaneBoundary(mutate(
      "packages/cli/src/serve/executor-data-plane-runtime.ts",
      (text) => text.replace(
        "readonly #spool: AssignmentStreamSpool;",
        "readonly spool: AssignmentStreamSpool;",
      ),
    )).join("\n"),
    /concrete spool\/ticket ownership escaped/u,
  );
  assert.match(
    inspectAssignmentDataPlaneBoundary(mutate(
      "packages/cli/src/serve/mesh-runtime-assembly.ts",
      (text) => text.replace(
        "dataPlane.registerMeshServices({",
        "registerAssignmentStreamService(this.services, { spool: dataPlane.spool,",
      ),
    )).join("\n"),
    /Mesh assignment data-plane binding owns concrete storage/u,
  );
  assert.match(
    inspectAssignmentDataPlaneBoundary(mutate(
      "packages/cli/src/serve/access-surfaces.ts",
      (text) => text.replace(
        "targets: new AssignmentDataPlaneTopologyAdapter({",
        "targets: ctx.executorDataPlane,",
      ),
    )).join("\n"),
    /Host assignment data-plane construction/u,
  );
});

test("Advancement evidence selects local or Mesh only through one finite Host directory", async () => {
  const paths = [
    "packages/cli/src/serve/advancement-evidence-topology.ts",
    "packages/cli/src/serve/advancement-controller.ts",
    "packages/cli/src/serve/command.ts",
    "packages/cli/src/serve/access-surface.ts",
    "packages/cli/src/serve/access-surfaces.ts",
    "packages/cli/src/serve/local-conversation-owner.ts",
    "packages/cli/src/serve/mesh-runtime-assembly.ts",
    "packages/cli/src/serve/evidence-mesh.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: (await readFile(relative, "utf8")).replaceAll("\r\n", "\n"),
  })));
  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );

  assert.deepEqual(inspectAdvancementEvidenceTopologyBoundary(records), []);
  assert.match(
    inspectAdvancementEvidenceTopologyBoundary(mutate(
      "packages/cli/src/serve/advancement-evidence-topology.ts",
      (text) => `${text}\ntype ConcreteLeak = EvidenceMeshClient;\n`,
    )).join("\n"),
    /demand contract leaked a concrete mechanism/u,
  );
  assert.match(
    inspectAdvancementEvidenceTopologyBoundary(mutate(
      "packages/cli/src/serve/advancement-controller.ts",
      (text) => text.replace(
        "evidenceRuntime.targets.clientForExecutor(executorId)",
        "ctx.meshRuntime.evidenceForExecutor(executorId)",
      ),
    )).join("\n"),
    /application bypassed its finite target directory/u,
  );
  assert.match(
    inspectAdvancementEvidenceTopologyBoundary(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "evidenceRuntime: advancementEvidenceRuntime,",
        "evidenceRuntime: () => ctx.meshRuntime?.evidenceForExecutor(),",
      ),
    )).join("\n"),
    /command restored an AssemblyContext or Mesh evidence service-locator/u,
  );
  assert.match(
    inspectAdvancementEvidenceTopologyBoundary(mutate(
      "packages/cli/src/serve/access-surfaces.ts",
      (text) => text.replace(
        "targets: new AdvancementEvidenceTopologyAdapter({",
        "targets: ctx.meshRuntime!,",
      ),
    )).join("\n"),
    /Host Advancement evidence topology construction/u,
  );
  assert.match(
    inspectAdvancementEvidenceTopologyBoundary(mutate(
      "packages/cli/src/serve/mesh-runtime-assembly.ts",
      (text) => text.replace(
        "  remoteEvidenceClient(executorId: string): EvidenceHandlerPort | undefined {\n    try {",
        "  remoteEvidenceClient(executorId: string): EvidenceHandlerPort | undefined {\n    if (executorId === this.options.authority.executorId && this.options.executor?.evidence) return this.options.executor.evidence;\n    try {",
      ),
    )).join("\n"),
    /Mesh evidence mechanism regained local selection/u,
  );
  assert.match(
    inspectAdvancementEvidenceTopologyBoundary(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => `${text}\nconst duplicateEvidenceClient = new EvidenceMeshClient(client, verifier);\n`,
    )).join("\n"),
    /Mesh client or service acquired a second production owner/u,
  );
});

test("Assignment resources cross Conversation and Job through finite Correctness roles", async () => {
  const paths = [
    "packages/cli/src/serve/conversation-owner-runtime.ts",
    "packages/cli/src/serve/conversation-protocol-runtime.ts",
    "packages/cli/src/serve/conversation-executor-dispatch.ts",
    "packages/cli/src/serve/conversation-executor-ledger.ts",
    "packages/cli/src/serve/conversation-assignment-worker.ts",
    "packages/cli/src/serve/job-assignment-worker.ts",
    "packages/cli/src/serve/access-surfaces.ts",
    "packages/cli/src/serve/executor-role-runtime.ts",
    "packages/cli/src/serve/mesh-runtime-assembly.ts",
    "packages/cli/src/setup-delivery.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: (await readFile(relative, "utf8")).replaceAll("\r\n", "\n"),
  })));
  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );

  assert.deepEqual(inspectAssignmentResourcePortBoundary(records), []);
  assert.match(
    inspectAssignmentResourcePortBoundary(mutate(
      "packages/cli/src/serve/conversation-assignment-worker.ts",
      (text) => `${text}\ntype ConcreteLeak = ExecutorResourceGovernor;\n`,
    )).join("\n"),
    /demand boundary regained the concrete governor/u,
  );
  assert.match(
    inspectAssignmentResourcePortBoundary(mutate(
      "packages/cli/src/serve/conversation-owner-runtime.ts",
      (text) => text.replace(
        "readonly executionResources?: ResourceReservationPort;",
        "readonly executorResourceGovernor?: ResourceReservationPort;",
      ),
    )).join("\n"),
    /resource role exact-set or legacy aliases drifted/u,
  );
  assert.match(
    inspectAssignmentResourcePortBoundary(mutate(
      "packages/cli/src/serve/conversation-protocol-runtime.ts",
      (text) => text.replace(
        "this.#authority.executionResources",
        "this.#authority.executorResourceGovernor",
      ),
    )).join("\n"),
    /protocol bypassed its finite resource roles/u,
  );
  assert.match(
    inspectAssignmentResourcePortBoundary(mutate(
      "packages/cli/src/serve/job-assignment-worker.ts",
      (text) => text.replace(
        "readonly resources: ResourceReservationPort;",
        "readonly resourceGovernor: ResourceReservationPort;",
      ),
    )).join("\n"),
    /job worker bypassed its ResourceReservationPort/u,
  );
  assert.match(
    inspectAssignmentResourcePortBoundary(mutate(
      "packages/cli/src/serve/conversation-executor-ledger.ts",
      (text) => text.replace(
        "resources: options.authority.assignmentResources,",
        "resources: options.authority.assignmentResources as ExecutorResourceGovernor,",
      ),
    )).join("\n"),
    /ledger or dispatch bypassed its coordinator port/u,
  );
  assert.match(
    inspectAssignmentResourcePortBoundary(mutate(
      "packages/cli/src/serve/access-surfaces.ts",
      (text) => text.replace(
        "resources: ctx.authorityRuntime.executorResourceGovernor,",
        "resourceGovernor: ctx.authorityRuntime.executorResourceGovernor,",
      ),
    )).join("\n"),
    /Host Assignment resource role projection exact-set drifted/u,
  );
  assert.match(
    inspectAssignmentResourcePortBoundary([
      ...records,
      {
        relative: "packages/cli/src/serve/duplicate-resource-owner.ts",
        text: "const duplicate = new executorRuntime!.ExecutorResourceGovernor({});",
      },
    ]).join("\n"),
    /governor acquired a second production owner/u,
  );
});

test("P07 workspace probe physical persistence stays at one Host adapter", async () => {
  const paths = [
    "packages/core/src/environment/workspace-probe.ts",
    "packages/core/src/environment/workspace-probe-persistence.ts",
    "packages/core/src/environment/index.ts",
    "packages/core/src/index.ts",
    "packages/cli/src/serve/workspace-probe-persistence.ts",
    "packages/cli/src/setup-delivery.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: (await readFile(relative, "utf8")).replaceAll("\r\n", "\n"),
  })));
  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );

  assert.deepEqual(inspectWorkspaceProbePersistenceBoundary(records), []);
  assert.match(
    inspectWorkspaceProbePersistenceBoundary(mutate(
      "packages/core/src/environment/workspace-probe.ts",
      (text) => text.replace(
        "readonly persistence: WorkspaceProbePersistencePort;",
        "readonly persistence?: WorkspaceProbePersistencePort;",
      ),
    )).join("\n"),
    /demand persistence port exact-set drifted/u,
  );
  assert.match(
    inspectWorkspaceProbePersistenceBoundary(mutate(
      "packages/core/src/environment/workspace-probe.ts",
      (text) => `import path from "node:path";\n${text}`,
    )).join("\n"),
    /regained a path, filesystem or concrete log mechanism/u,
  );
  assert.match(
    inspectWorkspaceProbePersistenceBoundary(mutate(
      "packages/core/src/environment/index.ts",
      (text) => `${text}\nexport * from "./workspace-probe-persistence.js";\n`,
    )).join("\n"),
    /leaked through a Core barrel/u,
  );
  assert.match(
    inspectWorkspaceProbePersistenceBoundary(mutate(
      "packages/cli/src/setup-delivery.ts",
      (text) => text.replace(
        "authorityLog: executorLog!",
        "authorityLog: authorityLog!",
      ),
    )).join("\n"),
    /setupAuthorityRuntime workspace probe persistence binding drifted/u,
  );
  assert.match(
    inspectWorkspaceProbePersistenceBoundary(mutate(
      "packages/cli/src/serve/workspace-probe-persistence.ts",
      (text) => text.replace('"workspace-probes"', '"workspace-probe-cache"'),
    )).join("\n"),
    /adapter ownership or durability drifted/u,
  );
  assert.match(
    inspectWorkspaceProbePersistenceBoundary([
      ...records,
      {
        relative: "packages/cli/src/serve/duplicate-workspace-probe-persistence.ts",
        text: "class Duplicate implements WorkspaceProbePersistencePort {}",
      },
    ]).join("\n"),
    /acquired a second adapter or constructor/u,
  );
});

test("P07 workspace binding generation marker and WAL stay paired at one Host adapter", async () => {
  const paths = [
    "packages/core/src/environment/workspace-bindings.ts",
    "packages/core/src/environment/workspace-binding-catalog.ts",
    "packages/core/src/environment/workspace-binding-generation-persistence.ts",
    "packages/core/src/environment/index.ts",
    "packages/core/src/index.ts",
    "packages/core/package.json",
    "packages/core/tsup.config.ts",
    "packages/cli/src/serve/workspace-binding-generation-persistence.ts",
    "packages/cli/src/setup-delivery.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: (await readFile(relative, "utf8")).replaceAll("\r\n", "\n"),
  })));
  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );

  assert.deepEqual(
    inspectWorkspaceBindingGenerationPersistenceBoundary(records),
    [],
  );
  assert.match(
    inspectWorkspaceBindingGenerationPersistenceBoundary(mutate(
      "packages/core/src/environment/workspace-bindings.ts",
      (text) => text.replace(
        "readonly persistence: WorkspaceBindingGenerationPersistencePort;",
        "readonly persistence?: WorkspaceBindingGenerationPersistencePort;",
      ),
    )).join("\n"),
    /persistence port exact-set drifted/u,
  );
  assert.match(
    inspectWorkspaceBindingGenerationPersistenceBoundary(mutate(
      "packages/core/src/environment/workspace-bindings.ts",
      (text) => `${text}\nconst logPath = \"hidden\";\n`,
    )).join("\n"),
    /regained generation paths, marker I\/O or concrete WAL access/u,
  );
  assert.match(
    inspectWorkspaceBindingGenerationPersistenceBoundary(mutate(
      "packages/core/src/environment/index.ts",
      (text) => `${text}\nexport * from \"./workspace-binding-generation-persistence.js\";\n`,
    )).join("\n"),
    /export boundary drifted/u,
  );
  assert.match(
    inspectWorkspaceBindingGenerationPersistenceBoundary(mutate(
      "packages/cli/src/setup-delivery.ts",
      (text) => text.replace(
        "generation,\n                log",
        "generation,\n                initialWorkspaceBindingLog",
      ),
    )).join("\n"),
    /setupAuthorityRuntime workspace binding generation pairing drifted/u,
  );
  assert.match(
    inspectWorkspaceBindingGenerationPersistenceBoundary(mutate(
      "packages/cli/src/serve/workspace-binding-generation-persistence.ts",
      (text) => text.replace('"wx", 0o600', '"wx", 0o644'),
    )).join("\n"),
    /ownership or durability drifted/u,
  );
  assert.match(
    inspectWorkspaceBindingGenerationPersistenceBoundary([
      ...records,
      {
        relative: "packages/cli/src/serve/duplicate-workspace-binding-generation-persistence.ts",
        text: "class Duplicate implements WorkspaceBindingGenerationPersistencePort {}",
      },
    ]).join("\n"),
    /acquired a second adapter or factory/u,
  );
});

test("P07 workspace binding root manifest stays at one Host CAS adapter", async () => {
  const paths = [
    "packages/core/src/environment/workspace-binding-catalog.ts",
    "packages/core/src/environment/workspace-binding-catalog-persistence.ts",
    "packages/core/src/environment/index.ts",
    "packages/core/src/index.ts",
    "packages/core/tsup.config.ts",
    "packages/cli/src/serve/workspace-binding-catalog-persistence.ts",
    "packages/cli/src/setup-delivery.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: (await readFile(relative, "utf8")).replaceAll("\r\n", "\n"),
  })));
  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );

  assert.deepEqual(
    inspectWorkspaceBindingCatalogPersistenceBoundary(records),
    [],
  );
  assert.match(
    inspectWorkspaceBindingCatalogPersistenceBoundary(mutate(
      "packages/core/src/environment/workspace-binding-catalog.ts",
      (text) => text.replace(
        "readonly rootPersistence: WorkspaceBindingCatalogPersistencePort;",
        "readonly rootPersistence?: WorkspaceBindingCatalogPersistencePort;",
      ),
    )).join("\n"),
    /persistence port exact-set drifted/u,
  );
  assert.match(
    inspectWorkspaceBindingCatalogPersistenceBoundary(mutate(
      "packages/core/src/environment/workspace-binding-catalog.ts",
      (text) => `import path from \"node:path\";\n${text}`,
    )).join("\n"),
    /regained root paths, file CAS or physical maintenance identity/u,
  );
  assert.match(
    inspectWorkspaceBindingCatalogPersistenceBoundary(mutate(
      "packages/core/src/environment/index.ts",
      (text) => `${text}\nexport * from \"./workspace-binding-catalog-persistence.js\";\n`,
    )).join("\n"),
    /export boundary drifted/u,
  );
  assert.match(
    inspectWorkspaceBindingCatalogPersistenceBoundary(mutate(
      "packages/cli/src/setup-delivery.ts",
      (text) => text.replace(
        "rootPersistence: new FileWorkspaceBindingCatalogPersistence({\n            zhixingHome: options.zhixingHome,",
        "rootPersistence: new FileWorkspaceBindingCatalogPersistence({\n            zhixingHome: bindingRoot,",
      ),
    )).join("\n"),
    /setupAuthorityRuntime Workspace binding root CAS binding drifted/u,
  );
  assert.match(
    inspectWorkspaceBindingCatalogPersistenceBoundary(mutate(
      "packages/cli/src/serve/workspace-binding-catalog-persistence.ts",
      (text) => text.replace('"w", 0o600', '"w", 0o644'),
    )).join("\n"),
    /ownership or durability drifted/u,
  );
  assert.match(
    inspectWorkspaceBindingCatalogPersistenceBoundary([
      ...records,
      {
        relative: "packages/cli/src/serve/duplicate-workspace-binding-catalog-persistence.ts",
        text: "class Duplicate implements WorkspaceBindingCatalogPersistencePort {}",
      },
    ]).join("\n"),
    /acquired a second adapter or constructor/u,
  );
});

test("P09 Mesh bootstrap projections stay finite and required at Host edges", async () => {
  const paths = [
    "packages/cli/src/serve/mesh-bootstrap-projection.ts",
    "packages/cli/src/serve/mesh-bootstrap-store.ts",
    "packages/cli/src/serve/mesh-control-plane.ts",
    "packages/cli/src/serve/mesh-runtime-bootstrap.ts",
    "packages/cli/src/serve/mesh-runtime-assembly.ts",
    "packages/cli/src/serve/access-surfaces.ts",
    "packages/cli/src/serve/executor-role-runtime.ts",
    "packages/cli/src/runtime/surface-core-host-link.ts",
    "packages/cli/src/serve/mesh-pair-command.ts",
    "packages/cli/src/serve/backup-command.ts",
    "packages/cli/src/serve/disaster-recovery-command.ts",
    "packages/cli/src/serve/recovery-root-establishment-runtime.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: (await readFile(relative, "utf8")).replaceAll("\r\n", "\n"),
  })));
  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );

  assert.deepEqual(inspectMeshBootstrapProjectionBoundary(records), []);
  assert.match(
    inspectMeshBootstrapProjectionBoundary(mutate(
      "packages/cli/src/serve/mesh-control-plane.ts",
      (text) => text.replace(
        "readonly endpointDirectory: MeshEndpointDirectoryPersistencePort;",
        "readonly endpointDirectory?: MeshEndpointDirectoryPersistencePort;",
      ),
    )).join("\n"),
    /concrete or optional bootstrap persistence/u,
  );
  assert.match(
    inspectMeshBootstrapProjectionBoundary(mutate(
      "packages/cli/src/serve/mesh-control-plane.ts",
      (text) => `import { FileMeshBootstrapStore } from "./mesh-bootstrap-store.js";\n${text}`,
    )).join("\n"),
    /concrete or optional bootstrap persistence/u,
  );
  assert.match(
    inspectMeshBootstrapProjectionBoundary(mutate(
      "packages/cli/src/serve/mesh-pair-command.ts",
      (text) => `${text}\nvoid input.store.markBootstrapComplete("peer", "offer");`,
    )).join("\n"),
    /Command Host Mesh bootstrap projection binding drifted/u,
  );
  assert.match(
    inspectMeshBootstrapProjectionBoundary(mutate(
      "packages/cli/src/serve/executor-role-runtime.ts",
      (text) => text.replace(
        "bootstrapProjection: bootstrap.mesh.bootstrapProjection,",
        "",
      ),
    )).join("\n"),
    /Persistent Host Mesh bootstrap projection binding drifted/u,
  );
  assert.match(
    inspectMeshBootstrapProjectionBoundary([
      ...records,
      {
        relative: "packages/cli/src/serve/duplicate-mesh-bootstrap-projection.ts",
        text: "class Duplicate implements\n    MeshEndpointDirectoryPersistencePort {}",
      },
    ]).join("\n"),
    /second factory or physical owner/u,
  );
});

test("P09 pairing continuation stays finite, durable, and required at command/Host edges", async () => {
  const paths = [
    "packages/cli/src/serve/mesh-pairing-continuation-repository.ts",
    "packages/cli/src/serve/mesh-pairing-continuation.ts",
    "packages/cli/src/serve/mesh-pair-command.ts",
    "packages/cli/src/serve/mesh-runtime-assembly.ts",
    "packages/cli/src/serve/access-surfaces.ts",
    "packages/cli/src/serve/executor-role-runtime.ts",
    "packages/cli/src/serve/device-removal-cleanup.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: (await readFile(relative, "utf8")).replaceAll("\r\n", "\n"),
  })));
  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );

  assert.deepEqual(inspectMeshPairingContinuationPersistenceBoundary(records), []);
  assert.match(
    inspectMeshPairingContinuationPersistenceBoundary(mutate(
      "packages/cli/src/serve/mesh-runtime-assembly.ts",
      (text) => text.replace(
        "readonly pairingContinuations: MeshPairingContinuationRepository;",
        "readonly pairingContinuations?: MeshPairingContinuationRepository;",
      ),
    )).join("\n"),
    /optional or bypassed/u,
  );
  assert.match(
    inspectMeshPairingContinuationPersistenceBoundary(mutate(
      "packages/cli/src/serve/mesh-pair-command.ts",
      (text) => text.replace(
        "readonly continuations: MeshPairingContinuationRepository;",
        "readonly continuations: FileMeshPairingContinuationStore;",
      ),
    )).join("\n"),
    /Pair command bypasses/u,
  );
  assert.match(
    inspectMeshPairingContinuationPersistenceBoundary(mutate(
      "packages/cli/src/serve/mesh-pairing-continuation.ts",
      (text) => text.replace(
        "class FileMeshPairingContinuationStore",
        "export class FileMeshPairingContinuationStore",
      ),
    )).join("\n"),
    /durability contract drifted/u,
  );
  assert.match(
    inspectMeshPairingContinuationPersistenceBoundary(mutate(
      "packages/cli/src/serve/access-surfaces.ts",
      (text) => text.replace(
        /\s*pairingContinuations: createFileMeshPairingContinuationRepository\(\s*ctx\.zhixingHome,?\s*\),/u,
        "",
      ),
    )).join("\n"),
    /optional or bypassed|second factory/u,
  );
  assert.match(
    inspectMeshPairingContinuationPersistenceBoundary(mutate(
      "packages/cli/src/serve/device-removal-cleanup.ts",
      (text) => `${text}\nvoid "mesh-pairing-continuation.json";`,
    )).join("\n"),
    /Device removal cleanup took ownership/u,
  );
  assert.match(
    inspectMeshPairingContinuationPersistenceBoundary([
      ...records,
      {
        relative: "packages/cli/src/serve/duplicate-pairing-continuation.ts",
        text: "class Duplicate implements MeshPairingContinuationRepository {}",
      },
    ]).join("\n"),
    /second factory or physical owner/u,
  );
});

test("P09 Surface asset staging stays finite and physical only at two composition entries", async () => {
  const paths = [
    "packages/core/src/authority/surface-asset-staging.ts",
    "packages/core/src/authority/surface-assets.ts",
    "packages/core/src/authority/artifact-lifecycle-index.ts",
    "packages/cli/src/serve/surface-asset-staging-infrastructure.ts",
    "packages/cli/src/serve/surface-asset-authority.ts",
    "packages/cli/src/serve/mesh-bootstrap-store.ts",
    "packages/cli/src/serve/device-removal-cleanup.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: (await readFile(relative, "utf8")).replaceAll("\r\n", "\n"),
  })));
  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );

  assert.deepEqual(inspectSurfaceAssetStagingPersistenceBoundary(records), []);
  assert.match(
    inspectSurfaceAssetStagingPersistenceBoundary(mutate(
      "packages/core/src/authority/surface-assets.ts",
      (text) => text.replace(
        "readonly receiver: SurfaceAssetUploadStagingPort;",
        "readonly receiver: FileResumableArtifactReceiver;",
      ),
    )).join("\n"),
    /concrete or broad physical mechanism/u,
  );
  assert.match(
    inspectSurfaceAssetStagingPersistenceBoundary(mutate(
      "packages/core/src/authority/artifact-lifecycle-index.ts",
      (text) => text.replace(
        "readonly receiver: SurfaceAssetTemporaryRecoveryPort;",
        'readonly receiver: Pick<FileResumableArtifactReceiver, "progress">;',
      ),
    )).join("\n"),
    /concrete or broad physical mechanism/u,
  );
  assert.match(
    inspectSurfaceAssetStagingPersistenceBoundary(mutate(
      "packages/cli/src/serve/mesh-bootstrap-store.ts",
      (text) => text.replace("createSurfaceAssetStagingInfrastructure({", "missingStaging({"),
    )).join("\n"),
    /command-only composition|second physical root/u,
  );
  assert.match(
    inspectSurfaceAssetStagingPersistenceBoundary(mutate(
      "packages/cli/src/serve/mesh-bootstrap-store.ts",
      (text) => text.replace(
        "checkpointRetention(): ArtifactCheckpointRetentionPort",
        "checkpointRetention(): ArtifactLifecycleIndex",
      ),
    )).join("\n"),
    /command-only composition/u,
  );
  assert.match(
    inspectSurfaceAssetStagingPersistenceBoundary(mutate(
      "packages/cli/src/serve/surface-asset-authority.ts",
      (text) => `${text}\nvoid new FileResumableArtifactReceiver();`,
    )).join("\n"),
    /bypassed finite staging roles/u,
  );
  assert.match(
    inspectSurfaceAssetStagingPersistenceBoundary(mutate(
      "packages/cli/src/serve/device-removal-cleanup.ts",
      (text) => text.replace(
        'path.join(distributed, "surface-asset-partials"),',
        "",
      ),
    )).join("\n"),
    /current-device cleanup exact-set/u,
  );
  assert.match(
    inspectSurfaceAssetStagingPersistenceBoundary([
      ...records,
      {
        relative: "packages/cli/src/serve/duplicate-surface-staging.ts",
        text: 'void "surface-asset-temporary";',
      },
    ]).join("\n"),
    /second physical root/u,
  );
});

test("P09 assignment artifact partial receiver stays finite and Host-composed", async () => {
  const paths = [
    "packages/cli/src/serve/assignment-artifact-receiver.ts",
    "packages/cli/src/serve/assignment-artifact-receiver-infrastructure.ts",
    "packages/cli/src/serve/assignment-mesh-adapter.ts",
    "packages/cli/src/serve/assignment-mesh-composition.ts",
    "packages/cli/src/serve/mesh-runtime-assembly.ts",
    "packages/cli/src/serve/access-surfaces.ts",
    "packages/cli/src/serve/executor-role-runtime.ts",
    "packages/cli/src/serve/device-removal-cleanup.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: (await readFile(relative, "utf8")).replaceAll("\r\n", "\n"),
  })));
  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );

  assert.deepEqual(inspectAssignmentArtifactReceiverBoundary(records), []);
  assert.match(
    inspectAssignmentArtifactReceiverBoundary(mutate(
      "packages/cli/src/serve/assignment-mesh-adapter.ts",
      (text) => text.replace(
        "readonly receiver: AssignmentArtifactReceiverPort;",
        "readonly receiver: FileResumableArtifactReceiver;",
      ),
    )).join("\n"),
    /concrete, broad, or optional receiver/u,
  );
  assert.match(
    inspectAssignmentArtifactReceiverBoundary(mutate(
      "packages/cli/src/serve/mesh-runtime-assembly.ts",
      (text) => text.replace(
        "readonly assignmentArtifactReceiver: AssignmentArtifactReceiverPort;",
        "readonly assignmentArtifactReceiver?: AssignmentArtifactReceiverPort;",
      ),
    )).join("\n"),
    /concrete, broad, or optional receiver/u,
  );
  assert.match(
    inspectAssignmentArtifactReceiverBoundary(mutate(
      "packages/cli/src/serve/access-surfaces.ts",
      (text) => text.replace(
        "assignmentArtifactReceiver: createAssignmentArtifactReceiverInfrastructure({",
        "assignmentArtifactReceiver: missingAssignmentArtifactReceiver({",
      ),
    )).join("\n"),
    /Anchor Host|second Host entry/u,
  );
  assert.match(
    inspectAssignmentArtifactReceiverBoundary(mutate(
      "packages/cli/src/serve/device-removal-cleanup.ts",
      (text) => text.replace(
        'path.join(distributed, "mesh-artifact-partials"),',
        "",
      ),
    )).join("\n"),
    /current-device cleanup exact-set|second Host entry/u,
  );
  assert.match(
    inspectAssignmentArtifactReceiverBoundary([
      ...records,
      {
        relative: "packages/cli/src/serve/duplicate-assignment-receiver.ts",
        text: 'void "mesh-artifact-partials";',
      },
    ]).join("\n"),
    /second Host entry or physical root/u,
  );
});

test("conversation adoption stays bound to the two production roots and ordered recovery", async () => {
  const paths = [
    "packages/cli/src/serve/mesh-runtime-assembly.ts",
    "packages/cli/src/serve/conversation-transfer-staging-infrastructure.ts",
    "packages/cli/src/serve/access-surfaces.ts",
    "packages/cli/src/serve/executor-role-runtime.ts",
    "packages/cli/src/serve/planned-anchor-transfer.ts",
    "packages/cli/src/serve/disaster-recovery-target.ts",
    "packages/cli/src/serve/device-removal-cleanup.ts",
    "packages/cli/src/serve/conversation-evidence-authority.ts",
    "packages/cli/src/serve/conversation-transfer-mesh.ts",
    "packages/cli/src/serve/first-party-conversation-mesh.ts",
    "packages/cli/src/serve/local-conversation-rpc.ts",
    "packages/cli/src/serve/post-adoption-review.ts",
    "packages/cli/src/serve/conversation-resume-binding.ts",
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
      "packages/cli/src/serve/access-surfaces.ts",
      (text) => text.replace(
        "conversationTransferStaging: createConversationTransferStagingInfrastructure({",
        "conversationTransferStaging: null ?? createConversationTransferStagingInfrastructure({",
      ),
    )).join("\n"),
    /required at Mesh composition and physically created only by the Anchor Host/,
  );
  assert.match(
    inspectConversationAdoptionAssembly(mutate(
      "packages/cli/src/serve/mesh-runtime-assembly.ts",
      (text) => text.replace(
        "readonly conversationTransferStaging: ConversationTransferStagingArea | null;",
        "readonly conversationTransferStaging?: ConversationTransferStagingArea;",
      ),
    )).join("\n"),
    /must use private staging and the authority governor\/lifecycle abort/,
  );
  assert.match(
    inspectConversationAdoptionAssembly(mutate(
      "packages/owner-kernel/src/conversation-transfer.ts",
      (text) => `${text}\nclass FileConversationTransferStagingArea {}`,
    )).join("\n"),
    /demand ports, shared promotion and durable-abort cleanup/u,
  );
  assert.match(
    inspectConversationAdoptionAssembly(mutate(
      "packages/cli/src/serve/conversation-transfer-staging-infrastructure.ts",
      (text) => text.replace(
        "new FileResumableArtifactReceiver(",
        "new FileResumableArtifactReceiver(new FileArtifactStore(\"second\"),",
      ),
    )).join("\n"),
    /physical factory or finite frozen projection/u,
  );
  assert.match(
    inspectConversationAdoptionAssembly(mutate(
      "packages/cli/src/serve/device-removal-cleanup.ts",
      (text) => `${text}\nvoid "conversation-transfer-staging";`,
    )).join("\n"),
    /ownership escaped into another P12 lifecycle/u,
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
    /demand ports, shared promotion and durable-abort cleanup/,
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
      "packages/cli/src/serve/conversation-resume-binding.ts",
      (text) => text.replace("input.adoptionReview!.reviewForSurface", "Promise.resolve"),
    )).join("\n"),
    /public resume must reuse the authenticated anchor review coordinator/,
  );
  assert.match(
    inspectConversationAdoptionAssembly(mutate(
      "packages/server/src/rpc/methods/session.ts",
      (text) => text.replace("const observerAdded = manager.addObserver(", "const observerAdded = manager.getObserverCount("),
    )).join("\n"),
    /session resume must bind the authenticated observer before adoption review/,
  );
  assert.match(
    inspectConversationAdoptionAssembly(mutate(
      "packages/server/src/rpc/methods/session.ts",
      (text) => text.replace("observerAdded &&\n          !alreadyObserved", "true"),
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
    "packages/cli/src/serve/backup-target-config.ts",
    "packages/cli/src/serve/backup-target-config-infrastructure.ts",
    "packages/cli/src/maintenance/doctor.ts",
    "packages/cli/src/index.ts",
    "packages/core/src/backup-recovery/application.ts",
    "packages/core/src/index.ts",
    "packages/core/package.json",
    "packages/core/tsup.config.ts",
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
    "packages/cli/src/serve/credential-exposure-authority.ts",
    "packages/cli/src/serve/credential-rotation-publication.ts",
    "packages/cli/src/startup.ts",
    "packages/cli/src/setup-delivery.ts",
    "packages/cli/src/serve/recovery-root-establishment-runtime.ts",
    "packages/cli/src/serve/recovery-root-activation.ts",
    "packages/cli/src/serve/paired-checkpoint-incoming-infrastructure.ts",
    "packages/cli/src/serve/paired-checkpoint-target.ts",
    "packages/cli/src/serve/paired-checkpoint-target-infrastructure.ts",
    "packages/cli/src/serve/published-checkpoint-target.ts",
    "packages/cli/src/serve/published-checkpoint-target-infrastructure.ts",
    "packages/cli/src/serve/access-surfaces.ts",
    "packages/cli/src/serve/executor-role-runtime.ts",
    "packages/cli/src/serve/device-removal-cleanup.ts",
    "packages/cli/src/serve/topology-command.ts",
    "packages/cli/src/serve/application-host.ts",
    "packages/cli/src/serve/role-topology.ts",
    "packages/mesh/src/checkpoint-service.ts",
    "packages/mesh/src/checkpoint-target.ts",
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
      (text) => text.replace(
        "readonly publishedDirectoryTargets: ExistingPublishedCheckpointDirectorySessions;",
        "readonly publishedDirectoryTargets?: ExistingPublishedCheckpointDirectorySessions;",
      ),
    )).join("\n"),
    /published checkpoint filesystem target factory, bounded session or retention boundary drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/published-checkpoint-target-infrastructure.ts",
      (text) => text.replace('"recovery-checkpoints"', '"recovery-checkpoints-v2"'),
    )).join("\n"),
    /published checkpoint filesystem target factory, bounded session or retention boundary drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/backup-command.ts",
      (text) => `${text}\nimport { FileRecoveryCheckpointTarget } from "@zhixing/mesh/checkpoint-target";`,
    )).join("\n"),
    /published checkpoint filesystem target factory, bounded session or retention boundary drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/published-checkpoint-target-infrastructure.ts",
      (text) => `${text}\nconst forbidden = "PairedRecoveryCheckpointTarget";`,
    )).join("\n"),
    /published checkpoint filesystem target factory, bounded session or retention boundary drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/mesh/src/checkpoint-service.ts",
      (text) => text.replace(
        "export interface RecoveryCheckpointTargetSession",
        "interface UnboundedRecoveryCheckpointTarget",
      ),
    )).join("\n"),
    /published checkpoint filesystem target factory, bounded session or retention boundary drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/backup-runtime-owner.ts",
      (text) => text.replace(
        "readonly backupTargets: BackupTargetConfigurationRepository;",
        "readonly backupTargets?: BackupTargetConfigurationRepository;",
      ),
    )).join("\n"),
    /backup target configuration finite repository, physical factory or durability boundary drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/backup-target-config-infrastructure.ts",
      (text) => text.replace('"recovery-backup-targets.json"', '"backup-targets-v2.json"'),
    )).join("\n"),
    /backup target configuration finite repository, physical factory or durability boundary drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "backupTargets: createBackupTargetConfigurationInfrastructure(zhixingHome),",
        "backupTargets: undefined,",
      ),
    )).join("\n"),
    /backup target configuration finite repository, physical factory or durability boundary drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/maintenance/doctor.ts",
      (text) => text.replace(
        "readonly backupTargets: BackupTargetConfigurationRepository;",
        "readonly backupTargets?: BackupTargetConfigurationRepository;",
      ),
    )).join("\n"),
    /backup target configuration finite repository, physical factory or durability boundary drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/backup-target-config-infrastructure.ts",
      (text) => text.replace("await handle.sync();", "void handle;"),
    )).join("\n"),
    /backup target configuration finite repository, physical factory or durability boundary drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly([
      ...records,
      {
        relative: "packages/cli/src/serve/backup-target-config-duplicate.ts",
        text: "class FileBackupTargetConfiguration {}",
      },
    ]).join("\n"),
    /backup target configuration finite repository, physical factory or durability boundary drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/core/src/backup-recovery/application.ts",
      (text) => text.replace(
        "class BackupRecoveryAdministrationApplicationService",
        "class BackupRecoveryAdministrationCoordinator",
      ),
    )).join("\n"),
    /one Backup & Recovery application owner/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/core/src/backup-recovery/application.ts",
      (text) => text.replaceAll(
        "`backup-setup:${binding.targetId}:${root.checkpointRevision}`",
        "`backup-setup:${binding.targetId}:latest`",
      ),
    )).join("\n"),
    /one Backup & Recovery application owner/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/backup-command.ts",
      (text) => text.replace(
        "createBackupRecoveryAdministration(context, options).verify()",
        "createService(context, context.trust, metadataOnlyTarget(\"latest\")).verify()",
      ),
    )).join("\n"),
    /one Backup & Recovery application owner/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/core/src/index.ts",
      (text) => `${text}\nexport * from \"./backup-recovery/application.js\";`,
    )).join("\n"),
    /one Backup & Recovery application owner/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "projectBackupRecoveryPublicStatus(ctx.authorityCheckpointOwner",
        "projectRecoveryBackupStatus(ctx.authorityCheckpointOwner",
      ),
    )).join("\n"),
    /one Backup & Recovery application owner/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/core/src/backup-recovery/application.ts",
      (text) => `${text}\ntype TestOnlyBackupSelector = { readonly pairedDeviceId?: string };`,
    )).join("\n"),
    /one Backup & Recovery application owner|candidate discovery and admission/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/disaster-recovery-command.ts",
      (text) => `${text}\nexport type DisasterRecoveryInventoryPort = unknown;`,
    )).join("\n"),
    /candidate discovery and admission must have one domain application owner/,
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
      "packages/cli/src/serve/paired-checkpoint-incoming-infrastructure.ts",
      (text) => text.replace("rootEstablishment: true", "rootEstablishment: false"),
    )).join("\n"),
    /signed activation replay must remain durably bound/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/application-host.ts",
      (text) => text.replace("await this.#dependencies.runRecoveryRoot({", "await this.#runRoleComponents({"),
    )).join("\n"),
    /finite pre-business topology/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/backup-command.ts",
      (text) => `${text}\nconst forbidden = "PairedRecoveryCheckpointTarget";`,
    )).join("\n"),
    /paired checkpoint target finite Infrastructure or lifecycle boundary drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace('kind: "runtime-unavailable"', 'kind: "available"'),
    )).join("\n"),
    /paired checkpoint target finite Infrastructure or lifecycle boundary drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/backup-runtime-owner.ts",
      (text) => text.replace(
        "readonly pairedTargets: BorrowedPairedCheckpointTargetSessions;",
        "readonly pairedTargets?: BorrowedPairedCheckpointTargetSessions;",
      ),
    )).join("\n"),
    /paired checkpoint target finite Infrastructure or lifecycle boundary drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/paired-checkpoint-target-infrastructure.ts",
      (text) => text.replace(
        "close: once(input.closeControlPlane)",
        "close: input.closeControlPlane",
      ),
    )).join("\n"),
    /paired checkpoint target finite Infrastructure or lifecycle boundary drifted/,
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
      "packages/cli/src/serve/paired-checkpoint-incoming-infrastructure.ts",
      (text) => text.replace(
        '"recovery-checkpoint-incoming"',
        '"recovery-checkpoint-incoming-v2"',
      ),
    )).join("\n"),
    /incoming physical factory, required Host ports or cleanup exact-set drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/access-surfaces.ts",
      (text) => text.replace(
        "createPersistentPairedCheckpointCommandReceiverInfrastructure({",
        "undefined /* missing paired checkpoint receiver */",
      ),
    )).join("\n"),
    /incoming physical factory, required Host ports or cleanup exact-set drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/mesh/src/paired-checkpoint-target.ts",
      (text) => text.replaceAll(
        "receiver: PairedCheckpointCommandReceiver,",
        "receiver: PairedCheckpointReceiver,",
      ),
    )).join("\n"),
    /incoming physical factory, required Host ports or cleanup exact-set drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/device-removal-cleanup.ts",
      (text) => text.replace(
        '"recovery-checkpoint-incoming"',
        '"recovery-checkpoints"',
      ),
    )).join("\n"),
    /incoming physical factory, required Host ports or cleanup exact-set drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/mesh-pair-command.ts",
      (text) => text.replace(
        "return createPairingSocketPublishedCheckpointTarget({",
        "return createUnboundedPairingTarget({",
      ),
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
      "packages/cli/src/serve/paired-checkpoint-incoming-infrastructure.ts",
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
      "packages/core/src/backup-recovery/application.ts",
      (text) => text.replace(
        "const transferId = this.mechanism.deriveTransferId(transferInput)",
        'const transferId = "xfer-latest"',
      ),
    )).join("\n"),
    /candidate discovery and admission must have one domain application owner/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/disaster-recovery-command.ts",
      (text) => `${text}\nclass BackupRecoveryDisasterAdmissionApplicationService {}`,
    )).join("\n"),
    /candidate discovery and admission must have one domain application owner/,
  );
  assert.match(
    inspectRecoveryBackupAssembly([
      ...records,
      {
        relative: "packages/cli/src/serve/disaster-recovery-inventory.ts",
        text: "export function selectDisasterRecoveryCandidate() {}",
      },
    ]).join("\n"),
    /candidate discovery and admission must have one domain application owner/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/disaster-recovery-command.ts",
      (text) => text.replace(
        "return await application.admit(selection)",
        "return await selectDisasterRecoveryCandidate(selection)",
      ),
    )).join("\n"),
    /candidate discovery and admission must have one domain application owner/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/core/src/backup-recovery/application.ts",
      (text) => text.replace(
        "if (currentDeviceId === issuerDeviceId)",
        "if (false)",
      ),
    )).join("\n"),
    /install, continuation and finish must have one domain application owner/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/core/src/backup-recovery/application.ts",
      (text) => text.replace(
        "const disposition = await session.readTombstoneDisposition(transferId)",
        'const disposition = "eligible" as const',
      ),
    )).join("\n"),
    /install, continuation and finish must have one domain application owner/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/core/src/backup-recovery/application.ts",
      (text) => text.replace(
        "await fresh.abort(Object.freeze({",
        "await Promise.resolve(Object.freeze({",
      ),
    )).join("\n"),
    /install, continuation and finish must have one domain application owner/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/core/src/backup-recovery/application.ts",
      (text) => text.replace(
        "if (!input.userConfirmedOldDeviceIsolated)",
        "if (false)",
      ),
    )).join("\n"),
    /install, continuation and finish must have one domain application owner/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/disaster-recovery-command.ts",
      (text) => `${text}\nclass BackupRecoveryDisasterLifecycleApplicationService {}`,
    )).join("\n"),
    /install, continuation and finish must have one domain application owner/,
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
        "openInventoryTargets(context, targetSelection, signal)",
        "openInventoryTargets(context, targetSelection)",
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
      "packages/core/src/backup-recovery/application.ts",
      (text) => text.replace('commands: Object.freeze(["rotate"', 'commands: Object.freeze(["bypass"'),
    )).join("\n"),
    /recovery root lifecycle application owner, confirmation priority, command exact-set or production binding drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/cli/src/serve/backup-command.ts",
      (text) => `${text}\nclass RecoveryRootLifecycleService {}`,
    )).join("\n"),
    /recovery root lifecycle application owner, confirmation priority, command exact-set or production binding drifted/,
  );
  assert.match(
    inspectRecoveryBackupAssembly(mutate(
      "packages/core/src/backup-recovery/application.ts",
      (text) => text.replace(
        /    if \(!input\.userConfirmed\) \{\r?\n      throw new BackupRecoveryRootLifecycleError\("reset-confirmation-required"\);\r?\n    \}\r?\n    const approval = freezeResetApproval\(input\.decodeApproval\(\)\);/u,
        '    const approval = freezeResetApproval(input.decodeApproval());\n' +
          '    if (!input.userConfirmed) {\n' +
          '      throw new BackupRecoveryRootLifecycleError("reset-confirmation-required");\n' +
          "    }",
      ),
    )).join("\n"),
    /recovery root lifecycle application owner, confirmation priority, command exact-set or production binding drifted/,
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
    "packages/cli/src/serve/application-host.ts",
    "packages/cli/src/serve/planned-anchor-transfer-staging-infrastructure.ts",
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
      "packages/cli/src/serve/planned-anchor-transfer.ts",
      (text) => `import path from "node:path";\n${text}`,
    )).join("\n"),
    /staging physical ownership or finite boundary drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/serve/planned-anchor-transfer-staging-infrastructure.ts",
      (text) => text.replace('"anchor-transfer-staging"', '"disaster-recovery-staging"'),
    )).join("\n"),
    /staging physical ownership or finite boundary drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/serve/application-host.ts",
      (text) => text.replace(
        "plannedAnchorTransferStaging,\n      disasterRecoveryStaging,",
        "this.#dependencies.createPlannedAnchorTransferStaging({ zhixingHome: this.#input.zhixingHome }),\n      disasterRecoveryStaging,",
      ),
    )).join("\n"),
    /Host\/bootstrap required instance flow drifted/,
  );
  assert.match(
    inspectPlannedAnchorTransferAssembly(mutate(
      "packages/cli/src/serve/planned-anchor-transfer.ts",
      (text) => text.replace(
        "await context.cleanupTransfer();",
        "await context.cleanupTransferAndJournal();",
      ),
    )).join("\n"),
    /cleanup or lifecycle exact-set drifted/,
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
    "packages/cli/src/serve/access-surface.ts",
    "packages/cli/src/serve/access-surfaces.ts",
    "packages/cli/src/serve/assembly-lifecycle.ts",
    "packages/cli/src/serve/executor-role-lifecycle.ts",
    "packages/cli/src/serve/executor-server-lifecycle.ts",
    "packages/cli/src/serve/anchor-host-shell-lifecycle.ts",
    "packages/cli/src/serve/anchor-internal-stop.ts",
    "packages/cli/src/serve/executor-role-runtime.ts",
    "packages/cli/src/serve/executor-internal-stop.ts",
    "packages/cli/src/serve/topology-command.ts",
    "packages/cli/src/serve/application-host.ts",
    "packages/cli/src/serve/role-topology.ts",
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
    "packages/server/src/index.ts",
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
      "packages/cli/src/serve/access-surfaces.ts",
      (text) => text.replace(
        'ctx.lifecycleContributions.acquire("meshRuntime.stop"',
        'ctx.startupRollback.register("meshRuntime.stop"',
      ),
    )).join("\n"),
    /pre-server lifecycle contribution ownership drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/access-surfaces.ts",
      (text) => text.replace(
        'ctx.lifecycleContributions.acquire(\n      "confirmationBridge.dispose",',
        'registerCleanup(ctx.cleanup,\n      "confirmationBridge.dispose",',
      ),
    )).join("\n"),
    /Anchor activation-gate runtime lifecycle contribution ownership drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/access-surfaces.ts",
      (text) => text.replace(
        'ctx.lifecycleContributions.acquire(\n      "conversationProtocol.stopRecovery",\n      () => protocol.stopRecoveryLoop(),\n    );\n    protocol.startRecoveryLoop();',
        'protocol.startRecoveryLoop();\n    ctx.lifecycleContributions.acquire(\n      "conversationProtocol.stopRecovery",\n      () => protocol.stopRecoveryLoop(),\n    );',
      ),
    )).join("\n"),
    /Anchor activation-gate runtime lifecycle contribution ownership drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        'lifecycleContributions.transferExactTo(registry, "activation", [',
        'lifecycleContributions.transferExactTo(registry, "runtime", [',
      ),
    )).join("\n"),
    /Anchor activation-gate runtime lifecycle contribution ownership drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "      lifecycleContributions.assertTransferred();",
        '      registerCleanup(registry, { owner: "anchor-host", role: "runtime", id: "inboundRouter.refuseNew" }, () => undefined);\n      lifecycleContributions.assertTransferred();',
      ),
    )).join("\n"),
    /Anchor activation-gate runtime lifecycle contribution ownership drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/assembly-lifecycle.ts",
      (text) => text.replace(
        "contribution.handle.run()",
        "Promise.resolve()",
      ),
    )).join("\n"),
    /pre-server lifecycle contribution ownership drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/executor-role-runtime.ts",
      (text) => text.replace(
        '"executorDataPlane.close",',
        '"executorDataPlane.unowned",',
      ),
    )).join("\n"),
    /Executor non-Server lifecycle contribution ownership drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/executor-role-runtime.ts",
      (text) => text.replace(
        "executorServerLifecycle.acquireBinding(localServerBinding)",
        "void localServerBinding",
      ),
    )).join("\n"),
    /Executor Server lifecycle ownership or failure isolation drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/executor-server-lifecycle.ts",
      (text) => text.replace(
        "    if (endpointTerminal) {\n      await attempt(() => this.#stateFile?.markStopped(), failures);\n    }",
        "    await attempt(() => this.#stateFile?.markStopped(), failures);",
      ),
    )).join("\n"),
    /Executor Server lifecycle ownership or failure isolation drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/executor-role-runtime.ts",
      (text) => text.replace(
        "executorServerLifecycle.transferToRunningServer(openingRunner)",
        "void openingRunner",
      ),
    )).join("\n"),
    /Executor Server lifecycle ownership or failure isolation drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/executor-role-runtime.ts",
      (text) => text.replace(
        "  throwExecutorRoleFailures(roleFailure, cleanupFailures);",
        "  await localServerBinding?.close();\n  throwExecutorRoleFailures(roleFailure, cleanupFailures);",
      ),
    )).join("\n"),
    /Executor Server lifecycle ownership or failure isolation drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/executor-role-runtime.ts",
      (text) => text.replace(
        "    const jobOwnerLifecycle = new ExecutorJobOwnerLifecycle(",
        "    await Promise.resolve();\n    const jobOwnerLifecycle = new ExecutorJobOwnerLifecycle(",
      ),
    )).join("\n"),
    /Executor non-Server lifecycle contribution ownership drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/executor-role-runtime.ts",
      (text) => text.replace(
        "  throwExecutorRoleFailures(roleFailure, cleanupFailures);",
        "  await dataPlane?.close();\n  throwExecutorRoleFailures(roleFailure, cleanupFailures);",
      ),
    )).join("\n"),
    /Executor non-Server lifecycle contribution ownership drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/executor-role-lifecycle.ts",
      (text) => text.replace(
        "this.#authorityRollback.owns(handle)",
        "handle.name.length > 0",
      ),
    )).join("\n"),
    /Executor non-Server lifecycle contribution ownership drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/assembly-lifecycle.ts",
      (text) => text.replace(
        "if (!this.#rollback.owns(handle))",
        "if (false)",
      ),
    )).join("\n"),
    /pre-server lifecycle contribution ownership drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/anchor-host-shell-lifecycle.ts",
      (text) => text.replace(
        "    if (endpointTerminal) {",
        "    if (true) {",
      ),
    )).join("\n"),
    /Anchor Host shell lifecycle ownership or truthful terminal drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/anchor-host-shell-lifecycle.ts",
      (text) => text
        .replace(
          "    await attempt(() => this.#releaseOwnedDiscovery(), failures);\n",
          "",
        )
        .replace(
          "    if (endpointTerminal) {",
          "    if (endpointTerminal) {\n      await attempt(() => this.#releaseOwnedDiscovery(), failures);",
        ),
    )).join("\n"),
    /Anchor Host shell lifecycle ownership or truthful terminal drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/server/src/server.ts",
      (text) => text.replace(
        "  activationGate?: (server: ZhixingServerInstance) => Promise<void>;",
        '  activationGate?: (server: ZhixingServerInstance) => Promise<void>;\n  activationFailureCleanupOwner?: "server" | "caller";',
      ),
    )).join("\n"),
    /entry-last activation or publication order drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/server/src/server.ts",
      (text) => text.replace(
        "await activationFailureOwner.cleanupActivationFailure();",
        "await Promise.resolve();",
      ),
    )).join("\n"),
    /entry-last activation or publication order drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/anchor-host-shell-lifecycle.ts",
      (text) => text.replace(
        "await this.#idleCheck?.catch(() => undefined);",
        "void this.#idleCheck;",
      ),
    )).join("\n"),
    /Anchor Host shell lifecycle ownership or truthful terminal drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace("    lifecycleOwner: hostShellLifecycle,\n", ""),
    )).join("\n"),
    /entry-last activation or publication order drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/server/src/lifecycle.ts",
      (text) => text.replace(
        "await opts.lifecycleOwner.publishDiscovery(server);",
        "void server.port;",
      ),
    )).join("\n"),
    /entry-last activation or publication order drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "      await hostShellLifecycle.markReady({",
        "      await stateFile.markReady({",
      ),
    )).join("\n"),
    /entry-last activation or publication order drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "lifecycleContributions.assertTransferred();",
        "void lifecycleContributions;",
      ),
    )).join("\n"),
    /pre-server lifecycle contribution ownership drifted/,
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
      "packages/cli/src/serve/executor-role-runtime.ts",
      (text) => text.replace(
        "beforeActivate: async (openingRunner) =>",
        "afterActivate: async (openingRunner) =>",
      ),
    )).join("\n"),
    /Executor entry-last activation or publication order drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/executor-role-runtime.ts",
      (text) => text.replace("await onTrustApplied();", "void onTrustApplied();"),
    )).join("\n"),
    /Executor entry-last activation or publication order drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/executor-role-runtime.ts",
      (text) => text.replace(
        "shutdown: (reason) => openingRunner.shutdown(reason)",
        "shutdown: (reason) => localConversationServer!.shutdown(reason)",
      ),
    )).join("\n"),
    /Executor entry-last activation or publication order drifted/,
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
      (text) => text.replace("await this.#runRoleComponents(", "await this.#runSecondRoleComponents("),
    )).join("\n"),
    /unique composition root drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/application-host.ts",
      (text) => `${text}\nvoid anchorRole.runServeCommand(`,
    )).join("\n"),
    /unique composition root drifted/,
  );
  assert.match(
    inspectManagedHostAssembly(mutate(
      "packages/cli/src/serve/application-host.ts",
      (text) => text.replace('if (plan.host === "anchor-host")', 'if (plan.host === "executor-host")'),
    )).join("\n"),
    /unique composition root drifted/,
  );
  assert.match(
    inspectManagedHostAssembly([
      ...records,
      {
        relative: "packages/cli/src/serve/anchor-role.ts",
        text: 'export const run = () => import("./command.js");',
      },
    ]).join("\n"),
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

test("Device Administration reads, paired/current removal and duty migration have one application and pure RPC bindings", async () => {
  const paths = [
    "packages/core/src/device-administration/application.ts",
    "packages/core/src/backup-recovery/application.ts",
    "packages/core/src/index.ts",
    "packages/core/package.json",
    "packages/core/tsup.config.ts",
    "packages/server/src/context.ts",
    "packages/server/src/rpc/methods/server.ts",
    "packages/cli/src/serve/command.ts",
    "packages/cli/src/serve/mesh-runtime-assembly.ts",
    "packages/core/src/device-administration/correctness.ts",
    "packages/cli/src/serve/current-device-retirement-transaction.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: (await readFile(relative, "utf8")).replaceAll("\r\n", "\n"),
  })));
  assert.deepEqual(inspectDeviceAdministrationReadOwnership(records), []);
  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );
  assert.match(
    inspectDeviceAdministrationReadOwnership([
      ...records,
      {
        relative: "packages/cli/src/serve/anchor-uninstall.ts",
        text: "export class AnchorUninstallCoordinator {}",
      },
    ]).join("\n"),
    /coordinator or product path selection returned/,
  );
  assert.match(
    inspectDeviceAdministrationReadOwnership(mutate(
      "packages/core/src/device-administration/application.ts",
      (text) => text.replace("defineProductApiQuery<", "defineProductApiQueryBroken<"),
    )).join("\n"),
    /Query\/Product API exact-set drifted/,
  );
  assert.match(
    inspectDeviceAdministrationReadOwnership(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "new DeviceAdministrationApplicationService({",
        "new DeviceAdministrationApplicationService({}); new DeviceAdministrationApplicationService({",
      ),
    )).join("\n"),
    /unique Host application composition drifted/,
  );
  assert.match(
    inspectDeviceAdministrationReadOwnership(mutate(
      "packages/server/src/rpc/methods/server.ts",
      (text) => text.replace(
        "productApi.query(DEVICE_ADMINISTRATION_LIST_QUERY",
        "ctx.server.deviceLifecycle.remove(); productApi.query(DEVICE_ADMINISTRATION_LIST_QUERY",
      ),
    )).join("\n"),
    /RPC pure read binding drifted/,
  );
  assert.match(
    inspectDeviceAdministrationReadOwnership(mutate(
      "packages/server/src/context.ts",
      (text) => text.replace(
        "productApi?: ProductApiDispatcher;",
        "productApi?: ProductApiDispatcher;\n  deviceLifecycle?: { remove(): Promise<void> };",
      ),
    )).join("\n"),
    /ServerContext owner returned/,
  );
  assert.match(
    inspectDeviceAdministrationReadOwnership(mutate(
      "packages/server/src/context.ts",
      (text) => text.replace(
        "productApi?: ProductApiDispatcher;",
        "productApi?: ProductApiDispatcher;\n  anchorUninstall?: { preflight(): Promise<void> };",
      ),
    )).join("\n"),
    /ServerContext owner returned/,
  );
  assert.match(
    inspectDeviceAdministrationReadOwnership(mutate(
      "packages/server/src/context.ts",
      (text) => text.replace(
        "productApi?: ProductApiDispatcher;",
        "productApi?: ProductApiDispatcher;\n  dutyMigration?: { prepare(): Promise<void> };",
      ),
    )).join("\n"),
    /ServerContext owner returned/,
  );
  assert.match(
    inspectDeviceAdministrationReadOwnership(mutate(
      "packages/server/src/rpc/methods/server.ts",
      (text) => text.replace(
        "productApi.command(DEVICE_ADMINISTRATION_PREPARE_DUTY_MIGRATION_COMMAND",
        "ctx.server.dutyMigration.prepare(); productApi.command(DEVICE_ADMINISTRATION_PREPARE_DUTY_MIGRATION_COMMAND",
      ),
    )).join("\n"),
    /RPC pure read binding drifted/,
  );
  assert.match(
    inspectDeviceAdministrationReadOwnership(mutate(
      "packages/server/src/rpc/methods/server.ts",
      (text) => text.replace(
        "return productApi.query(DEVICE_ADMINISTRATION_CURRENT_REMOVAL_PREFLIGHT_QUERY",
        "ctx.server.anchorUninstall.preflight(); return productApi.query(DEVICE_ADMINISTRATION_CURRENT_REMOVAL_PREFLIGHT_QUERY",
      ),
    )).join("\n"),
    /RPC pure read binding drifted/,
  );
  assert.match(
    inspectDeviceAdministrationReadOwnership(mutate(
      "packages/cli/src/serve/mesh-runtime-assembly.ts",
      (text) => `${text}\nfunction beginDeviceRemoval() { return undefined; }`,
    )).join("\n"),
    /decision returned to Mesh runtime/,
  );
  assert.match(
    inspectDeviceAdministrationReadOwnership(mutate(
      "packages/core/src/device-administration/correctness.ts",
      (text) => `${text}\nclass CurrentRemovalCoordinator { async acceptMigration() {} async acceptRecovery() {} }`,
    )).join("\n"),
    /coordinator or product path selection returned/,
  );
  assert.match(
    inspectDeviceAdministrationReadOwnership(mutate(
      "packages/core/src/device-administration/correctness.ts",
      (text) => `${text}\ntype LegacyMigrationInput = { readonly targetName: string };`,
    )).join("\n"),
    /coordinator or product path selection returned/,
  );
  assert.match(
    inspectDeviceAdministrationReadOwnership(mutate(
      "packages/core/src/device-administration/correctness.ts",
      (text) => `${text}\nfunction projectState() { return { nextAction: "continue" }; }`,
    )).join("\n"),
    /correctness regained product state/,
  );
  assert.match(
    inspectDeviceAdministrationReadOwnership(mutate(
      "packages/core/src/device-administration/correctness.ts",
      (text) => `${text}\nclass LegacyMigrationDrive { #driveMigration() { return undefined; } }`,
    )).join("\n"),
    /migration lifecycle has a second phase owner/,
  );
  assert.match(
    inspectDeviceAdministrationReadOwnership(mutate(
      "packages/core/src/device-administration/correctness.ts",
      (text) => `${text}\nclass LegacyRecoveryDrive { #driveRecovery() { return undefined; } }`,
    )).join("\n"),
    /recovery ownership drifted/,
  );
  assert.match(
    inspectDeviceAdministrationReadOwnership(mutate(
      "packages/cli/src/serve/current-device-retirement-transaction.ts",
      (text) => text.replace("decideCurrentDeviceRetirementCredentialExposures({", "legacyExposureDecision({"),
    )).join("\n"),
    /recovery ownership drifted/,
  );
  assert.match(
    inspectDeviceAdministrationReadOwnership(mutate(
      "packages/core/src/backup-recovery/application.ts",
      (text) => text.replaceAll("minimumUpToLsn?: number", "minimumLsn?: number"),
    )).join("\n"),
    /recovery ownership drifted/,
  );
  assert.match(
    inspectDeviceAdministrationReadOwnership(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "effects: {\n          closeAdmission: closeAnchorUninstallAdmission,",
        "effects: {\n          leakedPhase: operation.phase,\n          closeAdmission: closeAnchorUninstallAdmission,",
      ),
    )).join("\n"),
    /migration lifecycle has a second phase owner/,
  );
  assert.match(
    inspectDeviceAdministrationReadOwnership(mutate(
      "packages/core/src/device-administration/application.ts",
      (text) => text.replace('if (operation.phase === "transfer-committed")', "if (false)"),
    )).join("\n"),
    /Query\/Product API exact-set drifted/,
  );
  assert.match(
    inspectDeviceAdministrationReadOwnership(mutate(
      "packages/core/src/device-administration/application.ts",
      (text) => text.replace("assertCurrentRemovalCancellationEligible(lifecycle);", ""),
    )).join("\n"),
    /Query\/Product API exact-set drifted/,
  );
  assert.match(
    inspectDeviceAdministrationReadOwnership(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "currentRemovalContext: {",
        "currentRemovalContext: { recoveryBackupReady: true,",
      ),
    )).join("\n"),
    /unique Host application composition drifted/,
  );
  assert.match(
    inspectDeviceAdministrationReadOwnership(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "currentDeviceRemoval,",
        'currentDeviceRemoval: { ...currentDeviceRemoval, nextAction: "continue" },',
      ),
    )).join("\n"),
    /unique Host application composition drifted/,
  );
  assert.match(
    inspectDeviceAdministrationReadOwnership(mutate(
      "packages/core/src/index.ts",
      (text) => `${text}\nexport * from \"./device-administration/application.js\";`,
    )).join("\n"),
    /narrow export\/build boundary drifted/,
  );
});

test("Channel concrete runtime stays behind Host-owned demand ports", async () => {
  const paths = [
    "packages/cli/src/serve/channels.ts",
    "packages/cli/src/serve/access-surfaces.ts",
    "packages/cli/src/serve/channel-conversation-product-binding.ts",
    "packages/cli/src/serve/command.ts",
    "packages/cli/src/serve/conversation-run-control-binding.ts",
    "packages/core/src/conversation/application.ts",
    "packages/owner-kernel/src/conversation-agent-turn-admission.ts",
    "packages/server/src/context.ts",
    "packages/server/src/server.ts",
    "packages/server/src/channels/inbound-router.ts",
    "packages/server/src/confirmation/text-renderer.ts",
    "packages/core/src/delivery/channel-effect.ts",
    "packages/cli/src/serve/lossless-data-plane-runtime.ts",
    "packages/cli/src/serve/channel-interaction-coordinator.ts",
    "packages/cli/src/setup-delivery.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: await readFile(relative, "utf8"),
  })));
  assert.deepEqual(inspectChannelRuntimeBoundary(records), []);

  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );
  assert.match(
    inspectChannelRuntimeBoundary(mutate(
      "packages/cli/src/serve/channels.ts",
      (text) => text.replace(
        "  readonly delivery: ChannelDeliveryEffectSource;",
        "  readonly delivery: ChannelDeliveryEffectSource;\n  readonly inbound: InboundChannelPort;",
      ),
    )).join("\n"),
    /SetupChannelsResult exposes an unconsumed Channel capability/u,
  );
  assert.match(
    inspectChannelRuntimeBoundary(mutate(
      "packages/cli/src/serve/channels.ts",
      (text) => text.replace("      channels: inbound,", "      channels: missingInbound,"),
    )).join("\n"),
    /finite Host port assembly drifted/u,
  );
  assert.match(
    inspectChannelRuntimeBoundary(mutate(
      "packages/server/src/channels/inbound-router.ts",
      (text) => `${text}\ntype ChannelRegistry = unknown;\n`,
    )).join("\n"),
    /concrete Channel registry or adapter escaped/u,
  );
  assert.match(
    inspectChannelRuntimeBoundary(mutate(
      "packages/cli/src/serve/access-surfaces.ts",
      (text) => text.replace(
        "ctx.channelDelivery = result.delivery",
        "ctx.channelDelivery = result.registry",
      ),
    )).join("\n"),
    /separate finite Channel ports/u,
  );
  assert.match(
    inspectChannelRuntimeBoundary(mutate(
      "packages/server/src/server.ts",
      (text) => `${text}\nvoid ctx.channels;\n`,
    )).join("\n"),
    /Server status, inbound or confirmation demand boundary drifted/u,
  );
  assert.match(
    inspectChannelRuntimeBoundary(mutate(
      "packages/cli/src/serve/lossless-data-plane-runtime.ts",
      (text) => `${text}\ntype ChannelAdapter = unknown;\n`,
    )).join("\n"),
    /concrete Channel registry or adapter escaped/u,
  );
  assert.match(
    inspectChannelRuntimeBoundary(mutate(
      "packages/server/src/channels/inbound-router.ts",
      (text) => text.replace(
        "this.conversation.admitAgentTurn({",
        "this.conversations.admitTurn({",
      ),
    )).join("\n"),
    /finite Conversation application boundary/u,
  );
  assert.match(
    inspectChannelRuntimeBoundary(mutate(
      "packages/cli/src/serve/channel-conversation-product-binding.ts",
      (text) => text.replace(
        "productApi.command(\n        CONVERSATION_ADMIT_AGENT_TURN_COMMAND,",
        "this.#manager.admitTurn(\n        CONVERSATION_ADMIT_AGENT_TURN_COMMAND,",
      ),
    )).join("\n"),
    /Product API binding or unique Host composition/u,
  );
  assert.match(
    inspectChannelRuntimeBoundary(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "ctx.channelConversationProduct?.bind(productApi);",
        "void productApi;",
      ),
    )).join("\n"),
    /Product API binding or unique Host composition/u,
  );
  assert.match(
    inspectChannelRuntimeBoundary(mutate(
      "packages/owner-kernel/src/conversation-agent-turn-admission.ts",
      (text) => text.replaceAll(
        'request.source ?? "interactive"',
        '"interactive"',
      ),
    )).join("\n"),
    /admission or durable cancellation mechanism binding drifted/u,
  );
  assert.match(
    inspectChannelRuntimeBoundary(mutate(
      "packages/core/src/conversation/application.ts",
      (text) => text.replace(
        '  readonly kind = "authoritative-response" as const;',
        '  readonly kind = "authoritative-response" as const;\n  readonly replyTarget: unknown;',
      ),
    )).join("\n"),
    /admission or durable cancellation mechanism binding drifted/u,
  );
});

test("Kernel run input has one finite Envelope owner and three production bindings", async () => {
  const paths = [
    "packages/orchestrator/src/runtime/kernel-run-envelope.ts",
    "packages/orchestrator/src/runtime/create-agent-runtime.ts",
    "packages/orchestrator/src/runtime/index.ts",
    "packages/runtime-host/src/session-adapter.ts",
    "packages/runtime-host/src/runtime-host.ts",
    "packages/cli/src/serve/ephemeral-executor.ts",
    "packages/cli/src/serve/agent-job-runtime.ts",
    "packages/cli/src/serve/workscene-runtime-projection.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: await readFile(relative, "utf8"),
  })));
  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );

  assert.deepEqual(inspectKernelRunEnvelopeOwnership(records), []);
  assert.match(
    inspectKernelRunEnvelopeOwnership(mutate(
      "packages/orchestrator/src/runtime/kernel-run-envelope.ts",
      (text) => text.replace(
        "readonly observation: {",
        "readonly observation?: {",
      ),
    )).join("\n"),
    /partition is not required, readonly and finite/,
  );
  assert.match(
    inspectKernelRunEnvelopeOwnership(mutate(
      "packages/orchestrator/src/runtime/create-agent-runtime.ts",
      (text) => `${text}\ninterface RunParams { messages: unknown[] }`,
    )).join("\n"),
    /retired RunParams contract remains/,
  );
  assert.match(
    inspectKernelRunEnvelopeOwnership(mutate(
      "packages/orchestrator/src/runtime/create-agent-runtime.ts",
      (text) => text.replace(
        "const envelope = captureKernelRunEnvelope(input);",
        "const envelope = input;",
      ),
    )).join("\n"),
    /does not expose one captured Kernel Run Envelope entry/,
  );
  for (const relative of [
    "packages/runtime-host/src/session-adapter.ts",
    "packages/cli/src/serve/ephemeral-executor.ts",
    "packages/cli/src/serve/agent-job-runtime.ts",
  ]) {
    assert.match(
      inspectKernelRunEnvelopeOwnership(mutate(
        relative,
        (text) => text.replace("modelInput: {", "messages: {"),
      )).join("\n"),
      /production run binding bypasses/,
    );
  }
  assert.match(
    inspectKernelRunEnvelopeOwnership(mutate(
      "packages/runtime-host/src/runtime-host.ts",
      (text) => `${text}\nvoid createAgentRuntime({} as never);`,
    )).join("\n"),
    /second Kernel assembly path/,
  );
});

test("Kernel run events have one finite owner and explicit two-sided projections", async () => {
  const paths = [
    "packages/orchestrator/src/runtime/kernel-run-event.ts",
    "packages/orchestrator/src/runtime/kernel-run-envelope.ts",
    "packages/orchestrator/src/runtime/create-agent-runtime.ts",
    "packages/orchestrator/src/runtime/index.ts",
    "packages/orchestrator/src/index.ts",
    "packages/runtime-host/src/session-adapter.ts",
    "packages/cli/src/serve/ephemeral-executor.ts",
    "packages/cli/src/serve/agent-job-runtime.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: await readFile(relative, "utf8"),
  })));
  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );

  assert.deepEqual(inspectKernelRunEventOwnership(records), []);
  assert.match(
    inspectKernelRunEventOwnership(mutate(
      "packages/orchestrator/src/runtime/kernel-run-event.ts",
      (text) => text.replace(
        '  | { readonly type: "thinking_block_start" }\n',
        "",
      ),
    )).join("\n"),
    /variant or field exact-set drifted/,
  );
  assert.match(
    inspectKernelRunEventOwnership(mutate(
      "packages/orchestrator/src/runtime/create-agent-runtime.ts",
      (text) => text.replace(
        "projectAgentYieldToKernelRunEvent(value)",
        "value",
      ),
    )).join("\n"),
    /Loop to Kernel Event boundary is bypassed/,
  );
  assert.match(
    inspectKernelRunEventOwnership(mutate(
      "packages/runtime-host/src/session-adapter.ts",
      (text) => text.replace('    case "tool_end":', '    case "tool_finished":'),
    )).join("\n"),
    /product projection is not explicit and exhaustive/,
  );
  assert.match(
    inspectKernelRunEventOwnership(mutate(
      "packages/cli/src/serve/ephemeral-executor.ts",
      (text) => text.replace("  assertKernelRunEvent(event);", ""),
    )).join("\n"),
    /product projection is not explicit and exhaustive/,
  );
  assert.match(
    inspectKernelRunEventOwnership(mutate(
      "packages/cli/src/serve/agent-job-runtime.ts",
      (text) => `${text}\ntype KernelRunEvent = { type: string };`,
    )).join("\n"),
    /second owner/,
  );
  assert.match(
    inspectKernelRunEventOwnership(mutate(
      "packages/orchestrator/src/runtime/kernel-run-event.ts",
      (text) => `${text}\ntype SessionEventProjection = unknown;`,
    )).join("\n"),
    /out-of-band protocol projection share an owner/,
  );
  assert.match(
    inspectKernelRunEventOwnership(mutate(
      "packages/orchestrator/src/index.ts",
      (text) => `${text}\nexport { type KernelRunEvent } from "./runtime/index.js";`,
    )).join("\n"),
    /leaked through the orchestrator package root/,
  );
});

test("Kernel terminals have one finite owner, zero-copy artifact transfer and three product projections", async () => {
  const paths = [
    "packages/orchestrator/src/runtime/kernel-terminal.ts",
    "packages/orchestrator/src/runtime/create-agent-runtime.ts",
    "packages/orchestrator/src/runtime/index.ts",
    "packages/orchestrator/src/index.ts",
    "packages/runtime-host/src/session-adapter.ts",
    "packages/cli/src/serve/ephemeral-executor.ts",
    "packages/cli/src/serve/agent-job-runtime.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: await readFile(relative, "utf8"),
  })));
  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );

  assert.deepEqual(inspectKernelTerminalOwnership(records), []);
  assert.match(
    inspectKernelTerminalOwnership(mutate(
      "packages/orchestrator/src/runtime/kernel-terminal.ts",
      (text) => text.replace(
        "      readonly exitDelayMs?: number;\n",
        "",
      ),
    )).join("\n"),
    /variant or field exact-set drifted/,
  );
  assert.match(
    inspectKernelTerminalOwnership(mutate(
      "packages/orchestrator/src/runtime/create-agent-runtime.ts",
      (text) => text.replace(
        "projectAgentResultToKernelTerminal(value)",
        "value",
      ),
    )).join("\n"),
    /Loop to Kernel Terminal boundary is bypassed/,
  );
  assert.match(
    inspectKernelTerminalOwnership(mutate(
      "packages/orchestrator/src/runtime/kernel-terminal.ts",
      (text) => text.replace(
        "artifacts: Object.freeze({ ...artifacts }),",
        "artifacts: cloneAndFreeze(artifacts),",
      ),
    )).join("\n"),
    /without deep cloning/,
  );
  assert.match(
    inspectKernelTerminalOwnership(mutate(
      "packages/runtime-host/src/session-adapter.ts",
      (text) => text.replace('    case "max_turns":', '    case "turn_limit":'),
    )).join("\n"),
    /product projection is not explicit and exhaustive/,
  );
  assert.match(
    inspectKernelTerminalOwnership(mutate(
      "packages/runtime-host/src/session-adapter.ts",
      (text) => text.replace(
        "newMessages: [...artifacts.newMessages]",
        "newMessages: artifacts.newMessages.map((message) => structuredClone(message))",
      ),
    )).join("\n"),
    /repeats the Kernel artifact object graph/,
  );
  assert.match(
    inspectKernelTerminalOwnership(mutate(
      "packages/cli/src/serve/ephemeral-executor.ts",
      (text) => text.replace("  assertKernelTerminal(terminal);", ""),
    )).join("\n"),
    /product projection is not explicit and exhaustive/,
  );
  assert.match(
    inspectKernelTerminalOwnership(mutate(
      "packages/cli/src/serve/agent-job-runtime.ts",
      (text) => `${text}\ntype KernelTerminal = { reason: string };`,
    )).join("\n"),
    /second owner/,
  );
  assert.match(
    inspectKernelTerminalOwnership(mutate(
      "packages/orchestrator/src/index.ts",
      (text) => `${text}\nexport { type KernelTerminal } from "./runtime/index.js";`,
    )).join("\n"),
    /leaked through the package root/,
  );
});

test("Kernel Conformance covers four production bindings and freezes AgentRuntime API", async () => {
  const paths = [
    "packages/orchestrator/src/runtime/create-agent-runtime.ts",
    "packages/orchestrator/src/runtime/index.ts",
    "packages/orchestrator/src/index.ts",
    "packages/runtime-host/src/session-adapter.ts",
    "packages/cli/src/serve/ephemeral-executor.ts",
    "packages/cli/src/serve/agent-job-runtime.ts",
    "packages/executor/src/runtime-role.ts",
    "packages/cli/src/serve/executor-role-runtime.ts",
    "packages/cli/src/serve/__tests__/kernel-runtime-conformance.test.ts",
    "packages/cli/src/serve/assembly-lifecycle.ts",
    "packages/cli/src/serve/command.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: await readFile(relative, "utf8"),
  })));
  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );

  assert.deepEqual(inspectKernelConformanceAndAgentRuntimeBudget(records), []);
  assert.match(
    inspectKernelConformanceAndAgentRuntimeBudget(mutate(
      "packages/orchestrator/src/runtime/create-agent-runtime.ts",
      (text) => text.replace(
        "export interface AgentRuntime {",
        "export interface AgentRuntime {\n  readonly metadata: unknown;",
      ),
    )).join("\n"),
    /public member exact-set drifted/,
  );
  assert.match(
    inspectKernelConformanceAndAgentRuntimeBudget(mutate(
      "packages/orchestrator/src/index.ts",
      (text) => `${text}\nexport { createAgentRuntime } from "./runtime/index.js";`,
    )).join("\n"),
    /not confined to the runtime subpath/,
  );
  assert.match(
    inspectKernelConformanceAndAgentRuntimeBudget(mutate(
      "packages/cli/src/serve/__tests__/kernel-runtime-conformance.test.ts",
      (text) => text.replace('    name: "remote Executor assignment",', '    name: "local alias",'),
    )).join("\n"),
    /does not cover the four real production bindings/,
  );
  assert.match(
    inspectKernelConformanceAndAgentRuntimeBudget(mutate(
      "packages/cli/src/serve/__tests__/kernel-runtime-conformance.test.ts",
      (text) => text.replace(
        "createInProcessAssignmentRuntimeFactory(role)",
        "createInProcessRuntimeFactory(role)",
      ),
    )).join("\n"),
    /does not cover the four real production bindings/,
  );
  assert.match(
    inspectKernelConformanceAndAgentRuntimeBudget(mutate(
      "packages/cli/src/serve/__tests__/kernel-runtime-conformance.test.ts",
      (text) => text.replace(
        "expect(binding.cancel(ABORT_REASON)).toBe(true);",
        "expect(binding.cancel(ABORT_REASON)).toBe(false);",
      ),
    )).join("\n"),
    /does not cover the four real production bindings/,
  );
  assert.match(
    inspectKernelConformanceAndAgentRuntimeBudget(mutate(
      "packages/cli/src/serve/executor-role-runtime.ts",
      (text) => text.replace(
        "executor.createInProcessAssignmentRuntimeFactory(role)",
        "executor.createInProcessRuntimeFactory(role)",
      ),
    )).join("\n"),
    /Kernel production binding is missing or duplicated/,
  );
  assert.match(
    inspectKernelConformanceAndAgentRuntimeBudget(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        'lifecycleContributions.acquire("ephemeralRuntime.dispose",',
        'void ("ephemeralRuntime.dispose" &&',
      ),
    )).join("\n"),
    /lacks one typed production lifecycle owner/,
  );
});

test("AgentRuntime keeps one internal security chain behind finite public ports", async () => {
  const paths = [
    "packages/orchestrator/src/runtime/create-agent-runtime.ts",
    "packages/runtime-host/src/session-adapter.ts",
    "packages/runtime-host/src/runtime-host.ts",
    "packages/cli/src/serve/agent-job-runtime.ts",
    "packages/cli/src/serve/ephemeral-executor.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: await readFile(relative, "utf8"),
  })));
  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );

  assert.deepEqual(inspectAgentRuntimeSecurityEncapsulation(records), []);
  assert.match(
    inspectAgentRuntimeSecurityEncapsulation(mutate(
      "packages/orchestrator/src/runtime/create-agent-runtime.ts",
      (text) => text.replace(
        "  readonly confirmationBroker: IConfirmationBroker;",
        "  readonly securityPipeline: SecurityPipeline;\n  readonly confirmationBroker: IConfirmationBroker;",
      ),
    )).join("\n"),
    /exposes a security implementation/,
  );
  assert.match(
    inspectAgentRuntimeSecurityEncapsulation(mutate(
      "packages/orchestrator/src/runtime/create-agent-runtime.ts",
      (text) => text.replace(
        "    confirmationBroker,",
        "    permissionStore: permissionStorage,\n    confirmationBroker,",
      ),
    )).join("\n"),
    /returns a security implementation/,
  );
  assert.match(
    inspectAgentRuntimeSecurityEncapsulation(mutate(
      "packages/orchestrator/src/runtime/create-agent-runtime.ts",
      (text) => text.replace(
        "    confirmationBroker,",
        "    securityImplementation() { return securityPipeline; },\n    confirmationBroker,",
      ),
    )).join("\n"),
    /returns a security implementation/,
  );
  assert.match(
    inspectAgentRuntimeSecurityEncapsulation(mutate(
      "packages/runtime-host/src/session-adapter.ts",
      (text) => `${text}\nexport const leakedPipeline = (runtime: AgentRuntime) => runtime.securityPipeline;`,
    )).join("\n"),
    /external production code reads AgentRuntime security internals/,
  );
  assert.match(
    inspectAgentRuntimeSecurityEncapsulation(mutate(
      "packages/orchestrator/src/runtime/create-agent-runtime.ts",
      (text) => text.replace("      securityPipeline,", ""),
    )).join("\n"),
    /internal security chain is no longer single and shared/,
  );
});

test("AgentRuntime keeps workspace resolution internal while Anchor shares one host projection", async () => {
  const paths = [
    "packages/orchestrator/src/runtime/create-agent-runtime.ts",
    "packages/runtime-host/src/session-adapter.ts",
    "packages/runtime-host/src/runtime-host.ts",
    "packages/cli/src/serve/command.ts",
    "packages/cli/src/serve/host-default-workspace.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: await readFile(relative, "utf8"),
  })));
  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );

  assert.deepEqual(inspectAgentRuntimeWorkspaceEncapsulation(records), []);
  assert.match(
    inspectAgentRuntimeWorkspaceEncapsulation(mutate(
      "packages/orchestrator/src/runtime/create-agent-runtime.ts",
      (text) => text.replace(
        "  readonly confirmationBroker: IConfirmationBroker;",
        "  readonly resolvedWorkspace: ResolvedWorkspace;\n  readonly confirmationBroker: IConfirmationBroker;",
      ),
    )).join("\n"),
    /exposes workspace resolution/,
  );
  assert.match(
    inspectAgentRuntimeWorkspaceEncapsulation(mutate(
      "packages/orchestrator/src/runtime/create-agent-runtime.ts",
      (text) => text.replace(
        "    confirmationBroker,",
        "    workspaceMetadata: workspace,\n    confirmationBroker,",
      ),
    )).join("\n"),
    /returns workspace resolution/,
  );
  assert.match(
    inspectAgentRuntimeWorkspaceEncapsulation(mutate(
      "packages/runtime-host/src/session-adapter.ts",
      (text) => `${text}\nexport const leakedWorkspace = (runtime: AgentRuntime) => runtime.resolvedWorkspace;`,
    )).join("\n"),
    /external production code reads AgentRuntime workspace internals/,
  );
  assert.match(
    inspectAgentRuntimeWorkspaceEncapsulation(mutate(
      "packages/cli/src/serve/host-default-workspace.ts",
      (text) => text.replace(
        "resolveWorkspace(configuration, { sessionType })",
        "{ path: configuration.workspace?.root ?? null }",
      ),
    )).join("\n"),
    /authority resolver/,
  );
  assert.match(
    inspectAgentRuntimeWorkspaceEncapsulation(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "hostDefaultWorkspace.hostInfoWorkspace",
        "ephemeralRuntime.resolvedWorkspace.path ?? undefined",
      ),
    )).join("\n"),
    /do not share the one default workspace projection/,
  );
});

test("TurnContext providers are fixed assembly input before every RuntimeHost issuance", async () => {
  const paths = [
    "packages/orchestrator/src/runtime/create-agent-runtime.ts",
    "packages/runtime-host/src/runtime-host.ts",
    "packages/cli/src/runtime/turn-context-providers.ts",
    "packages/cli/src/serve/command.ts",
    "packages/cli/src/serve/executor-role-runtime.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: await readFile(relative, "utf8"),
  })));
  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );

  assert.deepEqual(inspectTurnContextProviderAssembly(records), []);
  assert.match(
    inspectTurnContextProviderAssembly(mutate(
      "packages/orchestrator/src/runtime/create-agent-runtime.ts",
      (text) => text.replace(
        "  drainLifecycleDiagnostics(): readonly AgentEventMap[\"lifecycle:warning\"][];",
        "  drainLifecycleDiagnostics(): readonly AgentEventMap[\"lifecycle:warning\"][];\n  registerTurnContextProvider(provider: TurnContextProvider): void;",
      ),
    )).join("\n"),
    /assembly-only|runtime-after-publication/,
  );
  assert.match(
    inspectTurnContextProviderAssembly(mutate(
      "packages/runtime-host/src/runtime-host.ts",
      (text) => text.replace(
        "const turnContextProviders = this.opts.turnContextProviders?.();",
        "const turnContextProviders = undefined;",
      ),
    )).join("\n"),
    /every issuance path/,
  );
  assert.match(
    inspectTurnContextProviderAssembly(mutate(
      "packages/runtime-host/src/runtime-host.ts",
      (text) => text.replace(
        "return this.assemble({ runtimeKind: \"ephemeral\", runtimeTools });",
        "return createAgentRuntime({} as never);",
      ),
    )).join("\n"),
    /every issuance path/,
  );
  assert.match(
    inspectTurnContextProviderAssembly(mutate(
      "packages/cli/src/runtime/turn-context-providers.ts",
      (text) => text
        .replace("new SchedulerProvider(deps.getSchedulerStatus)", "new TaskListProvider(() => [])")
        .replace("new TaskListProvider(() => {", "new SchedulerProvider(() => EMPTY_TASK_STATUS_SUMMARY),\n    new TaskListProvider(() => {"),
    )).join("\n"),
    /frozen scheduler\/task-list sequence/,
  );
  assert.match(
    inspectTurnContextProviderAssembly(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace("turnContextProviders: () =>", "providersAfterCreate: () =>"),
    )).join("\n"),
    /one CLI provider assembly factory/,
  );
  assert.match(
    inspectTurnContextProviderAssembly(mutate(
      "packages/cli/src/serve/executor-role-runtime.ts",
      (text) => `${text}\nconst turnContextProviders = [\"scheduler\"];`,
    )).join("\n"),
    /ExecutorRuntimeSubstrate/,
  );
});

test("Kernel model providers are concrete only at the Host edge", async () => {
  const paths = [
    "packages/orchestrator/src/runtime/kernel-model-provider.ts",
    "packages/orchestrator/src/runtime/kernel-runtime-environment.ts",
    "packages/orchestrator/src/runtime/create-agent-runtime.ts",
    "packages/orchestrator/src/runtime/index.ts",
    "packages/orchestrator/src/index.ts",
    "packages/runtime-host/src/runtime-host.ts",
    "packages/cli/src/runtime/kernel-runtime-bindings.ts",
    "packages/cli/src/serve/command.ts",
    "packages/cli/src/serve/executor-role-runtime.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: await readFile(relative, "utf8"),
  })));
  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );

  assert.deepEqual(inspectKernelProviderDependencyInversion(records), []);
  assert.match(
    inspectKernelProviderDependencyInversion(mutate(
      "packages/orchestrator/src/runtime/create-agent-runtime.ts",
      (text) => `import { createProviderRoles } from "@zhixing/providers";\n${text}`,
    )).join("\n"),
    /concrete Provider|concrete Provider\/configuration/,
  );
  assert.match(
    inspectKernelProviderDependencyInversion(mutate(
      "packages/orchestrator/src/index.ts",
      (text) => `${text}\nexport * from "./runtime/kernel-model-provider.js";`,
    )).join("\n"),
    /runtime subpath/,
  );
  assert.match(
    inspectKernelProviderDependencyInversion(mutate(
      "packages/runtime-host/src/runtime-host.ts",
      (text) => text.replace(
        "const modelProvider = this.opts.modelProvider.create({",
        "const modelProvider = { roles: {} }; // bypass\n    void ({",
      ),
    )).join("\n"),
    /every runtime through the Host-owned provider factories/,
  );
  assert.match(
    inspectKernelProviderDependencyInversion(mutate(
      "packages/cli/src/runtime/kernel-runtime-bindings.ts",
      (text) => text.replace("createProviderRoles({", "resolveProviderRoles({"),
    )).join("\n"),
    /concrete Provider\/configuration adapter owner/,
  );
  assert.match(
    inspectKernelProviderDependencyInversion(mutate(
      "packages/cli/src/runtime/kernel-runtime-bindings.ts",
      (text) => text.replace(
        /attention: \{\s*optimalMaxTokens: primaryModelCapability\.optimalMaxTokens,\s*riskMaxTokens: primaryModelCapability\.riskMaxTokens,\s*\}/u,
        "attention: primaryModelCapability",
      ),
    )).join("\n"),
    /concrete Provider\/configuration adapter owner/,
  );
  assert.match(
    inspectKernelProviderDependencyInversion(mutate(
      "packages/cli/src/serve/executor-role-runtime.ts",
      (text) => text.replace(
        "modelProvider: this.#modelProvider.create({ primaryRole }),",
        "modelProvider: {} as never,",
      ),
    )).join("\n"),
    /Executor production issuance/,
  );
  assert.match(
    inspectProductionManifest("packages/orchestrator/package.json", {
      dependencies: { "@zhixing/providers": "workspace:*" },
    }).join("\n"),
    /concrete Provider production dependency/,
  );
});

test("Kernel tool implementations are concrete only at the Host edge", async () => {
  const paths = [
    "packages/orchestrator/src/runtime/kernel-tool-implementation.ts",
    "packages/orchestrator/src/runtime/create-agent-runtime.ts",
    "packages/orchestrator/src/runtime/index.ts",
    "packages/orchestrator/src/index.ts",
    "packages/orchestrator/package.json",
    "packages/runtime-host/src/runtime-host.ts",
    "packages/cli/src/runtime/kernel-tool-implementation.ts",
    "packages/cli/src/serve/application-host.ts",
    "packages/cli/src/serve/role-topology.ts",
    "packages/cli/src/serve/command.ts",
    "packages/cli/src/serve/executor-role-runtime.ts",
    "packages/cli/src/runtime/workspace-command.ts",
    "packages/core/src/conversation/application.ts",
    "packages/core/src/workscene/application.ts",
    "packages/tools-builtin/src/task-list.ts",
    "packages/cli/src/serve/conversation-task-list-application.ts",
    "packages/cli/src/serve/builtin-extra-tools.ts",
    "packages/cli/src/serve/workmode-tools.ts",
    "packages/cli/src/serve/workscene-application-adapter.ts",
    "packages/cli/src/serve/workscene-runtime-projection.ts",
    "packages/cli/src/serve/job-runtime-tool-selection.ts",
    "packages/orchestrator/src/tools/task.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: await readFile(relative, "utf8"),
  })));
  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );

  assert.deepEqual(inspectKernelToolImplementationDependencyInversion(records), []);
  assert.match(inspectKernelToolImplementationDependencyInversion(mutate(
    "packages/orchestrator/src/runtime/create-agent-runtime.ts",
    (text) => `import { BUILTIN_TOOL_FACTORIES } from "@zhixing/tools-builtin";\n${text}`,
  )).join("\n"), /demand-owned Tool port|concrete Tool package/);
  assert.match(inspectKernelToolImplementationDependencyInversion(mutate(
    "packages/runtime-host/src/runtime-host.ts",
    (text) => text.replace(
      "toolImplementation: this.opts.toolImplementation,",
      "toolImplementation: fallbackToolImplementation,",
    ),
  )).join("\n"), /RuntimeHost/);
  assert.match(inspectKernelToolImplementationDependencyInversion(mutate(
    "packages/cli/src/serve/executor-role-runtime.ts",
    (text) => text.replace(
      "toolImplementation: this.options.toolImplementation,",
      "toolImplementation: createFallback(),",
    ),
  )).join("\n"), /Executor runtime issuance/);
  assert.match(inspectKernelToolImplementationDependencyInversion(mutate(
    "packages/orchestrator/src/index.ts",
    (text) => `${text}\nexport type { KernelToolImplementationPort } from "./runtime/index.js";`,
  )).join("\n"), /runtime-only subpath/);
  assert.match(inspectKernelToolImplementationDependencyInversion(mutate(
    "packages/tools-builtin/src/task-list.ts",
    (text) => `${text}\nconst assignmentMutations = runContextStorage.getStore();`,
  )).join("\n"), /Conversation-owned command/);
  assert.match(inspectKernelToolImplementationDependencyInversion(mutate(
    "packages/cli/src/serve/workmode-tools.ts",
    (text) => `${text}\nconst assignmentMutations = runContextStorage.getStore();`,
  )).join("\n"), /Workscene tools/);
  assert.match(inspectKernelToolImplementationDependencyInversion(mutate(
    "packages/cli/src/serve/executor-role-runtime.ts",
    (text) => `${text}\nthrow new Error("Job requested unavailable tools:");`,
  )).join("\n"), /requested-tool policy/);
  assert.match(inspectKernelToolImplementationDependencyInversion(mutate(
    "packages/orchestrator/src/tools/task.ts",
    (text) => text.replace(
      "securityPipeline: env.securityPipeline,",
      "securityPipeline: createIndependentSecurityPipeline(),",
    ),
  )).join("\n"), /parent controlled-effect chain/);
  assert.match(inspectProductionManifest("packages/orchestrator/package.json", {
    dependencies: { "@zhixing/tools-builtin": "workspace:*" },
  }).join("\n"), /concrete Tool production dependency/);
});

test("Advancement model providers are concrete only at the Host edge", async () => {
  const paths = [
    "packages/orchestrator/src/advancement/model-provider.ts",
    "packages/orchestrator/src/advancement/index.ts",
    "packages/orchestrator/src/index.ts",
    "packages/cli/src/runtime/advancement-model-provider.ts",
    "packages/cli/src/serve/advancement-controller.ts",
    "packages/cli/src/serve/command.ts",
    "packages/cli/src/serve/local-conversation-owner.ts",
    "packages/cli/src/serve/access-surfaces.ts",
    "packages/cli/src/serve/executor-role-runtime.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: await readFile(relative, "utf8"),
  })));
  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );

  assert.deepEqual(inspectAdvancementProviderDependencyInversion(records), []);
  assert.match(
    inspectAdvancementProviderDependencyInversion(mutate(
      "packages/cli/src/serve/advancement-controller.ts",
      (text) => `import { createProviderRoles } from "@zhixing/providers";\n${text}`,
    )).join("\n"),
    /concrete Provider configuration/,
  );
  assert.match(
    inspectAdvancementProviderDependencyInversion(mutate(
      "packages/cli/src/runtime/advancement-model-provider.ts",
      (text) => text.replace(
        /capability: \{\s*optimalMaxTokens: resolvedAttention\.optimalMaxTokens,\s*riskMaxTokens: resolvedAttention\.riskMaxTokens,\s*\}/u,
        "capability: resolvedAttention",
      ),
    )).join("\n"),
    /finite Advancement Provider projection/,
  );
  assert.match(
    inspectAdvancementProviderDependencyInversion(mutate(
      "packages/cli/src/serve/local-conversation-owner.ts",
      (text) => text.replace(
        "readonly advancementModelProvider: AdvancementModelProviderFactory;",
        "readonly config: ZhixingConfig;",
      ),
    )).join("\n"),
    /production roots/,
  );
  assert.match(
    inspectAdvancementProviderDependencyInversion(mutate(
      "packages/orchestrator/src/index.ts",
      (text) => `${text}\nexport { type AdvancementModelProviderBinding } from "./advancement/index.js";`,
    )).join("\n"),
    /narrow subpath/,
  );
});

test("runtime secrets cross the Host boundary only as frozen purpose projections", async () => {
  const paths = [
    "packages/cli/src/runtime/runtime-secret-projections.ts",
    "packages/cli/src/startup.ts",
    "packages/cli/src/serve/role-topology.ts",
    "packages/cli/src/serve/application-host.ts",
    "packages/cli/src/serve/command.ts",
    "packages/cli/src/serve/executor-role-runtime.ts",
    "packages/cli/src/runtime/workspace-command.ts",
    "packages/cli/src/serve/executor-readiness.ts",
    "packages/cli/src/serve/credential-rotation-publication.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: await readFile(relative, "utf8"),
  })));
  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );

  assert.deepEqual(inspectRuntimeSecretProjectionBoundary(records), []);
  assert.match(
    inspectRuntimeSecretProjectionBoundary(mutate(
      "packages/cli/src/runtime/runtime-secret-projections.ts",
      (text) => text.replace(
        "...(mcp === undefined ? {} : { mcp }),\n    }),\n    credentialRotationCredentials:",
        "...(mcp === undefined ? {} : { mcp }),\n      ...(channels === undefined ? {} : { channels }),\n    }),\n    credentialRotationCredentials:",
      ),
    )).join("\n"),
    /purpose exact-set/,
  );
  assert.match(
    inspectRuntimeSecretProjectionBoundary(mutate(
      "packages/cli/src/runtime/runtime-secret-projections.ts",
      (text) => text.replace("deepFreeze(structuredClone(value))", "value"),
    )).join("\n"),
    /frozen purpose exact-set/,
  );
  assert.match(
    inspectRuntimeSecretProjectionBoundary(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => `${text}\nconst leaked = bootstrap.startup.credentials;`,
    )).join("\n"),
    /Anchor role reconstructs or consumes aggregate credentials/,
  );
  assert.match(
    inspectRuntimeSecretProjectionBoundary(mutate(
      "packages/cli/src/serve/role-topology.ts",
      (text) => text.replace(
        "readonly credentialExposureCredentials: CredentialExposureSecretProjection;\n}",
        "readonly credentialExposureCredentials: CredentialExposureSecretProjection;\n  readonly channelCredentials: ChannelCredentialProjection;\n}",
      ),
    )).join("\n"),
    /topology isolation/,
  );
  assert.match(
    inspectRuntimeSecretProjectionBoundary(mutate(
      "packages/cli/src/serve/role-topology.ts",
      (text) => text.replace(
        "readonly credentialGeneration: string | null;",
        "readonly startup: StartupCheckResult;\n  readonly credentialGeneration: string | null;",
      ),
    )).join("\n"),
    /topology isolation/,
  );
});

test("validated configuration crosses composition roots as finite frozen projections", async () => {
  const paths = [
    "packages/cli/src/runtime/runtime-configuration-snapshot.ts",
    "packages/cli/src/runtime/runtime-configuration-projections.ts",
    "packages/cli/src/runtime/runtime-configuration-provider.ts",
    "packages/cli/src/runtime/repl-local-view.ts",
    "packages/cli/src/runtime/surface-core-host-link.ts",
    "packages/cli/src/repl.ts",
    "packages/cli/src/commands/info-commands.ts",
    "packages/cli/src/startup.ts",
    "packages/cli/src/serve/role-topology.ts",
    "packages/cli/src/serve/application-host.ts",
    "packages/cli/src/serve/command.ts",
    "packages/cli/src/serve/executor-role-runtime.ts",
    "packages/cli/src/runtime/workspace-command.ts",
    "packages/cli/src/serve/access-surface.ts",
    "packages/cli/src/serve/access-surfaces.ts",
    "packages/cli/src/runtime/kernel-runtime-bindings.ts",
    "packages/cli/src/runtime/advancement-model-provider.ts",
    "packages/cli/src/serve/host-default-workspace.ts",
    "packages/cli/src/serve/trust-administration-adapter.ts",
    "packages/cli/src/serve/credential-rotation-publication.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: await readFile(relative, "utf8"),
  })));
  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );

  assert.deepEqual(inspectRuntimeConfigurationProjectionBoundary(records), []);
  assert.match(
    inspectRuntimeConfigurationProjectionBoundary(mutate(
      "packages/cli/src/runtime/runtime-configuration-snapshot.ts",
      (text) => text.replace("structuredClone(configuration)", "configuration"),
    )).join("\n"),
    /uniquely cloned, branded and deeply frozen/,
  );
  assert.match(
    inspectRuntimeConfigurationProjectionBoundary(mutate(
      "packages/cli/src/startup.ts",
      (text) => text.replace(
        "runtimeConfiguration: RuntimeConfigurationSnapshot;",
        "config: ZhixingConfig;",
      ),
    )).join("\n"),
    /StartupCheckResult\.ready/,
  );
  assert.match(
    inspectRuntimeConfigurationProjectionBoundary(mutate(
      "packages/cli/src/runtime/runtime-configuration-projections.ts",
      (text) => text.replace(
        "const MCP_KEYS = [\"mcp\", \"network\"] as const;",
        "const MCP_KEYS = [\"mcp\", \"network\", \"agent\"] as const;",
      ),
    )).join("\n"),
    /MCP_KEYS: runtime configuration purpose exact-set drifted/,
  );
  assert.match(
    inspectRuntimeConfigurationProjectionBoundary(mutate(
      "packages/cli/src/runtime/runtime-configuration-projections.ts",
      (text) => text.replace(
        "structuredClone(configuration[key])",
        "configuration[key]",
      ),
    )).join("\n"),
    /purposes are not uniquely cloned/,
  );
  assert.match(
    inspectRuntimeConfigurationProjectionBoundary(mutate(
      "packages/cli/src/serve/application-host.ts",
      (text) => `${text}\nconst reloaded = loadConfig();`,
    )).join("\n"),
    /ApplicationHost does not perform/,
  );
  assert.match(
    inspectRuntimeConfigurationProjectionBoundary(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => `${text}\nconst leaked = bootstrap.config;`,
    )).join("\n"),
    /Anchor role can still consume/,
  );
  assert.match(
    inspectRuntimeConfigurationProjectionBoundary(mutate(
      "packages/cli/src/serve/role-topology.ts",
      (text) => text.replace(
        "readonly modelConfiguration: RuntimeModelConfigurationProjection;",
        "readonly config: ZhixingConfig;",
      ),
    )).join("\n"),
    /role bootstrap exposes an aggregate configuration path/,
  );
  assert.match(
    inspectRuntimeConfigurationProjectionBoundary(mutate(
      "packages/cli/src/serve/access-surface.ts",
      (text) => text.replace(
        "readonly modelConfiguration: RuntimeModelConfigurationProjection;",
        "readonly config: ZhixingConfig;",
      ),
    )).join("\n"),
    /Anchor assembly can still consume/,
  );
  assert.match(
    inspectRuntimeConfigurationProjectionBoundary(mutate(
      "packages/cli/src/serve/trust-administration-adapter.ts",
      (text) => text.replace(
        "readonly configuration: RuntimeWorkspaceConfigurationProjection;",
        "readonly configuration: RuntimeModelConfigurationProjection;",
      ),
    )).join("\n"),
    /Trust edge misses its finite runtime configuration projection/,
  );
  assert.match(
    inspectRuntimeConfigurationProjectionBoundary(mutate(
      "packages/cli/src/runtime/repl-local-view.ts",
      (text) => `${text}\nconst leaked = loadConfig();`,
    )).join("\n"),
    /REPL Surface regained|ordinary runtime Surface owns/,
  );
  assert.match(
    inspectRuntimeConfigurationProjectionBoundary(mutate(
      "packages/cli/src/runtime/surface-core-host-link.ts",
      (text) => `${text}\nconst leaked = loadConfig();`,
    )).join("\n"),
    /current-anchor Surface link bypasses|ordinary runtime Surface owns/,
  );
  assert.match(
    inspectRuntimeConfigurationProjectionBoundary(mutate(
      "packages/cli/src/runtime/runtime-configuration-provider.ts",
      (text) => text.replace(
        "return project(options).topology;",
        "return loadConfiguration(options);",
      ),
    )).join("\n"),
    /Configuration Provider does not publish only finite frozen Surface projections/,
  );
});

test("Anchor tool and MCP projection is outside the one generic RuntimeHost issuance", async () => {
  const paths = [
    "packages/runtime-host/src/runtime-host.ts",
    "packages/runtime-host/src/index.ts",
    "packages/runtime-host/src/conversation-runtime-projection.ts",
    "packages/orchestrator/src/runtime/kernel-runtime-identity.ts",
    "packages/orchestrator/src/runtime/create-agent-runtime.ts",
    "packages/cli/src/serve/builtin-extra-tools.ts",
    "packages/cli/src/serve/segment-deps.ts",
    "packages/cli/src/serve/workmode-tools.ts",
    "packages/cli/src/serve/workscene-port.ts",
    "packages/runtime-host/tsup.config.ts",
    "packages/cli/src/serve/execution-scheduler-facade.ts",
    "packages/cli/src/serve/workscene-runtime-projection.ts",
    "packages/cli/src/serve/command.ts",
    "packages/cli/src/serve/executor-role-runtime.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: await readFile(relative, "utf8"),
  })));
  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );

  assert.deepEqual(inspectWorksceneRuntimeProjectionBoundary(records), []);
  assert.match(
    inspectWorksceneRuntimeProjectionBoundary(mutate(
      "packages/runtime-host/src/runtime-host.ts",
      (text) => `${text}\nconst worksceneDirectory = {};`,
    )).join("\n"),
    /RuntimeHost still owns/,
  );
  assert.match(
    inspectWorksceneRuntimeProjectionBoundary(mutate(
      "packages/runtime-host/src/runtime-host.ts",
      (text) => text.replace("assertConversationRuntimeProjection(projection);", ""),
    )).join("\n"),
    /can bypass Workscene product projection/,
  );
  assert.match(
    inspectWorksceneRuntimeProjectionBoundary(mutate(
      "packages/runtime-host/src/index.ts",
      (text) => `${text}\nexport * from "./conversation-runtime-projection.js";`,
    )).join("\n"),
    /leaked through the RuntimeHost package root/,
  );
  assert.match(
    inspectWorksceneRuntimeProjectionBoundary(mutate(
      "packages/runtime-host/src/conversation-runtime-projection.ts",
      (text) => `${text}\nconst sceneId = "host-owned";`,
    )).join("\n"),
    /generic conversation projection/,
  );
  assert.match(
    inspectWorksceneRuntimeProjectionBoundary(mutate(
      "packages/orchestrator/src/runtime/kernel-runtime-identity.ts",
      (text) => text.replace("keys.length !== 1 ||", "false ||"),
    )).join("\n"),
    /Kernel runtime identity contribution/,
  );
  assert.match(
    inspectWorksceneRuntimeProjectionBoundary(mutate(
      "packages/cli/src/serve/builtin-extra-tools.ts",
      (text) => text.replace(
        "scheduler: () => SchedulerFacade;",
        "scheduler: () => SchedulerFacade;\n  spec?: { kind: \"workscene\" };",
      ),
    )).join("\n"),
    /still selects Workscene product tools/,
  );
  assert.match(
    inspectWorksceneRuntimeProjectionBoundary(mutate(
      "packages/runtime-host/src/runtime-host.ts",
      (text) => `${text}\nconst mcpHub = { catalog() { return []; } };`,
    )).join("\n"),
    /still owns Anchor Schedule, Task or MCP assembly/,
  );
  assert.match(
    inspectWorksceneRuntimeProjectionBoundary(mutate(
      "packages/runtime-host/src/index.ts",
      (text) => `${text}\nexport * from "./builtin-extra-tools.js";`,
    )).join("\n"),
    /retained a product implementation, export, build entry or consumer path/,
  );
  assert.match(
    inspectWorksceneRuntimeProjectionBoundary(mutate(
      "packages/runtime-host/tsup.config.ts",
      (text) => text.replace(
        '    "src/runtime-host.ts",',
        '    "src/runtime-host.ts",\n    "src/segment-deps.ts",',
      ),
    )).join("\n"),
    /retained a product implementation, export, build entry or consumer path/,
  );
  assert.match(
    inspectWorksceneRuntimeProjectionBoundary([
      ...records,
      {
        relative: "packages/runtime-host/src/workscene-port.ts",
        text: "export interface WorksceneToolDirectory {}",
      },
    ]).join("\n"),
    /retained a product implementation, export, build entry or consumer path/,
  );
  assert.match(
    inspectWorksceneRuntimeProjectionBoundary(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => `${text}\nimport "@zhixing/runtime-host/workmode-tools";`,
    )).join("\n"),
    /retained a product implementation, export, build entry or consumer path/,
  );
  assert.match(
    inspectWorksceneRuntimeProjectionBoundary(mutate(
      "packages/runtime-host/src/conversation-runtime-projection.ts",
      (text) => text.replace("assertRuntimeToolProjection(input.runtimeTools);", ""),
    )).join("\n"),
    /finite, immutable and fail closed/,
  );
  assert.match(
    inspectWorksceneRuntimeProjectionBoundary(mutate(
      "packages/cli/src/serve/workscene-runtime-projection.ts",
      (text) => text.replace(
        "    createWorksceneListTool(application, workscenes),",
        "",
      ),
    )).join("\n"),
    /capability exact-set drifted/,
  );
  assert.match(
    inspectWorksceneRuntimeProjectionBoundary(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "capabilities: anchorRuntimeProjections.capabilityCatalog()",
        "capabilities: runtimeHost.capabilityCatalog()",
      ),
    )).join("\n"),
    /production graph/,
  );
  assert.match(
    inspectWorksceneRuntimeProjectionBoundary(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => `${text}\nvoid runtimeHost.createWorksceneRuntime({} as never);`,
    )).join("\n"),
    /production graph|retired Workscene RuntimeHost entry/,
  );
  assert.match(
    inspectWorksceneRuntimeProjectionBoundary(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace("anchorRuntimeProjections.ephemeral()", "{} as never"),
    )).join("\n"),
    /production graph/,
  );
  assert.match(
    inspectWorksceneRuntimeProjectionBoundary(mutate(
      "packages/cli/src/serve/executor-role-runtime.ts",
      (text) => `${text}\nvoid createAnchorRuntimeProjectionAssembly;`,
    )).join("\n"),
    /ExecutorRuntimeSubstrate/,
  );
});

test("MCP runtime consumers use finite demand-owned ports behind one Host adapter", async () => {
  const paths = [
    "packages/cli/src/runtime/mcp-runtime-ports.ts",
    "packages/cli/src/runtime/mcp-runtime-adapter.ts",
    "packages/cli/src/serve/command.ts",
    "packages/cli/src/serve/access-surface.ts",
    "packages/cli/src/serve/access-surfaces.ts",
    "packages/cli/src/serve/builtin-extra-tools.ts",
    "packages/cli/src/serve/workscene-runtime-projection.ts",
    "packages/cli/src/serve/executor-role-runtime.ts",
    "packages/cli/src/runtime/workspace-command.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: await readFile(relative, "utf8"),
  })));
  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );

  assert.deepEqual(inspectMcpRuntimeBoundary(records), []);
  assert.match(
    inspectMcpRuntimeBoundary(mutate(
      "packages/cli/src/serve/executor-role-runtime.ts",
      (text) => `${text}\nconst leaked = createMcpHub([]);`,
    )).join("\n"),
    /concrete Hub\/catalog\/mapping leaked/,
  );
  assert.match(
    inspectMcpRuntimeBoundary(mutate(
      "packages/cli/src/serve/workscene-runtime-projection.ts",
      (text) => text.replace("const mcp = input.mcpTools.snapshot();", "const mcp = { tools: [], serverIds: [] };"),
    )).join("\n"),
    /bypasses the finite MCP runtime ports/,
  );
  assert.match(
    inspectMcpRuntimeBoundary(mutate(
      "packages/cli/src/runtime/mcp-runtime-ports.ts",
      (text) => `${text}\nexport interface LeakedHub { hub: McpHub; }`,
    )).join("\n"),
    /not finite or leak the concrete implementation/,
  );
  assert.match(
    inspectMcpRuntimeBoundary(mutate(
      "packages/cli/src/serve/builtin-extra-tools.ts",
      (text) => `${text}\nconst mcpHub = { catalog() { return []; } };`,
    )).join("\n"),
    /regained catalog\/configuration ownership/,
  );
});

test("MCP management consumes finite status, probe and discovery contracts behind one Host adapter", async () => {
  const paths = [
    "packages/cli/src/config-editor/mcp-management-contract.ts",
    "packages/cli/src/runtime/mcp-management-adapter.ts",
    "packages/cli/src/runtime/mcp-config.ts",
    "packages/cli/src/runtime/mcp-runtime-adapter.ts",
    "packages/cli/src/config-editor/mcp-setup.ts",
    "packages/cli/src/config-editor/mcp-discovery.ts",
    "packages/cli/src/config-editor/types.ts",
    "packages/cli/src/config-editor/panels/mcp.ts",
    "packages/cli/src/config-editor/sections/mcp.ts",
    "packages/cli/src/runtime/config-command.ts",
    "packages/cli/src/commands/config-commands.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: await readFile(relative, "utf8"),
  })));
  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );

  assert.deepEqual(inspectMcpManagementBoundary(records), []);
  assert.match(
    inspectMcpManagementBoundary(mutate(
      "packages/cli/src/config-editor/mcp-management-contract.ts",
      (text) => `${text}\nexport interface Leak { spec: McpServerSpec }`,
    )).join("\n"),
    /not finite or leaks infrastructure types/,
  );
  assert.match(
    inspectMcpManagementBoundary(mutate(
      "packages/cli/src/config-editor/panels/mcp.ts",
      (text) => `${text}\nconst leaked = probeServer;`,
    )).join("\n"),
    /regained concrete MCP ownership/,
  );
  assert.match(
    inspectMcpManagementBoundary(mutate(
      "packages/cli/src/config-editor/mcp-setup.ts",
      (text) => text.replace("probe.probe({", "probeServer(toServerSpec("),
    )).join("\n"),
    /regained concrete MCP ownership|bypasses its finite adapter/,
  );
  assert.match(
    inspectMcpManagementBoundary(mutate(
      "packages/cli/src/runtime/mcp-management-adapter.ts",
      (text) => text.replace("{ ...draft.credentials }", "{}"),
    )).join("\n"),
    /does not own status decoding, spec conversion, probe and discovery/,
  );
  assert.match(
    inspectMcpManagementBoundary(mutate(
      "packages/cli/src/runtime/config-command.ts",
      (text) => `${text}\nvoid hub.applyConfig([]);`,
    )).join("\n"),
    /hot-applies config/,
  );
  assert.match(
    inspectMcpManagementBoundary(mutate(
      "packages/cli/src/config-editor/sections/mcp.ts",
      (text) => `import type { McpServerStatus } from "@zhixing/mcp";\n${text}`,
    )).join("\n"),
    /regained concrete MCP ownership|Concrete MCP imports escaped/,
  );
});

test("Workspace Administration CRUD, reset, durable lifecycle and result delivery have one domain application boundary", async () => {
  const paths = [
    "packages/core/src/environment/workspace-administration.ts",
    "packages/core/src/environment/index.ts",
    "packages/core/src/index.ts",
    "packages/core/package.json",
    "packages/core/tsup.config.ts",
    "packages/cli/src/runtime/local-workspace-management-host.ts",
    "packages/cli/src/runtime/local-workspace-operation-outbox.ts",
    "packages/cli/src/runtime/local-workspace-durable-lifecycle-adapter.ts",
    "packages/cli/src/runtime/local-workspace-bootstrap.ts",
    "packages/cli/src/runtime/local-workspace-control.ts",
    "packages/cli/src/runtime/workspace-command.ts",
    "packages/cli/src/serve/access-surfaces.ts",
    "packages/cli/src/serve/executor-role-runtime.ts",
    "packages/cli/src/repl.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: await readFile(relative, "utf8"),
  })));
  assert.deepEqual(inspectWorkspaceAdministrationOwnership(records), []);
  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative
      ? { ...record, text: transform(record.text) }
      : record
  );

  assert.match(
    inspectWorkspaceAdministrationOwnership(mutate(
      "packages/cli/src/runtime/local-workspace-management-host.ts",
      (text) => `${text}\nclass LocalWorkspaceFacade {}`,
    )).join("\n"),
    /second durable\/result-delivery lifecycle owner/,
  );
  assert.match(
    inspectWorkspaceAdministrationOwnership(mutate(
      "packages/core/src/environment/workspace-administration.ts",
      (text) => text.replace(
        "class WorkspaceAdministrationBusinessError",
        "class WorkspaceAdministrationPolicyError",
      ),
    )).join("\n"),
    /uniquely own CRUD/,
  );
  assert.match(
    inspectWorkspaceAdministrationOwnership(mutate(
      "packages/core/src/environment/index.ts",
      (text) => `${text}\nexport * from \"./workspace-administration.js\";`,
    )).join("\n"),
    /one narrow non-root core subpath/,
  );
  assert.match(
    inspectWorkspaceAdministrationOwnership(mutate(
      "packages/cli/src/runtime/workspace-command.ts",
      (text) => `${text}\nconst selected = views.filter(({ name }) => name === sceneName);`,
    )).join("\n"),
    /still interprets Workspace Administration facts/,
  );
  assert.match(
    inspectWorkspaceAdministrationOwnership([
      ...records,
      {
        relative: "packages/cli/src/runtime/local-workspace-recovery.ts",
        text: "export class LocalWorkspaceRecovery {}",
      },
    ]).join("\n"),
    /second durable\/result-delivery lifecycle owner/,
  );
  assert.match(
    inspectWorkspaceAdministrationOwnership(mutate(
      "packages/core/src/environment/workspace-administration.ts",
      (text) => text.replace("this.#recovery.beginReset(", "this.#recovery.prepareReset("),
    )).join("\n"),
    /uniquely own CRUD, reset, durable lifecycle and result delivery/,
  );
  assert.match(
    inspectWorkspaceAdministrationOwnership(mutate(
      "packages/cli/src/runtime/local-workspace-management-host.ts",
      (text) => `${text}\nconst requestNonce = "host-owned-reset";`,
    )).join("\n"),
    /second durable\/result-delivery lifecycle owner/,
  );
  assert.match(
    inspectWorkspaceAdministrationOwnership(mutate(
      "packages/cli/src/runtime/workspace-command.ts",
      (text) => `${text}\nconst WORKSPACE_CATALOG_RESET_IMPACT = "CLI-owned";`,
    )).join("\n"),
    /still interprets Workspace Administration facts or reset impact/,
  );
  assert.match(
    inspectWorkspaceAdministrationOwnership(mutate(
      "packages/cli/src/serve/executor-role-runtime.ts",
      (text) => text.replace(
        "createExecutorLocalWorkspaceHost({",
        "createOtherWorkspaceHost({",
      ),
    )).join("\n"),
    /three production roots/,
  );
  assert.match(
    inspectWorkspaceAdministrationOwnership(mutate(
      "packages/cli/src/runtime/local-workspace-management-host.ts",
      (text) => text.replace(
        "return this.#lifecycle.pending(request.afterSeq);",
        "return this.#delivery.pending(request.afterSeq, 64);",
      ),
    )).join("\n"),
    /second durable\/result-delivery lifecycle owner/,
  );
  assert.match(
    inspectWorkspaceAdministrationOwnership(mutate(
      "packages/core/src/environment/workspace-administration.ts",
      (text) => text.replace(
        'readonly kind: "current"',
        'readonly kind: "lost-current-claim"',
      ),
    )).join("\n"),
    /does not uniquely own CRUD/,
  );
  assert.match(
    inspectWorkspaceAdministrationOwnership(mutate(
      "packages/core/src/environment/workspace-administration.ts",
      (text) => text.replace(
        "toView(await this.#bindingByName(displayName, control))",
        "toView((await this.#admin.list(control))[0])",
      ),
    )).join("\n"),
    /uniquely own CRUD/,
  );
  assert.match(
    inspectWorkspaceAdministrationOwnership(mutate(
      "packages/cli/src/runtime/workspace-command.ts",
      (text) => text.replace(
        "created.workspace.workspaceBindingRevision",
        "created.scene.workspace?.workspaceBindingRevision",
      ),
    )).join("\n"),
    /still interprets Workspace Administration facts/,
  );
  assert.match(
    inspectWorkspaceAdministrationOwnership(mutate(
      "packages/cli/src/runtime/workspace-command.ts",
      (text) => text.replace(
        "workspace: await workspace.viewByName(sceneName)",
        "workspace: (await workspace.list())[0]",
      ),
    )).join("\n"),
    /still interprets Workspace Administration facts/,
  );
  assert.match(
    inspectWorkspaceAdministrationOwnership(mutate(
      "packages/cli/src/runtime/workspace-command.ts",
      (text) => text.replace(
        "deviceId: authorization.deviceId,",
        "...authorization,",
      ),
    )).join("\n"),
    /still interprets Workspace Administration facts/,
  );
  assert.match(
    inspectWorkspaceAdministrationOwnership(mutate(
      "packages/cli/src/runtime/local-workspace-operation-outbox.ts",
      (text) => `${text}\ntype LocalWorkspaceWriteOperation = { kind: string };`,
    )).join("\n"),
    /outbox redefines the domain contract/,
  );
  assert.match(
    inspectWorkspaceAdministrationOwnership(mutate(
      "packages/cli/src/runtime/local-workspace-management-host.ts",
      (text) => text.replace(
        "this.#lifecycle.prepare(request.input)",
        "this.#applications.create(request.input)",
      ),
    )).join("\n"),
    /second durable\/result-delivery lifecycle owner/,
  );
  assert.match(
    inspectWorkspaceAdministrationOwnership(mutate(
      "packages/core/src/environment/workspace-administration.ts",
      (text) => text.replace(
        "class WorkspaceAdministrationDurableLifecycleApplicationService",
        "class WorkspaceAdministrationDurableMechanismService",
      ),
    )).join("\n"),
    /uniquely own CRUD/,
  );
  assert.match(
    inspectWorkspaceAdministrationOwnership(mutate(
      "packages/cli/src/runtime/local-workspace-management-host.ts",
      (text) => `${text}\nfunction #drainLoop() {}`,
    )).join("\n"),
    /second durable\/result-delivery lifecycle owner/,
  );
  assert.match(
    inspectWorkspaceAdministrationOwnership(mutate(
      "packages/cli/src/runtime/local-workspace-durable-lifecycle-adapter.ts",
      (text) => `${text}\nsetTimeout(() => undefined, 50);`,
    )).join("\n"),
    /finite infrastructure-failure projection/,
  );
  assert.match(
    inspectWorkspaceAdministrationOwnership(mutate(
      "packages/cli/src/runtime/local-workspace-operation-outbox.ts",
      (text) => text.replace(
        'recoveryOwner: "WorkspaceAdministrationDurableLifecycleApplicationService"',
        'recoveryOwner: "LocalWorkspaceManagementHost"',
      ),
    )).join("\n"),
    /owns lifecycle admission and settlement decisions/,
  );
  assert.match(
    inspectWorkspaceAdministrationOwnership(mutate(
      "packages/cli/src/runtime/workspace-command.ts",
      (text) => text.replace(
        "workspaceAdministrationOperationTarget(operation.input)",
        "operation.input.kind",
      ),
    )).join("\n"),
    /still interprets Workspace Administration facts/,
  );
  assert.match(
    inspectWorkspaceAdministrationOwnership(mutate(
      "packages/cli/src/runtime/local-workspace-control.ts",
      (text) => `import type { ExecutorResourceGovernor } from "@zhixing/executor";\n${text}`,
    )).join("\n"),
    /resource admission escaped its required finite Host projection/,
  );
  assert.match(
    inspectWorkspaceAdministrationOwnership(mutate(
      "packages/cli/src/runtime/local-workspace-management-host.ts",
      (text) => text.replace(
        "readonly resources: Pick<",
        "readonly resources?: Pick<",
      ),
    )).join("\n"),
    /resource admission escaped its required finite Host projection/,
  );
  assert.match(
    inspectWorkspaceAdministrationOwnership(mutate(
      "packages/cli/src/serve/access-surfaces.ts",
      (text) => text.replace(
        "resources: authorityRuntime.executorResourceGovernor,",
        "resources: authorityRuntime.resourceGovernor,",
      ),
    )).join("\n"),
    /Workspace resource port must be projected once/,
  );
  assert.match(
    inspectWorkspaceAdministrationOwnership(mutate(
      "packages/cli/src/runtime/workspace-command.ts",
      (text) => `${text}\nnew ExecutorWorkspaceAdministrationControl({});`,
    )).join("\n"),
    /resource admission escaped its required finite Host projection/,
  );
});

test("Trust Administration management has one domain application and Product API boundary", async () => {
  const paths = [
    "packages/core/src/trust-administration/application.ts",
    "packages/core/src/trust-administration/execution.ts",
    "packages/core/src/security/trust-administration-adapter.ts",
    "packages/core/src/security/security-pipeline.ts",
    "packages/core/src/product-api/catalog.ts",
    "packages/core/src/index.ts",
    "packages/core/package.json",
    "packages/core/tsup.config.ts",
    "packages/server/src/rpc/methods/trust.ts",
    "packages/server/src/context.ts",
    "packages/server/src/index.ts",
    "packages/cli/src/serve/trust-administration-adapter.ts",
    "packages/cli/src/serve/permission-storage-infrastructure.ts",
    "packages/cli/src/serve/command.ts",
    "packages/cli/src/serve/executor-role-runtime.ts",
    "packages/cli/src/runtime/workspace-command.ts",
    "packages/runtime-host/src/runtime-host.ts",
    "packages/cli/src/runtime/rpc-management-facade.ts",
    "packages/cli/src/security/commands.ts",
    "packages/cli/src/security/trust-rule-arg-provider.ts",
    "packages/orchestrator/src/security/secure-executor.ts",
    "packages/orchestrator/src/runtime/create-agent-runtime.ts",
    "packages/orchestrator/src/runtime/kernel-permission-storage.ts",
    "packages/orchestrator/src/tools/task.ts",
    "packages/orchestrator/src/subagent/factory.ts",
    "packages/orchestrator/src/subagent/loop-runner.ts",
    "packages/orchestrator/src/orchestration/agent-node-executor.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: await readFile(relative, "utf8"),
  })));
  assert.deepEqual(inspectTrustAdministrationOwnership(records), []);

  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );
  assert.match(
    inspectTrustAdministrationOwnership(mutate(
      "packages/core/src/trust-administration/application.ts",
      (text) => `${text}\nimport type { PermissionRule } from "../security/index.js";`,
    )).join("\n"),
    /does not uniquely own context, visibility, revoke, and committed fact semantics/,
  );
  assert.match(
    inspectTrustAdministrationOwnership(mutate(
      "packages/server/src/rpc/methods/trust.ts",
      (text) => text.replace(
        ".query(\n        TRUST_ADMINISTRATION_LIST_QUERY",
        ".trust.list(\n        TRUST_ADMINISTRATION_LIST_QUERY",
      ),
    )).join("\n"),
    /bypasses the Product API dispatcher/,
  );
  assert.match(
    inspectTrustAdministrationOwnership(mutate(
      "packages/server/src/context.ts",
      (text) => text.replace(
        "productApi?: ProductApiDispatcher;",
        "trust?: TrustDirectory;\n  productApi?: ProductApiDispatcher;",
      ),
    )).join("\n"),
    /retains the retired TrustDirectory application path/,
  );
  assert.match(
    inspectTrustAdministrationOwnership(mutate(
      "packages/cli/src/serve/trust-administration-adapter.ts",
      (text) => `${text}\nconst leakedDecision = rules.filter((rule) => rule.scope !== "builtin");`,
    )).join("\n"),
    /bridge owns product context or visibility semantics/,
  );
  assert.match(
    inspectTrustAdministrationOwnership(mutate(
      "packages/cli/src/serve/trust-administration-adapter.ts",
      (text) => `${text}\nconst leakedStore = new PermissionStore();`,
    )).join("\n"),
    /bridge owns product context|not confined to the one Host infrastructure adapter/,
  );
  assert.match(
    inspectTrustAdministrationOwnership(mutate(
      "packages/orchestrator/src/runtime/create-agent-runtime.ts",
      (text) => `${text}\nconst fallbackStore = new PermissionStore();`,
    )).join("\n"),
    /internal security chain|not confined to the one Host infrastructure adapter/,
  );
  assert.match(
    inspectTrustAdministrationOwnership(mutate(
      "packages/runtime-host/src/runtime-host.ts",
      (text) => text.replace(
        "      permissionStorage: this.opts.permissionStorage,",
        "",
      ),
    )).join("\n"),
    /bypasses the one Host permission storage adapter/,
  );
  assert.match(
    inspectTrustAdministrationOwnership(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "createTrustAdministrationProductApiContribution(trustAdministration),",
        "",
      ),
    )).join("\n"),
    /does not compose Trust Administration/,
  );
  assert.match(
    inspectTrustAdministrationOwnership([
      ...records,
      {
        relative: "packages/server/src/runtime/management-directories.ts",
        text: "export interface TrustDirectory {}",
      },
    ]).join("\n"),
    /retains the retired TrustDirectory application path/,
  );
  assert.match(
    inspectTrustAdministrationOwnership(mutate(
      "packages/core/src/trust-administration/execution.ts",
      (text) => `${text}\nimport { PermissionStore } from "../security/permission-store.js";`,
    )).join("\n"),
    /does not uniquely own explicit rules, contributions, sedimentation, and execution projections/,
  );
  assert.match(
    inspectTrustAdministrationOwnership(mutate(
      "packages/orchestrator/src/security/secure-executor.ts",
      (text) => `${text}\nPermissionStore.createRule({});`,
    )).join("\n"),
    /retains Trust rule creation or sedimentation ownership/,
  );
  assert.match(
    inspectTrustAdministrationOwnership(mutate(
      "packages/core/src/security/security-pipeline.ts",
      (text) => `${text}\ngetPermissionStore() { return undefined; }`,
    )).join("\n"),
    /retains mutable Trust Administration state or writer access/,
  );
  assert.match(
    inspectTrustAdministrationOwnership(mutate(
      "packages/orchestrator/src/subagent/loop-runner.ts",
      (text) => text.replace(
        "trustAdministration: opts.trustAdministration,",
        "",
      ),
    )).join("\n"),
    /child execution can bypass the one Trust application/,
  );
  assert.match(
    inspectTrustAdministrationOwnership([
      ...records,
      {
        relative: "packages/core/src/security/confirmation-tracker.ts",
        text: "export class ConfirmationTracker {}",
      },
    ]).join("\n"),
    /retired Trust tracker, helper, or temporary store bridge remains reachable/,
  );
});

test("Advancement whole-domain exact-set has one application/mechanism owner per family", async () => {
  const paths = [
    "packages/core/src/advancement/application.ts",
    "packages/core/src/advancement/store.ts",
    "packages/core/src/conversation/application.ts",
    "packages/core/src/advancement/index.ts",
    "packages/core/src/index.ts",
    "packages/core/package.json",
    "packages/core/tsup.config.ts",
    "packages/owner-services/src/advancement/controller.ts",
    "packages/owner-services/src/advancement/evidence.ts",
    "packages/owner-services/src/advancement/session-store.ts",
    "packages/owner-services/src/advancement/review-external-mechanism.ts",
    "packages/owner-services/src/advancement/proxy-scheduler.ts",
    "packages/owner-services/src/advancement/review-attempt-correctness.ts",
    "packages/owner-services/src/advancement/recovery-maintenance.ts",
    "packages/owner-services/src/advancement/index.ts",
    "packages/owner-services/package.json",
    "packages/owner-services/tsup.config.ts",
    "packages/server/src/rpc/methods/session.ts",
    "packages/server/src/context.ts",
    "packages/server/src/system-handlers.ts",
    "packages/cli/src/serve/command.ts",
    "packages/cli/src/serve/access-surfaces.ts",
    "packages/cli/src/serve/local-conversation-owner.ts",
    "packages/cli/src/serve/conversation-protocol-runtime.ts",
    "packages/cli/src/serve/conversation-delete-binding.ts",
    "packages/cli/src/serve/advancement-original-task-application.ts",
    "packages/cli/src/serve/advancement-controller.ts",
    "packages/server/src/advancement/adapters.ts",
    "packages/owner-kernel/src/conversation-manager.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: await readFile(relative, "utf8"),
  })));
  assert.deepEqual(inspectAdvancementDetailApplicationOwnership(records), []);
  assert.deepEqual(
    ADVANCEMENT_APPLICATION_OWNER_EXACT_SET.map(({ family }) => family),
    [
      "active-state",
      "detail",
      "rubric-lifecycle/publication",
      "original-task-admission",
      "active-user-turn",
      "conversation-retirement",
      "accepted-turn",
      "review-attempt/outcome",
      "review-result-projection",
      "recovery",
      "proxy-scheduling",
      "evidence",
      "persistence-correctness",
    ],
  );

  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );
  const failure = /Advancement detail\/rubric lacks one Product API application or conversation lifecycle lacks one independent application owner/;
  const closureFailure = /Advancement whole-domain exact-set has a second active-state, proxy-settlement, ServerContext, legacy Store export, or Store-write owner/;

  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "rubricCancellation: {",
        "rubricCancellation: advancementDetailController,\n          retiredRubricCancellation: {",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "advancementDetailController.loadRubricCancellationSession(",
        "ctx.advancementReviews.loadRubricCancellationSession(",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "ctx.advancementReviews.cancelSession(input)",
        "advancementDetailController.persistRubricCancellation(input)",
      ),
    )).join("\n"),
    failure,
  );

  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace("activeState: ctx.advancementReviews,", ""),
    )).join("\n"),
    closureFailure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/owner-services/src/advancement/recovery-maintenance.ts",
      (text) => text.replace(
        "this.options.reviews.settleProxyRun({",
        "this.options.advancement.settleProxyMessage({",
      ),
    )).join("\n"),
    closureFailure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/server/src/context.ts",
      (text) => `${text}\ninterface Regression { readonly advancement?: AdvancementController }`,
    )).join("\n"),
    closureFailure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => `${text}\nvoid store.cancelSession(conversationId, sessionId);`,
    )).join("\n"),
    closureFailure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/core/src/advancement/index.ts",
      (text) => `${text}\nexport { AdvancementStore } from "./store.js";`,
    )).join("\n"),
    closureFailure,
  );

  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/server/src/rpc/methods/session.ts",
      (text) => text.replace(
        "productApi.query(ADVANCEMENT_DETAIL_QUERY",
        "ctx.server.advancement.loadLatestSession",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/core/src/advancement/application.ts",
      (text) => text.replace(
        "if (!catchUpProvedContinuous(catchUp.status)) return;",
        "void catchUp;",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/core/src/advancement/application.ts",
      (text) => text.replace(
        "this.#mechanism.prepareEvidence({",
        "mechanism.prepareEvidence({",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/owner-services/src/advancement/controller.ts",
      (text) => `${text}\nafterTurnCommitted() { return undefined; }`,
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/cli/src/serve/access-surfaces.ts",
      (text) => text.replace(
        "review: ctx.advancementReviews,",
        "review: createSecondReviewApplication(),",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/cli/src/serve/access-surfaces.ts",
      (text) => text.replace(
        "advancementAcceptedTurns?.acceptCommittedTurn(info)",
        "void ctx.advancement?.afterTurnCommitted(info)",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/cli/src/serve/local-conversation-owner.ts",
      (text) => text.replace(
        "protocol.bindManager(manager);",
        "void manager;",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/server/src/advancement/adapters.ts",
      (text) => text.replace(
        "readonly manager: ConversationManager;",
        "readonly manager: ConversationManager | (() => ConversationManager);",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/cli/src/serve/access-surfaces.ts",
      (text) => text.replace(
        "manager.bindTurnCommittedListener((info) =>",
        "void ((info) =>",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/owner-services/src/advancement/review-external-mechanism.ts",
      (text) => text.replace(
        "options.evidence.collect({",
        "transitionReviewAttempt({",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership([
      ...records,
      {
        relative: "packages/owner-services/src/advancement/review-application-bridge.ts",
        text: "export function createAdvancementAcceptedTurnReviewMechanism() {}",
      },
    ]).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/owner-services/src/advancement/recovery-maintenance.ts",
      (text) => text.replace(
        "this.options.reviewResults.projectReviewResult({",
        "dispatchAdvancementReviewResult({",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership([
      ...records,
      {
        relative: "packages/cli/src/serve/advancement-review-maintenance.ts",
        text: "export function createAdvancementReviewMaintenance() {}",
      },
    ]).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/server/src/rpc/methods/session.ts",
      (text) => text.replace(
        "productApi.command(\n          ADVANCEMENT_CONFIRM_RUBRIC_COMMAND",
        "ctx.server.advancement.confirmRubric(\n          ADVANCEMENT_CONFIRM_RUBRIC_COMMAND",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/cli/src/serve/advancement-original-task-application.ts",
      (text) => text.replace(
        "await conversations.admitAgentTurn({",
        "await retiredConversationBypass({",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/core/src/advancement/index.ts",
      (text) => `${text}\nexport * from "./application.js";`,
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "createAdvancementProductApiContribution(",
        "createRetiredAdvancementDetailBypass(",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/server/src/rpc/methods/session.ts",
      (text) => text.replace(
        "const admissionError = sessionAgentTurnAdmissionRpcError(",
        "const admissionError = sessionTurnIdentityRpcError(",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/core/src/advancement/application.ts",
      (text) => text.replace("defineProductApiQuery<", "defineProductApiCommand<"),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/server/src/rpc/methods/session.ts",
      (text) => text.replace(
        "productApi.command(\n            ADVANCEMENT_REVISE_RUBRIC_COMMAND",
        "ctx.server.advancement.reviseRubricDraft(\n            ADVANCEMENT_REVISE_RUBRIC_COMMAND",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/core/src/advancement/application.ts",
      (text) => text.replaceAll(
        "ADVANCEMENT_CONTRACT_CANCELLED_FACT_EVENT,",
        "",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/core/src/advancement/application.ts",
      (text) => text.replace(
        "const committedDraft = updated.pendingRubricDraft",
        "const committedDraft = revisedDraft",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/server/src/rpc/methods/session.ts",
      (text) => text.replace(
        "productApi.command(\n          ADVANCEMENT_CANCEL_RUBRIC_COMMAND",
        "ctx.server.advancement.cancelRubric(\n          ADVANCEMENT_CANCEL_RUBRIC_COMMAND",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/core/src/advancement/application.ts",
      (text) => text.replace(
        "await command.fact.publish(decision.fact);",
        "void command.fact.publish(decision.fact);",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/server/src/rpc/methods/session.ts",
      (text) => text.replace(
        "if (newTaskNotApplicable) {\n            const racedActiveResponse = projectActiveAdvancementPreparation(\n              await dispatchActiveAdvancementUserTurn(),",
        "if (newTaskNotApplicable) {\n            const racedActiveResponse = null;\n            void dispatchActiveAdvancementUserTurn();",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/core/src/advancement/application.ts",
      (text) => text.replace(
        "const interruption = await this.#activeUserTurnRuntime.interruptProxy({",
        "const interruption = void this.#activeUserTurnRuntime.interruptProxy({",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/owner-services/src/advancement/controller.ts",
      (text) => `${text}\nasync prepareUserTurn(input: unknown) { return input; }`,
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "activeUserTurn: advancementDetailController,",
        "",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/owner-services/src/advancement/controller.ts",
      (text) => `${text}\nasync cancelRubric(input: unknown) { return input; }`,
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "rubricRevision: advancementDetailController,",
        "",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/owner-services/src/advancement/controller.ts",
      (text) => `${text}\nasync reviseRubricDraft(input: unknown) { return input; }`,
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/owner-services/src/advancement/controller.ts",
      (text) => `${text}\nasync confirmRubric(input: unknown) { return input; }`,
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "rubricConfirmation: advancementDetailController,",
        "",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/cli/src/serve/advancement-original-task-application.ts",
      (text) => text.replace(
        "throw new AdvancementOriginalTaskAdmissionError(reason, error);",
        "throw error;",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/core/src/advancement/application.ts",
      (text) => text.replace(
        "decideAwaitingRubricAdmission({",
        "decideRetiredAwaitingRubricBypass({",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/server/src/rpc/methods/session.ts",
      (text) => text.replace(
        "return await productApi.command(\n                ADVANCEMENT_CONTROL_AWAITING_RUBRIC_COMMAND,",
        "return await productApi.command(\n                ADVANCEMENT_CANCEL_RUBRIC_COMMAND,",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/server/src/rpc/methods/session.ts",
      (text) => text.replace(
        "if (id) {\n          const productApi",
        "if (id) {\n          void hasAwaitingAdvancementConfirmation;\n          const productApi",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/owner-services/src/advancement/controller.ts",
      (text) => `${text}\ntype RetiredAwaiting = { readonly kind: "await-existing-confirmation" };`,
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "awaitingRubricAdmission: advancementDetailController,",
        "",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/server/src/rpc/methods/session.ts",
      (text) => text.replace(
        "return await productApi.command(\n                ADVANCEMENT_PREPARE_NEW_TASK_COMMAND,",
        "return await ctx.server.advancement.prepareUserTurn(\n                ADVANCEMENT_PREPARE_NEW_TASK_COMMAND,",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/owner-services/src/advancement/controller.ts",
      (text) => `${text}\ntype RetiredNewTask = { readonly kind: "run-direct" };`,
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace("newTask: advancementDetailController,", ""),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/core/src/advancement/application.ts",
      (text) => text.replace(
        "await this.#newTaskConversation.ensureShell(command.conversationId);",
        "void this.#newTaskConversation.ensureShell(command.conversationId);",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/owner-services/src/advancement/controller.ts",
      (text) => `${text}\nasync cancelOpenConversationSession() { return null; }`,
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/owner-services/src/advancement/session-store.ts",
      (text) => `${text}\nasync sweepOrphanDirs() { return { scanned: 0, removed: 0, warnings: [] }; }`,
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/core/src/conversation/application.ts",
      (text) => text.replace(
        "const outcome = await input.projection.deleteRuntimeAndStorage({",
        `await input.projection.cancelDependentLifecycle!(input.conversationId);
  const outcome = await input.projection.deleteRuntimeAndStorage({`,
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/core/src/advancement/application.ts",
      (text) => text.replace(
        "export class AdvancementApplicationService implements AdvancementApplication {",
        `export class AdvancementApplicationService implements AdvancementApplication {
  async cancelConversationLifecycle(): Promise<void> {}`,
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => `${text}\nlet advancementLifecycleApplication;`,
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "runSweep: () => advancementConversationLifecycle.sweepOrphanData()",
        "runSweep: () => advancementDetailController.sweepOrphanData()",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/cli/src/serve/access-surfaces.ts",
      (text) => text.replace(
        "ctx.advancementConversationLifecycle.cancelConversationLifecycle(",
        "advancementDetailController.cancelOpenConversationSession(conversationId)",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/core/src/advancement/application.ts",
      (text) => text.replace(
        "export class AdvancementReviewAttemptApplicationService",
        "class RetiredReviewAttemptApplicationService",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/owner-services/src/advancement/controller.ts",
      (text) => `${text}\nvoid resources.inspectImmediateRoot;`,
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/owner-services/src/advancement/review-attempt-correctness.ts",
      (text) => `${text}\nif (attempt.phase === "invoking") throw new Error();`,
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/owner-services/src/advancement/index.ts",
      (text) => `${text}\nexport { createAdvancementReviewAttemptApplication } from "./review-attempt-correctness.js";`,
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/cli/src/serve/advancement-controller.ts",
      (text) => text.replace(
        "createAdvancementReviewAttemptApplication({",
        "createRetiredReviewAttemptBypass({",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/core/src/advancement/application.ts",
      (text) => text.replace(
        "  resolveRootTarget(\n",
        "  prepareEligibility(): Promise<void>;\n  resolveRootTarget(\n",
      ),
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/owner-services/src/advancement/controller.ts",
      (text) => `${text}\nvoid controller.persistReviewOutcome;`,
    )).join("\n"),
    failure,
  );
  assert.match(
    inspectAdvancementDetailApplicationOwnership(mutate(
      "packages/owner-services/src/advancement/review-attempt-correctness.ts",
      (text) => text.replace(
        "options.store.appendTerminalRunReview(",
        "options.store.retiredTerminalWrite(",
      ),
    )).join("\n"),
    failure,
  );
});

test("Skill Catalog management, load, save, admission and Kernel projection have one domain application boundary", async () => {
  const paths = [
    "packages/core/src/skills/catalog-application.ts",
    "packages/core/src/workscene/application.ts",
    "packages/core/src/conversation/application.ts",
    "packages/core/src/conversation/index.ts",
    "packages/core/src/scheduler/application.ts",
    "packages/core/src/scheduler/runtime-policy.ts",
    "packages/core/src/scheduler/facade.ts",
    "packages/core/src/delivery/application.ts",
    "packages/core/src/delivery/authority.ts",
    "packages/core/src/delivery/authority-pipeline.ts",
    "packages/core/src/delivery/channel-effect.ts",
    "packages/core/src/delivery/lifecycle-policy.ts",
    "packages/core/src/delivery/outbox.ts",
    "packages/core/src/delivery/types.ts",
    "packages/core/src/delivery/index.ts",
    "packages/core/src/product-api/catalog.ts",
    "packages/core/src/skills/global-state-adapter.ts",
    "packages/core/src/index.ts",
    "packages/core/src/skills/index.ts",
    "packages/core/package.json",
    "packages/core/tsup.config.ts",
    "packages/rpc/src/index.ts",
    "packages/rpc/src/session-wire.ts",
    "packages/rpc/src/skill-catalog-client.ts",
    "packages/rpc/package.json",
    "packages/rpc/tsup.config.ts",
    "packages/server/src/rpc/methods/skill.ts",
    "packages/server/src/rpc/methods/workscene.ts",
    "packages/server/src/index.ts",
    "packages/server/src/rpc/methods/schedule.ts",
    "packages/server/src/rpc/methods/server.ts",
    "packages/server/src/rpc/methods/auth.ts",
    "packages/server/src/context.ts",
    "packages/server/src/server.ts",
    "packages/server/src/lifecycle.ts",
    "packages/rpc/src/event-bridge.ts",
    "packages/cli/src/serve/command.ts",
    "packages/cli/src/serve/conversation-clear-binding.ts",
    "packages/cli/src/serve/conversation-resume-binding.ts",
    "packages/cli/src/serve/conversation-run-control-binding.ts",
    "packages/cli/src/serve/conversation-task-list-application.ts",
    "packages/cli/src/serve/conversation-compact-application.ts",
    "packages/cli/src/serve/conversation-usage-application.ts",
    "packages/cli/src/serve/conversation-security-application.ts",
    "packages/cli/src/serve/conversation-delete-binding.ts",
    "packages/cli/src/serve/conversation-directory.ts",
    "packages/cli/src/serve/workscene-directory.ts",
    "packages/cli/src/serve/workmode-tools.ts",
    "packages/cli/src/serve/workscene-runtime-projection.ts",
    "packages/cli/src/serve/workscene-application-adapter.ts",
    "packages/cli/src/serve/workscene-port.ts",
    "packages/cli/src/serve/workscene-session-owner.ts",
    "packages/cli/src/serve/local-conversation-directory-application.ts",
    "packages/cli/src/serve/local-conversation-rpc.ts",
    "packages/cli/src/serve/local-conversation-owner.ts",
    "packages/server/src/rpc/methods/session.ts",
    "packages/cli/src/serve/anchor-scheduler-runtime.ts",
    "packages/cli/src/serve/execution-scheduler-facade.ts",
    "packages/cli/src/runtime/rpc-scheduler-facade.ts",
    "packages/cli/src/runtime/rpc-management-facade.ts",
    "packages/cli/src/repl.ts",
    "packages/cli/src/commands/info-commands.ts",
    "packages/cli/src/skills/manager-controller.ts",
    "packages/cli/src/skills/manager-command.ts",
    "packages/cli/src/commands/skill-command-source.ts",
    "packages/cli/src/setup-delivery.ts",
    "packages/cli/src/serve/access-surface.ts",
    "packages/cli/src/serve/access-surfaces.ts",
    "packages/cli/src/serve/executor-role-runtime.ts",
    "packages/owner-kernel/src/delivery-control.ts",
    "packages/owner-kernel/src/delivery-obligation-correctness.ts",
    "packages/owner-kernel/src/delivery-participant.ts",
    "packages/owner-kernel/src/delivery.ts",
    "packages/owner-kernel/src/index.ts",
    "packages/owner-kernel/src/conversation-agent-turn-admission.ts",
    "packages/owner-kernel/package.json",
    "packages/owner-kernel/tsup.config.ts",
    "packages/owner-kernel/src/conversation-assignment.ts",
    "packages/owner-kernel/src/job-assignment.ts",
    "packages/owner-kernel/src/scheduler-user-notices.ts",
    "packages/owner-kernel/src/scheduler-global-state.ts",
    "packages/owner-kernel/src/scheduler-authority.ts",
    "packages/cli/src/serve/trust-administration-adapter.ts",
    "packages/orchestrator/src/runtime/assignment-skill-port.ts",
    "packages/core/src/protocol/assignment-mutation.ts",
    "packages/cli/src/serve/assignment-schedule-stager.ts",
    "packages/orchestrator/src/runtime/create-agent-runtime.ts",
    "packages/core/src/protocol/execution-asset-snapshot.ts",
    "packages/cli/src/serve/execution-asset-cache.ts",
    "packages/tools-builtin/src/skill.ts",
    "packages/tools-builtin/src/schedule.ts",
    "packages/tools-builtin/src/factories.ts",
    "packages/tools-builtin/src/index.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: await readFile(relative, "utf8"),
  })));
  assert.deepEqual(inspectSkillCatalogApplicationOwnership(records), []);

  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/server/src/rpc/methods/workscene.ts",
      (text) => text.replace(
        "requireWorksceneApplication(ctx.server).query(",
        "requireWorkscenes(ctx.server).list(",
      ),
    )).join("\n"),
    /Workscene management and entry lack one domain application and Product API owner/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/workscene-runtime-projection.ts",
      (text) => text.replace(
        "input.projectConversationRuntime({ conversationId: sessionId })",
        "input.getScene(sessionId)",
      ),
    )).join("\n"),
    /Workscene management and entry lack one domain application and Product API owner/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "const modelConfiguration = bootstrap.modelConfiguration;",
        "const modelConfiguration = bootstrap.modelConfiguration;\n  void worksceneDirectory.get(\"runtime-bypass\");",
      ),
    )).join("\n"),
    /Workscene management and entry lack one domain application and Product API owner/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/server/src/context.ts",
      (text) => text.replace(
        "export interface ServerContext {",
        "export interface ServerContext {\n  workscenes?: unknown;",
      ),
    )).join("\n"),
    /Workscene management and entry lack one domain application and Product API owner/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/server/src/index.ts",
      (text) => `${text}\nexport * from "./runtime/workscene-directory.js";`,
    )).join("\n"),
    /Workscene management and entry lack one domain application and Product API owner/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/workscene-port.ts",
      (text) => text.replace(
        "export interface WorksceneToolDirectory {",
        "export interface WorksceneToolDirectory {\n  rename(): Promise<void>;",
      ),
    )).join("\n"),
    /Workscene management and entry lack one domain application and Product API owner/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/workmode-tools.ts",
      (text) => text.replace(
        "export function createWorksceneRenameCurrentTool(\n  scene: WorksceneCurrentToolContext,",
        'export function createWorksceneRenameCurrentTool(\n  _workscenes: Pick<WorksceneToolDirectory, "rename">,\n  scene: WorksceneCurrentToolContext,',
      ),
    )).join("\n"),
    /Workscene management and entry lack one domain application and Product API owner/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/workscene-directory.ts",
      (text) => text.replace(
        "export type AnchorWorksceneDirectory = WorksceneToolDirectory & {",
        "export type AnchorWorksceneDirectory = WorksceneDirectory & WorksceneToolDirectory & {",
      ),
    )).join("\n"),
    /Workscene management and entry lack one domain application and Product API owner/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/workscene/application.ts",
      (text) => text.replace(
        "export const WORKSCENE_ENTRY_EXIT_COMMAND = defineProductApiCommand<",
        "export const WORKSCENE_ENTRY_EXIT_COMMAND = defineProductApiQuery<",
      ),
    )).join("\n"),
    /Workscene management and entry lack one domain application and Product API owner/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/conversation/index.ts",
      (text) => `${text}\nexport * from "./application.js";`,
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/rpc/src/session-wire.ts",
      (text) => text.replace(
        "export type SessionSecurityResult = ConversationSecurityResult",
        "export type SessionSecurityResult = RuntimeSecuritySnapshot",
      ),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/conversation/application.ts",
      (text) =>
        `import type { AdvancementReviewDecision } from "../advancement/types.js";\n${text}`,
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/conversation/application.ts",
      (text) => text.replace(
        "readonly taskList: TaskListState;\n}\n\nexport interface ConversationTaskListUpdateOutcome",
        "readonly taskList: TaskListState;\n  readonly fact?: ConversationTaskListChangedFact;\n}\n\nexport interface ConversationTaskListUpdateOutcome",
      ),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/server/src/rpc/methods/session.ts",
      (text) => text.replace(
        "const fact = dispatch.facts[0];",
        "const fact = dispatch.result.fact;",
      ),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/local-conversation-rpc.ts",
      (text) => text.replace("return outcome.result;", "return outcome;"),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership([
      ...records,
      {
        relative: "packages/server/src/runtime/conversation-directory.ts",
        text: "export interface ConversationDirectory { list(): Promise<unknown[]>; }",
      },
    ]).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/local-conversation-rpc.ts",
      (text) => `${text}\nvoid input.owner.createConversation();`,
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/conversation/application.ts",
      (text) => text.replace('factEmission: "subset"', 'factEmission: "exact"'),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/server/src/context.ts",
      (text) => text.replace(
        "productApi?: ProductApiDispatcher;",
        "taskListUpdate?: () => Promise<unknown>;\n  productApi?: ProductApiDispatcher;",
      ),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/local-conversation-rpc.ts",
      (text) => text.replace(
        "this.#application.updateTaskList({",
        "this.input.owner.mutateSession({",
      ),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "taskLists: createAnchorConversationTaskListPort({",
        "taskLists: undefined,",
      ),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "security: createAnchorConversationSecurityProjectionPort({",
        "security: undefined,",
      ),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "usage: createAnchorConversationUsageProjectionPort({",
        "usage: undefined,",
      ),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/server/src/rpc/methods/session.ts",
      (text) => text.replace(
        "result = await productApi.query(\n          CONVERSATION_CONTEXT_BUDGET_QUERY,",
        "result = await manager.inspectContextBudgetExisting(\n          conversationId,",
      ),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/server/src/rpc/methods/session.ts",
      (text) => text.replace(
        "result = await productApi.query(CONVERSATION_SECURITY_QUERY, {",
        "result = await manager.inspectSecurityExisting(conversationId, {",
      ),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/local-conversation-rpc.ts",
      (text) => text.replace(
        "return await this.#application.queryUsage({",
        "throw RpcErrors.busy(\"usage unavailable\");\n          return await Promise.resolve({",
      ),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/local-conversation-rpc.ts",
      (text) => text.replace(
        "return await this.#application.querySecurity({",
        "throw RpcErrors.busy(\"security unavailable\");\n          return await Promise.resolve({",
      ),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "compact: createAnchorConversationCompactPort({",
        "compact: undefined,",
      ),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/server/src/rpc/methods/session.ts",
      (text) => text.replace(
        "const dispatch = await productApi.command(\n          CONVERSATION_COMPACT_COMMAND,",
        "const dispatch = await requireConversations(ctx.server).compactExisting(\n          conversationId,",
      ),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/local-conversation-rpc.ts",
      (text) => text.replace(
        "return await this.#application.compact({",
        "throw RpcErrors.busy(\"compact unavailable\");\n        return await Promise.resolve({",
      ),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership([
      ...records,
      {
        relative: "packages/cli/src/runtime/task-list-actions.ts",
        text: "export function applyTaskListAction() {}",
      },
    ]).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/server/src/rpc/methods/session.ts",
      (text) => text.replace(
        "productApi.command(\n      CONVERSATION_ADMIT_AGENT_TURN_COMMAND",
        "input.manager.admitTurn(\n      CONVERSATION_ADMIT_AGENT_TURN_COMMAND",
      ),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/server/src/rpc/methods/session.ts",
      (text) => text.replace(
        "const turnIdentity = await prepareSessionSendTurnIdentity(",
        "const turnIdentity = await Promise.resolve(",
      ),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/server/src/rpc/methods/session.ts",
      (text) => text.replace(
        "const manager = requireConversations(ctx.server);",
        "const manager = requireConversations(ctx.server);\n      if (manager.usesDurableTurnProtocol()) void 0;",
      ),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/server/src/rpc/methods/session.ts",
      (text) => {
        const target = "turnIdentity: input.turnIdentity,";
        const index = text.lastIndexOf(target);
        return index < 0
          ? text
          : `${text.slice(0, index)}turnIdentitySource: "provided",\n        turnId: input.turnIdentity.turnId,${text.slice(index + target.length)}`;
      },
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/local-conversation-rpc.ts",
      (text) => text.replace(
        "this.#application.admitAgentTurn({",
        "this.input.owner.admitTurn({",
      ),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/owner-kernel/src/conversation-agent-turn-admission.ts",
      (text) => text.replace(
        "input.manager.admitDurableTurn({",
        "input.manager.writeDurableTurn({",
      ),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/owner-kernel/src/index.ts",
      (text) => `${text}\nexport * from "./conversation-agent-turn-admission.js";`,
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/server/src/rpc/methods/session.ts",
      (text) => `${text}\nvoid requireConversations(ctx.server).cancelDurableRuns({});`,
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/local-conversation-rpc.ts",
      (text) => `${text}\nvoid this.input.owner.cancelConversationRuns({});`,
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/conversation/application.ts",
      (text) => text.replace(
        "async resolveUncertain(",
        "async resolvePending(",
      ),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/server/src/rpc/methods/session.ts",
      (text) => text.replace(
        "const dispatch = await productApi.command(CONVERSATION_RESUME_COMMAND, {",
        "await requireDirectory(ctx.server).touch(params.conversationId);\n        const dispatch = await productApi.command(CONVERSATION_RESUME_COMMAND, {",
      ),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/server/src/rpc/methods/session.ts",
      (text) => text.replace("observerAdded &&\n          !alreadyObserved", "true"),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/local-conversation-rpc.ts",
      (text) => text.replace(
        'case "session.resume": {',
        'case "session.resume": {\n        await this.input.owner.listConversations();',
      ),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/server/src/context.ts",
      (text) => text.replace(
        "productApi?: ProductApiDispatcher;",
        "conversationAdoptionReview?: () => Promise<unknown>;\n  productApi?: ProductApiDispatcher;",
      ),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/server/src/context.ts",
      (text) => `${text}\ninterface LeakedConversationContext { conversationDirectory?: unknown; }`,
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/server/src/rpc/methods/session.ts",
      (text) => text.replace(
        "const observerAdded = manager.addObserver(",
        "const observerAdded = manager.getObserverCount(",
      ),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/local-conversation-rpc.ts",
      (text) => text.replace(
        "await this.#application.delete({",
        "await this.#mutate(conversationId, operationId, { kind: \"conversation-delete\" });\n          await this.#application.delete({",
      ),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/server/src/rpc/methods/session.ts",
      (text) => `${text}\nvoid ctx.server.conversationDirectory.ensure(id);`,
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/server/src/rpc/methods/session.ts",
      (text) => `${text}\nvoid requireConversations(ctx.server).delete(id);`,
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/conversation-delete-binding.ts",
      (text) => text.replace(
        "!deletionAlreadyCommitted ||",
        "deletionAlreadyCommitted &&",
      ),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/workscene-directory.ts",
      (text) => `${text}\nvoid deps.conversationStorageProjectionCleanup.removeCommittedProjection({ sceneId: "scene", conversationId: "ws:scene:second" });`,
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/conversation-delete-binding.ts",
      (text) => `${text}\nexport interface ConversationWorksceneDeleteProjectionBridge { deleteConversationStorageProjection(id: string): Promise<boolean>; }`,
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/workscene-session-owner.ts",
      (text) => text.replace(
        "await authority.deleteWorksceneSession({",
        "await this.#conversationStorageProjectionCleanup.removeCommittedProjection({ sceneId, conversationId });\n      await authority.deleteWorksceneSession({",
      ),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/workscene-session-owner.ts",
      (text) => `${text}\nvoid this.#directory.deleteStoredConversation("direct-delete");`,
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/conversation-clear-binding.ts",
      (text) => text.replace(
        "clearStoredView: (id) => input.directory.clearStoredView(id),",
        "clearStoredView: async (id) => { await input.directory.ensure(id); return input.directory.clearStoredView(id); },",
      ),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/conversation/application.ts",
      (text) => text.replaceAll(
        "CONVERSATION_ENSURE_SHELL_COMMAND",
        "RETIRED_SHELL_COMMAND",
      ),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/access-surface.ts",
      (text) => text.replace(
        "readonly conversationIdentityLifecycle: ConversationIdentityLifecycleApplication;",
        "readonly conversationDirectory: AnchorConversationDirectoryMechanism;",
      ),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/access-surfaces.ts",
      (text) => text.replace(
        "ctx.conversationIdentityLifecycle.identityExists(conversationId)",
        "ctx.conversationDirectory.exists(conversationId)",
      ),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/conversation/application.ts",
      (text) => text.replace(
        'parseConversationId(conversationId).scope.kind === "workscene"',
        'parseConversationId(conversationId).scope.kind === "user"',
      ),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/conversation-directory.ts",
      (text) => `${text}\nexport interface AnchorConversationDirectoryMechanism { exists(id: string): Promise<boolean>; }`,
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/local-conversation-rpc.ts",
      (text) => text.replace(
        "const cleared = await this.#application.clear({",
        "await this.#mutate(conversationId, operationId, { kind: \"window-op\", op: \"clear\" });\n          const cleared = await this.#application.clear({",
      ),
    )).join("\n"),
    /Conversation directory management lacks one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/scheduler/application.ts",
      (text) => text.replace("draft.enabled ?? true", "draft.enabled!"),
    )).join("\n"),
    /Schedule definition management lacks one domain application owner/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/runtime/rpc-scheduler-facade.ts",
      (text) => text.replace("function exactRecord(", "function looseRecord("),
    )).join("\n"),
    /Schedule consumers do not converge on the one management application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/commands/info-commands.ts",
      (text) => text.replace(
        "const tasks = await deps.getScheduler().list();",
        "const tasks = (await deps.getScheduler().list()).filter((task) => !task.system);",
      ),
    )).join("\n"),
    /Schedule consumers do not converge on the one management application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/scheduler/application.ts",
      (text) => text.replace(
        "handler(projectScheduleRuntimeEvent(signal));",
        "handler(signal);",
      ),
    )).join("\n"),
    /Schedule runtime and lifecycle lack one finite domain application boundary/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/scheduler/application.ts",
      (text) => text.replace(
        "await mechanism.pauseAndSettle();",
        'if (input.strategy !== "immediate") await mechanism.pauseAndSettle();',
      ),
    )).join("\n"),
    /Schedule runtime and lifecycle lack one finite domain application boundary/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/scheduler/runtime-policy.ts",
      (text) => text.replace(
        "export function decideScheduleTrigger(",
        "export function decideTimedTrigger(",
      ),
    )).join("\n"),
    /Schedule timing, offline and failure policy escaped its domain owner/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/owner-kernel/src/scheduler-authority.ts",
      (text) => `${text}\nconst offlineMiss = true;`,
    )).join("\n"),
    /Schedule timing, offline and failure policy escaped its domain owner/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/owner-kernel/src/job-assignment.ts",
      (text) => `${text}\nfunction frozenFailureNextFire() { return undefined; }`,
    )).join("\n"),
    /Schedule timing, offline and failure policy escaped its domain owner/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/owner-kernel/src/job-assignment.ts",
      (text) => text.replace(
        "pendingAutoDisable: selectPendingScheduleAutoDisable(",
        "pendingAutoDisable: [...state.failurePolicyByRun.values()].filter(",
      ),
    )).join("\n"),
    /Schedule timing, offline and failure policy escaped its domain owner/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "schedulerApplication.install(runtime);",
        "void runtime;",
      ),
    )).join("\n"),
    /Schedule runtime and lifecycle lack one finite domain application boundary/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/anchor-scheduler-runtime.ts",
      (text) => text.replace(
        "readonly #scheduler: AnchorScheduler;",
        "readonly scheduler: AnchorScheduler;",
      ),
    )).join("\n"),
    /Schedule runtime and lifecycle lack one finite domain application boundary/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "if (!startupLifecycle) schedulerApplication.activate();",
        "if (!startupLifecycle) schedulerRuntime?.activate();",
      ),
    )).join("\n"),
    /Schedule runtime and lifecycle lack one finite domain application boundary/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/server/src/context.ts",
      (text) => `${text}\ninterface LegacyScheduleOwner { scheduler?: SchedulerBackend }`,
    )).join("\n"),
    /Host, Server or Surface retains a raw Schedule runtime decision path/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/rpc/src/event-bridge.ts",
      (text) => `${text}\nconst rawEvent = \"scheduler:task-failed\";`,
    )).join("\n"),
    /Host, Server or Surface retains a raw Schedule runtime decision path/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/server/src/rpc/methods/schedule.ts",
      (text) => `${text}\nserver.scheduler.createTask({});`,
    )).join("\n"),
    /Schedule RPC management binding bypasses its Product API application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/server/src/rpc/methods/schedule.ts",
      (text) => `${text}\nserver.scheduler.runTask("task");`,
    )).join("\n"),
    /Schedule RPC management binding bypasses its Product API application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/server/src/rpc/methods/schedule.ts",
      (text) => text.replace(
        /case "system-task":\s*return error;/u,
        'case "system-task":\n      return RpcErrors.invalidParams(error.message);',
      ),
    )).join("\n"),
    /Schedule RPC management binding bypasses its Product API application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/server/src/rpc/methods/schedule.ts",
      (text) => text.replace(
        'method === "schedule.create"',
        'method.startsWith("schedule.")',
      ),
    )).join("\n"),
    /Schedule RPC management binding bypasses its Product API application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/scheduler/application.ts",
      (text) => text.replace(
        'requireString(command.taskId, "Schedule task id")',
        'nonEmpty(command.taskId, "Schedule task id")',
      ),
    )).join("\n"),
    /Schedule definition management lacks one domain application owner/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/execution-scheduler-facade.ts",
      (text) => `${text}\nthrow new Error("Cannot modify system task");`,
    )).join("\n"),
    /Schedule facades or Correctness adapter retain a second management decision path/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/scheduler/facade.ts",
      (text) => text.replace(
        "return result.result;",
        "return this.scheduler.runTask(id);",
      ),
    )).join("\n"),
    /Schedule facades or Correctness adapter retain a second management decision path/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/scheduler/application.ts",
      (text) => text.replace(
        "    SCHEDULE_MANUAL_ABORT_COMMAND,",
        "",
      ),
    )).join("\n"),
    /Schedule definition management lacks one domain application owner/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/package.json",
      (text) => text.replace(
        '    "./advancement": {',
        '    "./scheduler/application-compat": {\n      "types": "./dist/scheduler/application.d.ts",\n      "import": "./dist/scheduler/application.js"\n    },\n    "./advancement": {',
      ),
    )).join("\n"),
    /one narrow non-root core subpath/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/skills/catalog-application.ts",
      (text) => text.replace(
        "entry.mode === mode && !entry.disabled",
        "entry.mode === mode",
      ),
    )).join("\n"),
    /projection rules lack one immutable domain application owner/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/protocol/execution-asset-snapshot.ts",
      (text) => text.replace(
        "skills: [...input.skills],",
        'skills: [...input.skills].sort((left, right) => left.id.localeCompare(right.id, "en-US")),',
      ),
    )).join("\n"),
    /do not preserve Skill Authority order/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/execution-asset-cache.ts",
      (text) => text.replace(
        "await assertReadableSkills(snapshot.skills, this.artifacts)",
        "await filterReadableSkills(snapshot.skills, this.artifacts)",
      ),
    )).join("\n"),
    /partial or corrupt Skill catalog/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/execution-asset-cache.ts",
      (text) => text.replace(
        "nextRevision < current.skillCatalogRevision",
        "false",
      ),
    )).join("\n"),
    /do not reject Skill rollback or same-revision equivocation/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/execution-asset-cache.ts",
      (text) => `${text}\nconst duplicateProjection = renderSkillIndex([]);`,
    )).join("\n"),
    /became a second Skill projection owner/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/orchestrator/src/runtime/assignment-skill-port.ts",
      (text) => `${text}\nexport function renderAssignmentSkillIndex() { return []; }`,
    )).join("\n"),
    /projection adapter interprets Skill fields or omits the raw catalog query/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/orchestrator/src/runtime/create-agent-runtime.ts",
      (text) => text.replace(
        "entryInstanceEpoch === instanceEpoch",
        "true",
      ),
    )).join("\n"),
    /can regress the immutable projection/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/orchestrator/src/runtime/create-agent-runtime.ts",
      (text) => `${text}\nconst leakedProjection = renderSkillIndex(builtinIndexEntries("main", new Set()));`,
    )).join("\n"),
    /interprets Skill catalog fields|can regress the immutable projection/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/trust-administration-adapter.ts",
      (text) => `${text}\nexport const createSkillDirectory = () => undefined;`,
    )).join("\n"),
    /retired parallel Skill management application owner/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/server/src/rpc/methods/skill.ts",
      (text) => `${text}\nconst bypass = { kind: "skill-archive" };`,
    )).join("\n"),
    /binding writes Skill GlobalState directly/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/skills/catalog-application.ts",
      (text) => text.replace(
        "await this.correctness.stageUsage(`${request.operationId}:usage`,",
        "await this.correctness.stageUsage(request.operationId,",
      ),
    )).join("\n"),
    /load and usage invariants lack one domain application owner/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/orchestrator/src/runtime/assignment-skill-port.ts",
      (text) => `${text}\nexport interface SkillTextLoader { loadText(): void; }`,
    )).join("\n"),
    /retired parallel Skill load application owner/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/orchestrator/src/runtime/assignment-skill-port.ts",
      (text) => text.replace(
        "new SkillCatalogLoadApplicationService(",
        "createLegacySkillLoader(",
      ),
    )).join("\n"),
    /omits the domain adapter/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/orchestrator/src/runtime/assignment-skill-port.ts",
      (text) => text.replace(
        "const run = requireRunSkillContext();",
        'const run = optionalRunSkillContext();\n      if (!run) return { kind: "builtin-only" };',
      ),
    )).join("\n"),
    /retains Skill load business orchestration or omits the domain adapter/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/tools-builtin/src/skill.ts",
      (text) => text.replace("await application.load({", "await loader.loadText({"),
    )).join("\n"),
    /load_skill binding must consume only the Skill-owned application contract/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/orchestrator/src/runtime/create-agent-runtime.ts",
      (text) => text.replace(
        "skillCatalogLoad: skillPorts.loadApplication",
        "skillLoader: skillPorts.loader",
      ),
    )).join("\n"),
    /unique Skill load application binding|retired parallel Skill load application owner/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/skills/catalog-application.ts",
      (text) => text.replace(
        "const committed = await this.#state().mutate(",
        "const committed = bypassSkillCommit(",
      ),
    )).join("\n"),
    /fact must use the exact revision returned after authority commit/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/server/src/rpc/methods/skill.ts",
      (text) => text.replace(
        "for (const fact of result.facts) broadcastChanged(ctx.server, fact);",
        "for (const fact of result.facts) { broadcastChanged(ctx.server, fact); broadcastChanged(ctx.server, fact); }",
      ),
    )).join("\n"),
    /fact transport must follow each successful application command/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/server/src/rpc/methods/skill.ts",
      (text) => text.replace(
        "requireProductApi(ctx.server).query(SKILL_CATALOG_LIST_QUERY",
        "ctx.server.skillCatalog.query(",
      ),
    )).join("\n"),
    /bypasses the Product API dispatcher/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/server/src/context.ts",
      (text) => text.replace(
        "productApi?: ProductApiDispatcher",
        "skillCatalog?: SkillCatalogApplication",
      ),
    )).join("\n"),
    /expose only the Product API dispatcher binding/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "new ProductApiDispatcher(",
        "new ProductApiDispatcher(\n      // duplicate construction mutation\n      new ProductApiDispatcher(",
      ),
    )).join("\n"),
    /exactly one Product API dispatcher construction|install one Product API dispatcher/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/server/src/rpc/methods/server.ts",
      (text) => text.replace(
        "productApi.command(DELIVERY_RESOLVE_UNCERTAIN_COMMAND",
        "ctx.server.runtimeControl.resolveDelivery(",
      ),
    )).join("\n"),
    /delivery\.resolve bypasses the Product API dispatcher/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/server/src/context.ts",
      (text) => text.replace(
        "beginDrain?: () => Promise<void>;",
        "resolveDelivery?: (input: unknown) => Promise<unknown>;\n  beginDrain?: () => Promise<void>;",
      ),
    )).join("\n"),
    /expose only the Product API dispatcher binding/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "createDeliveryResolutionProductApiContribution(",
        "createSkillCatalogProductApiContribution(",
      ),
    )).join("\n"),
    /Skill and Delivery contributions/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/delivery/index.ts",
      (text) => `${text}\nexport * from "./application.js";`,
    )).join("\n"),
    /one narrow non-root core subpath/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership([
      ...records,
      {
        relative: "packages/core/src/delivery/resolution-application.ts",
        text: 'export * from "./application.js";',
      },
    ]).join("\n"),
    /resolution-only source path/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/delivery/application.ts",
      (text) => `${text}\nimport { AuthorityStorageError } from "../authority/index.js";`,
    )).join("\n"),
    /one narrow non-root core subpath/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/owner-kernel/src/delivery-obligation-correctness.ts",
      (text) => text.replace(
        'new AuthorityStorageError("commit-log-corrupt", error.message',
        'new Error(error.message',
      ),
    )).join("\n"),
    /one narrow Correctness transaction/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/package.json",
      (text) => text.replaceAll(
        "./dist/delivery/application",
        "./dist/delivery/resolution-application",
      ),
    )).join("\n"),
    /one narrow non-root core subpath/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/tsup.config.ts",
      (text) => text.replace(
        '"src/delivery/application.ts"',
        '"src/delivery/resolution-application.ts"',
      ),
    )).join("\n"),
    /one narrow non-root core subpath/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/delivery/authority-pipeline.ts",
      (text) => text.replace("this.#application.claim(", "this.#authority.claim("),
    )).join("\n"),
    /attempt lifecycle does not have one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/delivery/authority-pipeline.ts",
      (text) => `${text}\ninterface LegacyPipeline { readonly sender: DeliverySender }`,
    )).join("\n"),
    /send effect is not uniquely domain-owned/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/delivery/channel-effect.ts",
      (text) => `${text}\nconst leakedAuthority: DeliveryAuthority | undefined = undefined;`,
    )).join("\n"),
    /send effect is not uniquely domain-owned/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/delivery/channel-effect.ts",
      (text) => text.replace(
        'kind: "unverified"',
        'kind: "manual-resolution"',
      ),
    )).join("\n"),
    /send effect is not uniquely domain-owned/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/delivery/outbox.ts",
      (text) => `${text}\nconst authorityOrigin = true;`,
    )).join("\n"),
    /send effect is not uniquely domain-owned/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/setup-delivery.ts",
      (text) => text.replace(
        '@zhixing/core/delivery/channel-effect',
        '@zhixing/core',
      ),
    )).join("\n"),
    /send effect is not uniquely domain-owned/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/delivery/index.ts",
      (text) => `${text}\nexport * from "./channel-effect.js";`,
    )).join("\n"),
    /Channel effect must have one narrow non-root adapter subpath/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/delivery/authority.ts",
      (text) => text.replace(
        "async transactDeliveryLifecycle<Value>",
        "async claim<Value>",
      ),
    )).join("\n"),
    /attempt lifecycle does not have one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/delivery/authority.ts",
      (text) => `${text}\nasync function installLifecycleAdmission() {}`,
    )).join("\n"),
    /accepted-work lifecycle does not have one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/delivery/authority-pipeline.ts",
      (text) => `${text}\nfunction settleAcceptedWorkForLifecycle() { return "immediate"; }`,
    )).join("\n"),
    /accepted-work lifecycle does not have one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "ctx.deliveryStack?.lifecycle.install({",
        "ctx.deliveryStack?.authority.installLifecycleAdmission({",
      ),
    )).join("\n"),
    /accepted-work lifecycle does not have one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/executor-role-runtime.ts",
      (text) => `${text}\nvoid authority.authority.installLifecycleAdmission({});`,
    )).join("\n"),
    /accepted-work lifecycle does not have one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/owner-kernel/src/delivery-obligation-correctness.ts",
      (text) => text.replace(
        "authority.transactDeliveryLifecycle<Value>",
        "authority.claim",
      ),
    )).join("\n"),
    /attempt lifecycle does not have one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/delivery/lifecycle-policy.ts",
      (text) => text.replace(
        "deliveryUnknownOutcomeDisposition",
        "legacyUnknownOutcomeDisposition",
      ),
    )).join("\n"),
    /attempt lifecycle does not have one domain application/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/owner-kernel/src/delivery-participant.ts",
      (text) => `${text}\nvoid deliveryAuthority.prepareEnqueues([]);`,
    )).join("\n"),
    /one domain decision and one narrow Correctness adapter/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/owner-kernel/src/index.ts",
      (text) => `${text}\nexport * from "./delivery-obligation-correctness.js";`,
    )).join("\n"),
    /one domain decision and one narrow Correctness adapter/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/owner-kernel/src/scheduler-user-notices.ts",
      (text) => text.replace(
        "prepareSchedulerNotices?.(",
        "prepareEnqueues(",
      ),
    )).join("\n"),
    /Delivery producer bypasses the obligation participant/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/product-api/catalog.ts",
      (text) => `${text}\nconst leakedSkillRule = { skillId: "x", disabled: true };`,
    )).join("\n"),
    /domain-neutral/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/package.json",
      (text) => text.replace(
        '    "./advancement": {',
        '    "./product-api-compat": {\n      "types": "./dist/product-api/catalog.d.ts",\n      "import": "./dist/product-api/catalog.js"\n    },\n    "./advancement": {',
      ),
    )).join("\n"),
    /one narrow non-root core subpath/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/skills/index.ts",
      (text) => `${text}\nexport * from "./catalog-application.js";`,
    )).join("\n"),
    /leaked into the core root barrel/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/server/src/context.ts",
      (text) => text.replace(
        '@zhixing/core/product-api',
        '@zhixing/core',
      ),
    )).join("\n"),
    /expose only the Product API dispatcher binding/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/package.json",
      (text) => text.replace(
        '    "./advancement": {',
        '    "./skills/catalog-compat": {\n      "types": "./dist/skills/catalog-application.d.ts",\n      "import": "./dist/skills/catalog-application.js"\n    },\n    "./advancement": {',
      ),
    )).join("\n"),
    /second package export entry/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/server/src/rpc/methods/skill.ts",
      (text) => text.replace(
        "throw error;",
        "throw RpcErrors.busy(error.message);",
      ),
    )).join("\n"),
    /changed the pre-migration conflict wire contract/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/skills/index.ts",
      (text) => `${text}\nexport { runSkillSavePipeline } from "./save-pipeline.js";`,
    )).join("\n"),
    /retired parallel Skill save application owner|leaked into the core root barrel/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/tools-builtin/src/skill.ts",
      (text) => text.replace(
        '@zhixing/core/skills/catalog',
        '@zhixing/core',
      ),
    )).join("\n"),
    /bypasses its domain subpath|leaked back through core root import/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/orchestrator/src/runtime/assignment-skill-port.ts",
      (text) => `${text}\nconst bypass = scrubSecrets("draft");`,
    )).join("\n"),
    /retains Skill save business orchestration/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/orchestrator/src/runtime/create-agent-runtime.ts",
      (text) => text.replace(
        "skillCatalogSave: skillPorts.saveApplication",
        "skillSaver: skillPorts.saver",
      ),
    )).join("\n"),
    /does not install the unique Skill save application binding/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/skills/catalog-application.ts",
      (text) => text.replace(
        /await this\.correctness\.stage\(\s*stagedOperationId!,/u,
        "await bypassSkillSaveStage(",
      ),
    )).join("\n"),
    /stage one stable operation only after content artifact creation/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/skills/catalog-application.ts",
      (text) => text.replace(
        "record.recordSeq >= replayRecordSeq",
        "false",
      ),
    )).join("\n"),
    /does not exclude its own durable operation/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/skills/catalog-application.ts",
      (text) => text.replace(
        "sameSkillSaveDraft(replayMutation, candidate)",
        "false",
      ),
    )).join("\n"),
    /does not exclude its own durable operation/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/serve/assignment-schedule-stager.ts",
      (text) => text.replace(
        "const requestId = assignmentMutationRequestId({",
        "const requestId = legacyAssignmentMutationRequestId({",
      ),
    )).join("\n"),
    /identity is not shared with the durable assignment mutation ledger/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/skills/catalog-application.ts",
      (text) => text.replace(
        "candidate.digest !== pending.digest",
        "false",
      ),
    )).join("\n"),
    /admission lifecycle lacks one domain application owner/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/tools-builtin/src/skill.ts",
      (text) => `${text}\nexport interface SkillAdmissionPort { admit(): Promise<void>; }`,
    )).join("\n"),
    /retired parallel Skill admission application owner/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/orchestrator/src/runtime/assignment-skill-port.ts",
      (text) => text.replace(
        "new SkillCatalogAdmissionApplicationService(",
        "createLegacyAdmissionApplication(",
      ),
    )).join("\n"),
    /does not provide the path-free Skill admission adapter/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/orchestrator/src/runtime/create-agent-runtime.ts",
      (text) => text.replace(
        "skillCatalogAdmission: skillPorts.admissionApplication",
        "skillAdmission: skillPorts.admission",
      ),
    )).join("\n"),
    /does not install the unique Skill admission application binding/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/skills/global-state-adapter.ts",
      (text) => `${text}\nconst revived = "intent:skill-materialization";`,
    )).join("\n"),
    /legacy directory import or filesystem materialization/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/skills/global-state-adapter.ts",
      (text) => text.replace(
        "await this.#assertCommittedMutation(",
        "await Promise.resolve(",
      ),
    )).join("\n"),
    /does not validate committed Authority replay/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/setup-delivery.ts",
      (text) => `${text}\nconst revived = new SkillStore(getSkillsRoot());`,
    )).join("\n"),
    /constructs the retired filesystem Skill owner/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/core/src/skills/index.ts",
      (text) => `${text}\nexport { SkillStore } from "./store.js";`,
    )).join("\n"),
    /root barrel exposes retired filesystem storage/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership([
      ...records,
      {
        relative: "packages/core/src/skills/store.ts",
        text: "export class SkillStore {}",
      },
    ]).join("\n"),
    /retired filesystem Skill owner remains reachable/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/rpc/src/skill-catalog-client.ts",
      (text) => text.replace("requireExactKeys(value, [\"structuralVersion\"]);", "void value;"),
    )).join("\n"),
    /RPC client binding is not uniquely RPC-owned, domain-bound or strict fail-closed/,
  );
  for (const dependency of ["@zhixing/server", "@zhixing/cli"]) {
    assert.match(
      inspectSkillCatalogApplicationOwnership(mutate(
        "packages/rpc/src/skill-catalog-client.ts",
        (text) => `${text}\nimport type { Forbidden } from "${dependency}";`,
      )).join("\n"),
      /RPC client binding is not uniquely RPC-owned, domain-bound or strict fail-closed/,
    );
  }
  assert.match(
    inspectSkillCatalogApplicationOwnership([
      ...records,
      {
        relative: "packages/cli/src/runtime/skill-catalog-rpc-client.ts",
        text: 'const revived = "skill.list";',
      },
    ]).join("\n"),
    /leaked back into the CLI Surface package|wire escaped/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/rpc/src/index.ts",
      (text) => `${text}\nexport * from "./skill-catalog-client.js";`,
    )).join("\n"),
    /one narrow non-root RPC subpath/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/rpc/package.json",
      (text) => text.replace(
        '"./session-wire":',
        '"./skill-client-alias": { "types": "./dist/skill-catalog-client.d.ts", "import": "./dist/skill-catalog-client.js" },\n    "./session-wire":',
      ),
    )).join("\n"),
    /one narrow non-root RPC subpath/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/repl.ts",
      (text) => text.replace("client: skillClient", "listAll: async () => []"),
    )).join("\n"),
    /does not share one Skill client/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership(mutate(
      "packages/cli/src/runtime/rpc-management-facade.ts",
      (text) => `${text}\nconst revived = \"skill.list\";`,
    )).join("\n"),
    /parallel Skill client mainline|wire escaped/,
  );
  assert.match(
    inspectSkillCatalogApplicationOwnership([
      ...records,
      {
        relative: "packages/channels/feishu/src/skill-surface.ts",
        text: 'const method = "skill.list";',
      },
    ]).join("\n"),
    /unauthorized empty Skill Product API Surface/,
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
  assert.match(
    inspectProductionManifest("packages/runtime-host/package.json", {
      dependencies: { "@zhixing/mcp": "workspace:*" },
    }).join("\n"),
    /runtime-host declares product dependency/,
  );
  assert.match(
    inspectProductionManifest("packages/runtime-host/package.json", {
      exports: { "./workmode-tools": {} },
    }).join("\n"),
    /runtime-host exposes retired product subpath/,
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

test("Conversation storage implementations stay behind one finite Host adapter", async () => {
  const paths = [
    "packages/cli/src/serve/conversation-storage-infrastructure.ts",
    "packages/cli/src/serve/command.ts",
    "packages/cli/src/serve/access-surface.ts",
    "packages/cli/src/serve/access-surfaces.ts",
    "packages/cli/src/serve/conversation-directory.ts",
    "packages/cli/src/runtime/read-only-conversation-browser.ts",
    "packages/core/src/context/bootstrap/build-startup-bootstrap.ts",
    "packages/core/src/conversation/application.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: await readFile(relative, "utf8"),
  })));
  const mutate = (relative, update) => records.map((record) =>
    record.relative === relative ? { ...record, text: update(record.text) } : record);

  assert.deepEqual(inspectConversationStorageBoundary(records), []);
  assert.match(
    inspectConversationStorageBoundary(mutate(
      "packages/cli/src/serve/access-surfaces.ts",
      (text) => `${text}\nimport { ShardedTranscriptStore } from "@zhixing/core/transcript";`,
    )).join("\n"),
    /concrete Conversation storage ShardedTranscriptStore escaped/,
  );
  assert.match(
    inspectConversationStorageBoundary(mutate(
      "packages/cli/src/serve/conversation-directory.ts",
      (text) => text.replace(
        "routeConversation(conversationId: string)",
        "routeConversation?(conversationId: string)",
      ),
    )).join("\n"),
    /directory routing can recreate a concrete fallback owner/,
  );
  assert.match(
    inspectConversationStorageBoundary(mutate(
      "packages/cli/src/runtime/read-only-conversation-browser.ts",
      (text) => `${text}\nimport fs from "node:fs/promises";`,
    )).join("\n"),
    /Surface reads concrete storage or physical paths/,
  );
  assert.match(
    inspectConversationStorageBoundary(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => `${text}\ncreateConversationStorageInfrastructure({});`,
    )).join("\n"),
    /Host does not compose the single finite Conversation storage boundary/,
  );
  assert.match(
    inspectConversationStorageBoundary([
      ...records,
      {
        relative: "packages/cli/src/serve/advancement-gc.ts",
        text: "export const revived = true;",
      },
    ]).join("\n"),
    /retired physical Conversation liveness bypass returned/,
  );
});

test("Workscene cleanup cursor and walker stay behind finite Host effects", async () => {
  const paths = [
    "packages/cli/src/serve/workscene-storage-cleanup.ts",
    "packages/cli/src/serve/workscene-storage-removal.ts",
    "packages/cli/src/serve/command.ts",
    "packages/cli/src/serve/conversation-storage-infrastructure.ts",
    "packages/cli/src/serve/conversation-directory.ts",
    "packages/cli/src/serve/workscene-directory.ts",
    "packages/cli/src/serve/workscene-session-owner.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: await readFile(relative, "utf8"),
  })));
  const mutate = (relative, update) => records.map((record) =>
    record.relative === relative ? { ...record, text: update(record.text) } : record);

  assert.deepEqual(inspectWorksceneStorageCleanupBoundary(records), []);
  assert.match(
    inspectWorksceneStorageCleanupBoundary(mutate(
      "packages/cli/src/serve/workscene-directory.ts",
      (text) => `${text}\ncreateWorksceneStorageCleanupInfrastructure({ zhixingHome: "foreign" });`,
    )).join("\n"),
    /not constructed once at the Host edge/,
  );
  assert.match(
    inspectWorksceneStorageCleanupBoundary(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "createWorksceneStorageCleanupInfrastructure({\n    zhixingHome,",
        "createWorksceneStorageCleanupInfrastructure({",
      ),
    )).join("\n"),
    /not constructed once at the Host edge/,
  );
  assert.match(
    inspectWorksceneStorageCleanupBoundary(mutate(
      "packages/cli/src/serve/workscene-session-owner.ts",
      (text) => `${text}\nimport path from "node:path"; const cursorDirectory = path.join("workscenes", ".cleanup");`,
    )).join("\n"),
    /regained P03 paths, cursor, walker or concrete cleanup/,
  );
  assert.match(
    inspectWorksceneStorageCleanupBoundary(mutate(
      "packages/cli/src/serve/workscene-session-owner.ts",
      (text) => `${text}\ncreateWorksceneStorageCleanup({});`,
    )).join("\n"),
    /Retired Workscene cleanup constructor or fallback returned/,
  );
  assert.match(
    inspectWorksceneStorageCleanupBoundary(mutate(
      "packages/cli/src/serve/command.ts",
      (text) => text.replace(
        "sceneStorageRemoval: worksceneStorageCleanup.scenes",
        "sceneStorageRemoval: undefined",
      ),
    )).join("\n"),
    /not constructed once at the Host edge/,
  );
});

test("non-topology storage mechanisms stay behind finite Infrastructure edges", async () => {
  const paths = [
    "packages/providers/src/config-loader.ts",
    "packages/providers/src/credentials-loader.ts",
    "packages/secrets/src/platform-secret-store.ts",
    "packages/secrets/src/vault-secret-store.ts",
    "packages/orchestrator/src/runtime/assignment-skill-port.ts",
    "packages/core/src/skills/catalog-application.ts",
    "packages/cli/src/setup-delivery.ts",
    "packages/core/src/authority/artifact-store.ts",
    "packages/core/src/authority/commit-log.ts",
    "packages/core/src/authority/durable-projection-index.ts",
    "packages/core/src/authority/artifact-lifecycle-index.ts",
    "packages/cli/src/serve/status.ts",
    "packages/cli/src/serve/token.ts",
    "packages/cli/src/serve/command.ts",
    "packages/cli/src/serve/executor-role-runtime.ts",
    "packages/cli/src/serve/anchor-host-shell-lifecycle.ts",
    "packages/cli/src/serve/executor-server-lifecycle.ts",
    "packages/server/src/server-state.ts",
    "packages/server/src/process-lock.ts",
    "packages/server/src/server-log-lifecycle.ts",
    "packages/cli/src/serve/managed-service.ts",
    "packages/cli/src/output/llm-chunk-dump.ts",
    "packages/cli/src/security/keypress-dump.ts",
    "packages/cli/src/runtime/config-command.ts",
    "packages/cli/src/runtime/surface-core-host-link.ts",
    "packages/cli/src/runtime/workspace-command.ts",
    "packages/cli/src/serve/backup-command.ts",
    "packages/cli/src/serve/disaster-recovery-command.ts",
    "packages/cli/src/serve/managed-service-runtime.ts",
    "packages/cli/src/serve/mesh-pair-command.ts",
    "packages/cli/src/serve/topology-command.ts",
    "packages/cli/src/startup.ts",
    "packages/runtime-host/src/runtime-host.ts",
    "packages/core/src/conversation/application.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: await readFile(relative, "utf8"),
  })));
  const mutate = (relative, update) => records.map((record) =>
    record.relative === relative ? { ...record, text: update(record.text) } : record);

  assert.deepEqual(inspectStorageRemainderBoundary(records), []);
  assert.match(
    inspectStorageRemainderBoundary(mutate(
      "packages/core/src/skills/catalog-application.ts",
      (text) => `${text}\ncreatePlatformSecretStore({ homeDir: "domain" });`,
    )).join("\n"),
    /P01 SecretStore concrete factory production multiplicity|mechanism returned to a demand owner/,
  );
  assert.match(
    inspectStorageRemainderBoundary(mutate(
      "packages/cli/src/runtime/config-command.ts",
      (text) => `${text}\ncreatePlatformSecretStore({ homeDir: "duplicate" });`,
    )).join("\n"),
    /P01 SecretStore concrete factory production multiplicity/,
  );
  assert.match(
    inspectStorageRemainderBoundary(mutate(
      "packages/core/src/skills/catalog-application.ts",
      (text) => `${text}\nconst admissionRoot = "zhixing-skill-admission";`,
    )).join("\n"),
    /P05 admission temp escaped|mechanism returned to a demand owner/,
  );
  assert.match(
    inspectStorageRemainderBoundary(mutate(
      "packages/cli/src/runtime/workspace-command.ts",
      (text) => `${text}\nnew AssignmentSkillAdmissionCorrectnessPort({});`,
    )).join("\n"),
    /P05 admission temp adapter production multiplicity/,
  );
  assert.match(
    inspectStorageRemainderBoundary(mutate(
      "packages/runtime-host/src/runtime-host.ts",
      (text) => `${text}\nconst leaked = new FileArtifactStore("authority");`,
    )).join("\n"),
    /P06 file concrete escaped|mechanism returned to a demand owner/,
  );
  assert.match(
    inspectStorageRemainderBoundary(mutate(
      "packages/cli/src/serve/status.ts",
      (text) => `${text}\nexport class FileArtifactStore {}`,
    )).join("\n"),
    /P06 FileArtifactStore definition production multiplicity/,
  );
  assert.match(
    inspectStorageRemainderBoundary(mutate(
      "packages/cli/src/serve/status.ts",
      (text) => `${text}\nconst writer = new ServerStateFile();`,
    )).join("\n"),
    /P13 discovery\/auth\/state\/log ownership|P13 ServerStateFile constructor production multiplicity/,
  );
  assert.match(
    inspectStorageRemainderBoundary(mutate(
      "packages/cli/src/runtime/workspace-command.ts",
      (text) => `${text}\nconst secondWriter = new ServerStateFile();`,
    )).join("\n"),
    /P13 ServerStateFile constructor production multiplicity/,
  );
  assert.match(
    inspectStorageRemainderBoundary(mutate(
      "packages/cli/src/runtime/workspace-command.ts",
      (text) => `${text}\nvoid readServerStateSnapshot();`,
    )).join("\n"),
    /P13 read-only state projection definition\/consumer production multiplicity/,
  );
  assert.match(
    inspectStorageRemainderBoundary(mutate(
      "packages/cli/src/serve/status.ts",
      (text) => `${text}\nconst managed = new NodeManagedServiceAdapter({});`,
    )).join("\n"),
    /P14 NodeManagedServiceAdapter constructor production multiplicity/,
  );
  assert.match(
    inspectStorageRemainderBoundary(mutate(
      "packages/core/src/conversation/application.ts",
      (text) => `${text}\nconst forensic = "llm-error";`,
    )).join("\n"),
    /mechanism returned to a demand owner/,
  );
  assert.match(
    inspectStorageRemainderBoundary(mutate(
      "packages/cli/src/serve/status.ts",
      (text) => `${text}\nconst duplicateLogRoot = path.join(home, "logs", "llm-error");`,
    )).join("\n"),
    /P15 llm-error path writer production multiplicity/,
  );
  assert.match(
    inspectStorageRemainderBoundary(mutate(
      "packages/core/src/conversation/application.ts",
      (text) => `${text}\nclass StorageFacade {}`,
    )).join("\n"),
    /unified Storage facade returned/,
  );
});

test("disaster-recovery staging keeps one physical adapter and required Host flow", async () => {
  const paths = [
    "packages/cli/src/serve/disaster-recovery-staging.ts",
    "packages/cli/src/serve/disaster-recovery-staging-infrastructure.ts",
    "packages/cli/src/serve/disaster-recovery-target.ts",
    "packages/cli/src/serve/disaster-recovery-authority.ts",
    "packages/cli/src/serve/disaster-recovery-candidate.ts",
    "packages/cli/src/serve/disaster-recovery-installation.ts",
    "packages/cli/src/serve/disaster-recovery-command.ts",
    "packages/cli/src/serve/mesh-runtime-bootstrap.ts",
    "packages/cli/src/serve/mesh-runtime-assembly.ts",
    "packages/cli/src/serve/application-host.ts",
    "packages/cli/src/serve/access-surfaces.ts",
    "packages/cli/src/serve/executor-role-runtime.ts",
    "packages/cli/src/serve/device-removal-cleanup.ts",
  ];
  const records = await Promise.all(paths.map(async (relative) => ({
    relative,
    text: (await readFile(relative, "utf8")).replaceAll("\r\n", "\n"),
  })));
  assert.deepEqual(inspectDisasterRecoveryStagingBoundary(records), []);
  const mutate = (relative, transform) => records.map((record) =>
    record.relative === relative ? { ...record, text: transform(record.text) } : record
  );
  assert.match(
    inspectDisasterRecoveryStagingBoundary(mutate(
      "packages/cli/src/serve/disaster-recovery-target.ts",
      (text) => `import path from "node:path";\n${text}`,
    )).join("\n"),
    /demand-side finite staging boundary drifted/,
  );
  assert.match(
    inspectDisasterRecoveryStagingBoundary(mutate(
      "packages/cli/src/serve/disaster-recovery-staging-infrastructure.ts",
      (text) => text.replace('"disaster-recovery-staging"', '"anchor-transfer-staging"'),
    )).join("\n"),
    /unique physical ownership drifted/,
  );
  assert.match(
    inspectDisasterRecoveryStagingBoundary(mutate(
      "packages/cli/src/serve/application-host.ts",
      (text) => text.replace(
        "disasterRecoveryStaging,\n    );",
        "this.#dependencies.createDisasterRecoveryStaging({ zhixingHome: this.#input.zhixingHome }),\n    );",
      ),
    )).join("\n"),
    /Host\/bootstrap required instance flow drifted/,
  );
  assert.match(
    inspectDisasterRecoveryStagingBoundary(mutate(
      "packages/cli/src/serve/mesh-runtime-bootstrap.ts",
      (text) => text.replace(
        "readonly disasterRecoveryStaging: DisasterRecoveryStagingArea;",
        "readonly disasterRecoveryStaging?: DisasterRecoveryStagingArea;",
      ),
    )).join("\n"),
    /demand-side finite staging boundary drifted|Host\/bootstrap required instance flow drifted/,
  );
  assert.match(
    inspectDisasterRecoveryStagingBoundary(mutate(
      "packages/cli/src/serve/disaster-recovery-target.ts",
      (text) => text.replace("await context.cleanupTransfer();", "await context.close();"),
    )).join("\n"),
    /demand-side finite staging boundary drifted|exact cleanup ownership drifted/,
  );
  assert.match(
    inspectDisasterRecoveryStagingBoundary(mutate(
      "packages/cli/src/serve/device-removal-cleanup.ts",
      (text) => text.replace(
        "await input.disasterRecoveryStaging.cleanupCurrentDevice(input.signal);",
        "await input.disasterRecoveryStaging.close();",
      ),
    )).join("\n"),
    /exact cleanup ownership drifted/,
  );
});
