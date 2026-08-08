import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FEISHU_INBOUND_EVENT_NAMES } from "../packages/channels/feishu/src/adapter.ts";
import { SKILL_COMMAND_SOURCE_DESCRIPTOR } from "../packages/cli/src/commands/skill-command-source.ts";
import { captureCliCommandDescriptor } from "../packages/cli/src/index.ts";
import { captureChannelAdapterFactoryDescriptor } from "../packages/cli/src/serve/channels.ts";
import { planServeTopology } from "../packages/cli/src/serve/role-topology.ts";
import { SEGMENT_TRANSITION_HOOK_PHASES } from "../packages/core/src/context/segment/types.ts";
import { AGENT_RUNTIME_LIFECYCLE_PHASES } from "../packages/orchestrator/src/runtime/lifecycle.ts";
import { TASK_TOOL_CAPABILITY_DESCRIPTOR } from "../packages/orchestrator/src/tools/task.ts";
import {
  BUILTIN_EXTRA_TOOL_CAPABILITIES,
  createBuiltinExtraToolsAssembly,
} from "../packages/runtime-host/src/builtin-extra-tools.ts";
import { InboundRouter } from "../packages/server/src/channels/inbound-router.ts";
import { captureBuiltinRegistryDescriptor } from "../packages/server/src/rpc/methods/index.ts";
import {
  BUILTIN_TOOL_CAPABILITIES,
  BUILTIN_TOOL_FACTORIES,
} from "../packages/tools-builtin/src/factories.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(new URL("../packages/core/package.json", import.meta.url));
const ts = require("typescript");

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
const guardedRoots = [
  "packages/server/",
  "packages/executor/",
  "packages/runtime-host/",
  "packages/orchestrator/",
  "packages/tools-builtin/",
];

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

const baseMappingTuples = [
  ...coverageGroups.flatMap(([rowId, keys]) =>
    keys.map((key) => [key, { rowId }]),
  ),
  ["rpc:auth", { exclusion: "connection", reason: exclusions.connection }],
  ["rpc:health", { exclusion: "connection", reason: exclusions.connection }],
  ["cli:zhixing", { exclusion: "composition", reason: exclusions.composition }],
  [
    "cli:zhixing workspace",
    { exclusion: "composition", reason: exclusions.composition },
  ],
  ["cli:zhixing serve", { exclusion: "composition", reason: exclusions.composition }],
  [
    "cli:zhixing serve logs",
    { exclusion: "diagnostic", reason: exclusions.diagnostic },
  ],
  ["slash:help:repl", { exclusion: "localRender", reason: exclusions.localRender }],
  ["slash:model:repl", { exclusion: "localRender", reason: exclusions.localRender }],
];

function literalProperty(object, name) {
  const property = object.properties.find(
    (candidate) => ts.isPropertyAssignment(candidate) && candidate.name.getText().replaceAll(/["']/g, "") === name,
  );
  return property && ts.isStringLiteralLike(property.initializer) ? property.initializer.text : undefined;
}

function sourceFile(relative, text) {
  return ts.createSourceFile(relative, text, ts.ScriptTarget.Latest, true);
}

function resolveRelativeTypeScript(importer, specifier) {
  if (!specifier.startsWith(".")) return undefined;
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(importer), specifier),
  );
  return resolved.replace(/\.(?:mjs|cjs|js)$/u, ".ts");
}

export function discoverSlashRegistrars(replText) {
  const relative = "packages/cli/src/repl.ts";
  const source = sourceFile(relative, replText);
  const imports = new Map();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) continue;
    const importedSource = resolveRelativeTypeScript(
      relative,
      statement.moduleSpecifier.text,
    );
    if (!importedSource) continue;
    for (const element of statement.importClause.namedBindings.elements) {
      imports.set(element.name.text, {
        functionName: element.propertyName?.text ?? element.name.text,
        source: importedSource,
      });
    }
  }
  const registrars = [];
  let dynamicSkillRegistered = false;
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      if (
        ts.isIdentifier(node.expression) &&
        imports.has(node.expression.text) &&
        node.arguments[0] &&
        ts.isObjectLiteralExpression(node.arguments[0]) &&
        node.arguments[0].properties.some(
          (property) =>
            ts.isPropertyAssignment(property) &&
            property.name.getText().replaceAll(/["']/gu, "") === "registry",
        )
      ) {
        registrars.push(imports.get(node.expression.text));
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "registerDynamicSource" &&
        node.arguments[0] &&
        ts.isNewExpression(node.arguments[0]) &&
        ts.isIdentifier(node.arguments[0].expression) &&
        node.arguments[0].expression.text === "SkillCommandSource"
      ) dynamicSkillRegistered = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assertUnique(
    registrars.map((item) => `${item.source}:${item.functionName}`),
    "slash registrar",
  );
  if (!dynamicSkillRegistered) {
    throw new Error("dynamic SkillCommandSource is not registered by the production REPL");
  }
  return registrars;
}

export function collectSlashCommandsFromRegistrar(
  relative,
  text,
  functionName,
) {
  const source = sourceFile(relative, text);
  const declaration = source.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === functionName,
  );
  if (!declaration?.body) {
    throw new Error(`${relative}: missing production slash registrar ${functionName}`);
  }
  const commands = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "register" &&
      node.arguments[0] &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      const id = literalProperty(node.arguments[0], "id");
      const name = literalProperty(node.arguments[0], "name");
      const execution = literalProperty(node.arguments[0], "execution");
      if (!id || !name || !execution) {
        throw new Error(`${relative}:${functionName}: non-literal command descriptor`);
      }
      commands.push({ id, name, execution, source: relative, registrar: functionName });
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.body);
  if (commands.length === 0) {
    throw new Error(`${relative}:${functionName}: empty production slash registrar`);
  }
  return commands;
}

async function collectSlashCommands() {
  const repl = await readFile(path.join(root, "packages/cli/src/repl.ts"), "utf8");
  const registrars = discoverSlashRegistrars(repl);
  const commands = [];
  for (const registrar of registrars) {
    const text = await readFile(path.join(root, registrar.source), "utf8");
    commands.push(
      ...collectSlashCommandsFromRegistrar(
        registrar.source,
        text,
        registrar.functionName,
      ),
    );
  }
  commands.push({
    id: SKILL_COMMAND_SOURCE_DESCRIPTOR.entryId,
    name: SKILL_COMMAND_SOURCE_DESCRIPTOR.name,
    execution: SKILL_COMMAND_SOURCE_DESCRIPTOR.execution,
    source: "packages/cli/src/commands/skill-command-source.ts",
    collisionPolicy: SKILL_COMMAND_SOURCE_DESCRIPTOR.collisionPolicy,
  });
  assertUnique(commands.map((item) => item.id), "slash command id");
  return commands.sort((left, right) => left.id.localeCompare(right.id, "en-US"));
}

export function collectCleanupRegistrationsFromSource(relative, text) {
  const source = sourceFile(relative, text);
  const helperNames = new Set();
  const cleanupTypeNames = new Set();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings)
    ) continue;
    for (const element of statement.importClause.namedBindings.elements) {
      const importedName = element.propertyName?.text ?? element.name.text;
      if (importedName === "CleanupRegistry") cleanupTypeNames.add(element.name.text);
      if (importedName === "registerCleanup") {
        helperNames.add(element.name.text);
      }
    }
  }
  const cleanupNames = new Set();
  const cleanupPropertyNames = new Set();
  const aliases = [];
  const hasCleanupType = (type) =>
    type && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) &&
    cleanupTypeNames.has(type.typeName.text);
  const collectOwners = (node) => {
    if (
      (ts.isParameter(node) || ts.isPropertySignature(node) ||
        ts.isPropertyDeclaration(node)) &&
      ts.isIdentifier(node.name) &&
      hasCleanupType(node.type)
    ) {
      if (ts.isParameter(node)) cleanupNames.add(node.name.text);
      else cleanupPropertyNames.add(node.name.text);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (
        hasCleanupType(node.type) ||
        (node.initializer && ts.isNewExpression(node.initializer) &&
          ts.isIdentifier(node.initializer.expression) &&
          cleanupTypeNames.has(node.initializer.expression.text))
      ) cleanupNames.add(node.name.text);
      if (node.initializer) aliases.push({ name: node.name.text, initializer: node.initializer });
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      helperNames.has(node.expression.text) &&
      node.arguments[0] &&
      ts.isIdentifier(node.arguments[0])
    ) cleanupNames.add(node.arguments[0].text);
    ts.forEachChild(node, collectOwners);
  };
  collectOwners(source);
  const isCleanupExpression = (expression) =>
    (ts.isIdentifier(expression) && cleanupNames.has(expression.text)) ||
    (ts.isPropertyAccessExpression(expression) &&
      cleanupPropertyNames.has(expression.name.text));
  let changed = true;
  while (changed) {
    changed = false;
    for (const alias of aliases) {
      if (!cleanupNames.has(alias.name) && isCleanupExpression(alias.initializer)) {
        cleanupNames.add(alias.name);
        changed = true;
      }
    }
  }
  const result = [];
  const failures = [];
  const cleanupOwners = new Set([
    "anchor-host",
    "anchor-local-executor",
    "standalone-server",
  ]);
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      if (
        ts.isIdentifier(node.expression) &&
        helperNames.has(node.expression.text)
      ) {
        const descriptor = node.arguments[1];
        if (!descriptor || !ts.isObjectLiteralExpression(descriptor)) {
          failures.push(`${relative}: cleanup descriptor must be an object literal`);
        } else {
          const owner = literalProperty(descriptor, "owner");
          const role = literalProperty(descriptor, "role");
          const id = literalProperty(descriptor, "id");
          if (!owner || !role || !id) {
            failures.push(`${relative}: cleanup descriptor owner/role/id must be literal`);
          } else if (!cleanupOwners.has(owner)) {
            failures.push(`${relative}: unknown cleanup owner ${owner}`);
          } else {
            result.push({ owner, role, id, source: relative });
          }
        }
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "register" &&
        isCleanupExpression(node.expression.expression)
      ) {
        failures.push(
          `${relative}: direct register call bypasses registerCleanup descriptor`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (failures.length > 0) throw new Error(failures.join("\n"));
  return result;
}

async function collectCleanupRegistrations() {
  const files = await productionTypeScriptFiles(path.join(root, "packages"));
  const result = [];
  for (const absolute of files) {
    const relative = path.relative(root, absolute).replaceAll("\\", "/");
    result.push(
      ...collectCleanupRegistrationsFromSource(
        relative,
        await readFile(absolute, "utf8"),
      ),
    );
  }
  assertUnique(result.map((item) => `${item.owner}:${item.role}:${item.id}`), "cleanup descriptor");
  if (result.length === 0) throw new Error("cleanup descriptor set is empty");
  return result.sort((left, right) =>
    `${left.owner}:${left.role}:${left.id}`.localeCompare(
      `${right.owner}:${right.role}:${right.id}`,
      "en-US",
    ),
  );
}

function collectCliCommands() {
  return [...captureCliCommandDescriptor()];
}

export function validateInboundRouterAssembly(text) {
  const source = sourceFile("packages/cli/src/serve/channels.ts", text);
  let count = 0;
  const visit = (node) => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === InboundRouter.entryDescriptor.name
    ) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (count !== 1) {
    throw new Error(`InboundRouter production assembly count must be 1, got ${count}`);
  }
}

async function collectProductionConstants() {
  validateInboundRouterAssembly(
    await readFile(path.join(root, "packages/cli/src/serve/channels.ts"), "utf8"),
  );
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
  const inert = new Proxy(() => undefined, {
    get: () => inert,
    apply: () => undefined,
  });
  const assembly = createBuiltinExtraToolsAssembly(
    inert,
    { catalog: () => [], callTool: inert },
  );
  const assembledNames = (kind) =>
    new Set(
      assembly.assembleTools({
        scheduler: () => inert,
        worksceneDirectory: () => inert,
        spec: kind === "main"
          ? { kind: "main" }
          : { kind: "workscene", sceneId: "coverage", sceneName: "coverage" },
      }).map((tool) => tool.name),
    );
  const nonAuthorityNames = new Set(["workscene_list", "workscene_memory_query"]);
  for (const kind of ["main", "workscene"]) {
    const actual = [...assembledNames(kind)]
      .filter((name) => !nonAuthorityNames.has(name))
      .sort();
    const expected = [...new Set(
      extraTools
        .filter((item) => item.runtimeKinds.includes(kind))
        .map((item) => item.toolName),
    )].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `extra-tool ${kind} assembly drift: expected ${expected.join(",")}, got ${actual.join(",")}`,
      );
    }
  }
  const taskName = TASK_TOOL_CAPABILITY_DESCRIPTOR.authorityWrite ? TASK_TOOL_CAPABILITY_DESCRIPTOR.name : undefined;
  if (!taskName || channelAdapters.length === 0 || inboundEvents.length === 0) throw new Error("production descriptor extraction failed");
  return { channelAdapters, inboundEvents, builtinTools, extraTools, taskName };
}

