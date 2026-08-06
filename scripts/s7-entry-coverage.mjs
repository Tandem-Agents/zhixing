import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FEISHU_INBOUND_EVENT_NAMES } from "../packages/channels/feishu/src/adapter.ts";
import { captureCliCommandDescriptor } from "../packages/cli/src/index.ts";
import { captureChannelAdapterFactoryDescriptor } from "../packages/cli/src/serve/channels.ts";
import { SEGMENT_TRANSITION_HOOK_PHASES } from "../packages/core/src/context/segment/types.ts";
import { AGENT_RUNTIME_LIFECYCLE_PHASES } from "../packages/orchestrator/src/runtime/lifecycle.ts";
import { TASK_TOOL_CAPABILITY_DESCRIPTOR } from "../packages/orchestrator/src/tools/task.ts";
import { BUILTIN_EXTRA_TOOL_CAPABILITIES } from "../packages/runtime-host/src/builtin-extra-tools.ts";
import { captureBuiltinRegistryDescriptor } from "../packages/server/src/rpc/methods/index.ts";
import {
  BUILTIN_TOOL_CAPABILITIES,
  BUILTIN_TOOL_FACTORIES,
} from "../packages/tools-builtin/src/factories.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(new URL("../packages/core/package.json", import.meta.url));
const ts = require("typescript");

const slashSources = [
  "packages/cli/src/commands/info-commands.ts",
  "packages/cli/src/commands/session-commands.ts",
  "packages/cli/src/commands/config-commands.ts",
  "packages/cli/src/commands/task-commands.ts",
  "packages/cli/src/skills/manager-command.ts",
];

const cleanupSources = [
  ["server", "packages/server/src/lifecycle.ts"],
  ["runtime", "packages/cli/src/serve/command.ts"],
  ["common", "packages/cli/src/serve/shutdown-chain.ts"],
  ["surface", "packages/cli/src/serve/access-surfaces.ts"],
];

const dueDocuments = [
  ["research/design/drafts/transcript-persistence-and-attention-window-architecture.md", "GlobalStatePort"],
  ["research/design/drafts/scheduler-architecture.md", "JobJournal"],
  ["research/design/drafts/workscene-management-architecture.md", "ExplicitEnvironmentSelection"],
  ["research/design/drafts/task-advancement-rubric-architecture.md", "canonical evidence"],
  ["research/design/drafts/unified-core-and-access-surfaces.md", "owner-kernel"],
  ["research/design/specifications/message-outbox.md", "已整体退役"],
  ["research/design/specifications/persistent-service.md", "已整体退役"],
  ["research/design/specifications/agent-runtime-lifecycle.md", "权威提交"],
  ["research/design/drafts/permission-architecture-evolution.md", "PermissionSnapshotLease"],
  ["research/design/modules/distributed-runtime/specification.md", "surface 预上传"],
];

const exclusions = {
  connection: "连接握手或健康检查，不进入业务落点矩阵",
  composition: "产品组合根或命令分组，本身不执行领域操作",
  diagnostic: "只读取或渲染设备本地诊断信息，无权威写",
  localRender: "纯本地展示，不产生权威事实",
};

const retiredProductionTokens = [
  "LegacyDeliveryDrainer",
  "delivery-queue.json",
  "canonicalEvidenceOnly",
  "createDefaultAdvancementEvidenceProvider",
  "workspace.binding.admin",
  "workspace.binding.reset",
  "IDeliveryPipeline",
  "EnqueueParams",
];
const forbiddenWriteOwners = new Set(["MemoryStore", "SkillStore", "AnchorWorksceneRegistry"]);
const guardedRoots = ["packages/executor/", "packages/runtime-host/", "packages/orchestrator/", "packages/tools-builtin/"];

const agentLifecyclePhases = [...AGENT_RUNTIME_LIFECYCLE_PHASES];
const segmentLifecyclePhases = [...SEGMENT_TRANSITION_HOOK_PHASES];
const builtinRpcNames = new Set(captureBuiltinRegistryDescriptor().map((item) => item.name));

const coverageGroups = [
  ["session-send", ["rpc:session.send", "slash:skill:<catalog-id>"]],
  ["run-cancel", ["rpc:session.abort"]],
  ["uncertain-resolution", ["rpc:session.resolve", "rpc:delivery.resolve"]],
  ["confirmation-resolve", ["rpc:confirmation.resolve"]],
  ["confirmation-read", ["rpc:confirmation.list"]],
  ["session-observer", ["rpc:session.subscribe", "rpc:session.unsubscribe"]],
  ["global-list-read", ["rpc:schedule.list", "rpc:workscene.list", "rpc:skill.list", "slash:tasks:repl"]],
  ["trust-manage", ["rpc:trust.list", "rpc:trust.revoke", "slash:trust:repl"]],
  ["conversation-manage", ["rpc:session.new", "rpc:session.list", "rpc:session.resume", "slash:new:repl", "slash:resume:repl"]],
  ["conversation-window", ["rpc:session.clear", "rpc:session.compact", "slash:clear:repl", "slash:compact:repl"]],
  ["conversation-metadata", ["rpc:session.rename", "rpc:session.delete", "slash:name:repl"]],
  ["conversation-read", ["rpc:session.history", "rpc:session.usage", "rpc:session.security", "rpc:session.contextBudget", "slash:usage:repl", "slash:context:repl", "slash:security:repl"]],
  ["task-list", ["rpc:session.taskList", "rpc:session.taskListUpdate", "slash:task:repl", "slash:tasklist:repl", "tool:extra:task-list"]],
  ["advancement", ["rpc:session.advancementCancel", "rpc:session.advancementConfirm", "rpc:session.advancementDetail", "rpc:session.advancementRevise", "slash:advancement:repl"]],
  ["workscene-manage", ["rpc:workscene.create", "rpc:workscene.delete", "rpc:workscene.rename", "rpc:workscene.setWorkdir", "tool:extra:workscene:change-approve", "tool:extra:workscene:rename-current", "tool:extra:workscene:set-workdir-current", "tool:extra:workscene:clear-workdir-current"]],
  ["workscene-switch", ["rpc:workscene.enter", "rpc:workscene.exit", "slash:work:repl", "slash:exit:repl", "tool:extra:workscene:enter", "tool:extra:workscene:exit"]],
  ["schedule-manage", ["rpc:schedule.create", "rpc:schedule.update", "rpc:schedule.delete", "tool:extra:schedule:manage"]],
  ["schedule-run", ["rpc:schedule.run", "rpc:schedule.abortRun", "tool:extra:schedule:run"]],
  ["memory-write", ["tool:builtin:memory"]],
  ["memory-read", ["rpc:memory.journalStats", "rpc:memory.peopleList", "rpc:memory.profileGet", "slash:me:repl", "slash:journal:repl", "slash:people:repl"]],
  ["skill-manage", ["rpc:skill.archive", "rpc:skill.setState", "slash:skills:repl", "tool:builtin:save_skill", "tool:builtin:admit_skill"]],
  ["segment-transition", segmentLifecyclePhases.map((phase) => `lifecycle:segment:${phase}`)],
  ["workspace-binding", ["cli:zhixing workspace status", "cli:zhixing workspace list", "cli:zhixing workspace create", "cli:zhixing workspace create-scene", "cli:zhixing workspace rename", "cli:zhixing workspace repath", "cli:zhixing workspace remove", "cli:zhixing workspace reset"]],
  ["runtime-lifecycle", agentLifecyclePhases.map((phase) => `lifecycle:agent:${phase}`)],
  ["orchestration-child", ["tool:orchestrator:Task"]],
  ["channel-inbound", ["channel:router:InboundRouter", "channel:adapter:feishu", "channel:event:feishu:im.message.receive_v1"]],
  ["status-read", ["rpc:server.info", "cli:zhixing status", "slash:status:repl"]],
  ["light-inference", ["rpc:llm.complete"]],
  ["shutdown", ["rpc:server.shutdown", "cli:zhixing stop", "slash:stop:repl"]],
  ["runtime-config", ["slash:config:repl", "slash:mcp:repl"]],
  ["device-trust", ["cli:zhixing pair"]],
];

const explicitMappings = Object.fromEntries(
  coverageGroups.flatMap(([rowId, keys]) => keys.map((key) => [key, { rowId }])),
);