function assertUnique(values, label) {
  const duplicate = values.find((value, index) => values.indexOf(value) !== index);
  if (duplicate !== undefined) throw new Error(`duplicate ${label}: ${duplicate}`);
}

export function parseLandingRowIds(specification) {
  const start = specification.indexOf("## 八、落点矩阵");
  const end = specification.indexOf("## 九、能力矩阵", start);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("distributed runtime specification: landing matrix section missing");
  }
  const lines = specification.slice(start, end).split(/\r?\n/u);
  const headerIndex = lines.findIndex((line) =>
    /^\|\s*rowId\s*\|\s*操作\s*\|\s*现有入口\s*\|/u.test(line),
  );
  if (headerIndex < 0 || !/^\|(?:\s*:?-+:?\s*\|){6}$/u.test(lines[headerIndex + 1] ?? "")) {
    throw new Error("distributed runtime specification: invalid landing matrix header");
  }
  const rowIds = [];
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.startsWith("|")) break;
    const cells = line.slice(1, -1).split("|").map((cell) => cell.trim());
    if (cells.length !== 6) {
      throw new Error(`distributed runtime specification: invalid landing row schema: ${line}`);
    }
    const match = /^`([a-z0-9]+(?:-[a-z0-9]+)*)`$/u.exec(cells[0]);
    if (!match) {
      throw new Error(`distributed runtime specification: invalid rowId: ${cells[0]}`);
    }
    rowIds.push(match[1]);
  }
  if (rowIds.length === 0) throw new Error("landing matrix row set is empty");
  assertUnique(rowIds, "landing matrix rowId");
  return rowIds;
}

async function readRowIds() {
  const specification = await readFile(
    path.join(root, "research/design/modules/distributed-runtime/specification.md"),
    "utf8",
  );
  return parseLandingRowIds(specification);
}

async function validateDueDocuments() {
  const documents = [];
  for (const [relative, requiredFact] of dueDocuments) {
    const content = await readFile(path.join(root, relative), "utf8");
    if (!content.includes(requiredFact)) throw new Error(`${relative}: missing current S7 contract fact ${requiredFact}`);
    if (relative === "research/design/drafts/scheduler-architecture.md") {
      validateSchedulerCurrentArchitecture(content);
    }
    documents.push({ path: relative, status: "verified-current" });
  }
  return documents;
}

export function validateSchedulerCurrentArchitecture(content) {
  const start = content.indexOf("## 当前生产架构（S7 第 26 单元）");
  const end = content.indexOf("\n---", start);
  if (start < 0 || end < 0) throw new Error("scheduler current architecture section missing");
  const current = content.slice(start, end);
  for (const fact of [
    "AuthorityDelivery",
    "唯一生产链",
    "已整体退役",
    "生产装配与公开入口均不存在",
  ]) {
    if (!current.includes(fact)) {
      throw new Error(`scheduler current architecture missing retirement fact: ${fact}`);
    }
  }
  for (const stale of ["只允许一次性排空迁移", "排空后删除"]) {
    if (current.includes(stale)) {
      throw new Error(`scheduler current architecture retains stale migration wording: ${stale}`);
    }
  }
}

function coverageEntry(key, category, detail) {
  return { ...detail, key, category };
}

const serveRoleConfigurations = {
  "anchor-executor": ["anchor", "executor"],
  "anchor-executor-surface": ["anchor", "executor", "surface"],
  "anchor-only": ["anchor"],
  "anchor-surface": ["anchor", "surface"],
  "executor-only": ["executor"],
  "executor-surface": ["executor", "surface"],
  "disabled-empty": [],
  "surface-only": ["surface"],
};

function entryAppliesToRoles(entry, roles) {
  const plan = planServeTopology({ roles });
  if (entry.category === "rpc" || entry.category === "channel") {
    return plan.host === "anchor-host";
  }
  if (entry.category === "lifecycle" || entry.category === "tool") {
    return plan.loadExecutor;
  }
  if (entry.category === "cleanup") {
    return plan.activeCleanupOwners.includes(entry.owner);
  }
  return true;
}

export function buildServeRoleConfigurations(entries) {
  return Object.fromEntries(
    Object.entries(serveRoleConfigurations).map(([name, roles]) => {
      const plan = planServeTopology({ roles });
      return [
        name,
        {
          roles,
          topology: plan.host,
          activeCleanupOwners: plan.activeCleanupOwners,
          entryKeys: entries
            .filter((entry) => entryAppliesToRoles(entry, roles))
            .map((entry) => entry.key),
        },
      ];
    }),
  );
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
    coverageEntry(
      `channel:router:${InboundRouter.entryDescriptor.name}`,
      "channel",
      {
        source: "packages/server/src/channels/inbound-router.ts",
        name: InboundRouter.entryDescriptor.name,
      },
    ),
    ...constants.channelAdapters.map(({ configType, adapterType }) => coverageEntry(`channel:adapter:${adapterType}`, "channel", { configType, adapterType })),
    ...constants.inboundEvents.map((event) => coverageEntry(`channel:event:feishu:${event}`, "channel", { event })),
    ...agentLifecyclePhases.map((phase) => coverageEntry(`lifecycle:agent:${phase}`, "lifecycle", { phase })),
    ...segmentLifecyclePhases.map((phase) => coverageEntry(`lifecycle:segment:${phase}`, "lifecycle", { phase })),
    ...cleanup.map((item) => coverageEntry(`cleanup:${item.owner}:${item.role}:${item.id}`, "cleanup", item)),
    ...constants.builtinTools.map((name) => coverageEntry(`tool:builtin:${name}`, "tool", { name })),
    ...constants.extraTools.map((item) => coverageEntry(`tool:extra:${item.key}`, "tool", item)),
    coverageEntry(`tool:orchestrator:${constants.taskName}`, "tool", { name: constants.taskName, authorityWrite: true }),
  ];
  const mappingTuples = [
    ...baseMappingTuples,
    ...cleanup.map((item) => [
      `cleanup:${item.owner}:${item.role}:${item.id}`,
      { rowId: "shutdown" },
    ]),
  ];
  const rowIds = await readRowIds();
  const documents = await validateDueDocuments();
  entries.sort((left, right) => left.key.localeCompare(right.key, "en-US"));
  const result = validateCoverage({ entries, mappings: mappingTuples, rowIds });
  const roleConfigurations = buildServeRoleConfigurations(result.entries);
  return {
    rowIds: [...rowIds].sort(),
    documents,
    roleConfigurations,
    entries: result.entries.map((entry) => ({
      ...entry,
      target: result.mappingIndex.get(entry.key),
    })),
  };
}

export function validateCoverage({ entries, mappings, rowIds }) {
  const failures = [];
  const mappingTuples = Array.isArray(mappings)
    ? mappings
    : Object.entries(mappings);
  const mappingIndex = new Map();
  for (const tuple of mappingTuples) {
    if (!Array.isArray(tuple) || tuple.length !== 2 || typeof tuple[0] !== "string") {
      failures.push(`invalid mapping tuple: ${JSON.stringify(tuple)}`);
      continue;
    }
    const [key, target] = tuple;
    if (mappingIndex.has(key)) {
      failures.push(`duplicate mapping target: ${key}`);
      continue;
    }
    mappingIndex.set(key, target);
  }
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
    const target = mappingIndex.get(entry.key);
    if (!target) {
      failures.push(`unmapped entry: ${entry.key}`);
      continue;
    }
    const targetKeys = target && typeof target === "object" && !Array.isArray(target)
      ? Object.keys(target).sort()
      : [];
    if (Array.isArray(target) || (Boolean(target.rowId) === Boolean(target.exclusion))) {
      failures.push(`entry must have exactly one target: ${entry.key}`);
    } else if (target.rowId) {
      if (JSON.stringify(targetKeys) !== JSON.stringify(["rowId"])) {
        failures.push(`invalid row target schema: ${entry.key}`);
      } else if (!rowIds.includes(target.rowId)) {
        failures.push(`unknown rowId ${target.rowId}: ${entry.key}`);
      }
    } else if (
      JSON.stringify(targetKeys) !== JSON.stringify(["exclusion", "reason"]) ||
      !exclusions[target.exclusion] ||
      target.reason !== exclusions[target.exclusion]
    ) {
      failures.push(`invalid exclusion: ${entry.key}`);
    }
    if (entry.category === "cli" && target.rowId && !entry.hasAction) {
      failures.push(`mapped CLI command has no action: ${entry.key}`);
    }
  }
  for (const key of mappingIndex.keys()) {
    if (!seen.has(key)) failures.push(`stale mapping: ${key}`);
  }
  const sorted = [...entries].sort((left, right) => left.key.localeCompare(right.key, "en-US"));
  if (entries.some((entry, index) => entry.key !== sorted[index]?.key)) failures.push("entries are not stably sorted");
  if (failures.length > 0) throw new Error(`S7 entry coverage failed:\n- ${failures.join("\n- ")}`);
  return { entries: sorted, mappingIndex };
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
  const records = await Promise.all(files.map(async (absolute) => ({
    absolute,
    relative: path.relative(root, absolute).replaceAll("\\", "/"),
    text: await readFile(absolute, "utf8"),
  })));
  const resolveOwnerExposure = await buildWorkspaceOwnerExposure(records);
  const resolveRpcExposure = await buildWorkspaceSymbolExposure(
    records,
    rawRpcSymbols,
  );
  const failures = [];
  for (const record of records) {
    failures.push(...inspectProductionSource(
      record.relative,
      record.text,
      { resolveOwnerExposure, resolveRpcExposure },
    ));
  }
  failures.push(...await inspectCleanupRegistryConstructions(records));
  failures.push(...inspectLocalConversationOwnerIsolation(records));
  failures.push(...inspectConversationAdoptionAssembly(records));
  for (const packageName of [
    "server",
    "executor",
    "runtime-host",
    "orchestrator",
    "tools-builtin",
  ]) {
    const relative = `packages/${packageName}/package.json`;
    failures.push(...inspectProductionManifest(
      relative,
      JSON.parse(await readFile(path.join(root, relative), "utf8")),
    ));
  }
  const deliveryIndex = await readFile(path.join(root, "packages/core/src/delivery/index.ts"), "utf8");
  if (!deliveryIndex.includes("AuthorityDeliveryPipeline") || !deliveryIndex.includes("AuthorityDeliveryQueue")) {
    failures.push("current authority delivery entry was removed");
  }
  if (failures.length > 0) throw new Error(`S7 structure gate failed:\n- ${failures.join("\n- ")}`);
}

export function inspectLocalConversationOwnerIsolation(records) {
  const failures = [];
  const runtimeRecord = records.find(
    ({ relative }) => relative === "packages/cli/src/serve/conversation-owner-runtime.ts",
  );
  const assemblyRecord = records.find(
    ({ relative }) => relative === "packages/cli/src/serve/local-conversation-owner.ts",
  );
  if (!runtimeRecord || !assemblyRecord) {
    return ["local conversation owner isolation sources are missing"];
  }

  const runtimeSource = sourceFile(runtimeRecord.relative, runtimeRecord.text);
  const localRuntime = runtimeSource.statements.find(
    (node) => ts.isInterfaceDeclaration(node) &&
      node.name.text === "LocalConversationOwnerRuntimeStack",
  );
  if (!localRuntime) {
    failures.push(`${runtimeRecord.relative}: local owner runtime contract is missing`);
  } else {
    const properties = new Map(
      localRuntime.members
        .filter((member) => ts.isPropertySignature(member) && ts.isIdentifier(member.name))
        .map((member) => [member.name.text, member]),
    );
    for (const capability of ["surfaceAssets", "delivery", "participant", "globalState"]) {
      if (properties.get(capability)?.type?.kind !== ts.SyntaxKind.NeverKeyword) {
        failures.push(
          `${runtimeRecord.relative}: local owner capability ${capability} must remain never`,
        );
      }
    }
    const globalPublishing = properties.get("globalPublishing")?.type;
    if (
      !globalPublishing ||
      !ts.isLiteralTypeNode(globalPublishing) ||
      globalPublishing.literal.kind !== ts.SyntaxKind.FalseKeyword
    ) {
      failures.push(
        `${runtimeRecord.relative}: local owner globalPublishing must remain false`,
      );
    }
  }

  const assemblySource = sourceFile(assemblyRecord.relative, assemblyRecord.text);
  const ownerPort = assemblySource.statements.find(
    (node) => ts.isInterfaceDeclaration(node) &&
      node.name.text === "LocalConversationOwnerPort",
  );
  const sessionReadPort = assemblySource.statements.find(
    (node) => ts.isTypeAliasDeclaration(node) &&
      node.name.text === "LocalConversationSessionReadPort",
  );
  if (!ownerPort || !sessionReadPort) {
    failures.push(`${assemblyRecord.relative}: narrowed local owner port contract is missing`);
  } else {
    const allowedPortCapabilities = new Set([
      "admitTurn",
      "answerInteractionWithTicket",
      "cancelTurns",
      "createConversation",
      "deferSchedule",
      "discardDeferredIntent",
      "ensureSession",
      "finalHistory",
      "listConversations",
      "listConversationAuthorities",
      "listDeferredIntents",
      "mutateSession",
      "pendingInteractions",
      "resolveNoInteractiveSurface",
      "rubricCatalog",
      "runTurn",
      "sessionState",
      "statusHistory",
      "currentAuthority",
    ]);
    for (const member of ownerPort.members) {
      if (
        !(ts.isPropertySignature(member) || ts.isMethodSignature(member)) ||
        !ts.isIdentifier(member.name)
      ) {
        continue;
      }
      const name = member.name.text;
      if (["advancement", "consumer", "manager", "protocol"].includes(name)) {
        failures.push(`${assemblyRecord.relative}: local owner port must not expose raw ${name}`);
      } else if (!allowedPortCapabilities.has(name)) {
        failures.push(`${assemblyRecord.relative}: local owner port has unlisted capability ${name}`);
      }
    }
    const frozenReads = new Set([
      "readAdvancementState",
      "readSessionMeta",
      "readTaskList",
      "readTranscriptTail",
    ]);
    const selected = new Set();
    const collect = (node) => {
      if (ts.isLiteralTypeNode(node) && ts.isStringLiteralLike(node.literal)) {
        selected.add(node.literal.text);
      }
      ts.forEachChild(node, collect);
    };
    collect(sessionReadPort.type);
    if (
      selected.size !== frozenReads.size ||
      [...selected].some((name) => !frozenReads.has(name))
    ) {
      failures.push(`${assemblyRecord.relative}: local owner port sessionState must expose only the frozen read set`);
    }
  }
  const assemblyOptions = assemblySource.statements.find(
    (node) => ts.isInterfaceDeclaration(node) &&
      node.name.text === "LocalConversationOwnerAssemblyOptions",
  );
  if (!assemblyOptions) {
    failures.push(`${assemblyRecord.relative}: local owner assembly contract is missing`);
  } else {
    const properties = new Map(
      assemblyOptions.members
        .filter((member) => ts.isPropertySignature(member) && ts.isIdentifier(member.name))
        .map((member) => [member.name.text, member]),
    );
    const owner = properties.get("owner")?.type;
    if (
      !owner ||
      !ts.isTypeReferenceNode(owner) ||
      !ts.isIdentifier(owner.typeName) ||
      owner.typeName.text !== "LocalConversationOwnerRuntimeStack"
    ) {
      failures.push(
        `${assemblyRecord.relative}: assembly must receive the narrowed local owner contract`,
      );
    }
    if (properties.has("authority")) {
      failures.push(
        `${assemblyRecord.relative}: assembly cannot receive the anchor authority stack`,
      );
    }
  }

  const forbiddenAssemblySymbols = new Set([
    "AuthorityRuntimeStack",
    "GlobalStatePort",
    "DeferredGlobalIntentPort",
    "GlobalMutationCommitCoordinator",
    "GlobalMutationCommitParticipant",
    "ConversationDeliveryParticipant",
    "SurfaceAssetCoordinator",
    "MemoryStore",
    "SkillStore",
    "AnchorWorksceneRegistry",
  ]);
  const visitAssembly = (node) => {
    if (ts.isIdentifier(node) && forbiddenAssemblySymbols.has(node.text)) {
      failures.push(`${assemblyRecord.relative}: local assembly references forbidden capability ${node.text}`);
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ["bindMutationPublisher", "bindDeliveryDrain"].includes(node.name.text)
    ) {
      failures.push(`${assemblyRecord.relative}: local assembly calls forbidden protocol binder ${node.name.text}`);
    }
    ts.forEachChild(node, visitAssembly);
  };
  visitAssembly(assemblySource);

  let localIntentRepository;
  let localIntentRepositoryCount = 0;
  const intentConsumers = new Map([
    ["DeferredScheduleIntentProducer", 0],
    ["DeferredRubricPublication", 0],
  ]);
  const visitIntentAssembly = (node) => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "DeferredGlobalIntentRepository"
    ) {
      localIntentRepositoryCount += 1;
      if (
        ts.isVariableDeclaration(node.parent) &&
        ts.isIdentifier(node.parent.name) &&
        node.parent.initializer === node
      ) {
        localIntentRepository = node.parent.name.text;
      }
      const options = node.arguments?.[0];
      const mode = options && ts.isObjectLiteralExpression(options)
        ? options.properties.find((property) =>
            ts.isPropertyAssignment(property) && propertyNameText(property.name) === "mode"
          )
        : undefined;
      if (
        !mode || !ts.isPropertyAssignment(mode) ||
        !ts.isStringLiteralLike(mode.initializer) || mode.initializer.text !== "local"
      ) {
        failures.push(`${assemblyRecord.relative}: local intent repository must use local mode`);
      }
      if (options && ts.isObjectLiteralExpression(options)) {
        const requiredBindings = new Map([
          ["ownerEpoch", "owner.ownerEpoch"],
          ["conversationAuthority", "protocol.deferredIntentAuthority"],
        ]);
        for (const [name, expected] of requiredBindings) {
          const property = options.properties.find((candidate) =>
            ts.isPropertyAssignment(candidate) && propertyNameText(candidate.name) === name
          );
          if (
            !property || !ts.isPropertyAssignment(property) ||
            property.initializer.getText(assemblySource) !== expected
          ) {
            failures.push(`${assemblyRecord.relative}: local intent repository ${name} must bind ${expected}`);
          }
        }
      }
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      intentConsumers.has(node.expression.text)
    ) {
      const options = node.arguments?.[0];
      const intentProperty = options && ts.isObjectLiteralExpression(options)
        ? options.properties.find((property) =>
            property.name && propertyNameText(property.name) === "intents"
          )
        : undefined;
      const initializer = intentProperty && ts.isShorthandPropertyAssignment(intentProperty)
        ? intentProperty.name
        : intentProperty && ts.isPropertyAssignment(intentProperty)
          ? intentProperty.initializer
          : undefined;
      if (
        !initializer || !ts.isIdentifier(initializer) ||
        initializer.text !== localIntentRepository
      ) {
        failures.push(`${assemblyRecord.relative}: ${node.expression.text} must share the single local intent repository`);
      }
      intentConsumers.set(node.expression.text, intentConsumers.get(node.expression.text) + 1);
    }
    ts.forEachChild(node, visitIntentAssembly);
  };
  visitIntentAssembly(assemblySource);
  if (localIntentRepositoryCount !== 1 || !localIntentRepository) {
    failures.push(`${assemblyRecord.relative}: expected exactly one bound local intent repository`);
  }
  for (const [consumer, count] of intentConsumers) {
    if (count !== 1) {
      failures.push(`${assemblyRecord.relative}: expected exactly one ${consumer}, got ${count}`);
    }
  }

  const anchorIntentRecord = records.find(
    ({ relative }) => relative === "packages/cli/src/serve/anchor-scheduler-runtime.ts",
  );
  if (!anchorIntentRecord) {
    failures.push("packages/cli/src/serve/anchor-scheduler-runtime.ts: anchor intent review source is missing");
  } else {
    const source = sourceFile(anchorIntentRecord.relative, anchorIntentRecord.text);
    let repositoryCount = 0;
    let reviewCount = 0;
    const visitAnchorIntent = (node) => {
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
        if (node.expression.text === "DeferredGlobalIntentRepository") {
          repositoryCount += 1;
          const options = node.arguments?.[0];
          const mode = options && ts.isObjectLiteralExpression(options)
            ? options.properties.find((property) =>
                ts.isPropertyAssignment(property) && propertyNameText(property.name) === "mode"
              )
            : undefined;
          if (
            !mode || !ts.isPropertyAssignment(mode) ||
            !ts.isStringLiteralLike(mode.initializer) || mode.initializer.text !== "anchor"
          ) {
            failures.push(`${anchorIntentRecord.relative}: anchor intent repository must use anchor mode`);
          }
          if (options && ts.isObjectLiteralExpression(options)) {
            const requiredBindings = new Map([
              ["ownerEpoch", "options.authority.anchorEpoch"],
              ["conversationAuthority", "options.protocol.deferredIntentAuthority"],
            ]);
            for (const [name, expected] of requiredBindings) {
              const property = options.properties.find((candidate) =>
                ts.isPropertyAssignment(candidate) && propertyNameText(candidate.name) === name
              );
              if (
                !property || !ts.isPropertyAssignment(property) ||
                property.initializer.getText(source) !== expected
              ) {
                failures.push(`${anchorIntentRecord.relative}: anchor intent repository ${name} must bind ${expected}`);
              }
            }
          }
        }
        if (node.expression.text === "DeferredGlobalIntentAnchorReviewService") {
          reviewCount += 1;
          const options = node.arguments?.[0];
          const repository = options && ts.isObjectLiteralExpression(options)
            ? options.properties.find((property) =>
                ts.isPropertyAssignment(property) && propertyNameText(property.name) === "repository"
              )
            : undefined;
          if (
            !repository || !ts.isPropertyAssignment(repository) ||
            repository.initializer.getText(source) !== "this.#intentRepository"
          ) {
            failures.push(`${anchorIntentRecord.relative}: anchor review must share the single anchor intent repository`);
          }
        }
      }
      ts.forEachChild(node, visitAnchorIntent);
    };
    visitAnchorIntent(source);
    if (repositoryCount !== 1) {
      failures.push(`${anchorIntentRecord.relative}: expected exactly one anchor intent repository, got ${repositoryCount}`);
    }
    if (reviewCount !== 1) {
      failures.push(`${anchorIntentRecord.relative}: expected exactly one anchor intent review service, got ${reviewCount}`);
    }
  }

  const protocolIntentRecord = records.find(
    ({ relative }) => relative === "packages/cli/src/serve/conversation-protocol-runtime.ts",
  );
  if (!protocolIntentRecord) {
    failures.push("packages/cli/src/serve/conversation-protocol-runtime.ts: intent authority adapter source is missing");
  } else {
    const source = sourceFile(protocolIntentRecord.relative, protocolIntentRecord.text);
    let adapterCount = 0;
    const visitAdapter = (node) => {
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        node.left.getText(source) === "this.deferredIntentAuthority"
      ) {
        adapterCount += 1;
        const binding = node.right.getText(source);
        if (
          !binding.includes("Object.freeze") ||
          !binding.includes("protocol.#journal(input.conversationId).transactDeferredIntent(input)")
        ) {
          failures.push(`${protocolIntentRecord.relative}: intent authority adapter must route the current conversation journal narrow transaction`);
        }
      }
      ts.forEachChild(node, visitAdapter);
    };
    visitAdapter(source);
    if (adapterCount !== 1) {
      failures.push(`${protocolIntentRecord.relative}: expected exactly one intent authority adapter binding, got ${adapterCount}`);
    }
  }

  const internalIntentFiles = new Set([
    "packages/cli/src/serve/local-conversation-owner.ts",
    "packages/cli/src/serve/anchor-scheduler-runtime.ts",
    "packages/cli/src/serve/conversation-protocol-runtime.ts",
  ]);
  const publicIntentTokens = new Set([
    "deferSchedule",
    "listDeferredIntents",
    "discardDeferredIntent",
    "DeferredGlobalIntentAnchorReviewService",
    "DeferredGlobalIntentRepository",
  ]);
  for (const record of records) {
    if (
      internalIntentFiles.has(record.relative) ||
      !(
        record.relative.startsWith("packages/cli/src/") ||
        record.relative.startsWith("packages/rpc/src/") ||
        record.relative.startsWith("packages/channels/")
      )
    ) {
      continue;
    }
    const source = sourceFile(record.relative, record.text);
    const visitPublicIntent = (node) => {
      if (ts.isIdentifier(node) && publicIntentTokens.has(node.text)) {
        failures.push(`${record.relative}: deferred intent capability is exposed outside its internal owner seam`);
      }
      ts.forEachChild(node, visitPublicIntent);
    };
    visitPublicIntent(source);
  }

  const frozenDependencyKeys = [
    "artifacts",
    "deviceId",
    "executorCapabilities",
    "executorId",
    "executorLog",
    "executorResourceGovernor",
    "executionAssetCatalog",
    "localControlAdmission",
    "localDomainId",
    "localGovernorEpoch",
    "localOwnerEpoch",
    "permissionSnapshotFor",
    "preflightLocalConversationEnvironment",
    "prepareLocalConversationAssignment",
    "releaseLocalConversationEnvironmentPreflight",
    "signer",
    "storageMaintenance",
    "validateConversationRuntimeBinding",
    "validateLocalConversationManifest",
    "verifier",
  ];
  const dependencyContract = runtimeSource.statements.find(
    (node) => ts.isTypeAliasDeclaration(node) &&
      node.name.text === "LocalConversationOwnerRuntimeDependencies",
  );
  if (!dependencyContract) {
    failures.push(`${runtimeRecord.relative}: local runtime dependency contract is missing`);
  } else {
    const contractKeys = new Set();
    const collectContractKeys = (node) => {
      if (ts.isLiteralTypeNode(node) && ts.isStringLiteralLike(node.literal)) {
        contractKeys.add(node.literal.text);
      }
      ts.forEachChild(node, collectContractKeys);
    };
    collectContractKeys(dependencyContract.type);
    if (
      contractKeys.size !== frozenDependencyKeys.length ||
      frozenDependencyKeys.some((key) => !contractKeys.has(key))
    ) {
      failures.push(`${runtimeRecord.relative}: local runtime dependency contract must be exactly the frozen key set`);
    }
  }

  const localRuntimeFunction = runtimeSource.statements.find(
    (node) => ts.isFunctionDeclaration(node) &&
      node.name?.text === "localConversationOwnerRuntime",
  );
  const forbiddenRuntimeProperties = new Set([
    "surfaceAssets",
    "delivery",
    "participant",
    "globalState",
  ]);
  if (!localRuntimeFunction?.body) {
    failures.push(`${runtimeRecord.relative}: local runtime constructor is missing`);
  } else {
    const parameter = localRuntimeFunction.parameters[0];
    if (
      !parameter?.type ||
      !ts.isTypeReferenceNode(parameter.type) ||
      !ts.isIdentifier(parameter.type.typeName) ||
      parameter.type.typeName.text !== "LocalConversationOwnerRuntimeDependencies"
    ) {
      failures.push(`${runtimeRecord.relative}: local runtime factory must take LocalConversationOwnerRuntimeDependencies`);
    }
    const visitRuntime = (node) => {
      if (
        ts.isReturnStatement(node) &&
        node.expression &&
        ts.isObjectLiteralExpression(node.expression)
      ) {
        for (const property of node.expression.properties) {
          if (property.name && forbiddenRuntimeProperties.has(propertyNameText(property.name))) {
            failures.push(`${runtimeRecord.relative}: local runtime constructs forbidden capability ${propertyNameText(property.name)}`);
          }
        }
      }
      ts.forEachChild(node, visitRuntime);
    };
    visitRuntime(localRuntimeFunction.body);
  }

  const productionRoots = new Set([
    "packages/cli/src/serve/access-surfaces.ts",
    "packages/cli/src/serve/executor-role-runtime.ts",
  ]);
  const dependencyOwners = new Map([
    ["packages/cli/src/serve/access-surfaces.ts", "ctx.authorityRuntime"],
    ["packages/cli/src/serve/executor-role-runtime.ts", "authority"],
  ]);
  const allowedCreateProperties = new Set([
    "owner",
    "ledger",
    "ConversationAssignmentLedger",
    "InProcessAssignmentSubmission",
    "runtimeFactory",
    "interactions",
    "config",
    "credentials",
    "evidence",
    "dataPlane",
    "closeDrainBudgetMs",
    "currentAnchorDeviceId",
  ]);
  for (const record of records.filter(({ relative }) => productionRoots.has(relative))) {
    const source = sourceFile(record.relative, record.text);
    const factoryCalls = [];
    const collectFactoryCalls = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "localConversationOwnerRuntime"
      ) {
        factoryCalls.push(node);
      }
      ts.forEachChild(node, collectFactoryCalls);
    };
    collectFactoryCalls(source);
    if (factoryCalls.length !== 1) {
      failures.push(`${record.relative}: expected exactly one local runtime construction, got ${factoryCalls.length}`);
    }
    const factoryCall = factoryCalls[0];
    let boundLocalRuntime;
    if (factoryCall) {
      const argument = factoryCall.arguments[0];
      if (!argument || !ts.isObjectLiteralExpression(argument)) {
        failures.push(`${record.relative}: local runtime construction must receive one explicit dependency object literal`);
      } else {
        const dependencyKeys = new Set();
        const dependencyOwner = dependencyOwners.get(record.relative);
        for (const property of argument.properties) {
          if (!ts.isPropertyAssignment(property) || !property.name) {
            failures.push(`${record.relative}: local runtime dependencies cannot use spread or shorthand properties`);
            continue;
          }
          const name = propertyNameText(property.name);
          if (!name || dependencyKeys.has(name) || !frozenDependencyKeys.includes(name)) {
            failures.push(`${record.relative}: local runtime construction has forbidden or duplicate dependency ${name ?? "computed"}`);
            continue;
          }
          dependencyKeys.add(name);
          const initializerOwner = ts.isPropertyAccessExpression(property.initializer)
            ? property.initializer.expression.getText(source)
            : undefined;
          const initializerName = ts.isPropertyAccessExpression(property.initializer)
            ? property.initializer.name.text
            : undefined;
          if (
            initializerOwner !== dependencyOwner ||
            initializerName !== name
          ) {
            failures.push(
              `${record.relative}: local runtime dependency ${name} must bind ${dependencyOwner}.${name}`,
            );
          }
        }
        for (const key of frozenDependencyKeys) {
          if (!dependencyKeys.has(key)) {
            failures.push(`${record.relative}: local runtime construction is missing dependency ${key}`);
          }
        }
      }
      const parent = factoryCall.parent;
      if (
        parent &&
        ts.isVariableDeclaration(parent) &&
        ts.isIdentifier(parent.name) &&
        parent.initializer === factoryCall
      ) {
        boundLocalRuntime = parent.name.text;
      }
    }
    const isSingleLocalRuntime = (node) =>
      node === factoryCall ||
      (boundLocalRuntime !== undefined &&
        ts.isIdentifier(node) &&
        node.text === boundLocalRuntime);
    let createCount = 0;
    let assemblyBinding;
    let assemblyScope;
    const visitRoot = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "LocalConversationOwnerAssembly" &&
        node.expression.name.text === "create"
      ) {
        createCount += 1;
        const awaited = node.parent && ts.isAwaitExpression(node.parent)
          ? node.parent
          : undefined;
        const bindingParent = awaited?.parent;
        if (
          bindingParent &&
          ts.isVariableDeclaration(bindingParent) &&
          ts.isIdentifier(bindingParent.name)
        ) {
          assemblyBinding = bindingParent.name.text;
        } else if (
          bindingParent &&
          ts.isBinaryExpression(bindingParent) &&
          bindingParent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(bindingParent.left)
        ) {
          assemblyBinding = bindingParent.left.text;
        } else {
          failures.push(`${record.relative}: local owner construction must bind one assembly identity`);
        }
        let scope = node.parent;
        while (scope && !(ts.isFunctionLike(scope) && scope.body)) {
          scope = scope.parent;
        }
        assemblyScope = scope?.body;
        const options = node.arguments[0];
        if (!options || !ts.isObjectLiteralExpression(options)) {
          failures.push(`${record.relative}: local owner construction must use one object literal`);
        } else {
          const properties = new Map();
          for (const property of options.properties) {
            if (!property.name || ts.isSpreadAssignment(property)) {
              failures.push(`${record.relative}: local owner construction cannot use spread or anonymous properties`);
              continue;
            }
            const name = propertyNameText(property.name);
            if (!name || properties.has(name) || !allowedCreateProperties.has(name)) {
              failures.push(`${record.relative}: local owner construction has forbidden or duplicate capability ${name ?? "computed"}`);
            }
            properties.set(name, property);
          }
          const owner = properties.get("owner");
          const initializer = owner && ts.isPropertyAssignment(owner) ? owner.initializer : undefined;
          if (!initializer || !isSingleLocalRuntime(initializer)) {
            failures.push(`${record.relative}: local owner construction must receive the single local runtime construction`);
          }
          for (const required of [
            "owner",
            "ConversationAssignmentLedger",
            "InProcessAssignmentSubmission",
            "runtimeFactory",
            "interactions",
            "config",
            "credentials",
            "evidence",
            "dataPlane",
          ]) {
            if (!properties.has(required)) {
              failures.push(`${record.relative}: local owner construction is missing ${required}`);
            }
          }
        }
      } else if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "createConversationExecutorLedger"
      ) {
        const options = node.arguments[0];
        const authorityProperty = options && ts.isObjectLiteralExpression(options)
          ? options.properties.find(
              (property) => ts.isPropertyAssignment(property) &&
                propertyNameText(property.name) === "authority",
            )
          : undefined;
        const initializer = authorityProperty && ts.isPropertyAssignment(authorityProperty)
          ? authorityProperty.initializer
          : undefined;
        if (
          !initializer ||
          boundLocalRuntime === undefined ||
          !ts.isIdentifier(initializer) ||
          initializer.text !== boundLocalRuntime
        ) {
          failures.push(`${record.relative}: executor ledger must receive the same single local runtime construction`);
        }
      }
      ts.forEachChild(node, visitRoot);
    };
    visitRoot(source);
    if (createCount !== 1) {
      failures.push(`${record.relative}: expected one local owner production construction, got ${createCount}`);
    }
    if (assemblyBinding) {
      let startCount = 0;
      let closeCount = 0;
      const visitLifecycle = (node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === assemblyBinding
        ) {
          if (node.expression.name.text === "start") startCount += 1;
          if (node.expression.name.text === "close") closeCount += 1;
        }
        ts.forEachChild(node, visitLifecycle);
      };
      visitLifecycle(assemblyScope ?? source);
      if (startCount !== 1) {
        failures.push(`${record.relative}: local owner assembly must start exactly once, got ${startCount}`);
      }
      if (closeCount !== 1) {
        failures.push(`${record.relative}: local owner assembly must close exactly once, got ${closeCount}`);
      }
    }
  }
  return failures;
}