Object.assign(explicitMappings, {
  "rpc:auth": { exclusion: "connection", reason: exclusions.connection },
  "rpc:health": { exclusion: "connection", reason: exclusions.connection },
  "cli:zhixing": { exclusion: "composition", reason: exclusions.composition },
  "cli:zhixing workspace": { exclusion: "composition", reason: exclusions.composition },
  "cli:zhixing serve": { exclusion: "composition", reason: exclusions.composition },
  "cli:zhixing serve logs": { exclusion: "diagnostic", reason: exclusions.diagnostic },
  "slash:help:repl": { exclusion: "localRender", reason: exclusions.localRender },
  "slash:model:repl": { exclusion: "localRender", reason: exclusions.localRender },
});

function literalProperty(object, name) {
  const property = object.properties.find(
    (candidate) => ts.isPropertyAssignment(candidate) && candidate.name.getText().replaceAll(/["']/g, "") === name,
  );
  return property && ts.isStringLiteralLike(property.initializer) ? property.initializer.text : undefined;
}

async function collectSlashCommands() {
  const commands = [];
  for (const relative of slashSources) {
    const source = ts.createSourceFile(relative, await readFile(path.join(root, relative), "utf8"), ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "register" &&
        node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        const id = literalProperty(node.arguments[0], "id");
        const name = literalProperty(node.arguments[0], "name");
        const execution = literalProperty(node.arguments[0], "execution");
        if (id && name && execution) commands.push({ id, name, execution, source: relative });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  commands.push({
    id: "skill:<catalog-id>",
    name: "<catalog-id>",
    execution: "agent",
    source: "packages/cli/src/commands/skill-command-source.ts",
    collisionPolicy: "builtin-first",
  });
  return commands.sort((left, right) => left.id.localeCompare(right.id, "en-US"));
}

async function collectCleanupRegistrations() {
  const result = [];
  for (const [role, relative] of cleanupSources) {
    const text = await readFile(path.join(root, relative), "utf8");
    const ids = [...text.matchAll(/\b(?:cleanup|registry)\.register\(\s*["']([^"']+)["']/gu)].map((match) => match[1]);
    for (const id of [...new Set(ids)].sort()) result.push({ role, id, source: relative });
  }
  return result.sort((left, right) => `${left.role}:${left.id}`.localeCompare(`${right.role}:${right.id}`, "en-US"));
}

function collectCliCommands() {
  return [...captureCliCommandDescriptor()];
}

async function collectProductionConstants() {
  const [schedule, taskList, workmode] = await Promise.all([
    readFile(path.join(root, "packages/tools-builtin/src/schedule.ts"), "utf8"),
    readFile(path.join(root, "packages/tools-builtin/src/task-list.ts"), "utf8"),
    readFile(path.join(root, "packages/runtime-host/src/workmode-tools.ts"), "utf8"),
  ]);
  const channelAdapters = [...captureChannelAdapterFactoryDescriptor()];
  assertUnique(channelAdapters.map((item) => item.configType), "channel config type");
  assertUnique(channelAdapters.map((item) => item.adapterType), "channel adapter type");
  const inboundEvents = [...FEISHU_INBOUND_EVENT_NAMES];
  assertUnique(inboundEvents, "channel inbound event");
  const factoryNames = Object.keys(BUILTIN_TOOL_FACTORIES).sort();
  const capabilityNames = Object.keys(BUILTIN_TOOL_CAPABILITIES).sort();
  if (JSON.stringify(factoryNames) !== JSON.stringify(capabilityNames)) throw new Error("builtin factory/capability descriptor drift");
  const builtinTools = Object.entries(BUILTIN_TOOL_CAPABILITIES)
    .filter(([, capability]) => capability.authorityWrite)
    .map(([name]) => name);
  const extraTools = BUILTIN_EXTRA_TOOL_CAPABILITIES.filter((item) => item.authorityWrite);
  assertUnique(extraTools.map((item) => item.key), "extra-tool capability key");
  const actualExtraNames = new Set([...`${schedule}\n${taskList}\n${workmode}`.matchAll(/name:\s*"([A-Za-z0-9_]+)"/gu)].map((match) => match[1]));
  for (const item of extraTools) if (!actualExtraNames.has(item.toolName)) throw new Error(`extra-tool capability descriptor drift: ${item.toolName}`);
  const taskName = TASK_TOOL_CAPABILITY_DESCRIPTOR.authorityWrite ? TASK_TOOL_CAPABILITY_DESCRIPTOR.name : undefined;
  if (!taskName || channelAdapters.length === 0 || inboundEvents.length === 0) throw new Error("production descriptor extraction failed");
  return { channelAdapters, inboundEvents, builtinTools, extraTools, taskName };
}

function assertUnique(values, label) {
  const duplicate = values.find((value, index) => values.indexOf(value) !== index);
  if (duplicate !== undefined) throw new Error(`duplicate ${label}: ${duplicate}`);
}

async function readRowIds() {
  const specification = await readFile(path.join(root, "research/design/modules/distributed-runtime/specification.md"), "utf8");
  const section = specification.slice(specification.indexOf("## 八、落点矩阵"), specification.indexOf("## 九、能力矩阵"));
  return [...section.matchAll(/^\| `([a-z0-9-]+)` \|/gmu)].map((match) => match[1]);
}

async function validateDueDocuments() {
  const documents = [];
  for (const [relative, requiredFact] of dueDocuments) {
    const content = await readFile(path.join(root, relative), "utf8");
    if (!content.includes(requiredFact)) throw new Error(`${relative}: missing current S7 contract fact ${requiredFact}`);
    documents.push({ path: relative, status: "verified-current" });
  }
  return documents;
}

function coverageEntry(key, category, detail) {
  return { ...detail, key, category };
}

export async function captureS7EntryCoverage() {
  const rpc = captureBuiltinRegistryDescriptor();
  const cli = collectCliCommands();
  const slash = await collectSlashCommands();
  const cleanup = await collectCleanupRegistrations();
  const constants = await collectProductionConstants();
  const entries = [
    ...rpc.map((item) => coverageEntry(`rpc:${item.name}`, "rpc", item)),
    ...cli.map((item) => coverageEntry(`cli:${item.path}`, "cli", item)),
    ...slash.map((item) => coverageEntry(`slash:${item.id}`, "slash", item)),
    coverageEntry("channel:router:InboundRouter", "channel", { source: "packages/server/src/channels/inbound-router.ts" }),
    ...constants.channelAdapters.map(({ configType, adapterType }) => coverageEntry(`channel:adapter:${adapterType}`, "channel", { configType, adapterType })),
    ...constants.inboundEvents.map((event) => coverageEntry(`channel:event:feishu:${event}`, "channel", { event })),
    ...agentLifecyclePhases.map((phase) => coverageEntry(`lifecycle:agent:${phase}`, "lifecycle", { phase })),
    ...segmentLifecyclePhases.map((phase) => coverageEntry(`lifecycle:segment:${phase}`, "lifecycle", { phase })),
    ...cleanup.map((item) => coverageEntry(`cleanup:${item.role}:${item.id}`, "cleanup", item)),
    ...constants.builtinTools.map((name) => coverageEntry(`tool:builtin:${name}`, "tool", { name })),
    ...constants.extraTools.map((item) => coverageEntry(`tool:extra:${item.key}`, "tool", item)),
    coverageEntry(`tool:orchestrator:${constants.taskName}`, "tool", { name: constants.taskName, authorityWrite: true }),
  ];
  for (const item of cleanup) {
    explicitMappings[`cleanup:${item.role}:${item.id}`] = { rowId: "shutdown" };
  }
  const rowIds = await readRowIds();
  const documents = await validateDueDocuments();
  entries.sort((left, right) => left.key.localeCompare(right.key, "en-US"));
  const result = validateCoverage({ entries, mappings: explicitMappings, rowIds });
  return {
    rowIds: [...rowIds].sort(),
    documents,
    entries: result.entries.map((entry) => ({ ...entry, target: explicitMappings[entry.key] })),
  };
}

export function validateCoverage({ entries, mappings, rowIds }) {
  const failures = [];
  if (entries.length === 0) failures.push("entry set is empty");
  const seen = new Set();
  const slashNames = new Set();
  for (const entry of entries) {
    if (!entry.key || !entry.category) failures.push(`invalid entry at ${JSON.stringify(entry)}`);
    if (seen.has(entry.key)) failures.push(`duplicate entry key: ${entry.key}`);
    seen.add(entry.key);
    if (entry.category === "slash") {
      if (entry.name === "<catalog-id>") {
        if (entry.execution !== "agent" || entry.collisionPolicy !== "builtin-first") {
          failures.push("dynamic skill commands must be agent-executed with builtin-first collision policy");
        }
      } else if (slashNames.has(entry.name)) {
        failures.push(`duplicate slash command name: ${entry.name}`);
      } else {
        slashNames.add(entry.name);
      }
    }
    const target = mappings[entry.key];
    if (!target) {
      failures.push(`unmapped entry: ${entry.key}`);
      continue;
    }
    if (Array.isArray(target) || (Boolean(target.rowId) === Boolean(target.exclusion))) {
      failures.push(`entry must have exactly one target: ${entry.key}`);
    } else if (target.rowId && !rowIds.includes(target.rowId)) {
      failures.push(`unknown rowId ${target.rowId}: ${entry.key}`);
    } else if (target.exclusion && (!exclusions[target.exclusion] || !target.reason?.trim())) {
      failures.push(`invalid exclusion: ${entry.key}`);
    }
    if (entry.category === "cli" && target.rowId && !entry.hasAction) {
      failures.push(`mapped CLI command has no action: ${entry.key}`);
    }
  }
  for (const key of Object.keys(mappings)) if (!seen.has(key)) failures.push(`stale mapping: ${key}`);
  const sorted = [...entries].sort((left, right) => left.key.localeCompare(right.key, "en-US"));
  if (entries.some((entry, index) => entry.key !== sorted[index]?.key)) failures.push("entries are not stably sorted");
  if (failures.length > 0) throw new Error(`S7 entry coverage failed:\n- ${failures.join("\n- ")}`);
  return { entries: sorted };
}

async function productionTypeScriptFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "__tests__" || entry.name === "test-support" || entry.name === "dist") continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await productionTypeScriptFiles(absolute));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) result.push(absolute);
  }
  return result;
}