export function inspectConversationAdoptionAssembly(records) {
  const failures = [];
  const required = new Map([
    ["packages/cli/src/serve/mesh-runtime-assembly.ts", undefined],
    ["packages/cli/src/serve/access-surfaces.ts", undefined],
    ["packages/cli/src/serve/executor-role-runtime.ts", undefined],
    ["packages/cli/src/serve/conversation-evidence-authority.ts", undefined],
    ["packages/cli/src/serve/conversation-transfer-mesh.ts", undefined],
    ["packages/cli/src/serve/first-party-conversation-mesh.ts", undefined],
    ["packages/cli/src/serve/local-conversation-rpc.ts", undefined],
    ["packages/cli/src/serve/post-adoption-memory.ts", undefined],
    ["packages/cli/src/serve/post-adoption-review.ts", undefined],
    ["packages/cli/src/serve/command.ts", undefined],
    ["packages/cli/src/runtime/rpc-confirmation-broker.ts", undefined],
    ["packages/cli/src/repl.ts", undefined],
    ["packages/rpc/src/confirmation-bridge.ts", undefined],
    ["packages/server/src/context.ts", undefined],
    ["packages/server/src/rpc/handlers.ts", undefined],
    ["packages/server/src/rpc/methods/session.ts", undefined],
    ["packages/server/src/rpc/methods/confirmation.ts", undefined],
    ["packages/owner-kernel/src/conversation-transfer.ts", undefined],
  ]);
  for (const record of records) {
    if (required.has(record.relative)) required.set(record.relative, record);
  }
  for (const [relative, record] of required) {
    if (!record) failures.push(`${relative}: S8 production assembly source is missing`);
  }
  if (failures.length > 0) return failures;

  const count = (text, pattern) => [...text.matchAll(pattern)].length;
  const requireCount = (record, pattern, expected, description) => {
    const actual = count(record.text, pattern);
    if (actual !== expected) {
      failures.push(`${record.relative}: expected ${expected} ${description}, got ${actual}`);
    }
  };

  const mesh = required.get("packages/cli/src/serve/mesh-runtime-assembly.ts");
  requireCount(mesh, /new\s+ConversationTransferTarget\s*\(/gu, 1, "anchor transfer target construction");
  requireCount(mesh, /registerConversationTransferMeshService\s*\(/gu, 1, "conversation transfer mesh registration");
  requireCount(mesh, /options\.localConversationOwner\.transferSource\s*\(\s*\)/gu, 1, "local transfer source binding");
  requireCount(mesh, /afterCommit\s*:\s*async\s*\(base\)[\s\S]*?this\.#installCommittedTransfer\s*\(base\)/gu, 1, "post-commit authority installation");
  if (!/this\.#transferTarget\s*=\s*roles\.has\("anchor"\)\s*\?[\s\S]*?new\s+ConversationTransferTarget\s*\(/u.test(mesh.text)) {
    failures.push(`${mesh.relative}: transfer target must be owned only by the active anchor role`);
  }
  if (
    !/staging:\s*new\s+FileConversationTransferStagingArea\s*\([\s\S]*?storageMaintenance:\s*options\.authority\.storageMaintenance,[\s\S]*?abortSignal:\s*\(\)\s*=>\s*this\.#transferAbort\.signal/u.test(mesh.text)
  ) {
    failures.push(`${mesh.relative}: anchor transfer target must use private staging and the authority governor/lifecycle abort`);
  }
  if (
    !/this\.#firstPartyConversationTarget\s*=\s*roles\.has\("anchor"\)[\s\S]*?new\s+FirstPartyConversationMeshTarget\s*\(\s*\)/u.test(mesh.text) ||
    !/registerFirstPartyConversationMeshService\s*\([\s\S]*?this\.#firstPartyConversationTarget/u.test(mesh.text)
  ) {
    failures.push(`${mesh.relative}: anchor must own the single finite first-party conversation relay target`);
  }
  const startBoundary = mesh.text.indexOf("  async start(): Promise<void> {");
  const stopBoundary = mesh.text.indexOf("  async stop(): Promise<void> {");
  if (startBoundary < 0 || stopBoundary < 0 || startBoundary > stopBoundary) {
    failures.push(`${mesh.relative}: mesh lifecycle start/stop boundary is missing`);
  } else {
    const startBody = mesh.text.slice(startBoundary, stopBoundary);
    const restore = startBody.indexOf("await this.#restoreCommittedTransfers()");
    const admission = startBody.indexOf("await this.#control.start()");
    if (restore < 0 || admission < 0 || restore > admission) {
      failures.push(`${mesh.relative}: committed transfers must restore before mesh admission opens`);
    }
  }
  if (!/async\s+bindPostAdoptionMemory\s*\([\s\S]*?this\.#postAdoptionMemory\s*=\s*port;\s*await\s+this\.#restoreCommittedTransfers\s*\(\s*\)/u.test(mesh.text)) {
    failures.push(`${mesh.relative}: post-adoption memory must bind before replaying durable commits`);
  }
  if (!/await\s+protocol\.installCommittedConversationTransfer\s*\(base\);[\s\S]*?this\.#postAdoptionMemory[\s\S]*?\.flush\s*\(/u.test(mesh.text)) {
    failures.push(`${mesh.relative}: committed authority must install before post-adoption memory consumption`);
  }
  if (!/loadCandidates:\s*\(\)\s*=>\s*protocol\.conversationMemoryFlushes\s*\(/u.test(mesh.text)) {
    failures.push(`${mesh.relative}: completed post-adoption memory watermarks must be checked before loading candidate history`);
  }
  if (!/async\s+bindPostAdoptionReview\s*\([\s\S]*?this\.#postAdoptionReview\s*=\s*port;\s*await\s+this\.#restoreCommittedTransfers\s*\(\s*\)/u.test(mesh.text)) {
    failures.push(`${mesh.relative}: post-adoption review must bind before replaying durable commits`);
  }
  if (!/await\s+protocol\.installCommittedConversationTransfer\s*\(base\);[\s\S]*?this\.#postAdoptionReview[\s\S]*?\.reviewAfterAdoption\s*\(/u.test(mesh.text)) {
    failures.push(`${mesh.relative}: committed authority must install before deferred-intent review`);
  }

  const productionRoots = [
    required.get("packages/cli/src/serve/access-surfaces.ts"),
    required.get("packages/cli/src/serve/executor-role-runtime.ts"),
  ];
  for (const rootRecord of productionRoots) {
    requireCount(rootRecord, /new\s+MeshRuntimeAssembly\s*\(/gu, 1, "mesh runtime production construction");
    requireCount(rootRecord, /createConversationEvidenceAuthorityVerifier\s*\(/gu, 1, "current-owner evidence verifier injection");
    if (!/localConversationOwner\s*[:,]/u.test(rootRecord.text)) {
      failures.push(`${rootRecord.relative}: mesh production root must bind its local conversation source`);
    }
  }
  const accessRoot = required.get("packages/cli/src/serve/access-surfaces.ts");
  const executorRoot = required.get("packages/cli/src/serve/executor-role-runtime.ts");
  if (
    !/storageMaintenance:\s*ctx\.authorityRuntime\.storageMaintenance/u.test(accessRoot.text) ||
    !/authority:\s*ctx\.authorityRuntime/u.test(accessRoot.text)
  ) {
    failures.push(`${accessRoot.relative}: combined production root must share one authority storage governor with source and target`);
  }
  if (
    !/storageMaintenance:\s*authority\.storageMaintenance/u.test(executorRoot.text) ||
    !/authority,\s*[\r\n]+\s*localConversationOwner,/u.test(executorRoot.text)
  ) {
    failures.push(`${executorRoot.relative}: executor-only production root must share one authority storage governor with source and target`);
  }

  requireCount(executorRoot, /new\s+LocalConversationRpcRouter\s*\(/gu, 1, "first-party local conversation router construction");
  requireCount(executorRoot, /conversationRpc\s*:\s*localConversationRpc/gu, 1, "first-party local conversation router injection");

  const evidence = required.get("packages/cli/src/serve/conversation-evidence-authority.ts");
  if (!/resolveCurrentConversationAuthority\s*\([\s\S]*?request\.conversationId/u.test(evidence.text)) {
    failures.push(`${evidence.relative}: evidence verifier must resolve the durable current conversation authority`);
  }
  if (!/current\.deviceId\s*!==\s*request\.signature\.keyId[\s\S]*?current\.ownerEpoch\s*!==\s*request\.ownerEpoch/u.test(evidence.text)) {
    failures.push(`${evidence.relative}: evidence verifier must bind both owner identity and owner epoch`);
  }

  const router = required.get("packages/cli/src/serve/local-conversation-rpc.ts");
  if (!/params\.continueLocally\s*!==\s*true/u.test(router.text) || !/assertLocalConversationIdForDevice\s*\(/u.test(router.text)) {
    failures.push(`${router.relative}: local session writes must require user consent and a local conversation identity`);
  }
  if (
    !/this\.input\.owner\.currentAuthority\s*\(conversationId\)/u.test(router.text) ||
    !/this\.input\.owner\.listConversationAuthorities\s*\(\s*\)/u.test(router.text) ||
    !/this\.#remoteFor\s*\(authority\.deviceId\)\.dispatch/u.test(router.text) ||
    !/dispatchCanonical[\s\S]*?#listAllConfirmations/u.test(router.text)
  ) {
    failures.push(`${router.relative}: first-party session and confirmation routing must share current-owner resolution and canonical local dispatch`);
  }
  const context = required.get("packages/server/src/context.ts");
  if (!/conversationRpc\?\s*:\s*FirstPartyConversationRpcRouter/u.test(context.text)) {
    failures.push(`${context.relative}: server context must expose the narrow first-party conversation router`);
  }
  const handlers = required.get("packages/server/src/rpc/handlers.ts");
  if (!/ctx\.server\.conversationRpc\?\.dispatch\s*\(/u.test(handlers.text)) {
    failures.push(`${handlers.relative}: canonical RPC dispatch must consult the first-party conversation router`);
  }

  const command = required.get("packages/cli/src/serve/command.ts");
  requireCount(command, /bindPostAdoptionMemory\s*\(/gu, 1, "anchor post-adoption memory binding");
  requireCount(command, /new\s+PostAdoptionReviewCoordinator\s*\(/gu, 1, "anchor post-adoption review construction");
  requireCount(command, /bindPostAdoptionReview\s*\(/gu, 1, "anchor post-adoption review binding");
  if (!/ctx\.meshRuntime\s*&&\s*ctx\.authorityRuntime\?\.globalState/u.test(command.text)) {
    failures.push(`${command.relative}: post-adoption memory must be limited to an anchor with GlobalState`);
  }
  const memoryBinding = command.text.indexOf("await ctx.meshRuntime.bindPostAdoptionMemory(");
  const reviewBinding = command.text.indexOf("await ctx.meshRuntime.bindPostAdoptionReview(");
  const publicServer = command.text.indexOf("runner = await runServer(");
  if (
    memoryBinding < 0 || reviewBinding < 0 || publicServer < 0 ||
    memoryBinding > publicServer || reviewBinding > publicServer
  ) {
    failures.push(`${command.relative}: adoption recovery consumers must bind before public server admission`);
  }
  if (!/conversationAdoptionReview\s*:[\s\S]*?adoptionReview!\.reviewForSurface\s*\(input\)/u.test(command.text)) {
    failures.push(`${command.relative}: public resume must reuse the authenticated anchor review coordinator`);
  }

  const review = required.get("packages/cli/src/serve/post-adoption-review.ts");
  if (
    !/parseLocalConversationId\s*\(input\.conversationId\)/u.test(review.text) ||
    !/this\.#review\.decide\s*\(intent\.intentId,\s*"confirmed"/u.test(review.text) ||
    !/this\.#hub\.attach\s*\("post-adoption-review",\s*this\.#broker,\s*\{/u.test(review.text) ||
    !/conversationIdFor:\s*\(request\)\s*=>/u.test(review.text) ||
    !/triggeredBy:\s*surfacePrincipal\s*\(context\)/u.test(review.text)
  ) {
    failures.push(`${review.relative}: adoption review must remain local-conversation scoped and reuse the durable review/confirmation seams`);
  }

  const firstParty = required.get("packages/cli/src/serve/first-party-conversation-mesh.ts");
  if (
    !/const\s+METHODS\s*=\s*new\s+Set\s*\(\[/u.test(firstParty.text) ||
    !/METHODS\.has\(command\.method\)/u.test(firstParty.text) ||
    !/connection\.peer\.deviceId/u.test(firstParty.text) ||
    !/surface generation is stale/u.test(firstParty.text) ||
    !/prior\.close\s*\(\s*\)/u.test(firstParty.text)
  ) {
    failures.push(`${firstParty.relative}: first-party mesh relay must remain finite, peer-bound and single-generation`);
  }

  const transferMesh = required.get("packages/cli/src/serve/conversation-transfer-mesh.ts");
  if (
    !/result\.requestId\s*!==\s*command\.requestId\s*\|\|\s*result\.transferId\s*!==\s*command\.transferId/u.test(transferMesh.text) ||
    !/class\s+ConversationTransferRejectedError[\s\S]*?readonly\s+retryable/u.test(transferMesh.text) ||
    !/okAborted\(command,\s*aborted\.abort\)/u.test(transferMesh.text)
  ) {
    failures.push(`${transferMesh.relative}: transfer results must retain strict originating-command correlation and signed abort facts`);
  }

  const transferOwner = required.get("packages/owner-kernel/src/conversation-transfer.ts");
  const settle = transferOwner.text.indexOf("await this.#options.settleConversation(input.conversationId)");
  const revalidate = transferOwner.text.indexOf("const settled = await this.#options.conversationState(input.conversationId)", settle);
  const appendPrepared = transferOwner.text.indexOf("t: \"prepared\"", revalidate);
  if (settle < 0 || revalidate < 0 || appendPrepared < 0 || !(settle < revalidate && revalidate < appendPrepared)) {
    failures.push(`${transferOwner.relative}: source prepare must revalidate durable identity after settling and before append`);
  }
  if (
    !/class\s+FileConversationTransferStagingArea[\s\S]*?path\.join\(this\.#rootDir,\s*transferId/u.test(transferOwner.text) ||
    !/promoteTransferClosure\s*\([\s\S]*?putVerifiedStream/u.test(transferOwner.text) ||
    !/step:\s*"staging-cleanup"[\s\S]*?obligation:\s*"committed"/u.test(transferOwner.text)
  ) {
    failures.push(`${transferOwner.relative}: transfer-private staging, shared promotion and committed cleanup must remain distinct`);
  }

  const memory = required.get("packages/cli/src/serve/post-adoption-memory.ts");
  for (const kind of ["discovery", "attempt", "plan", "effect", "completed"]) {
    if (!memory.text.includes(`post-adoption-memory-${kind}`)) {
      failures.push(`${memory.relative}: durable post-adoption memory ${kind} record is missing`);
    }
  }
  const projectionRead = memory.text.indexOf("const beforeLoad = await readProjection");
  const candidateLoad = memory.text.indexOf("input.candidates ?? await input.loadCandidates?.()", projectionRead);
  if (
    projectionRead < 0 ||
    candidateLoad < 0 ||
    projectionRead > candidateLoad ||
    !/if\s*\(!durableDiscovery\)\s*\{[\s\S]*?input\.candidates\s*\?\?\s*await input\.loadCandidates\?\.\(\)[\s\S]*?appendDiscoveryWithAttempts/u.test(memory.text) ||
    !/for\s*\(const operationId of durableDiscovery\.operationIds\)[\s\S]*?operation\?\.completed[\s\S]*?operation\?\.attempt\?\.input/u.test(memory.text)
  ) {
    failures.push(`${memory.relative}: durable discovery inputs must be frozen atomically and only incomplete operations may be re-driven without reloading history`);
  }

  const session = required.get("packages/server/src/rpc/methods/session.ts");
  const addObserver = session.text.indexOf("manager.addObserver(params.conversationId");
  const reviewSurface = session.text.indexOf("ctx.server.conversationAdoptionReview?.({");
  if (addObserver < 0 || reviewSurface < 0 || addObserver > reviewSurface) {
    failures.push(`${session.relative}: session resume must bind the authenticated observer before adoption review`);
  }

  const confirmation = required.get("packages/server/src/rpc/methods/confirmation.ts");
  if (
    !/!e\.conversationId[\s\S]*?rpcOriginMatches\s*\(e\.request,\s*ctx\.connection\)/u.test(confirmation.text) ||
    !/origin\.triggeredBy\s*===\s*String\(connection\.id\)[\s\S]*?origin\.triggeredBy\s*===\s*connection\.surfacePrincipal/u.test(confirmation.text) ||
    !/connection\.authenticated[\s\S]*?connection\.loopback[\s\S]*?rpcOriginMatches\(req,\s*connection\)/u.test(confirmation.text)
  ) {
    failures.push(`${confirmation.relative}: missed confirmations must be recoverable only by their authenticated local surface`);
  }
  const bridge = required.get("packages/rpc/src/confirmation-bridge.ts");
  if (!/origin\.triggeredBy\s*===\s*String\(conn\.id\)[\s\S]*?origin\.triggeredBy\s*===\s*conn\.surfacePrincipal/u.test(bridge.text)) {
    failures.push(`${bridge.relative}: confirmation notifications must follow the stable authenticated surface across reconnects`);
  }

  const broker = required.get("packages/cli/src/runtime/rpc-confirmation-broker.ts");
  if (!/async\s+refresh\s*\(\s*\)[\s\S]*?request[\s\S]*?"confirmation\.list"[\s\S]*?this\.acceptPending/u.test(broker.text)) {
    failures.push(`${broker.relative}: the first-party confirmation renderer must recover missed pending requests`);
  }
  const repl = required.get("packages/cli/src/repl.ts");
  if (!/initialAdoptionReview[\s\S]*?\.message/u.test(repl.text) || !/rpcConfirmationBroker\.refresh\s*\(\s*\)/u.test(repl.text)) {
    failures.push(`${repl.relative}: the first-party REPL must present adoption summaries and recover pending confirmations`);
  }

  return failures;
}

function resolveSourceSpecifier(importer, specifier, sourceFiles, publicSources) {
  if (publicSources.has(specifier)) return publicSources.get(specifier);
  if (!specifier.startsWith(".")) return undefined;
  const joined = path.posix.normalize(
    path.posix.join(path.posix.dirname(importer), specifier),
  );
  const candidates = [
    joined,
    joined.replace(/\.(?:mjs|cjs|js)$/u, ".ts"),
    `${joined}.ts`,
    `${joined}/index.ts`,
  ];
  return candidates.find((candidate) => sourceFiles.has(candidate));
}

async function workspacePackageJsonFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await workspacePackageJsonFiles(absolute));
    else if (entry.name === "package.json") result.push(absolute);
  }
  return result;
}

function exportTarget(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  return value.import ?? value.default ?? value.types;
}

async function workspacePublicSources(sourceFiles) {
  const result = new Map();
  for (const absolute of await workspacePackageJsonFiles(path.join(root, "packages"))) {
    const manifest = JSON.parse(await readFile(absolute, "utf8"));
    if (typeof manifest.name !== "string") continue;
    const packageRoot = path.relative(root, path.dirname(absolute)).replaceAll("\\", "/");
    const exports = manifest.exports && typeof manifest.exports === "object"
      ? manifest.exports
      : { ".": "./dist/index.js" };
    for (const [subpath, value] of Object.entries(exports)) {
      const target = exportTarget(value);
      if (typeof target !== "string" || !target.includes("/dist/")) continue;
      const source = path.posix.join(
        packageRoot,
        target.replace(/^\.\/dist\//u, "src/").replace(/\.d\.ts$/u, ".ts").replace(/\.js$/u, ".ts"),
      );
      if (!sourceFiles.has(source)) continue;
      const specifier = subpath === "."
        ? manifest.name
        : `${manifest.name}/${subpath.replace(/^\.\//u, "")}`;
      result.set(specifier, source);
    }
  }
  return result;
}

function exportedDeclarationName(statement, trackedSymbols) {
  if (
    (ts.isClassDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)) &&
    statement.name &&
    trackedSymbols.has(statement.name.text) &&
    hasModifier(statement, ts.SyntaxKind.ExportKeyword)
  ) return statement.name.text;
  if (ts.isVariableStatement(statement) &&
      hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
    const names = statement.declarationList.declarations
      .filter((declaration) =>
        ts.isIdentifier(declaration.name) && trackedSymbols.has(declaration.name.text))
      .map((declaration) => declaration.name.text);
    return names.length === 1 ? names[0] : undefined;
  }
  return undefined;
}

export async function buildWorkspaceSymbolExposure(
  records,
  trackedSymbols,
  publicSourcesOverride,
) {
  const sourceFiles = new Set(records.map((record) => record.relative));
  const publicSources = publicSourcesOverride ??
    await workspacePublicSources(sourceFiles);
  const sources = new Map(
    records.map((record) => [record.relative, sourceFile(record.relative, record.text)]),
  );
  const exposure = new Map(records.map((record) => [record.relative, new Map()]));
  for (const [relative, source] of sources) {
    for (const statement of source.statements) {
      const name = exportedDeclarationName(statement, trackedSymbols);
      if (name) exposure.get(relative).set(name, name);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [relative, source] of sources) {
      const current = exposure.get(relative);
      const locals = new Map();
      for (const statement of source.statements) {
        if (
          (ts.isClassDeclaration(statement) ||
            ts.isInterfaceDeclaration(statement) ||
            ts.isFunctionDeclaration(statement) ||
            ts.isTypeAliasDeclaration(statement) ||
            ts.isEnumDeclaration(statement)) &&
          statement.name &&
          trackedSymbols.has(statement.name.text)
        ) {
          locals.set(statement.name.text, statement.name.text);
          continue;
        }
        const reference = moduleReference(statement);
        if (!reference?.literal) continue;
        const target = resolveSourceSpecifier(
          relative,
          reference.specifier,
          sourceFiles,
          publicSources,
        );
        if (!target) continue;
        const upstream = exposure.get(target);
        if (!upstream || upstream.size === 0) continue;
        if (ts.isImportDeclaration(statement) && statement.importClause) {
          if (statement.importClause.name) {
            locals.set(statement.importClause.name.text, "namespace/default");
          }
          const bindings = statement.importClause.namedBindings;
          if (bindings && ts.isNamespaceImport(bindings)) {
            locals.set(bindings.name.text, "namespace/default");
          } else if (bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) {
              const owner = upstream.get(
                element.propertyName?.text ?? element.name.text,
              );
              if (owner) locals.set(element.name.text, owner);
            }
          }
        } else if (ts.isImportEqualsDeclaration(statement)) {
          locals.set(statement.name.text, "namespace/default");
        }
      }
      for (const statement of source.statements) {
        if (ts.isExportDeclaration(statement)) {
          if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
            const target = resolveSourceSpecifier(
              relative,
              statement.moduleSpecifier.text,
              sourceFiles,
              publicSources,
            );
            if (!target) continue;
            const upstream = exposure.get(target);
            if (!upstream) continue;
            if (!statement.exportClause) {
              for (const [name, owner] of upstream) {
                if (!current.has(name)) {
                  current.set(name, owner);
                  changed = true;
                }
              }
            } else if (ts.isNamedExports(statement.exportClause)) {
              for (const element of statement.exportClause.elements) {
                const original = element.propertyName?.text ?? element.name.text;
                const owner = upstream.get(original);
                if (owner && !current.has(element.name.text)) {
                  current.set(element.name.text, owner);
                  changed = true;
                }
              }
            } else if (
              ts.isNamespaceExport(statement.exportClause) &&
              upstream.size > 0 &&
              !current.has(statement.exportClause.name.text)
            ) {
              current.set(statement.exportClause.name.text, "namespace/default");
              changed = true;
            }
          } else if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
            for (const element of statement.exportClause.elements) {
              const owner = locals.get(
                element.propertyName?.text ?? element.name.text,
              );
              if (owner && !current.has(element.name.text)) {
                current.set(element.name.text, owner);
                changed = true;
              }
            }
          }
        } else if (
          ts.isExportAssignment(statement) &&
          ts.isIdentifier(statement.expression)
        ) {
          const owner = locals.get(statement.expression.text);
          if (owner && !current.has("default")) {
            current.set("default", owner);
            changed = true;
          }
        }
      }
    }
  }
  return (importer, specifier) => {
    const target = resolveSourceSpecifier(importer, specifier, sourceFiles, publicSources);
    return target ? exposure.get(target) ?? new Map() : new Map();
  };
}

export function buildWorkspaceOwnerExposure(records, publicSourcesOverride) {
  return buildWorkspaceSymbolExposure(
    records,
    forbiddenWriteOwners,
    publicSourcesOverride,
  );
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return undefined;
}

function enclosingFunction(node) {
  let current = node.parent;
  while (current) {
    if (ts.isFunctionLike(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function validateCleanupOwnerOptions(relative, node, topologyTypeNames) {
  const failures = [];
  if (node.arguments.length !== 1 || !ts.isObjectLiteralExpression(node.arguments[0])) {
    return [`${relative}: CleanupRegistry options must be one object literal`];
  }
  const options = node.arguments[0];
  if (options.properties.some((property) => ts.isSpreadAssignment(property))) {
    failures.push(`${relative}: CleanupRegistry options cannot use spread assignment`);
  }
  if (options.properties.some((property) =>
    property.name && ts.isComputedPropertyName(property.name))) {
    failures.push(`${relative}: CleanupRegistry options cannot use computed properties`);
  }
  const activeOwners = options.properties.filter(
    (property) => ts.isPropertyAssignment(property) &&
      propertyNameText(property.name) === "activeOwners",
  );
  if (activeOwners.length !== 1) {
    failures.push(`${relative}: CleanupRegistry activeOwners must appear exactly once`);
    return failures;
  }
  const initializer = activeOwners[0].initializer;
  if (relative === "packages/cli/src/serve/command.ts") {
    const validAccess = ts.isPropertyAccessExpression(initializer) &&
      initializer.name.text === "activeCleanupOwners" &&
      ts.isIdentifier(initializer.expression);
    const ownerName = validAccess ? initializer.expression.text : undefined;
    const ownerFunction = enclosingFunction(node);
    const parameter = ownerFunction?.parameters.find(
      (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === ownerName,
    );
    const typeName = parameter?.type && ts.isTypeReferenceNode(parameter.type) &&
      ts.isIdentifier(parameter.type.typeName)
      ? parameter.type.typeName.text
      : undefined;
    if (!ownerName || !typeName || !topologyTypeNames.has(typeName)) {
      failures.push(
        `${relative}: CleanupRegistry activeOwners must come from a ServeTopologyPlan parameter`,
      );
    }
  } else if (relative === "packages/server/src/lifecycle.ts") {
    const validStandalone = ts.isArrayLiteralExpression(initializer) &&
      initializer.elements.length === 1 &&
      ts.isStringLiteralLike(initializer.elements[0]) &&
      initializer.elements[0].text === "standalone-server";
    if (!validStandalone) {
      failures.push(
        `${relative}: CleanupRegistry activeOwners must be exactly standalone-server`,
      );
    }
  }
  return failures;
}

export async function inspectCleanupRegistryConstructions(
  records,
  publicSourcesOverride,
) {
  const resolveExposure = await buildWorkspaceSymbolExposure(
    records,
    new Set(["CleanupRegistry"]),
    publicSourcesOverride,
  );
  const failures = [];
  const constructions = [];
  for (const record of records) {
    const source = sourceFile(record.relative, record.text);
    const bindings = new Set();
    const namespaceBindings = new Map();
    const topologyTypeNames = new Set();
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) ||
          !ts.isStringLiteral(statement.moduleSpecifier) ||
          !statement.importClause) continue;
      const specifier = statement.moduleSpecifier.text;
      const exposed = resolveExposure(record.relative, specifier);
      const named = statement.importClause.namedBindings;
      if (named && ts.isNamespaceImport(named) &&
          [...exposed.values()].includes("CleanupRegistry")) {
        namespaceBindings.set(named.name.text, exposed);
      } else if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          if (exposed.get(imported) === "CleanupRegistry") {
            bindings.add(element.name.text);
          }
          if (imported === "ServeTopologyPlan" &&
              specifier.endsWith("role-topology.js")) {
            topologyTypeNames.add(element.name.text);
          }
        }
      }
    }
    const aliases = [];
    const collectAliases = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        aliases.push({ name: node.name.text, initializer: node.initializer });
      }
      ts.forEachChild(node, collectAliases);
    };
    collectAliases(source);
    const unwrapConstructor = (expression) => {
      let current = expression;
      while (ts.isParenthesizedExpression(current) ||
             ts.isAsExpression(current) ||
             ts.isTypeAssertionExpression(current) ||
             ts.isNonNullExpression(current)) {
        current = current.expression;
      }
      return current;
    };
    const isCleanupConstructor = (expression) => {
      const candidate = unwrapConstructor(expression);
      if (ts.isIdentifier(candidate)) return bindings.has(candidate.text);
      if (ts.isPropertyAccessExpression(candidate) &&
          ts.isIdentifier(candidate.expression)) {
        const exposed = namespaceBindings.get(candidate.expression.text);
        return exposed?.get(candidate.name.text) === "CleanupRegistry";
      }
      if (ts.isElementAccessExpression(candidate) &&
          ts.isIdentifier(candidate.expression) && candidate.argumentExpression &&
          ts.isStringLiteralLike(candidate.argumentExpression)) {
        const exposed = namespaceBindings.get(candidate.expression.text);
        return exposed?.get(candidate.argumentExpression.text) === "CleanupRegistry";
      }
      return false;
    };
    let changed = true;
    while (changed) {
      changed = false;
      for (const alias of aliases) {
        if (!bindings.has(alias.name) && isCleanupConstructor(alias.initializer)) {
          bindings.add(alias.name);
          changed = true;
        }
      }
    }
    const visit = (node) => {
      if (ts.isNewExpression(node) && isCleanupConstructor(node.expression)) {
        constructions.push({ relative: record.relative, node, topologyTypeNames });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const expected = new Map([
    ["packages/cli/src/serve/command.ts", 1],
    ["packages/server/src/lifecycle.ts", 1],
  ]);
  for (const [relative, count] of expected) {
    const actual = constructions.filter((item) => item.relative === relative).length;
    if (actual !== count) {
      failures.push(
        `${relative}: expected ${count} production CleanupRegistry construction, got ${actual}`,
      );
    }
  }
  for (const construction of constructions) {
    if (!expected.has(construction.relative)) {
      failures.push(
        `${construction.relative}: unregistered production CleanupRegistry construction`,
      );
      continue;
    }
    failures.push(...validateCleanupOwnerOptions(
      construction.relative,
      construction.node,
      construction.topologyTypeNames,
    ));
  }
  return failures;
}

function moduleReference(node) {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
    return { specifier: node.moduleSpecifier.text, literal: true };
  }
  if (ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)) {
    const expression = node.moduleReference.expression;
    return expression && ts.isStringLiteralLike(expression)
      ? { specifier: expression.text, literal: true }
      : { literal: false };
  }
  if (ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
       (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
    const argument = node.arguments[0];
    return argument && ts.isStringLiteralLike(argument)
      ? { specifier: argument.text, literal: true }
      : { literal: false };
  }
  return undefined;
}

function enclosingMethodName(node) {
  let current = node.parent;
  while (current) {
    if (ts.isMethodDeclaration(current)) return current.name.getText();
    current = current.parent;
  }
  return undefined;
}

function safeRpcForwarders(source) {
  const calls = new Map();
  const candidates = new Map();
  const visit = (node) => {
    const privateMethod =
      ts.isMethodDeclaration(node) &&
      (ts.isPrivateIdentifier(node.name) ||
        node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword));
    if (privateMethod && node.body && node.parameters[0] &&
        ts.isIdentifier(node.parameters[0].name)) {
      const methodName = node.name.getText();
      const parameter = node.parameters[0].name.text;
      let forwardsParameter = false;
      const inspect = (child) => {
        if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression) &&
            child.expression.name.text === "request" && child.arguments[0] &&
            ts.isIdentifier(child.arguments[0]) && child.arguments[0].text === parameter) {
          forwardsParameter = true;
        }
        ts.forEachChild(child, inspect);
      };
      inspect(node.body);
      if (forwardsParameter) candidates.set(methodName, parameter);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.getText();
      if (!calls.has(name)) calls.set(name, []);
      calls.get(name).push(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return new Set([...candidates.keys()].filter((name) => {
    const argumentsForCalls = calls.get(name) ?? [];
    return argumentsForCalls.length > 0 && argumentsForCalls.every(
      (argument) => argument && ts.isStringLiteralLike(argument) && builtinRpcNames.has(argument.text),
    );
  }));
}

const rawRpcSymbols = new Set([
  "CoreHostConnection",
  "CoreHostRpcLink",
  "RpcClient",
  "createRpcClient",
]);

const coreHostRpcLinkOwners = new Set([
  "packages/cli/src/runtime/rpc-confirmation-broker.ts",
  "packages/cli/src/runtime/rpc-conversation-facade.ts",
  "packages/cli/src/runtime/rpc-management-facade.ts",
  "packages/cli/src/runtime/rpc-scheduler-facade.ts",
  "packages/cli/src/runtime/rpc-workscene-facade.ts",
]);
const rpcClientOwners = new Set([
  "packages/cli/src/runtime/core-host-connection.ts",
  "packages/cli/src/serve/stop.ts",
]);
const coreHostConnectionOwners = new Set([
  "packages/cli/src/repl.ts",
  "packages/cli/src/runtime/workspace-command.ts",
]);
const rpcMethodOwners = new Set([
  ...coreHostRpcLinkOwners,
  ...rpcClientOwners,
]);

function hasModifier(node, kind) {
  return node.modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

function isCoreHostModule(relative, specifier) {
  return resolveRelativeTypeScript(relative, specifier) ===
    "packages/cli/src/runtime/core-host-connection.ts";
}

function isRpcMethodOwner(relative) {
  return rpcMethodOwners.has(relative);
}

function allowedRpcCapabilityOwner(relative, symbol) {
  if (symbol === "CoreHostRpcLink") return coreHostRpcLinkOwners.has(relative);
  if (symbol === "RpcClient" || symbol === "createRpcClient") return rpcClientOwners.has(relative);
  if (symbol === "CoreHostConnection") return coreHostConnectionOwners.has(relative);
  return false;
}

function directRpcExposure(relative, specifier) {
  if (specifier === "@zhixing/server") {
    return new Map([
      ["RpcClient", "RpcClient"],
      ["createRpcClient", "createRpcClient"],
    ]);
  }
  if (isCoreHostModule(relative, specifier)) {
    return new Map([
      ["CoreHostConnection", "CoreHostConnection"],
      ["CoreHostRpcLink", "CoreHostRpcLink"],
    ]);
  }
  return new Map();
}

function rpcExposure(relative, specifier, resolveRpcExposure) {
  const resolved = resolveRpcExposure?.(relative, specifier) ?? new Map();
  const fallback = directRpcExposure(relative, specifier);
  return new Map(
    [...fallback, ...resolved].filter(([, symbol]) => rawRpcSymbols.has(symbol)),
  );
}

function isPrivateMember(node) {
  return ts.isPrivateIdentifier(node.name) || hasModifier(node, ts.SyntaxKind.PrivateKeyword);
}

function isParameterProperty(node) {
  return ts.isParameter(node) && ts.isConstructorDeclaration(node.parent) &&
    node.modifiers?.some((modifier) => [
      ts.SyntaxKind.PublicKeyword,
      ts.SyntaxKind.ProtectedKeyword,
      ts.SyntaxKind.PrivateKeyword,
      ts.SyntaxKind.ReadonlyKeyword,
    ].includes(modifier.kind));
}

function isVisibleReturnBoundary(node) {
  let current = node;
  while (current) {
    if (ts.isMethodDeclaration(current) || ts.isGetAccessorDeclaration(current)) {
      return !isPrivateMember(current);
    }
    if (ts.isFunctionDeclaration(current)) {
      return hasModifier(current, ts.SyntaxKind.ExportKeyword) ||
        hasModifier(current, ts.SyntaxKind.DefaultKeyword);
    }
    if (ts.isFunctionExpression(current) || ts.isArrowFunction(current)) {
      const declaration = current.parent;
      const statement = ts.isVariableDeclaration(declaration)
        ? declaration.parent?.parent
        : undefined;
      return !!statement && ts.isVariableStatement(statement) &&
        hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    }
    current = current.parent;
  }
  return false;
}

function inspectCliRpcCapabilities(relative, source, options = {}) {
  if (!relative.startsWith("packages/cli/src/")) return [];
  const failures = [];
  const bindings = new Map();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) && statement.importClause) {
      const specifier = statement.moduleSpecifier.text;
      const exposed = rpcExposure(relative, specifier, options.resolveRpcExposure);
      if (exposed.size === 0) continue;
      if (statement.importClause.name) {
        failures.push(`${relative}: raw RPC default capability import`);
      }
      const named = statement.importClause.namedBindings;
      if (!named) continue;
      if (ts.isNamespaceImport(named)) {
        failures.push(`${relative}: raw RPC namespace capability import`);
        continue;
      }
      for (const element of named.elements) {
        const imported = element.propertyName?.text ?? element.name.text;
        const original = exposed.get(imported);
        if (!original) continue;
        bindings.set(element.name.text, original);
        if (!allowedRpcCapabilityOwner(relative, original)) {
          failures.push(
            `${relative}: raw RPC capability ${original} acquired outside owner`,
          );
        }
      }
    }
    if (ts.isImportEqualsDeclaration(statement) &&
        ts.isExternalModuleReference(statement.moduleReference) &&
        statement.moduleReference.expression &&
        ts.isStringLiteralLike(statement.moduleReference.expression) &&
        rpcExposure(
          relative,
          statement.moduleReference.expression.text,
          options.resolveRpcExposure,
        ).size > 0) {
      failures.push(`${relative}: raw RPC namespace capability import`);
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)) {
      const exposed = rpcExposure(
        relative,
        statement.moduleSpecifier.text,
        options.resolveRpcExposure,
      );
      if (exposed.size === 0) continue;
      if (!statement.exportClause || ts.isNamespaceExport(statement.exportClause)) {
        failures.push(`${relative}: raw RPC namespace re-export`);
      } else if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const imported = element.propertyName?.text ?? element.name.text;
          const original = exposed.get(imported);
          if (original) {
            failures.push(`${relative}: raw RPC capability ${original} re-exported`);
          }
        }
      }
    }
  }

  const expressionUsesRawBinding = (node) => {
    let found = false;
    const visit = (child) => {
      if (ts.isIdentifier(child) && bindings.has(child.text)) found = true;
      if (!found) ts.forEachChild(child, visit);
    };
    visit(node);
    return found;
  };
  const typeNames = (node) => {
    const names = [];
    const visit = (child) => {
      if (ts.isTypeReferenceNode(child) && ts.isIdentifier(child.typeName)) {
        names.push(bindings.get(child.typeName.text) ?? child.typeName.text);
      }
      ts.forEachChild(child, visit);
    };
    if (node) visit(node);
    return names;
  };
  const rawMemberNames = new Set();
  const rawValueNames = new Set();
  const collectRawMembers = (node) => {
    if ((ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) ||
         ts.isParameter(node) || ts.isVariableDeclaration(node)) &&
        ts.isIdentifier(node.name) &&
        typeNames(node.type).some((name) => rawRpcSymbols.has(name))) {
      rawValueNames.add(node.name.text);
      if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) ||
          isParameterProperty(node)) {
        rawMemberNames.add(node.name.text);
      }
      if (ts.isPropertyDeclaration(node) && !isPrivateMember(node)) {
        failures.push(`${relative}: raw RPC capability exposed on instance member`);
      }
      if (isParameterProperty(node) && !hasModifier(node, ts.SyntaxKind.PrivateKeyword)) {
        failures.push(`${relative}: raw RPC capability exposed on parameter property`);
      }
    }
    ts.forEachChild(node, collectRawMembers);
  };
  collectRawMembers(source);
  const returnsRawCapability = (expression) => {
    if (ts.isIdentifier(expression)) {
      return bindings.has(expression.text) || rawValueNames.has(expression.text);
    }
    if (ts.isPropertyAccessExpression(expression)) {
      return rawMemberNames.has(expression.name.text);
    }
    if (ts.isElementAccessExpression(expression) && expression.argumentExpression &&
        ts.isStringLiteralLike(expression.argumentExpression)) {
      return rawMemberNames.has(expression.argumentExpression.text);
    }
    if (ts.isCallExpression(expression)) {
      return (ts.isPropertyAccessExpression(expression.expression) &&
          (expression.expression.name.text === "getClient" ||
            expression.expression.name.text === "getConnectedClient")) ||
        (ts.isIdentifier(expression.expression) &&
          bindings.get(expression.expression.text) === "createRpcClient");
    }
    if (ts.isNewExpression(expression)) {
      return ts.isIdentifier(expression.expression) &&
        bindings.get(expression.expression.text) === "CoreHostConnection";
    }
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) ||
        ts.isTypeAssertionExpression(expression) || ts.isNonNullExpression(expression) ||
        ts.isAwaitExpression(expression) ||
        expression.kind === ts.SyntaxKind.SatisfiesExpression) {
      return returnsRawCapability(expression.expression);
    }
    if (ts.isObjectLiteralExpression(expression)) {
      return expression.properties.some((property) => {
        if (ts.isShorthandPropertyAssignment(property)) {
          return rawValueNames.has(property.name.text) || bindings.has(property.name.text);
        }
        if (ts.isPropertyAssignment(property) || ts.isSpreadAssignment(property)) {
          return returnsRawCapability(property.expression ?? property.initializer);
        }
        return false;
      });
    }
    if (ts.isArrayLiteralExpression(expression)) {
      return expression.elements.some((element) =>
        !ts.isOmittedExpression(element) && returnsRawCapability(element));
    }
    if (ts.isConditionalExpression(expression)) {
      return returnsRawCapability(expression.whenTrue) ||
        returnsRawCapability(expression.whenFalse);
    }
    if (ts.isBinaryExpression(expression) &&
        expression.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      return returnsRawCapability(expression.right);
    }
    if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
      if (!ts.isBlock(expression.body)) return returnsRawCapability(expression.body);
      return expression.body.statements.some((statement) =>
        ts.isReturnStatement(statement) && statement.expression &&
        returnsRawCapability(statement.expression));
    }
    return false;
  };
  let changed = true;
  while (changed) {
    changed = false;
    const collectAliases = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) &&
          node.initializer && returnsRawCapability(node.initializer) &&
          !rawValueNames.has(node.name.text)) {
        rawValueNames.add(node.name.text);
        changed = true;
      }
      ts.forEachChild(node, collectAliases);
    };
    collectAliases(source);
  }
  const visit = (node) => {
    if (ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument) &&
          rpcExposure(relative, argument.text, options.resolveRpcExposure).size > 0) {
        failures.push(`${relative}: raw RPC namespace capability loaded dynamically`);
      }
    }
    if (ts.isExportDeclaration(node) && node.exportClause &&
        ts.isNamedExports(node.exportClause) && !node.moduleSpecifier) {
      for (const element of node.exportClause.elements) {
        const local = element.propertyName?.text ?? element.name.text;
        if (bindings.has(local) || rawValueNames.has(local)) {
          failures.push(
            `${relative}: raw RPC capability ${bindings.get(local) ?? local} re-exported`,
          );
        }
      }
    }
    if (ts.isPropertyDeclaration(node) && !isPrivateMember(node) &&
        node.initializer && returnsRawCapability(node.initializer)) {
      failures.push(`${relative}: raw RPC capability exposed on instance member`);
    }
    if (ts.isExportAssignment(node) &&
        (expressionUsesRawBinding(node.expression) ||
          returnsRawCapability(node.expression))) {
      failures.push(`${relative}: raw RPC capability exported from assignment`);
    }
    if ((ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) ||
         ts.isGetAccessorDeclaration(node)) && node.type &&
        typeNames(node.type).some((name) => rawRpcSymbols.has(name)) &&
        isVisibleReturnBoundary(node) &&
        relative !== "packages/cli/src/runtime/core-host-connection.ts") {
      failures.push(`${relative}: raw RPC capability returned from public boundary`);
    }
    if (ts.isVariableStatement(node) &&
        hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of node.declarationList.declarations) {
        if ((declaration.initializer &&
              (expressionUsesRawBinding(declaration.initializer) ||
                returnsRawCapability(declaration.initializer))) ||
            (declaration.type &&
              typeNames(declaration.type).some((name) => rawRpcSymbols.has(name)))) {
          failures.push(`${relative}: raw RPC capability exported from variable`);
        }
      }
    }
    if (ts.isReturnStatement(node) && node.expression &&
        returnsRawCapability(node.expression) &&
        isVisibleReturnBoundary(node) &&
        relative !== "packages/cli/src/runtime/core-host-connection.ts") {
      failures.push(`${relative}: raw RPC capability returned from function`);
    }
    if (ts.isPropertyAccessExpression(node) &&
        (node.name.text === "getClient" || node.name.text === "getConnectedClient") &&
        !isRpcMethodOwner(relative)) {
      failures.push(`${relative}: raw RPC client accessed outside facade owner`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return failures;
}

function isPackageOrSubpath(specifier, packageName) {
  return specifier === packageName || specifier.startsWith(`${packageName}/`);
}

function directOwnerBindings(node, exposedOwners) {
  const result = [];
  if (ts.isImportDeclaration(node) && node.importClause) {
    if (node.importClause.name && exposedOwners.size > 0) {
      result.push({ local: node.importClause.name.text, owner: "namespace/default" });
    }
    const bindings = node.importClause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings) && exposedOwners.size > 0) {
      result.push({ local: bindings.name.text, owner: "namespace/default" });
    }
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const original = element.propertyName?.text ?? element.name.text;
        const owner = exposedOwners.get(original);
        if (owner) result.push({ local: element.name.text, owner });
      }
    }
  }
  if (ts.isExportDeclaration(node) && node.exportClause &&
      ts.isNamedExports(node.exportClause)) {
    for (const element of node.exportClause.elements) {
      const original = element.propertyName?.text ?? element.name.text;
      const owner = exposedOwners.get(original);
      if (owner) result.push({ local: element.name.text, owner });
    }
  }
  if (ts.isExportDeclaration(node) && node.exportClause &&
      ts.isNamespaceExport(node.exportClause) && exposedOwners.size > 0) {
    result.push({ local: node.exportClause.name.text, owner: "namespace/default" });
  }
  return result;
}

export function inspectProductionManifest(relative, manifest) {
  const failures = [];
  const fields = ["dependencies", "optionalDependencies", "peerDependencies"];
  const edges = fields.flatMap((field) => Object.keys(manifest[field] ?? {}));
  if (relative === "packages/server/package.json" && edges.includes("@zhixing/executor")) {
    failures.push(`${relative}: server declares production dependency on executor`);
  }
  if (relative === "packages/executor/package.json" && edges.includes("@zhixing/server")) {
    failures.push(`${relative}: executor declares production dependency on server`);
  }
  return failures;
}

export function inspectProductionSource(relative, text, options = {}) {
  const failures = [];
  for (const token of retiredProductionTokens) if (text.includes(token)) failures.push(`${relative}: retired token ${token}`);
  const guarded = guardedRoots.some((prefix) => relative.startsWith(prefix));
  const dependencyGuarded = relative.startsWith("packages/server/") || relative.startsWith("packages/executor/");
  const source = sourceFile(relative, text);
  failures.push(...inspectCliRpcCapabilities(relative, source, options));
  const rpcGuarded = isRpcMethodOwner(relative);
  if (!guarded && !dependencyGuarded && !rpcGuarded) return failures;
  const allowedForwarders = rpcGuarded ? safeRpcForwarders(source) : new Set();
  const visit = (node) => {
    const reference = moduleReference(node);
    if (reference) {
      if (!reference.literal) {
        failures.push(`${relative}: non-literal production module load`);
      } else {
        const specifier = reference.specifier;
        const exposedOwners = options.resolveOwnerExposure?.(relative, specifier) ??
          (specifier === "@zhixing/core"
            ? new Map([...forbiddenWriteOwners].map((name) => [name, name]))
            : new Map());
        if (guarded) {
          for (const binding of directOwnerBindings(node, exposedOwners)) {
            failures.push(
              `${relative}: forbidden writable owner import ${binding.owner} as ${binding.local}`,
            );
          }
          if ((ts.isCallExpression(node) || ts.isImportEqualsDeclaration(node) ||
              (ts.isExportDeclaration(node) && !node.exportClause)) && exposedOwners.size > 0) {
            failures.push(`${relative}: forbidden writable owner namespace from ${specifier}`);
          }
        }
      if (relative.startsWith("packages/server/") && isPackageOrSubpath(specifier, "@zhixing/executor")) failures.push(`${relative}: server imports executor`);
      if (relative.startsWith("packages/executor/") && isPackageOrSubpath(specifier, "@zhixing/server")) failures.push(`${relative}: executor imports server`);
      }
    }
    if (
      rpcGuarded &&
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === "request" || node.expression.name.text === "requestWithReconnect")
    ) {
      const method = node.arguments[0];
      if (!method) {
        failures.push(`${relative}: CLI RPC call has no method`);
      } else if (ts.isStringLiteralLike(method)) {
        if (!builtinRpcNames.has(method.text)) {
          failures.push(`${relative}: CLI forwards to unknown RPC ${method.text}`);
        }
      } else if (!allowedForwarders.has(enclosingMethodName(node))) {
        failures.push(`${relative}: CLI forwards a non-canonical dynamic RPC method`);
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