export async function validateS7Structure() {
  const files = await productionTypeScriptFiles(path.join(root, "packages"));
  const failures = [];
  for (const absolute of files) {
    const relative = path.relative(root, absolute).replaceAll("\\", "/");
    const text = await readFile(absolute, "utf8");
    failures.push(...inspectProductionSource(relative, text));
  }
  const deliveryIndex = await readFile(path.join(root, "packages/core/src/delivery/index.ts"), "utf8");
  if (!deliveryIndex.includes("AuthorityDeliveryPipeline") || !deliveryIndex.includes("AuthorityDeliveryQueue")) {
    failures.push("current authority delivery entry was removed");
  }
  if (failures.length > 0) throw new Error(`S7 structure gate failed:\n- ${failures.join("\n- ")}`);
}

export function inspectProductionSource(relative, text) {
  const failures = [];
  for (const token of retiredProductionTokens) if (text.includes(token)) failures.push(`${relative}: retired token ${token}`);
  const guarded = guardedRoots.some((prefix) => relative.startsWith(prefix));
  const dependencyGuarded = relative.startsWith("packages/server/") || relative.startsWith("packages/executor/");
  const rpcGuarded =
    relative.startsWith("packages/cli/src/runtime/rpc-") ||
    relative === "packages/cli/src/runtime/core-host-connection.ts";
  if (!guarded && !dependencyGuarded && !rpcGuarded) return failures;
  const source = ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true);
  const visit = (node) => {
    if (guarded && ts.isImportDeclaration(node) && node.importClause) {
      const names = [];
      if (node.importClause.name) names.push(node.importClause.name.text);
      if (node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
        names.push(...node.importClause.namedBindings.elements.map((element) => element.name.text));
      }
      for (const name of names) if (forbiddenWriteOwners.has(name)) failures.push(`${relative}: forbidden writable owner import ${name}`);
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text;
      if (relative.startsWith("packages/server/") && specifier.includes("@zhixing/executor")) failures.push(`${relative}: server imports executor`);
      if (relative.startsWith("packages/executor/") && specifier.includes("@zhixing/server")) failures.push(`${relative}: executor imports server`);
    }
    if (
      rpcGuarded &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === "request" || node.expression.name.text === "requestWithReconnect")
    ) {
      const method = node.arguments[0];
      if (method && ts.isStringLiteralLike(method) && !builtinRpcNames.has(method.text)) {
        failures.push(`${relative}: CLI forwards to unknown RPC ${method.text}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return failures;
}

export async function runS7Lint() {
  await captureS7EntryCoverage();
  await validateS7Structure();
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await runS7Lint();
}
