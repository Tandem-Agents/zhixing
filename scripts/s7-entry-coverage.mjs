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
  "JsonTaskStore",
  "scheduler.json",
  "WorksceneMigrationMutation",
  "legacyCheckpoint",
  "--rollback",
  "createMemoryTool",
  "MemoryToolPort",
  "MemoryDirectory",
  "memory.profileGet",
  "memory.journalStats",
  "memory.peopleList",
  "workscene_memory_query",
];
const forbiddenWriteOwners = new Set(["SkillStore", "AnchorWorksceneRegistry"]);
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
  ["skill-manage", ["rpc:skill.archive", "rpc:skill.setState", "slash:skills:repl", "tool:builtin:save_skill", "tool:builtin:admit_skill"]],
  ["segment-transition", segmentLifecyclePhases.map((phase) => `lifecycle:segment:${phase}`)],
  ["workspace-binding", ["cli:zhixing workspace status", "cli:zhixing workspace list", "cli:zhixing workspace create", "cli:zhixing workspace create-scene", "cli:zhixing workspace rename", "cli:zhixing workspace repath", "cli:zhixing workspace remove", "cli:zhixing workspace reset"]],
  ["runtime-lifecycle", agentLifecyclePhases.map((phase) => `lifecycle:agent:${phase}`)],
  ["orchestration-child", ["tool:orchestrator:Task"]],
  ["channel-inbound", ["channel:router:InboundRouter", "channel:adapter:feishu", "channel:event:feishu:im.message.receive_v1"]],
  ["status-read", [
    "rpc:server.info",
    "cli:zhixing status",
    "slash:status:repl",
  ]],
  ["light-inference", ["rpc:llm.complete"]],
  ["shutdown", [
    "rpc:server.shutdown",
    "rpc:server.uninstall.preflight",
    "rpc:server.uninstall.begin",
    "rpc:server.uninstall.continue",
    "rpc:server.uninstall.cancel",
    "rpc:server.uninstall.status",
    "rpc:device.list",
    "rpc:device.remove",
    "rpc:device.status",
    "rpc:device.continue",
    "cli:zhixing stop",
    "cli:zhixing app remove",
    "cli:zhixing device list",
    "cli:zhixing device remove",
    "cli:zhixing device status",
    "cli:zhixing device continue",
    "slash:stop:repl",
  ]],
  ["runtime-config", ["slash:config:repl", "slash:mcp:repl"]],
  ["device-trust", [
    "cli:zhixing pair",
    "cli:zhixing duty targets",
    "cli:zhixing duty migrate",
    "cli:zhixing duty continue",
    "cli:zhixing duty cancel",
    "rpc:dutyMigration.targets",
    "rpc:dutyMigration.prepare",
    "rpc:dutyMigration.commit",
    "rpc:dutyMigration.cancel",
  ]],
  ["recovery-backup", ["cli:zhixing backup setup", "cli:zhixing backup verify", "cli:zhixing backup status"]],
  ["disaster-recovery", ["cli:zhixing backup recover", "cli:zhixing backup recover-finish"]],
  ["recovery-root-lifecycle", [
    "cli:zhixing backup root rotate",
    "cli:zhixing backup root invalidate",
    "cli:zhixing backup root approve-reset",
    "cli:zhixing backup root reset",
  ]],
];

const baseMappingTuples = [
  ...coverageGroups.flatMap(([rowId, keys]) =>
    keys.map((key) => [key, { rowId }]),
  ),
  ["rpc:auth", { exclusion: "connection", reason: exclusions.connection }],
  ["rpc:health", { exclusion: "connection", reason: exclusions.connection }],
  ["cli:zhixing", { exclusion: "composition", reason: exclusions.composition }],
  ["cli:zhixing app", { exclusion: "composition", reason: exclusions.composition }],
  [
    "cli:zhixing workspace",
    { exclusion: "composition", reason: exclusions.composition },
  ],
  ["cli:zhixing serve", { exclusion: "composition", reason: exclusions.composition }],
  ["cli:zhixing duty", { exclusion: "composition", reason: exclusions.composition }],
  ["cli:zhixing device", { exclusion: "composition", reason: exclusions.composition }],
  ["cli:zhixing backup", { exclusion: "composition", reason: exclusions.composition }],
  ["cli:zhixing backup root", { exclusion: "composition", reason: exclusions.composition }],
  [
    "cli:zhixing serve logs",
    { exclusion: "diagnostic", reason: exclusions.diagnostic },
  ],
  ["cli:zhixing doctor", { exclusion: "diagnostic", reason: exclusions.diagnostic }],
  ["cli:zhixing help", { exclusion: "localRender", reason: exclusions.localRender }],
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

function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function frozenLiteralDescriptor(relative, text, name) {
  const source = sourceFile(relative, text);
  let declaration;
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    declaration = statement.declarationList.declarations.find(
      (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name,
    );
    if (declaration) break;
  }
  if (!declaration?.initializer) return undefined;
  const initializer = unwrapExpression(declaration.initializer);
  if (
    !ts.isCallExpression(initializer) ||
    initializer.expression.getText(source) !== "Object.freeze" ||
    initializer.arguments.length !== 1
  ) return undefined;
  const object = unwrapExpression(initializer.arguments[0]);
  if (
    ts.isArrayLiteralExpression(object) &&
    object.elements.every((element) => ts.isStringLiteralLike(element))
  ) return object.elements.map((element) => element.text);
  if (!ts.isObjectLiteralExpression(object)) return undefined;
  const result = {};
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) return undefined;
    const key = property.name.getText(source).replaceAll(/["']/g, "");
    const value = unwrapExpression(property.initializer);
    if (ts.isStringLiteralLike(value)) {
      result[key] = value.text;
      continue;
    }
    if (
      ts.isCallExpression(value) &&
      value.expression.getText(source) === "Object.freeze" &&
      value.arguments.length === 1
    ) {
      const array = unwrapExpression(value.arguments[0]);
      if (
        !ts.isArrayLiteralExpression(array) ||
        array.elements.some((element) => !ts.isStringLiteralLike(element))
      ) return undefined;
      result[key] = array.elements.map((element) => element.text);
      continue;
    }
    return undefined;
  }
  return result;
}

function descriptorDrivesPhase(relative, text, descriptorName, inputText) {
  const source = sourceFile(relative, text);
  let found = false;
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "includes" &&
      node.arguments.length === 1 &&
      node.arguments[0].getText(source) === inputText
    ) {
      let usesDescriptor = false;
      const findDescriptor = (child) => {
        if (ts.isIdentifier(child) && child.text === descriptorName) usesDescriptor = true;
        ts.forEachChild(child, findDescriptor);
      };
      findDescriptor(node.expression.expression);
      if (usesDescriptor) found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function newExpressionPropertyBindings(relative, text, constructorName, propertyName) {
  const source = sourceFile(relative, text);
  const bindings = [];
  const visit = (node) => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === constructorName
    ) {
      const options = node.arguments?.[0];
      const property = options && ts.isObjectLiteralExpression(options)
        ? options.properties.find((candidate) =>
            ts.isPropertyAssignment(candidate) && propertyNameText(candidate.name) === propertyName
          )
        : undefined;
      bindings.push(
        property && ts.isPropertyAssignment(property)
          ? property.initializer.getText(source)
          : undefined,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return bindings;
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
  const assemblyLifecycleSource =
    relative === "packages/cli/src/serve/assembly-lifecycle.ts";
  const anchorHostShellSource =
    relative === "packages/cli/src/serve/anchor-host-shell-lifecycle.ts";
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
  const result = assemblyLifecycleSource
    ? collectAssemblyLifecycleDescriptors(relative, source)
    : anchorHostShellSource
      ? [collectNamedCleanupDescriptor(
          relative,
          source,
          "ANCHOR_HOST_SHELL_CLEANUP_DESCRIPTOR",
        )]
      : [];
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
        const typedLifecycleTransfer = (assemblyLifecycleSource || anchorHostShellSource) &&
          descriptor && ts.isIdentifier(descriptor) &&
          (
            descriptor.text === "descriptor" ||
            descriptor.text === "ANCHOR_HOST_SHELL_CLEANUP_DESCRIPTOR"
          );
        if (typedLifecycleTransfer) {
          // The finite literal descriptor table above is the contract source;
          // this call transfers one of those typed entries without rebuilding it.
        } else if (!descriptor || !ts.isObjectLiteralExpression(descriptor)) {
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

function collectNamedCleanupDescriptor(relative, source, name) {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
      const descriptor = unwrapStaticExpression(declaration.initializer);
      if (!descriptor || !ts.isObjectLiteralExpression(descriptor)) break;
      const owner = literalProperty(descriptor, "owner");
      const role = literalProperty(descriptor, "role");
      const id = literalProperty(descriptor, "id");
      if (!owner || !role || !id) break;
      return { owner, role, id, source: relative };
    }
  }
  throw new Error(`${relative}: ${name} must be one literal cleanup descriptor`);
}

function collectAssemblyLifecycleDescriptors(relative, source) {
  const initializers = new Map();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        [
          "ASSEMBLY_LIFECYCLE_DESCRIPTORS",
          "ANCHOR_RUNTIME_LIFECYCLE_DESCRIPTORS",
        ].includes(declaration.name.text)
      ) initializers.set(declaration.name.text, declaration.initializer);
    }
  }
  const result = [];
  for (const tableName of [
    "ASSEMBLY_LIFECYCLE_DESCRIPTORS",
    "ANCHOR_RUNTIME_LIFECYCLE_DESCRIPTORS",
  ]) {
    const table = unwrapStaticExpression(initializers.get(tableName));
    if (!table || !ts.isArrayLiteralExpression(table)) {
      throw new Error(`${relative}: ${tableName} must be a literal array`);
    }
    for (const element of table.elements) {
      const descriptor = unwrapStaticExpression(element);
      if (!descriptor || !ts.isObjectLiteralExpression(descriptor)) {
        throw new Error(`${relative}: assembly lifecycle descriptor must be an object literal`);
      }
      const owner = literalProperty(descriptor, "owner");
      const role = literalProperty(descriptor, "role");
      const id = literalProperty(descriptor, "id");
      const stage = literalProperty(descriptor, "stage");
      if (!owner || !role || !id) {
        throw new Error(`${relative}: cleanup descriptor owner/role/id must be literal`);
      }
      if (!stage) {
        throw new Error(`${relative}: assembly lifecycle stage must be literal`);
      }
      if (![
        "anchor-host",
        "anchor-local-executor",
        "standalone-server",
      ].includes(owner)) {
        throw new Error(`${relative}: unknown cleanup owner ${owner}`);
      }
      if (!["foundation", "surface", "post-server", "runtime", "activation"].includes(stage)) {
        throw new Error(`${relative}: unknown assembly lifecycle stage ${stage}`);
      }
      result.push({ owner, role, id, source: relative });
    }
  }
  return result;
}

function unwrapStaticExpression(expression) {
  let current = expression;
  while (
    current &&
    (ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current))
  ) current = current.expression;
  return current;
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
  const nonAuthorityNames = new Set(["workscene_list"]);
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
  failures.push(...inspectRecoveryBackupAssembly(records));
  failures.push(...inspectPlannedAnchorTransferAssembly(records));
  failures.push(...inspectManagedHostAssembly(records));
  failures.push(...inspectDeviceLifecycleAssembly(records));
  failures.push(...inspectSkillCatalogApplicationOwnership([
    ...records,
    {
      relative: "packages/core/package.json",
      text: await readFile(path.join(root, "packages/core/package.json"), "utf8"),
    },
  ]));
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

/** A2 Skill Catalog management must have one domain application owner. */
export function inspectSkillCatalogApplicationOwnership(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const required = (relative) => {
    const text = byPath.get(relative);
    if (text === undefined) failures.push(`${relative}: Skill Catalog production source is missing`);
    return text ?? "";
  };

  const application = required("packages/core/src/skills/catalog-application.ts");
  const coreIndex = required("packages/core/src/index.ts");
  const skillIndex = required("packages/core/src/skills/index.ts");
  const coreManifestText = required("packages/core/package.json");
  const coreBuild = required("packages/core/tsup.config.ts");
  const handler = required("packages/server/src/rpc/methods/skill.ts");
  const context = required("packages/server/src/context.ts");
  const composition = required("packages/cli/src/serve/command.ts");
  const cliDirectories = required("packages/cli/src/serve/management-directories.ts");
  const assignmentSkillPort = required(
    "packages/orchestrator/src/runtime/assignment-skill-port.ts",
  );
  const assignmentMutationIdentity = required(
    "packages/core/src/protocol/assignment-mutation.ts",
  );
  const assignmentMutationPort = required(
    "packages/cli/src/serve/assignment-schedule-stager.ts",
  );
  const agentRuntime = required(
    "packages/orchestrator/src/runtime/create-agent-runtime.ts",
  );
  const builtinSkill = required("packages/tools-builtin/src/skill.ts");
  const builtinFactories = required("packages/tools-builtin/src/factories.ts");
  const builtinIndex = required("packages/tools-builtin/src/index.ts");
  const admissionStart = application.indexOf(
    "export interface SkillCatalogAdmissionRequest",
  );
  const saveApplication = admissionStart >= 0
    ? application.slice(0, admissionStart)
    : application;

  let coreManifest;
  try {
    coreManifest = JSON.parse(coreManifestText);
  } catch {
    failures.push("Core manifest is invalid while checking the Skill Catalog subpath");
  }
  const skillCatalogExport = coreManifest?.exports?.["./skills/catalog"];
  if (
    skillCatalogExport?.types !== "./dist/skills/catalog-application.d.ts" ||
    skillCatalogExport?.import !== "./dist/skills/catalog-application.js"
  ) {
    failures.push("Skill Catalog must have one canonical core domain subpath");
  }
  const duplicateSkillCatalogExports = Object.entries(coreManifest?.exports ?? {})
    .filter(([subpath, conditions]) =>
      subpath !== "./skills/catalog" &&
      conditions &&
      typeof conditions === "object" &&
      (conditions.types === skillCatalogExport?.types ||
        conditions.import === skillCatalogExport?.import)
    );
  if (duplicateSkillCatalogExports.length > 0) {
    failures.push("Skill Catalog contract has a second package export entry");
  }
  if (
    coreIndex.includes("catalog-application") ||
    skillIndex.includes("catalog-application") ||
    skillIndex.includes("SkillCatalogApplication") ||
    skillIndex.includes("SkillCatalogAdmissionApplication") ||
    skillIndex.includes("SkillCatalogLoadApplication") ||
    skillIndex.includes("SkillCatalogSaveApplication") ||
    skillIndex.includes("runSkillSavePipeline")
  ) {
    failures.push("Skill Catalog application contract leaked into the core root barrel");
  }
  if (coreBuild.split('"src/skills/catalog-application.ts"').length - 1 !== 1) {
    failures.push("Skill Catalog canonical subpath lacks one dedicated build entry");
  }

  for (const record of records) {
    if (/\bSkillTextLoader\b|\bskillLoader\b/u.test(record.text)) {
      failures.push(`${record.relative}: retired parallel Skill load application owner`);
    }
    if (
      record.relative === "packages/core/src/skills/save-pipeline.ts" ||
      /\b(?:runSkillSavePipeline|SkillSaver)\b/u.test(record.text)
    ) {
      failures.push(`${record.relative}: retired parallel Skill save application owner`);
    }
    if (
      /\b(?:SkillAdmissionPort|SkillAdmissionAssess|SkillAdmissionWorkspace)\b/u.test(record.text)
    ) {
      failures.push(`${record.relative}: retired parallel Skill admission application owner`);
    }
    if (
      (record.relative.startsWith("packages/server/src/") ||
        record.relative.startsWith("packages/cli/src/")) &&
      /\b(?:SkillDirectory|createSkillDirectory)\b/u.test(record.text)
    ) {
      failures.push(`${record.relative}: retired parallel Skill management application owner`);
    }
    if (
      (record.relative.startsWith("packages/server/src/") ||
        record.relative.startsWith("packages/cli/src/")) &&
      /kind:\s*["']skill-(?:set-state|archive)["']/u.test(record.text)
    ) {
      failures.push(`${record.relative}: binding writes Skill GlobalState directly`);
    }
  }

  if (!application.includes("class SkillCatalogApplicationService")) {
    failures.push("Skill Catalog domain application service is missing");
  }
  if (
    !saveApplication.includes("class SkillCatalogSaveApplicationService") ||
    !saveApplication.includes("interface SkillCatalogSaveCorrectnessPort") ||
    !saveApplication.includes("scrubSecrets(draft.name)") ||
    !saveApplication.includes("stringifyFrontmatter(") ||
    !saveApplication.includes("skillNameToId(normalized.name)")
  ) {
    failures.push("Skill Catalog save invariants lack one domain application owner");
  }
  const loadStart = application.indexOf("export interface SkillCatalogLoadRequest");
  const loadEnd = application.indexOf(
    "/** Skill-owned request for the admit_skill two-stage lifecycle.",
  );
  const loadApplication = loadStart >= 0 && loadEnd > loadStart
    ? application.slice(loadStart, loadEnd)
    : "";
  if (
    !loadApplication.includes("class SkillCatalogLoadApplicationService") ||
    !loadApplication.includes("interface SkillCatalogLoadCorrectnessPort") ||
    !loadApplication.includes("const builtin = getBuiltinSkill(id)") ||
    !loadApplication.includes("foldSkillCatalogEntry(") ||
    !loadApplication.includes("const parsed = parseFrontmatter(document)") ||
    !loadApplication.includes('scope.kind === "builtin-only"') ||
    !loadApplication.includes(
      "User skills require an active artifact-backed assignment",
    ) ||
    !loadApplication.includes("`${request.operationId}:usage`") ||
    !loadApplication.includes('kind: "skill-usage"')
  ) {
    failures.push("Skill Catalog load and usage invariants lack one domain application owner");
  }
  const loadContent = loadApplication.indexOf(
    "await this.correctness.readContent(entry.contentRef)",
  );
  const loadParse = loadApplication.indexOf("parseFrontmatter(document)");
  const loadStage = loadApplication.indexOf("await this.correctness.stageUsage(");
  if (!(loadContent >= 0 && loadParse > loadContent && loadStage > loadParse)) {
    failures.push("Skill Catalog usage must stage only after artifact read and document parsing");
  }
  if (
    !application.includes("class SkillCatalogAdmissionApplicationService") ||
    !application.includes("interface SkillCatalogAdmissionCorrectnessPort") ||
    !application.includes("readonly #pending = new Map") ||
    !application.includes("await assessSkill(") ||
    !application.includes("ADMISSION_TOKEN_TTL_MS") ||
    !application.includes("candidate.digest !== pending.digest") ||
    !application.includes("`${operationId}:admit`")
  ) {
    failures.push("Skill Catalog admission lifecycle lacks one domain application owner");
  }
  const admitArtifact = application.lastIndexOf("await this.correctness.putContent(");
  const admitStage = application.lastIndexOf("await this.correctness.stage(");
  if (!(admitArtifact >= 0 && admitStage > admitArtifact)) {
    failures.push("Skill Catalog admit must stage only after its content artifact exists");
  }
  if (
    !saveApplication.includes("requestIdentityFor(stagedOperationId)") ||
    !saveApplication.includes("record.requestIdentity === currentRequestIdentity") ||
    !saveApplication.includes("record.recordSeq >= replayRecordSeq") ||
    !saveApplication.includes("sameSkillSaveDraft(replayMutation, candidate)") ||
    !saveApplication.includes("const mutation = exactReplay")
  ) {
    failures.push(
      "Skill Catalog save replay does not exclude its own durable operation at the exact overlay boundary",
    );
  }
  const saveArtifact = saveApplication.indexOf("await this.correctness.putContent(");
  const saveStage = saveApplication.indexOf("await this.correctness.stage(");
  if (
    !(saveArtifact >= 0 && saveStage > saveArtifact) ||
    !saveApplication.includes("`${operationId}:save`")
  ) {
    failures.push("Skill Catalog save must stage one stable operation only after content artifact creation");
  }
  const commit = application.indexOf("await this.#state().mutate(");
  const fact = application.lastIndexOf('kind: "skill-catalog-changed"');
  if (
    !(commit >= 0 && fact > commit) ||
    !application.includes("catalogRevision: committed.catalogRevision")
  ) {
    failures.push("Skill Catalog fact must use the exact revision returned after authority commit");
  }
  if (!context.includes("skillCatalog?: SkillCatalogApplication") || context.includes("SkillDirectory")) {
    failures.push("ServerContext must consume the Skill-owned application contract only");
  }
  for (const [relative, text] of [
    ["packages/server/src/context.ts", context],
    ["packages/server/src/rpc/methods/skill.ts", handler],
    ["packages/cli/src/serve/command.ts", composition],
  ]) {
    if (!text.includes('from "@zhixing/core/skills/catalog"')) {
      failures.push(`${relative}: Skill Catalog contract bypasses its domain subpath`);
    }
    for (const match of text.matchAll(
      /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["'](@zhixing\/core)["']/gu,
    )) {
      if (/\bSkillCatalogApplication(?:Error|Service)?\b/u.test(match[1])) {
        failures.push(`${relative}: Skill Catalog contract leaked back through core root import`);
      }
    }
  }
  if (!composition.includes("new SkillCatalogApplicationService({")) {
    failures.push("Anchor composition root does not install the Skill Catalog application service");
  }
  for (const [relative, text] of [
    ["packages/orchestrator/src/runtime/assignment-skill-port.ts", assignmentSkillPort],
    ["packages/tools-builtin/src/skill.ts", builtinSkill],
    ["packages/tools-builtin/src/factories.ts", builtinFactories],
  ]) {
    if (!text.includes('from "@zhixing/core/skills/catalog"')) {
      failures.push(`${relative}: Skill save contract bypasses its domain subpath`);
    }
    for (const match of text.matchAll(
      /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["'](@zhixing\/core)["']/gu,
    )) {
      if (/\bSkillCatalog(?:Save|Admission|Load)Application(?:Service)?\b/u.test(match[1])) {
        failures.push(`${relative}: Skill application contract leaked back through core root import`);
      }
    }
  }
  if (
    assignmentSkillPort.includes("getBuiltinSkill") ||
    assignmentSkillPort.includes("parseFrontmatter") ||
    assignmentSkillPort.includes("skillNameToId") ||
    !assignmentSkillPort.includes("new SkillCatalogLoadApplicationService(") ||
    !assignmentSkillPort.includes("createSkillCatalogLoadCorrectnessPort(artifacts)") ||
    !assignmentSkillPort.includes("async readScope(skillId)") ||
    !assignmentSkillPort.includes("const run = requireRunSkillContext()") ||
    assignmentSkillPort.includes("return { kind: \"builtin-only\" }") ||
    !assignmentSkillPort.includes("async stageUsage(operationId, mutation)")
  ) {
    failures.push("Orchestrator retains Skill load business orchestration or omits the domain adapter");
  }
  if (
    assignmentSkillPort.includes("scrubSecrets") ||
    assignmentSkillPort.includes("stringifyFrontmatter") ||
    assignmentSkillPort.includes("SkillDraft") ||
    !assignmentSkillPort.includes("new SkillCatalogSaveApplicationService(") ||
    !assignmentSkillPort.includes("createSkillCatalogSaveCorrectnessPort(artifacts)")
  ) {
    failures.push("Orchestrator retains Skill save business orchestration or omits the domain service");
  }
  if (
    !assignmentSkillPort.includes("new SkillCatalogAdmissionApplicationService(") ||
    !assignmentSkillPort.includes("implements SkillCatalogAdmissionCorrectnessPort") ||
    !assignmentSkillPort.includes("acquireLocalCandidate(") ||
    !assignmentSkillPort.includes("assertRegularCandidateTree(") ||
    assignmentSkillPort.includes("class SkillAdmissionWorkspace")
  ) {
    failures.push("Orchestrator does not provide the path-free Skill admission adapter");
  }
  if (
    !assignmentMutationIdentity.includes(
      'protocolDigest("AssignmentMutationRequest", 1, input)',
    ) ||
    !assignmentMutationPort.includes(
      "const requestId = assignmentMutationRequestId({",
    ) ||
    !assignmentSkillPort.includes(
      "return assignmentMutationRequestId({",
    ) ||
    !assignmentSkillPort.includes("requestIdentity: record.requestId") ||
    !assignmentSkillPort.includes("recordSeq: record.recordSeq")
  ) {
    failures.push(
      "Skill save replay identity is not shared with the durable assignment mutation ledger",
    );
  }
  if (
    !builtinSkill.includes("application: SkillCatalogLoadApplication") ||
    !builtinSkill.includes("await application.load({") ||
    builtinSkill.includes("loadText(") ||
    builtinFactories.includes("SkillTextLoader")
  ) {
    failures.push("load_skill binding must consume only the Skill-owned application contract");
  }
  if (
    !builtinSkill.includes("application: SkillCatalogSaveApplication") ||
    !builtinSkill.includes("await application.save(") ||
    builtinSkill.includes("SkillSaver") ||
    builtinIndex.includes("SkillSaver")
  ) {
    failures.push("save_skill binding must consume only the Skill-owned application contract");
  }
  if (
    !builtinSkill.includes("application: SkillCatalogAdmissionApplication") ||
    !builtinSkill.includes("await application.admit(") ||
    builtinSkill.includes("new Map<string, PendingAdmission>") ||
    builtinSkill.includes("function firstCall(") ||
    builtinSkill.includes("function confirmAdmission(") ||
    builtinSkill.includes("computeStagingDigest") ||
    builtinSkill.includes("acquireToStaging")
  ) {
    failures.push("admit_skill binding retains a parallel admission state machine");
  }
  if (
    !builtinFactories.includes("skillCatalogLoad?: SkillCatalogLoadApplication") ||
    !agentRuntime.includes("skillCatalogLoad: skillPorts.loadApplication") ||
    !agentRuntime.includes('return { kind: "builtin-only" }') ||
    agentRuntime.includes("skillLoader: skillPorts.loader")
  ) {
    failures.push("Agent runtime does not install the unique Skill load application binding");
  }
  if (
    !builtinFactories.includes("skillCatalogSave?: SkillCatalogSaveApplication") ||
    !agentRuntime.includes("skillCatalogSave: skillPorts.saveApplication") ||
    agentRuntime.includes("skillSaver: skillPorts.saver")
  ) {
    failures.push("Agent runtime does not install the unique Skill save application binding");
  }
  if (
    !builtinFactories.includes(
      "skillCatalogAdmission?: SkillCatalogAdmissionApplication",
    ) ||
    !agentRuntime.includes(
      "skillCatalogAdmission: skillPorts.admissionApplication",
    ) ||
    builtinFactories.includes("admissionLlm?: AdmissionLlm") ||
    builtinFactories.includes("skillAdmission?: SkillAdmissionPort")
  ) {
    failures.push("Agent runtime does not install the unique Skill admission application binding");
  }
  if (cliDirectories.includes("GlobalStatePort") || cliDirectories.includes("skill-set-state")) {
    failures.push("CLI management directories retain a direct Skill correctness adapter");
  }
  if (handler.includes("GlobalStatePort") || handler.includes(".mutate(")) {
    failures.push("Skill RPC binding owns a direct Skill mutation path");
  }
  if (
    handler.includes("RpcErrors.busy(error.message)") ||
    !handler.includes('if (error.code === "not-found")') ||
    !handler.includes('if (error.code === "invalid-command")') ||
    !handler.includes("throw error;")
  ) {
    failures.push("Skill RPC binding changed the pre-migration conflict wire contract");
  }
  const executeCalls = [...handler.matchAll(/const result = await callSkillApplication/gu)]
    .map((match) => match.index);
  const factTransports = [...handler.matchAll(/broadcastChanged\(ctx\.server, result\.fact\)/gu)]
    .map((match) => match.index);
  if (
    executeCalls.length !== 2 ||
    factTransports.length !== 2 ||
    executeCalls.some((position, index) => factTransports[index] <= position)
  ) {
    failures.push("Skill RPC fact transport must follow each successful application command");
  }
  return failures;
}

export function inspectDeviceLifecycleAssembly(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const protocol = byPath.get("packages/core/src/protocol/device-lifecycle.ts");
  const journal = byPath.get("packages/core/src/authority/device-lifecycle-journal.ts");
  const removal = byPath.get("packages/cli/src/serve/device-removal.ts");
  const assembly = byPath.get("packages/cli/src/serve/mesh-runtime-assembly.ts");
  const command = byPath.get("packages/cli/src/serve/command.ts");
  const executor = byPath.get("packages/cli/src/serve/executor-role-runtime.ts");
  const methods = byPath.get("packages/server/src/rpc/methods/index.ts");
  if (!protocol || !journal || !removal || !assembly || !command || !executor || !methods) {
    return ["device lifecycle production assembly sources are missing"];
  }
  const count = (text, token) => text.split(token).length - 1;
  if (
    count(protocol, 'export const DEVICE_LIFECYCLE_STREAM = "device-lifecycle"') !== 1 ||
    !journal.includes('stream: DEVICE_LIFECYCLE_STREAM') ||
    !journal.includes('record.t === "advanced" || record.t === "terminal"') ||
    !protocol.includes('`${identity.homeId}\\u0000device:${identity.localDeviceId}`')
  ) failures.push("device lifecycle single journal or retained terminal evidence drifted");
  if (
    !removal.includes("await this.options.closeAdmission(identity.operationId)") ||
    !removal.includes("await this.options.settleAcceptedWork({") ||
    !removal.includes("ownerItems,") ||
    !removal.includes("async resumeBeforeAdmission(): Promise<void>") ||
    !assembly.includes("await this.#deviceRemovalTarget.restoreLocalAdmissionGate()") ||
    !assembly.includes("await this.#deviceRemovalTarget.resumeBeforeAdmission()") ||
    !command.includes("await ctx.meshRuntime?.bindDeviceRemovalLifecycle({") ||
    !executor.includes("await mesh.bindDeviceRemovalLifecycle({") ||
    !executor.includes("const stopCoordinator = new HostStopCoordinator({") ||
    !executor.includes("lifecycleShutdown: stopCoordinator,") ||
    !executor.includes("await waitForExecutorRoleTerminal({") ||
    !executor.includes("server: localConversationServer,") ||
    !executor.includes("deviceRemoved: lifecycleShutdown,")
  ) failures.push("device removal admission, accepted-work or two-root recovery binding drifted");
  if (
    !assembly.includes("log: options.bootstrapStore.authorityLog(),") ||
    assembly.includes("log: options.authority.executorLog,") ||
    command.includes("activeDeliveryLifecycleOperationId") ||
    !command.includes('delivery: stopPort("delivery", async ({ operationId, strategy, timeoutMs }) =>')
  ) failures.push("local lifecycle authority root or exact delivery operation ownership drifted");
  for (const method of [
    "server.shutdown",
    "server.uninstall.preflight",
    "server.uninstall.begin",
    "server.uninstall.continue",
    "server.uninstall.cancel",
    "server.uninstall.status",
  ]) {
    if (!methods.includes(`"${method}"`)) {
      failures.push(`device-local lifecycle RPC ownership drifted: ${method}`);
    }
  }
  return failures;
}

export function inspectManagedHostAssembly(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const reconciler = byPath.get("packages/cli/src/serve/managed-service-reconciler.ts");
  const service = byPath.get("packages/cli/src/serve/managed-service.ts");
  const serviceRuntime = byPath.get("packages/cli/src/serve/managed-service-runtime.ts");
  const bootstrap = byPath.get("packages/mesh/src/bootstrap.ts");
  const pairing = byPath.get("packages/cli/src/serve/mesh-pair-command.ts");
  const config = byPath.get("packages/cli/src/runtime/config-command.ts");
  const command = byPath.get("packages/cli/src/serve/command.ts");
  const accessSurface = byPath.get("packages/cli/src/serve/access-surface.ts");
  const accessSurfaces = byPath.get("packages/cli/src/serve/access-surfaces.ts");
  const assemblyLifecycle = byPath.get("packages/cli/src/serve/assembly-lifecycle.ts");
  const executorRoleLifecycle = byPath.get("packages/cli/src/serve/executor-role-lifecycle.ts");
  const executorServerLifecycle = byPath.get("packages/cli/src/serve/executor-server-lifecycle.ts");
  const anchorHostShell = byPath.get(
    "packages/cli/src/serve/anchor-host-shell-lifecycle.ts",
  );
  const anchorInternalStop = byPath.get("packages/cli/src/serve/anchor-internal-stop.ts");
  const executorRoot = byPath.get("packages/cli/src/serve/executor-role-runtime.ts");
  const executorInternalStop = byPath.get("packages/cli/src/serve/executor-internal-stop.ts");
  const topology = byPath.get("packages/cli/src/serve/topology-command.ts");
  const applicationHost = byPath.get("packages/cli/src/serve/application-host.ts");
  const roleTopology = byPath.get("packages/cli/src/serve/role-topology.ts");
  const connection = byPath.get("packages/cli/src/runtime/core-host-connection.ts");
  const repl = byPath.get("packages/cli/src/repl.ts");
  const surfaceLink = byPath.get("packages/cli/src/runtime/surface-core-host-link.ts");
  const secrets = byPath.get("packages/secrets/src/platform-secret-store.ts");
  const status = byPath.get("packages/cli/src/serve/status.ts");
  const publicStatus = byPath.get("packages/server/src/managed-host-status.ts");
  const statusRoute = byPath.get("packages/server/src/routes.ts");
  const scheduler = byPath.get("packages/cli/src/serve/anchor-scheduler-runtime.ts");
  const manifest = byPath.get("packages/core/src/protocol/manifest.ts");
  const serverContext = byPath.get("packages/server/src/context.ts");
  const serverShutdown = byPath.get("packages/server/src/rpc/methods/server.ts");
  const serverLifecycle = byPath.get("packages/server/src/lifecycle.ts");
  const server = byPath.get("packages/server/src/server.ts");
  const serverIndex = byPath.get("packages/server/src/index.ts");
  if (
    !reconciler || !service || !serviceRuntime || !bootstrap || !pairing || !config ||
    !command || !accessSurface || !accessSurfaces || !assemblyLifecycle ||
    !executorRoleLifecycle || !executorServerLifecycle || !anchorHostShell ||
    !anchorInternalStop || !executorRoot || !executorInternalStop || !topology || !applicationHost || !roleTopology || !connection || !repl || !surfaceLink || !secrets || !status ||
    !publicStatus || !statusRoute || !scheduler || !manifest || !serverContext || !serverShutdown ||
    !serverLifecycle || !server || !serverIndex
  ) return ["managed host production assembly sources are missing"];
  const count = (text, token) => text.split(token).length - 1;
  const assemblyLifecycleIds = [
    "authorityRuntime.stopStorageMaintenance",
    "localWorkspaceHost.close",
    "localConversationOwner.close",
    "channels.dispose",
    "deliveryStack.stop",
    "mcpHub.dispose",
    "meshRuntime.stop",
    "executorDataPlane.close",
    "jobStatus.dispose",
    "assetMaintenance.stop",
    "executorJobOwner.close",
    "losslessDataPlane.close",
  ];
  const anchorRuntimeLifecycleIds = [
    "confirmationBridge.dispose",
    "execution.abortAllAndWait",
    "conversationProtocol.stopRecovery",
    "scheduler.stop",
    "inboundRouter.refuseNew",
    "evidenceHandler.stopAccepting",
  ];
  const allAnchorLifecycleIds = [
    ...assemblyLifecycleIds,
    ...anchorRuntimeLifecycleIds,
  ];
  const lifecycleDescriptors = collectCleanupRegistrationsFromSource(
    "packages/cli/src/serve/assembly-lifecycle.ts",
    assemblyLifecycle,
  );
  const contributionCount = (identity) => {
    const escaped = identity.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const pattern = new RegExp(
      `lifecycleContributions\\.(?:acquire|contribute)\\(\\s*"${escaped}"`,
      "gu",
    );
    return [...`${accessSurfaces}\n${command}`.matchAll(pattern)].length;
  };
  const postServerSetup = command.indexOf(
    'await setupAssemblyUnits(assemblyUnits, ctx, "post-server")',
  );
  const postServerTransfer = command.indexOf(
    'lifecycleContributions.transferExactTo(\n        registry,\n        "post-server",',
    postServerSetup,
  );
  const runtimeTransfer = command.indexOf(
    'lifecycleContributions.transferTo(registry, "runtime")',
  );
  const activationTransfer = command.indexOf(
    'lifecycleContributions.transferExactTo(registry, "activation", [',
    runtimeTransfer,
  );
  const transferAssertion = command.indexOf(
    "lifecycleContributions.assertTransferred()",
    activationTransfer,
  );
  const rollbackCommit = command.indexOf("startupRollback.commit()", transferAssertion);
  const schedulerHandle = command.indexOf("schedulerCleanup = startupRollback.register(");
  const schedulerContribution = command.indexOf(
    'lifecycleContributions.contribute("scheduler.stop", schedulerCleanup)',
    schedulerHandle,
  );
  const schedulerFirstAwait = command.indexOf("await ", schedulerContribution);
  const evidenceConstruction = accessSurfaces.indexOf(
    "const evidenceHandler = new ExecutorEvidenceHandler({",
  );
  const evidenceContribution = accessSurfaces.indexOf(
    '"evidenceHandler.stopAccepting",',
    evidenceConstruction,
  );
  const evidenceFirstAwait = accessSurfaces.indexOf("await ", evidenceConstruction);
  const managerConstruction = accessSurfaces.indexOf("manager = new ConversationManager(");
  const executionContribution = accessSurfaces.indexOf(
    '"execution.abortAllAndWait",',
    managerConstruction,
  );
  const managerFirstEffect = accessSurfaces.indexOf(
    "await ctx.executorDataPlane.start()",
    managerConstruction,
  );
  const inboundConstruction = accessSurfaces.indexOf("const router = result.router;");
  const inboundContribution = accessSurfaces.indexOf(
    '"inboundRouter.refuseNew",',
    inboundConstruction,
  );
  const inboundFirstAwait = accessSurfaces.indexOf("await ", inboundConstruction);
  const confirmationConstruction = accessSurfaces.indexOf(
    "const confirmationBridge = createConfirmationBridge({",
  );
  const confirmationContribution = accessSurfaces.indexOf(
    '"confirmationBridge.dispose",',
    confirmationConstruction,
  );
  const recoveryContribution = accessSurfaces.indexOf(
    '"conversationProtocol.stopRecovery",',
    confirmationContribution,
  );
  const recoveryStart = accessSurfaces.indexOf(
    "protocol.startRecoveryLoop();",
    recoveryContribution,
  );
  if (
    lifecycleDescriptors.length !== allAnchorLifecycleIds.length ||
    lifecycleDescriptors.map(({ id }) => id).join("\n") !== allAnchorLifecycleIds.join("\n") ||
    assemblyLifecycleIds.some((identity) => contributionCount(identity) !== 1) ||
    [accessSurface, accessSurfaces, command, anchorHostShell]
      .some((source) => source.includes("startupCleanups") || source.includes("AssemblyStartupCleanups")) ||
    count(command, 'lifecycleContributions.transferTo(registry, "foundation")') !== 1 ||
    count(command, 'lifecycleContributions.transferTo(registry, "surface")') !== 1 ||
    count(command, 'lifecycleContributions.transferTo(registry, "runtime")') !== 1 ||
    runtimeTransfer < 0 || transferAssertion < runtimeTransfer || rollbackCommit < transferAssertion ||
    count(assemblyLifecycle, "registerCleanup(registry, descriptor, () => contribution.handle.run())") !== 1 ||
    count(assemblyLifecycle, "if (!this.#rollback.owns(handle))") !== 1 ||
    count(assemblyLifecycle, "Assembly lifecycle contribution already exists") !== 1
  ) failures.push("Anchor pre-server lifecycle contribution ownership drifted");
  if (
    anchorRuntimeLifecycleIds.some((identity) => contributionCount(identity) !== 1) ||
    accessSurface.includes("readonly cleanup: CleanupRegistry") ||
    accessSurfaces.includes("registerCleanup(") ||
    postServerSetup < 0 || postServerTransfer <= postServerSetup ||
    runtimeTransfer <= postServerTransfer || activationTransfer <= runtimeTransfer ||
    transferAssertion <= activationTransfer || rollbackCommit <= transferAssertion ||
    schedulerHandle < 0 || schedulerContribution <= schedulerHandle ||
    schedulerContribution >= schedulerFirstAwait ||
    evidenceConstruction < 0 || evidenceContribution <= evidenceConstruction ||
    evidenceContribution >= evidenceFirstAwait ||
    managerConstruction < 0 || executionContribution <= managerConstruction ||
    managerFirstEffect < 0 || executionContribution >= managerFirstEffect ||
    inboundConstruction < 0 || inboundContribution <= inboundConstruction ||
    inboundContribution >= inboundFirstAwait ||
    confirmationConstruction < 0 || confirmationContribution <= confirmationConstruction ||
    recoveryContribution <= confirmationContribution || recoveryStart <= recoveryContribution ||
    count(assemblyLifecycle, "transferExactTo(") !== 1 ||
    !assemblyLifecycle.includes("Assembly lifecycle ${stage} exact-set mismatch") ||
    anchorRuntimeLifecycleIds.some((identity) =>
      command.includes(`id: "${identity}"`) ||
      accessSurfaces.includes(`id: "${identity}"`)
    )
  ) failures.push("Anchor activation-gate runtime lifecycle contribution ownership drifted");
  const executorRoleLifecycleIds = [
    "localConversationOwner.close",
    "evidenceHandler.stopAccepting",
    "localWorkspaceHost.close",
    "executorJobOwnerLifecycle.close",
    "executorDataPlane.close",
    "authorityRuntime.stopStorageMaintenance",
    "mcpHub.dispose",
  ];
  const executorLifecyclePositions = executorRoleLifecycleIds.map((identity) =>
    executorRoleLifecycle.indexOf(`{ owner: "executor-role", id: "${identity}" }`)
  );
  const executorCleanupTail = executorRoot.slice(
    executorRoot.indexOf("const cleanupFailures: unknown[] = []"),
  );
  const executorMeshConstruction = executorRoot.indexOf("mesh = new MeshRuntimeAssembly({");
  const executorJobLifecycleConstruction = executorRoot.indexOf(
    "const jobOwnerLifecycle = new ExecutorJobOwnerLifecycle(",
    executorMeshConstruction,
  );
  const executorJobLifecycleContribution = executorRoot.indexOf(
    '"executorJobOwnerLifecycle.close"',
    executorJobLifecycleConstruction,
  );
  const firstAwaitAfterExecutorMesh = executorRoot.indexOf("await ", executorMeshConstruction);
  if (
    count(executorRoleLifecycle, 'owner: "executor-role"') !==
      executorRoleLifecycleIds.length ||
    executorLifecyclePositions.some((position) => position < 0) ||
    executorLifecyclePositions.some((position, index) =>
      index > 0 && position <= executorLifecyclePositions[index - 1]) ||
    count(executorRoot, "new ExecutorRoleLifecycle()") !== 1 ||
    count(executorRoot, "executorRoleLifecycle.acquire(") !== 6 ||
    executorRoleLifecycleIds
      .filter((identity) => identity !== "authorityRuntime.stopStorageMaintenance")
      .some((identity) => count(executorRoot, `"${identity}"`) !== 1) ||
    count(executorRoot, "executorRoleLifecycle.authorityStartupRollback()") !== 1 ||
    count(executorRoot, "executorRoleLifecycle.adoptAuthority(authority.startupCleanup)") !== 1 ||
    count(executorRoot, "executorRoleLifecycle.seal()") !== 1 ||
    count(executorRoot, "await executorRoleLifecycle.close()") !== 1 ||
    executorMeshConstruction < 0 ||
    executorJobLifecycleConstruction <= executorMeshConstruction ||
    executorJobLifecycleContribution <= executorJobLifecycleConstruction ||
    firstAwaitAfterExecutorMesh <= executorJobLifecycleContribution ||
    !executorRoot.slice(firstAwaitAfterExecutorMesh).startsWith("await mesh.bindDeviceRemovalLifecycle({") ||
    !executorRoleLifecycle.includes("this.#authorityRollback.owns(handle)") ||
    !executorRoleLifecycle.includes("Executor role lifecycle contributions are incomplete") ||
    !executorRoleLifecycle.includes("for (const { id } of EXECUTOR_ROLE_LIFECYCLE_DESCRIPTORS)") ||
    [
      "await localConversationOwner?.close()",
      "evidenceHandler?.stopAccepting()",
      "await localWorkspaceHost?.close()",
      "await jobOwnerLifecycle.close()",
      "await jobOwnerAssembly?.close()",
      "await mesh?.stop()",
      "await dataPlane?.close()",
      "await authority?.stopStorageMaintenance()",
      "await mcpHub.dispose()",
    ].some((token) => executorCleanupTail.includes(token))
  ) failures.push("Executor non-Server lifecycle contribution ownership drifted");
  const executorServerLifecycleIds = [
    "inactiveBinding.close",
    "runningServer.shutdown",
    "serverState.lifecycle",
    "heartbeatTimer.clear",
    "idleTimer.clearAndSettle",
  ];
  const executorServerLifecyclePositions = executorServerLifecycleIds.map((identity) =>
    executorServerLifecycle.indexOf(`{ owner: "executor-server", id: "${identity}" }`)
  );
  const executorBinding = executorRoot.indexOf("const localServerBinding = await bindServer({");
  const executorBindingOwner = executorRoot.indexOf(
    "executorServerLifecycle.acquireBinding(localServerBinding)",
    executorBinding,
  );
  const executorFirstAwaitAfterBinding = executorRoot.indexOf("await ", executorBindingOwner);
  const executorState = executorRoot.indexOf("const localServerState = new ServerStateFile({");
  const executorStateOwner = executorRoot.indexOf(
    "executorServerLifecycle.acquireStateFile(localServerState)",
    executorState,
  );
  const executorServerStop = executorRoot.indexOf("await executorServerLifecycle.stop()");
  const executorRoleStop = executorRoot.indexOf("await executorRoleLifecycle.close()", executorServerStop);
  const executorStateCleanup = executorRoot.indexOf(
    "await executorServerLifecycle.cleanupState()",
    executorRoleStop,
  );
  const executorServerCleanupTail = executorRoot.slice(
    executorRoot.indexOf("const cleanupFailures: unknown[] = []"),
  );
  if (
    count(executorServerLifecycle, 'owner: "executor-server"') !==
      executorServerLifecycleIds.length ||
    executorServerLifecyclePositions.some((position) => position < 0) ||
    executorServerLifecyclePositions.some((position, index) =>
      index > 0 && position <= executorServerLifecyclePositions[index - 1]) ||
    count(executorRoot, "new ExecutorServerLifecycle()") !== 1 ||
    executorBinding < 0 ||
    executorBindingOwner <= executorBinding ||
    executorBindingOwner >= executorFirstAwaitAfterBinding ||
    executorState < 0 ||
    executorStateOwner <= executorState ||
    count(executorRoot, "executorServerLifecycle.transferToRunningServer(openingRunner)") !== 1 ||
    count(executorRoot, "executorServerLifecycle.assertRunningServer(localConversationServer)") !== 1 ||
    count(executorRoot, "executorServerLifecycle.startHeartbeat()") !== 1 ||
    count(executorRoot, "executorServerLifecycle.startIdleTimer(") !== 1 ||
    executorServerStop < 0 || executorRoleStop <= executorServerStop ||
    executorStateCleanup <= executorRoleStop ||
    !executorServerLifecycle.includes("server.server.httpServer !== current.binding.httpServer") ||
    !executorServerLifecycle.includes("await this.#idleCheck?.catch(() => undefined)") ||
    !executorServerLifecycle.includes(
      'let endpointTerminal = endpoint.kind === "none" || endpoint.kind === "terminal"',
    ) ||
    !executorServerLifecycle.includes(
      "endpointTerminal = await attempt(() => endpoint.binding.close(), failures)",
    ) ||
    !executorServerLifecycle.includes(
      "endpointTerminal = await attempt(() => endpoint.server.shutdown(reason), failures)",
    ) ||
    !executorServerLifecycle.includes(
      "if (endpointTerminal) {\n      await attempt(() => this.#stateFile?.markStopped(), failures);\n    }",
    ) ||
    [
      "await localServerState?.markStopping",
      "await localConversationServer?.shutdown",
      "await localServerBinding?.close",
      "await localServerState?.markStopped",
      "await localServerState?.cleanup",
    ].some((token) => executorServerCleanupTail.includes(token))
  ) failures.push("Executor Server lifecycle ownership or failure isolation drifted");
  const descriptor = frozenLiteralDescriptor(
    "packages/cli/src/serve/managed-service-reconciler.ts",
    reconciler,
    "MANAGED_HOST_ASSEMBLY_DESCRIPTOR",
  );
  const expected = {
    owner: "home-managed-host",
    planModes: ["managed", "on-demand", "none"],
    triggers: [
      "pairing-issuer-committed",
      "pairing-joiner-committed",
      "local-role-config-committed",
      "current-trust-applied",
      "managed-preflight",
      "host-missing",
    ],
    managedProfiles: ["anchor-executor", "anchor-only"],
    selectableProfiles: ["executor-only", "executor-surface"],
    excludedProfiles: ["surface-only", "disabled-empty"],
  };
  if (
    JSON.stringify(descriptor) !== JSON.stringify(expected) ||
    !reconciler.includes("MANAGED_SERVICE_RECONCILE_TRIGGERS.includes(input.trigger)") ||
    !reconciler.includes("type ManagedServiceReconcileAdapter = Pick<") ||
    count(reconciler, "resolveHostLaunchPlan(") < 2
  ) failures.push("managed host plan or reconcile trigger descriptor exact-set drifted");
  if (
    count(pairing, 'reconcileAfterPairing(options, "pairing-issuer-committed")') !== 1 ||
    count(pairing, 'reconcileAfterPairing(input.input, "pairing-joiner-committed")') !== 1 ||
    count(config, 'reconcileCurrentManagedService("local-role-config-committed")') !== 1 ||
    !config.includes("const reload = await captureConfigPostCommitEffect(() => input.reload({") ||
    !config.includes("const reconcile = input.launchSelectionChanged") ||
    config.indexOf("const reload = await captureConfigPostCommitEffect(() => input.reload({") >=
      config.indexOf("const reconcile = input.launchSelectionChanged") ||
    count(serviceRuntime, 'reconcile("current-trust-applied")') !== 1 ||
    serviceRuntime.indexOf("await deps.requestShutdown()") >=
      serviceRuntime.indexOf('await reconcile("current-trust-applied")') ||
    !serviceRuntime.includes('return "stopped";') ||
    count(command, "coordinateManagedHostTrustTransition({") !== 1 ||
    count(executorRoot, "coordinateManagedHostTrustTransition({") !== 1 ||
    count(executorRoot, "captureManagedHostAdmission(") !== 1 ||
    count(executorRoot, "onTrustApplied,") !== 1 ||
    count(topology, 'reconcileCurrentManagedService("managed-preflight")') < 1 ||
    count(connection, 'reconcileCurrentManagedService("host-missing")') !== 1
  ) failures.push("managed host production trigger exact-set drifted");
  if (
    count(service, "<UserId>${osUser}</UserId>") !== 2 ||
    !service.includes("const osUser = xmlEscape(spec.osUser);") ||
    !serviceRuntime.includes('export type ManagedServiceStateLoadIntent = "inspect" | "activate";') ||
    count(serviceRuntime, 'loadCurrentManagedServiceState("activate", homeDir)') !== 2 ||
    count(serviceRuntime, 'loadCurrent("activate")') !== 1 ||
    count(serviceRuntime, 'loadCurrent("activate", homeDir)') !== 1 ||
    count(topology, 'loadCurrentManagedServiceState("activate")') !== 2 ||
    count(status, 'loadCurrentManagedServiceState("inspect")') !== 1
  ) failures.push("managed host OS user or current-state intent exact-set drifted");
  if (
    !service.includes('\'<?xml version="1.0" encoding="UTF-16"?>\'') ||
    !service.includes("Buffer.from([0xff, 0xfe])") ||
    !service.includes('Buffer.from(spec.definition, "utf16le")') ||
    count(service, "windowsTaskSchedulerCommand([") !== 7 ||
    count(service, 'args: [...args, "/HRESULT"]') !== 1 ||
    count(service, "hresult === 0x80070002") !== 1 ||
    count(service, "hresult === 0x80070005") !== 1 ||
    !service.includes("windowsTaskInspectionCommand(spec.serviceId)") ||
    !service.includes("currentUserIdentities.some((candidate) => windowsIdentityMatches(identity, candidate))") ||
    !service.includes("projection.enabled !== projection.settings.enabled") ||
    service.includes("projection.settings.enabled &&") ||
    !service.includes("projection.triggers.length === 1") ||
    !service.includes("projection.actions.items.length === 1")
  ) failures.push("managed host Windows bytes, strict projection or HRESULT classifier drifted");
  if (
    count(serviceRuntime, "createManagedServiceAdapter({ storageGovernor: capacity.storage })") !== 4 ||
    !serviceRuntime.includes("export async function prepareManagedServiceMaintenance(") ||
    !serviceRuntime.includes("export async function prepareProgramUninstallManagedService(") ||
    !service.includes('"managed-service-reconcile"') ||
    !service.includes("export function managedServiceDefinitionBytes(") ||
    !service.includes('"--managed-home"') ||
    !service.includes('"--managed-secret-backend"') ||
    !service.includes("applyManagedServiceLaunchContext(") ||
    !topology.includes("await waitForManagedHostTurn()") ||
    count(topology, "createPersistentApplicationHost({") !== 1 ||
    count(topology, "await host.run()") !== 1 ||
    topology.includes("runConfiguredServeTopology(") ||
    topology.includes("prepareMeshRuntimeBootstrap(") ||
    topology.includes("runRecoveryRootEstablishmentTopology(") ||
    topology.includes("acquireExecutorLocalWorkspaceOwner(") ||
    !applicationHost.includes("export class PersistentApplicationHost<Options>") ||
    count(applicationHost, "await this.#runRoleComponents(") !== 1 ||
    count(applicationHost, 'importAnchorRole: () => import("./command.js")') !== 1 ||
    count(applicationHost, 'importExecutorRole: () => import("./executor-role-runtime.js")') !== 1 ||
    count(applicationHost, 'importExecutorModule: () => import("@zhixing/executor")') !== 1 ||
    count(applicationHost, ".runServeCommand(") !== 1 ||
    count(applicationHost, ".runExecutorRole(") !== 1 ||
    count(applicationHost, "const [anchorRole, executor] = await Promise.all([") !== 1 ||
    count(applicationHost, "const [executorRole, executor] = await Promise.all([") !== 1 ||
    count(applicationHost, 'if (plan.host === "anchor-host")') !== 1 ||
    applicationHost.includes("runRoleTopology") ||
    applicationHost.includes("roleLoaders") ||
    applicationHost.includes("runConfiguredServeTopology") ||
    applicationHost.includes("./anchor-role.js") ||
    applicationHost.includes("./executor-role.js") ||
    roleTopology.includes("runConfiguredServeTopology") ||
    roleTopology.includes("ServiceHostModule") ||
    roleTopology.includes("ServeRoleLoaders") ||
    byPath.has("packages/cli/src/serve/anchor-role.ts") ||
    byPath.has("packages/cli/src/serve/executor-role.ts") ||
    !command.includes('processMode !== "managed"')
  ) failures.push("managed host service adapter, preflight or unique composition root drifted");
  if (
    count(reconciler, "return reconcileOrJoin(key, input, false);") !== 1 ||
    count(reconciler, "if (!allowSuccessor) throw error;") !== 1 ||
    count(service, "await this.requireCommand(startCommand(spec), signal);") !== 1
  ) failures.push("managed host bounded successor or start classifier drifted");
  const closeOldClient = connection.indexOf("const staleEndpoint = await this.closeCurrentClient();");
  const disableFuture = connection.indexOf("await opts.beforeTurnover?.();", closeOldClient);
  const oldTurnover = connection.indexOf("await this.waitForEndpointTurnover(staleEndpoint, opts);", disableFuture);
  const successor = connection.indexOf("await this.getClientNow();", oldTurnover);
  if (
    count(reconciler, "input.adapter.disableFuture(initial.spec, input.signal)") !== 3 ||
    count(reconciler, "input.adapter.disable(initial.spec, input.signal)") !== 0 ||
    !serviceRuntime.includes(".disableFuture(current.spec, signal)") ||
    !config.includes("? { beforeTurnover: input.prepareManagedServiceTurnover }") ||
    !repl.includes('strategy: "drain"') ||
    !repl.includes("prepareManagedServiceTurnover: prepareCurrentManagedServiceConfigTurnover") ||
    !serverContext.includes("lifecycleShutdown?: LifecycleShutdownAdapter;") ||
    !serverShutdown.includes("return await lifecycle.prepare({") ||
    !serverShutdown.includes("queueMicrotask(() => trigger(`${reason}:${strategy}`));") ||
    !command.includes("const stopCoordinator = new HostStopCoordinator({") ||
    !command.includes("lifecycleShutdown: stopCoordinator,") ||
    !command.includes("beginDrain: async () => {") ||
    !command.includes("drainAcceptedWork: async () => {") ||
    closeOldClient < 0 || disableFuture < closeOldClient || oldTurnover < disableFuture || successor < oldTurnover
  ) failures.push("managed host accepted-work drain or generation-safe turnover order drifted");
  const anchorInternalStopOwner = command.indexOf(
    "anchorInternalStop.current = createAnchorInternalStopPort({",
  );
  const anchorRoleTerminal = command.indexOf(
    "await runner.waitForShutdown()",
    anchorInternalStopOwner,
  );
  if (
    count(command, "createAnchorInternalStopPort({") !== 1 ||
    count(command, "requestAnchorInternalStop({") !== 3 ||
    count(command, "serverCtx.requestShutdown") !== 1 ||
    !command.includes("return stop.requestStop(request);") ||
    !command.includes('reason: "managed-role-changed"') ||
    !command.includes('reason: "device-removed"') ||
    !command.includes('requestAnchorInternalStop({ reason: "idle", strategy: "drain" })') ||
    !command.includes('chalk.red("[idle] durable Host stop failed; the same operation will retry")') ||
    !command.includes("prepare: (request) => stopCoordinator.prepare(request)") ||
    !command.includes("const shutdown = serverCtx.requestShutdown;") ||
    command.includes('serverCtx.requestShutdown?.("managed-role-changed")') ||
    command.includes('serverCtx.requestShutdown?.("device-removed")') ||
    command.includes('serverCtx.requestShutdown?.("idle")') ||
    anchorInternalStopOwner < 0 ||
    anchorRoleTerminal < anchorInternalStopOwner ||
    !anchorInternalStop.includes("const frozen = claimed ?? Object.freeze({ ...request });") ||
    !anchorInternalStop.includes("claimed = frozen;") ||
    !anchorInternalStop.includes("if (inFlight) return inFlight;") ||
    !anchorInternalStop.includes("await dependencies.prepare({") ||
    !anchorInternalStop.includes("await dependencies.requestShutdown(frozen.reason);") ||
    !anchorInternalStop.includes("shutdownTriggered = true;")
  ) failures.push("managed host internal stop durable owner drifted");
  const executorInternalStopOwner = executorRoot.indexOf(
    "executorInternalStop.current = createExecutorInternalStopPort({",
  );
  const executorRoleTerminal = executorRoot.indexOf(
    "await waitForExecutorRoleTerminal({",
    executorInternalStopOwner,
  );
  if (
    count(executorRoot, "createExecutorInternalStopPort({") !== 1 ||
    count(executorRoot, "requestExecutorInternalStop({") !== 2 ||
    !executorRoot.includes('reason: "managed-role-changed"') ||
    !executorRoot.includes('requestExecutorInternalStop({ reason: "idle", strategy: "drain" })') ||
    !executorRoot.includes('processMode === "on-demand"') ||
    !executorRoot.includes("localConversationServer.server.connections.size") ||
    !executorRoot.includes("mesh!.connections.has(anchorDeviceId)") ||
    !executorRoot.includes("localConversationOwner!.hasIdleBlockingWork()") ||
    !executorRoot.includes("jobOwnerAssembly!.acceptedWorkItems()") ||
    !executorServerLifecycle.includes("await this.#idleCheck?.catch(() => undefined)") ||
    executorInternalStopOwner < 0 ||
    executorRoleTerminal < executorInternalStopOwner ||
    !executorInternalStop.includes("const frozen = claimed ?? Object.freeze({ ...request });") ||
    !executorInternalStop.includes("claimed = frozen;") ||
    !executorInternalStop.includes("if (inFlight) return inFlight;") ||
    !executorInternalStop.includes("await dependencies.prepare({") ||
    !executorInternalStop.includes("await dependencies.shutdown(frozen.reason);") ||
    !executorInternalStop.includes("await dependencies.waitForShutdown();") ||
    !executorInternalStop.includes("terminal = true;")
  ) failures.push("Executor trust/idle durable stop owner drifted");
  const anchorRunServer = command.indexOf("runner = await runServer({");
  const anchorOpenGate = command.indexOf("beforeActivate: async (openingRunner) =>", anchorRunServer);
  const anchorShellOwner = command.indexOf(
    "hostShellLifecycle.assertActivationOwnership({",
    anchorOpenGate,
  );
  const deliveryActivation = command.indexOf("ctx.deliveryStack?.activate()", anchorOpenGate);
  const schedulerActivation = command.indexOf("schedulerRuntime?.activate()", anchorOpenGate);
  const foundationTransfer = command.indexOf(
    'lifecycleContributions.transferTo(registry, "foundation")',
    anchorOpenGate,
  );
  const surfaceTransfer = command.indexOf(
    'lifecycleContributions.transferTo(registry, "surface")',
    foundationTransfer,
  );
  const postServerContribution = command.indexOf(
    'await setupAssemblyUnits(assemblyUnits, ctx, "post-server")',
    anchorOpenGate,
  );
  const cleanupTransfer = command.indexOf("startupRollback.commit()", anchorOpenGate);
  const activeEndpointProof = command.indexOf(
    "hostShellLifecycle.assertActiveEndpoint(openingServer)",
    cleanupTransfer,
  );
  const readyPublication = command.indexOf("publishReady: async (openingRunner) =>", anchorOpenGate);
  const readyMarker = command.indexOf("await hostShellLifecycle.markReady({", readyPublication);
  const executorRunServer = executorRoot.indexOf("const localConversationServer = await runServer({");
  const executorOpenGate = executorRoot.indexOf(
    "beforeActivate: async (openingRunner) =>",
    executorRunServer,
  );
  const executorTrustBinding = executorRoot.indexOf(
    "coordinateRuntimeTrustTransition = async () =>",
    executorOpenGate,
  );
  const executorEndpointTransfer = executorRoot.indexOf(
    "executorServerLifecycle.transferToRunningServer(openingRunner)",
    executorOpenGate,
  );
  const executorFinalAdmission = executorRoot.indexOf(
    "await onTrustApplied();",
    executorTrustBinding,
  );
  const executorReadyPublication = executorRoot.indexOf(
    "publishReady: async (openingRunner) =>",
    executorFinalAdmission,
  );
  const executorReadyMarker = executorRoot.indexOf(
    "await executorServerLifecycle.markReady({",
    executorReadyPublication,
  );
  const lifecycleActivationGate = serverLifecycle.indexOf(
    "activationGate: async (preparedServer) =>",
  );
  const lifecycleCloseOwner = serverLifecycle.indexOf(
    "opts.lifecycleOwner.transferPreparedServer(preparedServer, registry)",
    lifecycleActivationGate,
  );
  const lifecycleOpenPrerequisite = serverLifecycle.indexOf(
    "await opts.beforeActivate?.(runner)",
    lifecycleCloseOwner,
  );
  const lifecycleActiveProof = serverLifecycle.indexOf(
    "await opts.beforePublish?.(server)",
    lifecycleOpenPrerequisite,
  );
  const lifecycleDiscoveryPublication = serverLifecycle.indexOf(
    "await opts.lifecycleOwner.publishDiscovery(server)",
    lifecycleActiveProof,
  );
  const lifecycleReadyPublication = serverLifecycle.indexOf(
    "await opts.publishReady?.(runner)",
    lifecycleDiscoveryPublication,
  );
  const serverGate = server.indexOf("await opts.activationGate?.(server)");
  const serverActivate = server.indexOf("boundServer.activate({", serverGate);
  if (
    count(command, "await bindServer({") !== 1 ||
    count(command, "runner = await runServer({") !== 1 ||
    count(command, "beforeActivate: async (openingRunner) =>") !== 1 ||
    count(command, "publishReady: async (openingRunner) =>") !== 1 ||
    count(command, "lifecycleOwner: hostShellLifecycle") !== 1 ||
    count(command, "hostShellLifecycle.acquireServerLog(") !== 1 ||
    count(command, "hostShellLifecycle.acquireBinding(") !== 1 ||
    count(command, "hostShellLifecycle.acquireStateFile(") !== 1 ||
    count(command, "hostShellLifecycle.acquireCheckpointOwner(") !== 1 ||
    count(command, "hostShellLifecycle.startHeartbeat(") !== 1 ||
    count(command, "hostShellLifecycle.startIdleReaper(") !== 1 ||
    command.includes("registerCoreCleanup") ||
    command.includes("registerTailCleanup") ||
    command.includes("shutdown-chain.js") ||
    anchorRunServer < 0 ||
    anchorOpenGate < anchorRunServer ||
    [
      anchorShellOwner,
      deliveryActivation,
      schedulerActivation,
      foundationTransfer,
      surfaceTransfer,
      postServerContribution,
      cleanupTransfer,
    ].some((position) => position < anchorOpenGate || position >= readyPublication) ||
    foundationTransfer >= surfaceTransfer ||
    activeEndpointProof < cleanupTransfer ||
    activeEndpointProof >= readyPublication ||
    readyMarker < readyPublication ||
    count(serverLifecycle, "activationGate: async (preparedServer) =>") !== 1 ||
    count(serverLifecycle, "await opts.lifecycleOwner.publishDiscovery(server)") !== 1 ||
    count(serverLifecycle, "await opts.publishReady?.(runner)") !== 1 ||
    lifecycleCloseOwner < lifecycleActivationGate ||
    lifecycleOpenPrerequisite < lifecycleCloseOwner ||
    lifecycleActiveProof < lifecycleOpenPrerequisite ||
    lifecycleDiscoveryPublication < lifecycleActiveProof ||
    lifecycleReadyPublication < lifecycleDiscoveryPublication ||
    count(server, "await opts.activationGate?.(server)") !== 1 ||
    count(server, "boundServer.activate({") !== 1 ||
    server.includes("activationFailureCleanupOwner") ||
    count(server, "await activationFailureOwner.cleanupActivationFailure()") !== 1 ||
    serverIndex.includes("startServerWithActivationFailureOwner") ||
    serverIndex.includes("ServerActivationFailureOwner") ||
    count(
      serverLifecycle,
      "await startServerWithActivationFailureOwner(startOptions, opts.lifecycleOwner)",
    ) !== 1 ||
    serverGate < 0 ||
    serverActivate < serverGate
  ) failures.push("managed host entry-last activation or publication order drifted");
  const anchorHostShellResourceIds = [
    "serverLogLifecycle.stop",
    "endpoint.close",
    "authorityCheckpointOwner.stop",
    "serverState.lifecycle",
    "heartbeatTimer.clear",
    "idleTimer.clearAndSettle",
    "processDiscovery.release",
  ];
  const endpointTerminalGuard = anchorHostShell.indexOf("if (endpointTerminal) {");
  const stoppedAfterTerminal = anchorHostShell.indexOf(
    "this.#stateFile?.markStopped()",
    endpointTerminalGuard,
  );
  const stateCleanupAfterTerminal = anchorHostShell.indexOf(
    "this.#stateFile?.cleanup()",
    endpointTerminalGuard,
  );
  const discoveryReleaseBeforeEndpoint = anchorHostShell.indexOf(
    "await attempt(() => this.#releaseOwnedDiscovery(), failures);",
  );
  const bindingCloseAfterRelease = anchorHostShell.indexOf(
    "endpoint.binding.close()",
    discoveryReleaseBeforeEndpoint,
  );
  const serverCloseAfterRelease = anchorHostShell.indexOf(
    "endpoint.server.close()",
    discoveryReleaseBeforeEndpoint,
  );
  const discoveryRestoreAfterFailure = anchorHostShell.indexOf(
    "this.#restoreOwnedDiscovery(ownedEndpoint)",
    serverCloseAfterRelease,
  );
  if (
    anchorHostShellResourceIds.some((id) =>
      count(anchorHostShell, `{ owner: "anchor-host", id: "${id}" }`) !== 1
    ) ||
    count(anchorHostShell, "new AnchorHostShellLifecycle") !== 0 ||
    count(anchorHostShell, "registerCleanup(registry, ANCHOR_HOST_SHELL_CLEANUP_DESCRIPTOR") !== 1 ||
    count(anchorHostShell, "return this.#handle.run()") !== 3 ||
    count(anchorHostShell, "cleanupActivationFailure(): Promise<void>") !== 1 ||
    !anchorHostShell.includes("this.#assertSameEndpoint(server, current.binding)") ||
    !anchorHostShell.includes("server.httpServer !== binding.httpServer") ||
    !anchorHostShell.includes("server.port !== binding.port") ||
    !anchorHostShell.includes("server.host !== binding.host") ||
    !anchorHostShell.includes("await this.#idleCheck?.catch(() => undefined)") ||
    endpointTerminalGuard < 0 ||
    stoppedAfterTerminal < endpointTerminalGuard ||
    stateCleanupAfterTerminal < stoppedAfterTerminal ||
    discoveryReleaseBeforeEndpoint < 0 ||
    bindingCloseAfterRelease < discoveryReleaseBeforeEndpoint ||
    serverCloseAfterRelease < discoveryReleaseBeforeEndpoint ||
    endpointTerminalGuard < serverCloseAfterRelease ||
    discoveryRestoreAfterFailure < endpointTerminalGuard ||
    !anchorHostShell.includes("current.pid !== process.pid") ||
    !anchorHostShell.includes("current.startedAt !== this.#processInfo.startedAt") ||
    !anchorHostShell.includes("current.startTime !== (this.#processInfo.startTime ?? null)") ||
    !anchorHostShell.includes("current.port !== this.#discoveryPort") ||
    command.includes('id: "serverLogLifecycle.stop"') ||
    command.includes('id: "authorityCheckpointOwner.stop"') ||
    command.includes('id: "server.close"') ||
    command.includes('id: "releaseLock"')
  ) failures.push("Anchor Host shell lifecycle ownership or truthful terminal drifted");
  if (
    count(executorRoot, "const localConversationServer = await runServer({") !== 1 ||
    count(executorRoot, "beforeActivate: async (openingRunner) =>") !== 1 ||
    count(executorRoot, "publishReady: async (openingRunner) =>") !== 1 ||
    executorRunServer < 0 ||
    executorOpenGate < executorRunServer ||
    [executorEndpointTransfer, executorInternalStopOwner, executorTrustBinding, executorFinalAdmission]
      .some((position) => position < executorOpenGate || position >= executorReadyPublication) ||
    executorEndpointTransfer >= executorInternalStopOwner ||
    executorReadyMarker < executorReadyPublication ||
    !executorRoot.includes("shutdown: (reason) => openingRunner.shutdown(reason)") ||
    !executorRoot.includes("waitForShutdown: () => openingRunner.waitForShutdown()")
  ) failures.push("Executor entry-last activation or publication order drifted");
  if (
    !bootstrap.includes("export function resolveHostLaunchPlan(") ||
    !bootstrap.includes("configuration.executorAutoStart === true") ||
    !bootstrap.includes('"anchor-authority-conflict"') ||
    !bootstrap.includes('if (roleSet.has("anchor")) {') ||
    !bootstrap.includes('return Object.freeze({ mode: "managed" as const, roles });') ||
    !secrets.includes('context?: "foreground" | "managed"') ||
    !secrets.includes("async loadExisting(): Promise<Buffer>") ||
    !secrets.includes('const BACKEND_BINDING_FILE = `${SECRET_STORE_FILE_PREFIX}.backend.json`;')
  ) failures.push("managed host authority plan or SecretStore context drifted");
  if (
    !publicStatus.includes("export function projectManagedHostStatus(") ||
    !status.includes('from "@zhixing/server"') ||
    !status.includes("export { projectManagedHostStatus }") ||
    !status.includes("export async function buildManagedHostPublicStatus(") ||
    !status.includes("export async function buildManagedHostStatusSnapshot(") ||
    !statusRoute.includes("return await ctx.managedHostPublicStatus?.() ?? projectManagedHostStatus({") ||
    !command.includes("managedHostPublicStatus: () => buildManagedHostPublicStatus(") ||
    !scheduler.includes("executorCapabilities.onAccepted(") ||
    !scheduler.includes("this.scheduler.wakeQueuedUserJobs()") ||
    !manifest.includes("onAccepted(listener:")
  ) failures.push("managed host public status or executor queue wake drifted");
  if (
    !connection.includes('if (spawned.mode === "none")') ||
    !connection.includes("const surfaceClient = await this.deps.createSurfaceClient()") ||
    !surfaceLink.includes("isCurrentAnchorRelayMethod(method)") ||
    !surfaceLink.includes("canonicalize(trust)") ||
    !surfaceLink.includes("await this.#remote.close(this.#connection)") ||
    !surfaceLink.includes("this.bootstrapStore.stopStorageMaintenance()")
  ) failures.push("managed host finite current-anchor surface relay drifted");
  for (const forbidden of [
    "uninstallManagedService",
    "upgradeManagedService",
    "rollbackManagedService",
    "automaticFailover",
    "continuousSynchronization",
  ]) {
    if ([reconciler, service, serviceRuntime].some((text) => text.includes(forbidden))) {
      failures.push(`managed host assembly includes downstream capability ${forbidden}`);
    }
  }
  return failures;
}

export function inspectRecoveryBackupAssembly(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const command = byPath.get("packages/cli/src/serve/command.ts");
  const owner = byPath.get("packages/cli/src/serve/backup-runtime-owner.ts");
  const backup = byPath.get("packages/cli/src/serve/backup-command.ts");
  const bootstrapStore = byPath.get("packages/cli/src/serve/mesh-bootstrap-store.ts");
  const bootstrap = byPath.get("packages/cli/src/serve/mesh-runtime-bootstrap.ts");
  const topology = byPath.get("packages/cli/src/serve/topology-command.ts");
  const applicationHost = byPath.get("packages/cli/src/serve/application-host.ts");
  const rootEstablishment = byPath.get(
    "packages/cli/src/serve/recovery-root-establishment-runtime.ts",
  );
  const rootActivation = byPath.get(
    "packages/cli/src/serve/recovery-root-activation.ts",
  );
  const controlPlane = byPath.get("packages/cli/src/serve/mesh-control-plane.ts");
  const runtime = byPath.get("packages/cli/src/serve/mesh-runtime-assembly.ts");
  const pairing = byPath.get("packages/cli/src/serve/mesh-pair-command.ts");
  const disasterCommand = byPath.get("packages/cli/src/serve/disaster-recovery-command.ts");
  const disasterCandidate = byPath.get("packages/cli/src/serve/disaster-recovery-candidate.ts");
  const disasterEvidence = byPath.get("packages/cli/src/serve/disaster-recovery-trust-evidence.ts");
  const disasterInstallation = byPath.get("packages/cli/src/serve/disaster-recovery-installation.ts");
  const disasterTarget = byPath.get("packages/cli/src/serve/disaster-recovery-target.ts");
  const artifactRetention = byPath.get("packages/core/src/authority/artifact-retention.ts");
  const authorityCommitLog = byPath.get("packages/core/src/authority/commit-log.ts");
  const rootLifecycle = byPath.get("packages/cli/src/serve/recovery-root-lifecycle.ts");
  const exposureAuthority = byPath.get("packages/cli/src/serve/credential-exposure-authority.ts");
  const credentialRotation = byPath.get("packages/cli/src/serve/credential-rotation-publication.ts");
  const startup = byPath.get("packages/cli/src/startup.ts");
  const setupDelivery = byPath.get("packages/cli/src/setup-delivery.ts");
  const checkpointService = byPath.get("packages/mesh/src/checkpoint-service.ts");
  const checkpointOwner = byPath.get("packages/mesh/src/checkpoint-owner.ts");
  const pairedTarget = byPath.get("packages/mesh/src/paired-checkpoint-target.ts");
  if (
    !command || !owner || !backup || !bootstrapStore || !bootstrap || !topology || !applicationHost || !rootEstablishment ||
    !rootActivation || !controlPlane ||
    !runtime || !pairing || !disasterCommand || !disasterCandidate || !disasterEvidence ||
    !disasterInstallation || !disasterTarget || !artifactRetention || !authorityCommitLog ||
    !rootLifecycle || !exposureAuthority ||
    !credentialRotation || !startup || !setupDelivery || !checkpointService ||
    !checkpointOwner || !pairedTarget
  ) {
    return ["recovery backup production assembly sources are missing"];
  }
  const count = (text, token) => text.split(token).length - 1;
  if (
    count(command, "createConfiguredCheckpointOwner({") !== 1 ||
    count(command, "ctx.authorityCheckpointOwner?.start()") !== 1 ||
    count(command, "hostShellLifecycle.acquireCheckpointOwner(ctx.authorityCheckpointOwner)") !== 1 ||
    command.includes('id: "authorityCheckpointOwner.stop"')
  ) {
    failures.push("packages/cli/src/serve/command.ts: recovery checkpoint owner must have one create/start/stop lifecycle");
  }
  for (const token of [
    "assertHomeAuthority(trust, input.mesh.deviceKey.deviceId)",
    "assertHomeAuthority(trust, this.input.mesh.deviceKey.deviceId)",
    "return new ConfiguredCheckpointOwnerSlot(input)",
    "resolveTarget",
  ]) {
    if (!owner.includes(token)) {
      failures.push(`packages/cli/src/serve/backup-runtime-owner.ts: missing owner boundary ${token}`);
    }
  }
  if (count(owner, "currentAnchor: true") !== 2) {
    failures.push("packages/cli/src/serve/backup-runtime-owner.ts: missing owner boundary currentAnchor: true");
  }
  const pairedClientConstructions = records.filter(({ text }) =>
    text.includes("new PairedRecoveryCheckpointTarget({")
  );
  const expectedPairedClientOwners = new Map([
    ["packages/cli/src/serve/backup-command.ts", "context.capacity.storage"],
    ["packages/cli/src/serve/backup-runtime-owner.ts", "input.storageMaintenance"],
    ["packages/cli/src/serve/mesh-pair-command.ts", "input.storageMaintenance"],
    ["packages/cli/src/serve/disaster-recovery-command.ts", "context.storageMaintenance"],
  ]);
  if (
    pairedClientConstructions.length !== expectedPairedClientOwners.size ||
    pairedClientConstructions.some(({ relative }) => !expectedPairedClientOwners.has(relative))
  ) {
    failures.push("paired checkpoint client production owner exact-set drifted");
  }
  for (const [relative, governorBinding] of expectedPairedClientOwners) {
    const text = byPath.get(relative);
    if (
      !text ||
      JSON.stringify(newExpressionPropertyBindings(
        relative,
        text,
        "PairedRecoveryCheckpointTarget",
        "storageMaintenance",
      )) !== JSON.stringify([governorBinding])
    ) {
      failures.push(`${relative}: paired checkpoint client must use the device storage governor`);
    }
  }
  if (
    !checkpointService.includes("export async function projectDurableRecoveryBackupStatus(") ||
    !checkpointService.includes("canonicalize(record.generation) === canonicalize(generation)") ||
    count(checkpointService, "return projectDurableRecoveryBackupStatus({") !== 1 ||
    !owner.includes("projectDurableRecoveryBackupStatus({") ||
    count(owner, "fullBackupReady: status.fullBackupReady") !== 2
  ) {
    failures.push("durable recovery readiness projector or unavailable consumer drifted");
  }
  const prepareIdentity = backup.indexOf("await prepareInitialRoot(context, options.readRecoveryPackage)");
  const pairedConnect = backup.indexOf("await connectPairedTarget(", prepareIdentity);
  if (
    prepareIdentity < 0 ||
    pairedConnect < prepareIdentity ||
    !backup.includes("prepared.checkpoint.envelope.recipientKeyId")
  ) {
    failures.push("paired root establishment must freeze package identity before target connection");
  }
  const limitedBranch = applicationHost.indexOf("await this.#dependencies.runRecoveryRoot({");
  const oldBootstrapStop = applicationHost.indexOf("await this.#releaseCurrentMesh();");
  const residentBootstrap = applicationHost.indexOf(
    "mesh = await this.#prepareMesh(deviceCapacity);",
    oldBootstrapStop,
  );
  const workspaceAdmission = applicationHost.indexOf(
    "await this.#dependencies.acquireLocalWorkspaceOwner(",
  );
  const normalTopology = applicationHost.indexOf("await this.#runRoleComponents(");
  if (
    !bootstrap.includes("!!trust.recoveryRootPublicKey !== !!trust.recoveryBackupPublicKey") ||
    limitedBranch < 0 ||
    oldBootstrapStop < limitedBranch ||
    residentBootstrap < oldBootstrapStop ||
    workspaceAdmission < limitedBranch ||
    normalTopology < workspaceAdmission
  ) {
    failures.push("trusted-home root establishment must remain a finite pre-business topology");
  }
  if (
    count(applicationHost, "await this.#prepareMesh(deviceCapacity)") !== 2 ||
    !rootEstablishment.includes("watchTrust: false") ||
    !backup.includes("watchTrust: false") ||
    !controlPlane.includes("this.options.watchTrust !== false")
  ) {
    failures.push("root-establishment transport must stay stable through signed activation and reload normal topology");
  }
  const expectedRootServices = frozenLiteralDescriptor(
    "packages/cli/src/serve/recovery-root-establishment-runtime.ts",
    rootEstablishment,
    "ROOT_ESTABLISHMENT_SERVICE_EXACT_SET",
  );
  if (
    JSON.stringify(expectedRootServices) !== JSON.stringify([
      "mesh.endpoint",
      "recovery.checkpoint",
    ]) ||
    count(rootEstablishment, "registerPairedCheckpointMeshService(") !== 1 ||
    count(rootEstablishment, "new PairedCheckpointReceiver({") !== 1 ||
    !rootEstablishment.includes("rootEstablishment: true") ||
    !rootEstablishment.includes("commitRootActivation:") ||
    !rootEstablishment.includes("deviceId === input.mesh.trust.issuer.deviceId") ||
    rootEstablishment.includes("new MeshRuntimeAssembly(")
  ) {
    failures.push("root-establishment receiver exact-set or current-issuer boundary drifted");
  }
  if (
    !pairedTarget.includes("bindRootEstablishment(") ||
    !pairedTarget.includes("root-establishment.pending.json") ||
    !pairedTarget.includes("assertRootEstablishment(") ||
    !pairedTarget.includes('t: "checkpoint.activate-root"') ||
    !backup.includes("connection.target.activateRoot(replay)") ||
    !backup.includes("await connection.target.activateRoot({") ||
    !runtime.includes("rootLifecycle: true") ||
    !runtime.includes("commitRootActivation:") ||
    !rootActivation.includes("appendTrustEvent({ event, record })") ||
    !rootActivation.includes("isExactRecoveryRootActivationReplay(")
  ) {
    failures.push("paired root-establishment staging and signed activation replay must remain durably bound");
  }
  const replayHelperStart = backup.indexOf("async function currentPairedRootActivation(");
  const replayHelperEnd = replayHelperStart < 0
    ? -1
    : backup.indexOf("\nasync function ", replayHelperStart + 1);
  const replayHelper = replayHelperStart < 0
    ? ""
    : backup.slice(replayHelperStart, replayHelperEnd < 0 ? backup.length : replayHelperEnd);
  const replayQueryStart = bootstrapStore.indexOf("  async loadRecoveryRootActivationReplay(input:");
  const replayQueryEnd = replayQueryStart < 0
    ? -1
    : bootstrapStore.indexOf("\n  async ", replayQueryStart + 1);
  const replayQuery = replayQueryStart < 0
    ? ""
    : bootstrapStore.slice(replayQueryStart, replayQueryEnd < 0 ? bootstrapStore.length : replayQueryEnd);
  if (
    !replayQuery.includes('body.t === "recovery-activation-committed"') ||
    !replayQuery.includes('protocolDigest("RecoveryActivationPlan", 1, body.commit.plan)') ||
    !replayQuery.includes("envelope.lsn > match.lsn") ||
    !replayQuery.includes("verifyHomeTrustRecord(record, historical)") ||
    !replayQuery.includes("current.recoveryActivationDigest !== input.activationDigest") ||
    !replayQuery.includes("const event = plan.rootEvent") ||
    !replayQuery.includes("const record = activationRecords[0]!") ||
    replayQuery.includes("loadTrustRecord(") ||
    replayQuery.includes("loadCheckpointRecords(") ||
    replayQuery.includes(".at(-1)") ||
    replayQuery.includes(".reverse()") ||
    !replayHelper.includes("return context.store.loadRecoveryRootActivationReplay({") ||
    replayHelper.includes("loadTrustEvents(") ||
    replayHelper.includes("loadTrustRecord(") ||
    replayHelper.includes("loadCheckpointRecords(") ||
    replayHelper.includes(".at(-1)") ||
    replayHelper.includes(".reverse()")
  ) {
    failures.push("paired root activation replay must use the originating commit and same-LSN historical trust tuple");
  }
  const ownerDescriptor = frozenLiteralDescriptor(
    "packages/mesh/src/checkpoint-owner.ts",
    checkpointOwner,
    "RECOVERY_CHECKPOINT_OWNER_DESCRIPTOR",
  );
  const expectedOwnerDescriptor = {
    owner: "current-anchor",
    roles: ["single-machine", "anchor-executor"],
    phases: ["daily", "forced"],
    order: ["recover-pending", "create-replicate", "cleanup-expired"],
  };
  if (
    JSON.stringify(ownerDescriptor) !== JSON.stringify(expectedOwnerDescriptor) ||
    !descriptorDrivesPhase(
      "packages/mesh/src/checkpoint-owner.ts",
      checkpointOwner,
      "RECOVERY_CHECKPOINT_OWNER_DESCRIPTOR",
      "request.kind",
    )
  ) {
    failures.push("packages/mesh/src/checkpoint-owner.ts: recovery owner descriptor exact-set or production binding drifted");
  }
  const receiverDescriptor = frozenLiteralDescriptor(
    "packages/mesh/src/paired-checkpoint-target.ts",
    pairedTarget,
    "PAIRED_CHECKPOINT_RECEIVER_DESCRIPTOR",
  );
  const expectedReceiverDescriptor = {
    owner: "paired-target",
    roles: ["onboarding", "active"],
    phases: [
      "checkpoint.begin",
      "checkpoint.progress",
      "checkpoint.append",
      "checkpoint.commit",
      "checkpoint.get",
      "checkpoint.inventory",
      "checkpoint.range",
      "checkpoint.retire",
      "checkpoint.activate-root",
    ],
    order: [
      "checkpoint.begin",
      "checkpoint.progress",
      "checkpoint.append",
      "checkpoint.commit",
    ],
  };
  if (
    JSON.stringify(receiverDescriptor) !== JSON.stringify(expectedReceiverDescriptor) ||
    !descriptorDrivesPhase(
      "packages/mesh/src/paired-checkpoint-target.ts",
      pairedTarget,
      "PAIRED_CHECKPOINT_RECEIVER_DESCRIPTOR",
      "command.t",
    )
  ) {
    failures.push("packages/mesh/src/paired-checkpoint-target.ts: paired receiver descriptor exact-set or production binding drifted");
  }
  const disasterDescriptor = frozenLiteralDescriptor(
    "packages/cli/src/serve/disaster-recovery-target.ts",
    disasterTarget,
    "DISASTER_RECOVERY_TARGET_DESCRIPTOR",
  );
  const expectedDisasterDescriptor = {
    owner: "eligible-recovery-target",
    roles: ["anchor-executor", "anchor-only"],
    phases: ["prepare", "commit", "abort", "tombstone"],
    order: [
      "claim",
      "verify",
      "private-import",
      "atomic-install",
      "generation-rebind",
      "consumer-recovery",
      "credential-guard",
      "open",
    ],
  };
  if (
    JSON.stringify(disasterDescriptor) !== JSON.stringify(expectedDisasterDescriptor) ||
    count(disasterTarget, "async prepareAndImport(") !== 1 ||
    count(disasterTarget, "async commit(") !== 1 ||
    count(disasterTarget, "async abort(") !== 1 ||
    count(disasterTarget, "async tombstone(") !== 1 ||
    count(disasterCommand, "new DisasterRecoveryTarget({") !== 1 ||
    !disasterCommand.includes("discoverDisasterRecoveryCandidates({") ||
    !disasterCommand.includes("await target.prepareAndImport({") ||
    !disasterCommand.includes("await target.commit({ transferId, recoveryRoot: decoded.root, signal })") ||
    !disasterCommand.includes("await target.tombstone({")
  ) {
    failures.push("disaster recovery target owner, inventory, phase or public journey exact-set drifted");
  }
  if (
    count(runtime, "registerDisasterRecoveryTrustEvidenceService(") !== 1 ||
    count(disasterCommand, "collectDisasterRecoveryTrustEvidence({") !== 1 ||
    count(disasterCommand, "recoveryEvidencePeerIds: peerIds") !== 1 ||
    !disasterEvidence.includes('"anchor.disaster-recovery.trust-evidence"') ||
    count(disasterEvidence, "registerDisasterRecoveryTrustEvidenceService(") !== 1 ||
    count(disasterEvidence, "collectDisasterRecoveryTrustEvidence(") !== 1 ||
    !disasterEvidence.includes("const peerEvidence = await Promise.all(") ||
    !disasterEvidence.includes("verifyHomeTrustRecord(record, projection)") ||
    !disasterCandidate.includes('"reachabilityCut"') ||
    !disasterCandidate.includes('"trustEvidenceDigest"') ||
    !disasterTarget.includes("trustEvidenceDigest: input.trustEvidence.digest")
  ) {
    failures.push("disaster no-rollback evidence producer, authenticated cut or candidate binding drifted");
  }
  if (
    count(setupDelivery, "export function createProductionAnchorReadySnapshot(") !== 1 ||
    count(disasterCommand, "return createProductionAnchorReadySnapshot({") !== 1 ||
    !disasterCommand.includes("credentialGeneration: credentials.generation") ||
    !disasterCommand.includes("credentialRevision,") ||
    !disasterTarget.includes("candidateDigest: disasterReadyCandidateDigest({") ||
    count(disasterTarget, "expectedIdentity: {") !== 2
  ) {
    failures.push("disaster readiness must use the shared production snapshot and exact candidate identity");
  }
  const abortTerminal = disasterTarget.indexOf(
    'candidate.terminal(input.abort.transferId, "aborted", abort)',
  );
  const abortCleanup = disasterTarget.indexOf(
    'rm(path.join(this.options.stagingRoot, "transfers", input.abort.transferId)',
    abortTerminal,
  );
  const abortKeyLoad = disasterTarget.indexOf(
    "const transferKey = await loadAnchorIssuerKey(",
    abortTerminal,
  );
  const freshKey = disasterTarget.indexOf(
    "const issuerKey = await loadOrCreateAnchorIssuerKey(",
  );
  const firstCreatorTerminalCheck = disasterTarget.indexOf(
    "await this.#deleteFreshIssuerKeyIfAborted({",
    freshKey,
  );
  const freshRecordVerified = disasterTarget.indexOf(
    "verified = await candidate.recordVerified(",
    firstCreatorTerminalCheck,
  );
  const secondCreatorTerminalCheck = disasterTarget.indexOf(
    "await this.#deleteFreshIssuerKeyIfAborted({",
    firstCreatorTerminalCheck + 1,
  );
  if (
    !disasterCommand.includes("const ownedAbort = options.signal ? undefined : new AbortController()") ||
    !disasterCommand.includes("discoverDisasterRecoveryCandidates({") ||
    !disasterCommand.includes("openInventoryTargets(context, selection, signal)") ||
    !disasterCommand.includes("waitForPeer(control, pairedDeviceId, 30_000, signal)") ||
    !disasterCommand.includes("selected.target.read(selected.entry.checkpointId, signal)") ||
    !disasterCommand.includes("createSignedDisasterRecoveryAbort({") ||
    !disasterCommand.includes("await target.abort({ abort, recoveryRoot: decoded.root })") ||
    abortTerminal < 0 || abortKeyLoad < abortTerminal || abortCleanup < abortKeyLoad ||
    freshKey < 0 || firstCreatorTerminalCheck < freshKey ||
    freshRecordVerified < firstCreatorTerminalCheck ||
    secondCreatorTerminalCheck < freshRecordVerified ||
    count(disasterTarget, "await this.#deleteFreshIssuerKeyIfAborted({") !== 3 ||
    !disasterTarget.includes("input.issuerKey.deviceId") ||
    !disasterCandidate.includes("terminal: record.terminal, abort: record.abort")
  ) {
    failures.push("disaster pre-commit signal or authenticated candidate terminal order drifted");
  }
  const verifiedReplay = disasterTarget.indexOf("if (claimed.verified) {");
  const freshVerification = disasterTarget.indexOf(
    "verifyAndStageDisasterRecoveryAuthority({",
    verifiedReplay,
  );
  const installDecision = disasterTarget.indexOf("candidate.decideInstall(");
  const authorityInstall = disasterTarget.indexOf(
    "this.options.authorityLog.installPlannedAnchorPrefix({",
    installDecision,
  );
  const committedTerminals = [...disasterTarget.matchAll(
    /candidate\.terminal\([^\n]+,\s*"committed"\)/g,
  )].map((match) => match.index ?? -1);
  const liveCompletion = disasterTarget.indexOf("async #completeInstalled(");
  const livePrivateCommitted = disasterTarget.indexOf(
    't: "anchor-committed"',
    liveCompletion,
  );
  const liveActiveKeyReadBack = disasterTarget.indexOf(
    "await loadActiveAnchorIssuerKey(",
    livePrivateCommitted,
  );
  const liveTerminal = disasterTarget.indexOf(
    'candidate.terminal(transferId, "committed")',
    liveCompletion,
  );
  const startupCompletion = disasterTarget.indexOf(
    "export async function completeDisasterRecoveryInstallationBeforeBootstrap(",
  );
  const startupPrivateCommitted = disasterTarget.indexOf(
    't: "anchor-committed"',
    startupCompletion,
  );
  const startupActiveKeyReadBack = disasterTarget.indexOf(
    "await loadActiveAnchorIssuerKey(",
    startupPrivateCommitted,
  );
  const startupTerminal = disasterTarget.indexOf(
    'candidate.terminal(installation.transferId, "committed")',
    startupCompletion,
  );
  const candidateReducerStart = disasterCandidate.indexOf("function reduceProjection(");
  const candidateReducerEnd = disasterCandidate.indexOf(
    "function validateRecord(",
    candidateReducerStart,
  );
  const candidateReducer = disasterCandidate.slice(candidateReducerStart, candidateReducerEnd);
  if (
    verifiedReplay < 0 || freshVerification < 0 || verifiedReplay > freshVerification ||
    !disasterTarget.includes("#importVerifiedCandidate({") ||
    !disasterTarget.includes("issuerKey,") ||
    !disasterCandidate.includes('t: "disaster-recovery-candidate-install-decided"') ||
    disasterCandidate.includes("disaster-recovery-candidate-prepared") ||
    !disasterCandidate.includes("async decideInstall(") ||
    !disasterCandidate.includes("installationEntries") ||
    !disasterCandidate.includes("candidateReferences") ||
    !disasterCandidate.includes("readonly verifiedRef?: ArtifactRef") ||
    !disasterCandidate.includes("readonly installDecisionRef?: ArtifactRef") ||
    !disasterCandidate.includes("await this.log.artifactStore.get(stored.verifiedRef)") ||
    !disasterCandidate.includes("await this.log.artifactStore.get(stored.installDecisionRef)") ||
    !disasterCandidate.includes("decodeCanonicalArtifact(") ||
    disasterCandidate.includes("verifiedJson") ||
    disasterCandidate.includes("decisionJson") ||
    candidateReducer.includes("artifactStore") ||
    !artifactRetention.includes('schema: "DisasterRecoveryVerifiedCandidate"') ||
    !artifactRetention.includes('schema: "DisasterRecoveryInstallDecision"') ||
    !artifactRetention.includes('body.verifiedRef') ||
    !artifactRetention.includes('body.decisionRef') ||
    count(artifactRetention, "return unconditionalOnly(envelope)") < 2 ||
    !/projectionId: RETAINED_REFERENCE_PROJECTION_ID,\r?\n\s+reducerVersion: 4,/.test(
      authorityCommitLog,
    ) ||
    !disasterCandidate.includes("Committed disaster candidate has no durable install decision") ||
    !disasterCandidate.includes("Install-decided disaster candidate cannot be aborted") ||
    installDecision < 0 || authorityInstall < installDecision ||
    committedTerminals.length === 0 ||
    committedTerminals.some((index) => index < authorityInstall) ||
    liveCompletion < 0 || livePrivateCommitted < liveCompletion ||
    liveActiveKeyReadBack < livePrivateCommitted || liveTerminal < liveActiveKeyReadBack ||
    startupCompletion < 0 || startupPrivateCommitted < startupCompletion ||
    startupActiveKeyReadBack < startupPrivateCommitted ||
    startupTerminal < startupActiveKeyReadBack
  ) {
    failures.push("disaster verified replay, install decision or target-wide terminal order drifted");
  }
  const rootLifecycleDescriptor = frozenLiteralDescriptor(
    "packages/cli/src/serve/recovery-root-lifecycle.ts",
    rootLifecycle,
    "RECOVERY_ROOT_LIFECYCLE_DESCRIPTOR",
  );
  const expectedRootLifecycleDescriptor = {
    owner: "current-issuer",
    roles: ["anchor-executor", "anchor-only"],
    operations: ["rotate", "invalidate", "domain-reset-establish"],
    checkpointed: ["rotate", "domain-reset-establish"],
  };
  if (
    JSON.stringify(rootLifecycleDescriptor) !== JSON.stringify(expectedRootLifecycleDescriptor) ||
    count(rootLifecycle, "RECOVERY_ROOT_LIFECYCLE_DESCRIPTOR.operations[0]") !== 1 ||
    count(rootLifecycle, "RECOVERY_ROOT_LIFECYCLE_DESCRIPTOR.operations[1]") !== 1 ||
    count(rootLifecycle, "RECOVERY_ROOT_LIFECYCLE_DESCRIPTOR.operations[2]") !== 1 ||
    count(backup, "new RecoveryRootLifecycleService({") !== 1
  ) {
    failures.push("recovery root lifecycle owner, plan exact-set or production binding drifted");
  }
  if (
    count(runtime, "registerPairedCheckpointMeshService(") !== 1 ||
    count(runtime, "new PairedCheckpointReceiver({") !== 1 ||
    !runtime.includes('member.device.deviceId === options.authority.deviceId') ||
    !runtime.includes('member.state === "active"')
  ) {
    failures.push("packages/cli/src/serve/mesh-runtime-assembly.ts: active paired backup receiver boundary drifted");
  }
  const pairingDescriptor = frozenLiteralDescriptor(
    "packages/cli/src/serve/mesh-pair-command.ts",
    pairing,
    "PAIRING_TRUST_EVENT_DESCRIPTOR",
  );
  const expectedPairingDescriptor = {
    owner: "current-issuer",
    initial: "enroll",
    reenrollment: "reenroll",
    eligibleState: "pending-reenroll",
    proof: "fresh-pairing-transcript",
  };
  if (
    JSON.stringify(pairingDescriptor) !== JSON.stringify(expectedPairingDescriptor) ||
    count(pairing, "PAIRING_TRUST_EVENT_DESCRIPTOR.eligibleState") !== 1 ||
    count(pairing, "PAIRING_TRUST_EVENT_DESCRIPTOR.reenrollment") !== 1 ||
    count(pairing, "PAIRING_TRUST_EVENT_DESCRIPTOR.initial") !== 1 ||
    count(pairing, "createPairingTrustEvent({") !== 1
  ) {
    failures.push("pairing enroll and pending-reenroll exact-set drifted");
  }
  const exposureDescriptor = frozenLiteralDescriptor(
    "packages/cli/src/serve/credential-exposure-authority.ts",
    exposureAuthority,
    "CREDENTIAL_EXPOSURE_ROUTE_DESCRIPTOR",
  );
  const expectedExposureDescriptor = {
    owner: "current-device",
    protectedKinds: ["provider", "channel", "mcp", "webhook", "rendezvous"],
    excludedKinds: ["device-key"],
    states: ["active", "compromised", "rotated"],
  };
  if (
    JSON.stringify(exposureDescriptor) !== JSON.stringify(expectedExposureDescriptor) ||
    count(exposureAuthority, "CREDENTIAL_EXPOSURE_ROUTE_DESCRIPTOR.excludedKinds") !== 1 ||
    count(exposureAuthority, "CREDENTIAL_EXPOSURE_ROUTE_DESCRIPTOR.protectedKinds") !== 1 ||
    count(startup, "const credentialReadGuard = await createCredentialReadGuard(") !== 1 ||
    count(startup, "authorizeCredentialRead: credentialReadGuard") !== 1 ||
    count(setupDelivery, ").publishActiveBindings({") !== 1 ||
    count(pairing, "exposureGuardedSecretStore(") !== 1 ||
    !disasterCommand.includes("credentialRouteGuard: new CredentialExposureAuthority({")
  ) {
    failures.push("credential exposure projection, guard or production read route exact-set drifted");
  }
  if (
    count(command, "await publishRequiredCredentialRotations({") !== 1 ||
    count(credentialRotation, "export async function publishRequiredCredentialRotations(") !== 1 ||
    count(credentialRotation, "options.authority.publishRotation({") !== 1 ||
    !credentialRotation.includes("const stored = await options.readCredentials()") ||
    !credentialRotation.includes('verification: "service-verified"') ||
    !credentialRotation.includes('binding("provider"') ||
    !credentialRotation.includes('binding("mcp"') ||
    !credentialRotation.includes('binding("channel"')
  ) {
    failures.push("credential rotation read-back, service verification or production caller exact-set drifted");
  }
  const approvalStart = backup.indexOf("async function openResetApprovalContext(");
  const approvalEnd = approvalStart < 0
    ? -1
    : backup.indexOf("\nasync function ", approvalStart + 1);
  const approvalContext = approvalStart < 0
    ? ""
    : backup.slice(approvalStart, approvalEnd < 0 ? backup.length : approvalEnd);
  if (
    count(backup, "const context = await openResetApprovalContext(options)") !== 1 ||
    !approvalContext.includes("await loadDeviceKey(secretStore, deviceId)") ||
    !approvalContext.includes("store.loadTrustProjection()") ||
    !approvalContext.includes('member.state !== "active"') ||
    !approvalContext.includes("projection.issuer.deviceId === key.deviceId") ||
    approvalContext.includes("loadOrCreateDeviceKey(") ||
    approvalContext.includes("authorityLog(")
  ) {
    failures.push("recovery reset approval minimum-privilege distinct co-signer boundary drifted");
  }
  const disasterCompletion = runtime.indexOf('completion.installation.t === "disaster-anchor-installed"');
  const disasterFinish = runtime.indexOf("await finishDisasterRecoveryPostInstall({", disasterCompletion);
  const surfaceOpen = runtime.indexOf("await consumers.openCurrentOwnerSurfaces()", disasterFinish);
  const synchronousGate = runtime.indexOf("this.#postInstallTransitionPending = true;");
  const liveAwait = runtime.indexOf("await this.#loadLiveDisasterPostInstall(record)", synchronousGate);
  if (
    !bootstrap.includes("const disasterRecoveryPostInstall = trust") ||
    !bootstrap.includes("await completeDisasterRecoveryInstallationBeforeBootstrap({") ||
    !bootstrap.includes("disasterRecoveryPostInstall ?? plannedAnchorPostInstall") ||
    !disasterInstallation.includes('t: "disaster-post-install-completed"') ||
    !disasterInstallation.includes("input.log.transactProjection<") ||
    count(disasterCommand, "const context = await openRecoveryContext(options, false)") !== 2 ||
    !disasterCommand.includes("context.trust.issuer.deviceId === context.key.deviceId") ||
    !disasterCommand.includes("await waitForDisasterRecoveryPostInstallReceipt({") ||
    synchronousGate < 0 || liveAwait < synchronousGate ||
    disasterCompletion < 0 || disasterFinish < disasterCompletion || surfaceOpen < disasterFinish
  ) {
    failures.push("disaster installation completion, consumer recovery or public-open order drifted");
  }
  const onboardingStart = pairing.indexOf('t: "recovery-onboarding-start"');
  const onboardingTarget = pairing.indexOf("return new PairedRecoveryCheckpointTarget({", onboardingStart);
  const enrollment = pairing.indexOf("const trustEvent = createPairingTrustEvent", onboardingTarget);
  if (
    onboardingStart < 0 ||
    onboardingTarget < onboardingStart ||
    enrollment < onboardingTarget ||
    count(pairing, "new PairedCheckpointReceiver({") !== 1
  ) {
    failures.push("packages/cli/src/serve/mesh-pair-command.ts: authenticated onboarding checkpoint must precede business enrollment");
  }
  return failures;
}

export function inspectPlannedAnchorTransferAssembly(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const assembly = byPath.get("packages/cli/src/serve/mesh-runtime-assembly.ts");
  const mesh = byPath.get("packages/cli/src/serve/planned-anchor-transfer-mesh.ts");
  const transfer = byPath.get("packages/cli/src/serve/planned-anchor-transfer.ts");
  const command = byPath.get("packages/cli/src/serve/command.ts");
  const server = byPath.get("packages/server/src/rpc/methods/server.ts");
  const facade = byPath.get("packages/cli/src/runtime/rpc-management-facade.ts");
  const product = byPath.get("packages/cli/src/runtime/duty-migration-command.ts");
  const firstParty = byPath.get("packages/cli/src/serve/first-party-conversation-mesh.ts");
  const connectionLifetime = byPath.get("packages/cli/src/serve/connection-lifetime-obligation.ts");
  const localRouter = byPath.get("packages/cli/src/serve/local-conversation-rpc.ts");
  const registry = byPath.get("packages/server/src/rpc/methods/index.ts");
  const bootstrap = byPath.get("packages/cli/src/serve/mesh-runtime-bootstrap.ts");
  const accessRoot = byPath.get("packages/cli/src/serve/access-surfaces.ts");
  const executorRoot = byPath.get("packages/cli/src/serve/executor-role-runtime.ts");
  const setup = byPath.get("packages/cli/src/setup-delivery.ts");
  const channels = byPath.get("packages/cli/src/serve/channels.ts");
  const inboundRouter = byPath.get("packages/server/src/channels/inbound-router.ts");
  const conversationProtocol = byPath.get("packages/cli/src/serve/conversation-protocol-runtime.ts");
  const deliveryPipeline = byPath.get("packages/core/src/delivery/authority-pipeline.ts");
  const surfaceAssetAuthority = byPath.get("packages/cli/src/serve/surface-asset-authority.ts");
  const surfaceAssets = byPath.get("packages/core/src/authority/surface-assets.ts");
  if (
    !assembly || !mesh || !transfer || !command || !server || !facade || !product ||
    !accessRoot || !executorRoot || !setup || !firstParty || !connectionLifetime || !localRouter ||
    !registry || !bootstrap || !channels || !inboundRouter || !conversationProtocol ||
    !deliveryPipeline || !surfaceAssetAuthority || !surfaceAssets
  ) {
    return ["planned anchor transfer production assembly sources are missing"];
  }
  const count = (text, token) => text.split(token).length - 1;
  const descriptor = frozenLiteralDescriptor(
    "packages/cli/src/serve/planned-anchor-transfer-mesh.ts",
    mesh,
    "PLANNED_ANCHOR_TRANSFER_ASSEMBLY_DESCRIPTOR",
  );
  const expectedDescriptor = {
    owner: "current-duty-device",
    receiver: "prepared-duty-target",
    roles: ["anchor-executor", "anchor-only"],
    targetPhases: ["prepare", "status", "freeze", "import", "commit", "abort"],
    sourcePhases: ["probe", "read-range"],
    order: ["ready", "prepare", "freeze", "import", "commit"],
    trustReconciliation: "single-planned-issuer-transition",
    readinessReservation: "target-lifecycle",
  };
  if (
    JSON.stringify(descriptor) !== JSON.stringify(expectedDescriptor) ||
    count(mesh, "PLANNED_ANCHOR_TRANSFER_ASSEMBLY_DESCRIPTOR.targetPhases.includes(") !== 1 ||
    count(mesh, "PLANNED_ANCHOR_TRANSFER_ASSEMBLY_DESCRIPTOR.sourcePhases.includes(") !== 1
  ) {
    failures.push("planned anchor transfer owner/receiver phase exact-set drifted");
  }

  const roots = records.filter(({ text }) => text.includes("new MeshRuntimeAssembly({"));
  const expectedRoots = new Set([
    "packages/cli/src/serve/access-surfaces.ts",
    "packages/cli/src/serve/executor-role-runtime.ts",
  ]);
  if (
    roots.length !== expectedRoots.size ||
    roots.some(({ relative }) => !expectedRoots.has(relative)) ||
    count(accessRoot, "new MeshRuntimeAssembly({") !== 1 ||
    count(executorRoot, "new MeshRuntimeAssembly({") !== 1 ||
    count(accessRoot, "plannedAnchorIssuerKey: bootstrap.anchorIssuerKey") !== 1 ||
    count(executorRoot, "plannedAnchorIssuerKey: bootstrap.mesh.anchorIssuerKey") !== 1
  ) {
    failures.push("planned anchor transfer two production roots exact-set drifted");
  }

  const ownerConstructions = records.filter(({ text }) =>
    text.includes("new PlannedAnchorTransferOwner({"));
  const targetConstructions = records.filter(({ text }) =>
    text.includes("new PlannedAnchorTransferTarget({"));
  if (
    ownerConstructions.length !== 1 ||
    ownerConstructions[0]?.relative !== "packages/cli/src/serve/mesh-runtime-assembly.ts" ||
    targetConstructions.length !== 1 ||
    targetConstructions[0]?.relative !== "packages/cli/src/serve/mesh-runtime-assembly.ts" ||
    count(assembly, "registerPlannedAnchorTransferSourceMeshService(") !== 1 ||
    count(assembly, "registerPlannedAnchorTransferMeshServices(") !== 1 ||
    count(
      assembly,
      'const roleEnabled = this.options.configuration.enabledRoles.includes("anchor")',
    ) !== 1 ||
    !assembly.includes('local?.state === "active" && local.roles.includes("anchor")')
  ) {
    failures.push("planned anchor transfer owner/receiver topology exact-set drifted");
  }
  if (
    count(accessRoot, "ctx.meshRuntime?.currentAnchorDeviceId()") !== 3 ||
    count(executorRoot, "mesh?.currentAnchorDeviceId()") !== 1 ||
    count(assembly, "currentSourceDeviceId: () => this.#control.currentTrust().issuer.deviceId") !== 1 ||
    count(assembly, "this.#plannedCommittedTargetDeviceId ??") !== 1 ||
    count(assembly, "this.#plannedCommittedTargetDeviceId = targetDeviceId") !== 1 ||
    count(transfer, "this.options.onSourceCommitted?.(state.identity.targetDeviceId)") !== 3
  ) {
    failures.push("planned anchor transfer current-owner resolver exact-set drifted");
  }
  if (
    count(command, "conversationRpc: new CurrentAnchorFirstPartyRpcRouter({") !== 1 ||
    count(executorRoot, "new CurrentAnchorFirstPartyRpcRouter({") !== 1 ||
    count(executorRoot, "new ExecutorFirstPartyRpcRouter({") !== 1 ||
    count(firstParty, "export class CurrentAnchorFirstPartyRpcRouter") !== 1 ||
    count(firstParty, "const current = this.input.currentAnchorDeviceId()") !== 1 ||
    count(firstParty, "result: await remote.dispatch(input.method, input.params, input.connection)") !== 1 ||
    count(firstParty, "captureCurrentAnchorRelayMethods()") !== 1 ||
    count(firstParty, "fulfillConnectionLifetimeObligation({") !== 1 ||
    firstParty.includes("connectionClosed") ||
    count(connectionLifetime, "readonly connectionClosed?: Promise<unknown>;") !== 1 ||
    count(firstParty, 'error.code === "connection-closed"') !== 1 ||
    count(firstParty, 'error.code === "service-unavailable"') !== 1 ||
    count(firstParty, 'error.code === "request-timeout"') !== 1 ||
    count(firstParty, "error.code === RPC_ERROR_CODES.BUSY") !== 1 ||
    count(firstParty, "this.#active.get(connectionId) !== active") !== 1 ||
    count(registry, ".filter((name) => !local.has(name))") !== 1 ||
    count(localRouter, "export class ExecutorFirstPartyRpcRouter") !== 1 ||
    count(localRouter, "if (LOCAL_METHODS.has(input.method))") !== 1 ||
    count(localRouter, "if (isCurrentAnchorRelayMethod(input.method))") !== 1 ||
    !assembly.includes('this.#peerHasRole(deviceId, "executor") ||') ||
    !assembly.includes('this.#peerHasRole(deviceId, "anchor")')
  ) {
    failures.push("planned anchor transfer first-party current-owner relay drifted");
  }

  const sourceClaim = transfer.indexOf("const candidate = await this.#journal.claimCandidate({");
  const remoteReady = transfer.indexOf("proof: await target.ready({", sourceClaim);
  const targetClaim = transfer.indexOf("const candidate = await this.#candidates.claimCandidate(identity);");
  const targetContext = transfer.indexOf("const context = this.#context(identity.transferId);", targetClaim);
  const targetKey = transfer.indexOf("await createAnchorTransferReadyProof({", targetClaim);
  if (
    sourceClaim < 0 || remoteReady < sourceClaim ||
    targetClaim < 0 || targetContext < targetClaim || targetKey < targetClaim ||
    count(transfer, "planned-anchor-candidate-release-delivered") !== 3 ||
    count(mesh, "PLANNED_ANCHOR_CANDIDATE_RELEASE_SERVICE") !== 3 ||
    count(assembly, "registerPlannedAnchorTransferMeshServices(") !== 1
  ) {
    failures.push("planned anchor candidate durable single-flight or claim-before-effect drifted");
  }
  const targetRelease = transfer.indexOf("async releaseCandidate(input: PlannedAnchorCandidateRelease)");
  const targetReleaseContext = transfer.indexOf(
    "const context = this.#context(release.identity.transferId);",
    targetRelease,
  );
  const targetReleasePhase = transfer.indexOf(
    "const phase = await context.journal.state(release.identity.transferId);",
    targetReleaseContext,
  );
  const targetReleaseDecision = transfer.indexOf(
    "await this.#candidates.releaseUnprepared(release.identity);",
    targetReleasePhase,
  );
  if (
    count(transfer, "const state = await this.#journal.prepareCandidate(preparedRecord(command));") !== 1 ||
    count(transfer, "await this.#journal.releaseUnpreparedCandidate(candidate.identity);") !== 1 ||
    count(
      transfer,
      "const decision = await this.#candidates.markPrepared(candidate.identity, prepared);",
    ) !== 1 ||
    count(transfer, "const state = await context.journal.append(decision.prepared!);") !== 1 ||
    targetRelease < 0 || targetReleaseContext < targetRelease ||
    targetReleasePhase < targetReleaseContext || targetReleaseDecision < targetReleasePhase
  ) {
    failures.push("planned anchor candidate terminal/prepared durable ordering drifted");
  }

  const remoteAbort = transfer.indexOf(
    "const decision = await this.#candidates.decideRemoteAbort(",
  );
  const remoteAbortCleanup = transfer.indexOf(
    "await this.#cleanupClaimOnlyCandidate(decision);",
    remoteAbort,
  );
  const remotePreparedMaterialization = transfer.indexOf(
    "state = await context.journal.append(decision.prepared);",
    remoteAbort,
  );
  const candidateRecovery = transfer.indexOf(
    "for (const candidate of (await this.#candidates.states()).values())",
  );
  const phaseRecovery = transfer.indexOf(
    "const journalsRoot = path.join(this.options.stagingRoot, \"journals\");",
    candidateRecovery,
  );
  if (
    count(transfer, "readonly prepared?: PlannedAnchorPreparedRecord;") !== 1 ||
    count(transfer, "readonly abort?: AnchorTransferAbort;") !== 1 ||
    count(transfer, "prepared: PlannedAnchorPreparedRecord;") !== 1 ||
    count(transfer, "readonly abort: AnchorTransferAbort;") !== 1 ||
    count(transfer, "async decideRemoteAbort(") !== 1 ||
    remoteAbort < 0 || remoteAbortCleanup < remoteAbort ||
    remotePreparedMaterialization < remoteAbort ||
    candidateRecovery < 0 || phaseRecovery < candidateRecovery ||
    count(transfer, "assertCandidateReadyProofIdentity(candidate);") !== 2 ||
    count(transfer, "await this.#assertCandidateIssuerKey(candidate);") !== 2
  ) {
    failures.push("planned anchor signed abort or candidate terminal recovery drifted");
  }

  const completion = transfer.indexOf("export async function completePlannedAnchorInstallationBeforeBootstrap(");
  const loadInstall = transfer.indexOf("loadCurrentPlannedAnchorInstallation(", completion);
  const activateKey = transfer.indexOf("await activateAnchorIssuerKey(", completion);
  const committed = transfer.indexOf('t: "anchor-committed"', completion);
  const bootstrapCompletion = bootstrap.indexOf("completePlannedAnchorInstallationBeforeBootstrap({");
  const activeGate = bootstrap.indexOf("loadActiveAnchorIssuerKey(", bootstrapCompletion);
  if (
    completion < 0 || loadInstall < completion || activateKey < loadInstall || committed < activateKey ||
    bootstrapCompletion < 0 || activeGate < bootstrapCompletion ||
    count(assembly, "bindPlannedAnchorPostInstallConsumers(") !== 1 ||
    count(command, "bindPlannedAnchorPostInstallConsumers({") !== 1 ||
    !assembly.includes('kind: "assignment" | "intent"') ||
    !assembly.includes('kind: "interaction" | "confirmation" | "final"') ||
    !assembly.includes('kind: "delivery"') ||
    count(assembly, "await finishPlannedAnchorPostInstall({") !== 1 ||
    count(firstParty, "this.input.isReady?.() === false") !== 1
  ) {
    failures.push("planned anchor pre-bootstrap/post-install completion closure drifted");
  }
  const generationParticipants = frozenLiteralDescriptor(
    "packages/cli/src/setup-delivery.ts",
    setup,
    "INSTALLED_AUTHORITY_GENERATION_PARTICIPANTS",
  );
  const expectedGenerationParticipants = [
    "runtime-epoch",
    "delivery-authority",
    "control-admission",
    "resource-governor",
    "surface-assets",
    "workscene-global-state",
    "skill-global-state",
    "rubric-global-state",
  ];
  const generationRebind = command.indexOf(
    "const receipt = await ctx.authorityRuntime!.rebindInstalledAuthority(generation);",
  );
  const schedulerRecovery = command.indexOf("recoverScheduler: async", generationRebind);
  const assemblyGenerationRebind = assembly.indexOf(
    "const generationReceipt = await consumers.rebindAuthorityGeneration(",
  );
  if (
    JSON.stringify(generationParticipants) !== JSON.stringify(expectedGenerationParticipants) ||
    count(
      bootstrap,
      "installedAuthorityGeneration: anchorPostInstall.installedGeneration",
    ) !== 1 ||
    count(
      accessRoot,
      "installedAuthorityGeneration: bootstrap.installedAuthorityGeneration",
    ) !== 1 ||
    count(setup, "const rebindInstalledAuthority = async (") !== 1 ||
    count(setup, "installedAuthorityGeneration = Object.freeze(structuredClone(generation));") !== 1 ||
    setup.includes("AnchorMemoryGlobalStateAdapter") ||
    setup.includes('"memory-global-state"') ||
    setup.includes("memory-domain:") ||
    count(
      setup,
      "rebindSurfaceAssetAuthority(surfaceAssets!, nextSurfaceAssetOptions)",
    ) !== 1 ||
    count(surfaceAssetAuthority, "await authority.rebindAuthority(binding);") !== 1 ||
    count(surfaceAssets, "async rebindAuthority(binding: SurfaceAssetAuthorityBinding)") !== 1 ||
    generationRebind < 0 || schedulerRecovery < generationRebind ||
    assemblyGenerationRebind < 0 ||
    assemblyGenerationRebind > assembly.indexOf(
      "const readBack = await readBackPlannedAnchorPostInstallObligations({",
    )
  ) {
    failures.push("planned anchor installed authority generation rebind exact-set drifted");
  }
  const plannedLifecycle = command.indexOf("ctx.meshRuntime?.bindPlannedAnchorLifecycle({");
  const stopInbound = command.indexOf("ctx.inboundRouter?.refuseNewMessages()", plannedLifecycle);
  const drainInbound = command.indexOf(
    "await ctx.inboundRouter?.drainAcceptedMessages()",
    stopInbound,
  );
  const disconnectChannels = command.indexOf(
    "await ctx.channelConnections?.disconnectConfigured()",
    drainInbound,
  );
  const quiesceDelivery = command.indexOf(
    "await ctx.deliveryStack?.quiesceForAuthorityTransfer()",
    disconnectChannels,
  );
  const drainAccepted = command.indexOf("drainAccepted: async () => {", quiesceDelivery);
  const postInstallReadBack = assembly.indexOf(
    "const readBack = await readBackPlannedAnchorPostInstallObligations({",
  );
  const postInstallFinish = assembly.indexOf(
    "await finishPlannedAnchorPostInstall({",
    postInstallReadBack,
  );
  const postInstallOpen = assembly.indexOf(
    "await consumers.openCurrentOwnerSurfaces()",
    postInstallFinish,
  );
  if (
    plannedLifecycle < 0 || stopInbound < plannedLifecycle || drainInbound < stopInbound ||
    disconnectChannels < drainInbound || quiesceDelivery < disconnectChannels ||
    drainAccepted < quiesceDelivery ||
    count(command, "await ctx.deliveryStack?.resumeAfterAuthorityTransfer()") !== 4 ||
    count(command, "await protocol.recoverInstalledAuthority()") !== 1 ||
    count(command, "return obligations;") !== 4 ||
    count(conversationProtocol, "async recoverInstalledAuthority(): Promise<number>") !== 1 ||
    count(deliveryPipeline, "async quiesceForAuthorityTransfer(): Promise<void>") !== 1 ||
    count(deliveryPipeline, "async resumeAfterAuthorityTransfer(): Promise<void>") !== 1 ||
    postInstallReadBack < 0 || postInstallFinish < postInstallReadBack ||
    postInstallOpen < postInstallFinish
  ) {
    failures.push("planned anchor source quiesce or installed consumer read-back order drifted");
  }
  if (
    count(accessRoot, "isCurrentOwner: isCurrentChannelOwner") !== 1 ||
    count(accessRoot, "connectImmediately: isCurrentChannelOwner()") !== 1 ||
    count(accessRoot, "connectConfigured: result.connectConfigured") !== 1 ||
    count(accessRoot, "disconnectConfigured: result.disconnectConfigured") !== 1 ||
    count(channels, "isCurrentOwner,") !== 2 ||
    count(channels, "connectImmediately = true") !== 1 ||
    count(channels, "if (isCurrentOwner?.() === false)") !== 1 ||
    count(channels, "onChallengeAction: currentOwnerChallengeAction") !== 1 ||
    count(channels, "connectConfigured,") !== 2 ||
    count(channels, "disconnectConfigured,") !== 1 ||
    count(inboundRouter, "if (!this.isCurrentOwner())") !== 1 ||
    count(inboundRouter, "async drainAcceptedMessages(): Promise<void>") !== 1
  ) {
    failures.push("planned anchor channel current-owner connection or final guard drifted");
  }

  const recoveryCall = "await this.#plannedAnchorOwner?.recoverBeforeAdmission()";
  const targetRecoveryCall = "await this.#plannedAnchorTarget?.recoverBeforeAdmission()";
  const connectionRecoveryGate = /this\.\#plannedTransferRuntime\.run\(async \(\) => \{\s+await this\.\#plannedAnchorOwner\?\.recoverBeforeAdmission\(\);\s+\}\)/;
  const startupRecoveryGate = /this\.\#plannedTransferRuntime\.run\(async \(\) => \{\s+await this\.\#plannedAnchorTarget\?\.recoverBeforeAdmission\(\);\s+await this\.\#plannedAnchorOwner\?\.recoverBeforeAdmission\(\);\s+\}\)/;
  const recovery = assembly.lastIndexOf(recoveryCall);
  const targetRecovery = assembly.indexOf(targetRecoveryCall);
  const startupRecovery = assembly.indexOf(
    "await this.#recoverStartupState(options.lifecycleAdmissionClosed === true)",
  );
  const admission = assembly.indexOf("await this.#startControl()", startupRecovery);
  const reconcile = assembly.indexOf("await reconcilePlannedAnchorTrustFromPeer(");
  const connectionRecovery = assembly.indexOf(
    recoveryCall,
    reconcile,
  );
  const freeze = assembly.indexOf("await owner.freeze(input)");
  const commitCall = assembly.indexOf("return owner.commit(input)", freeze);
  if (
    count(assembly, recoveryCall) !== 2 || count(assembly, targetRecoveryCall) !== 1 ||
    !connectionRecoveryGate.test(assembly) || !startupRecoveryGate.test(assembly) ||
    targetRecovery < 0 || targetRecovery > recovery || recovery < 0 || startupRecovery < 0 ||
    admission < startupRecovery || reconcile < 0 ||
    connectionRecovery < reconcile || freeze < 0 || commitCall < freeze ||
    count(assembly, "registerPlannedAnchorTrustReconciliationService(") !== 1 ||
    count(assembly, "reconcilePlannedAnchorTrustFromPeer(") !== 1 ||
    !transfer.includes("await this.options.onInstalled?.(record)") ||
    !assembly.includes("await this.#control.reconcileTrust(record)")
  ) {
    failures.push("planned anchor transfer recovery/commit/admission order drifted");
  }

  if (
    count(setup, "const plannedAnchorReadiness = createPlannedAnchorReadinessCoordinator(") !== 1 ||
    count(setup, "plannedAnchorReadiness: plannedAnchorReadiness.port") !== 1 ||
    count(setup, "plannedAnchorReadiness.runRevisionChange(") !== 1 ||
    count(assembly, "readiness: this.options.authority.plannedAnchorReadiness") !== 3 ||
    count(transfer, "this.options.readiness.reserve({") !== 3 ||
    count(transfer, "this.options.readiness.release(") !== 5 ||
    count(mesh, "options.lifecycle.run(() => target.") !== 4
  ) {
    failures.push("planned anchor transfer readiness reservation assembly drifted");
  }

  const publicMethods = [
    "dutyMigration.targets",
    "dutyMigration.prepare",
    "dutyMigration.commit",
    "dutyMigration.cancel",
  ];
  if (
    publicMethods.some((method) =>
      count(server, `name: "${method}"`) !== 1 ||
      count(facade, `"${method}"`) !== 1) ||
    count(command, "dutyMigration: {") !== 1 ||
    !product.includes("正在检查目标设备并准备迁移") ||
    !product.includes("此时仍可取消") ||
    !product.includes("正在收束当前任务并传输耐久状态") ||
    !product.includes("后续操作将由新设备处理")
  ) {
    failures.push("planned anchor transfer public journey or canonical RPC exact-set drifted");
  }
  const targetsStart = assembly.indexOf("async plannedAnchorTargets(): Promise");
  const targetsEnd = assembly.indexOf("preparePlannedAnchorTransfer(input:", targetsStart);
  const targetsBlock = targetsStart >= 0 && targetsEnd > targetsStart
    ? assembly.slice(targetsStart, targetsEnd)
    : "";
  if (
    count(targetsBlock, "this.#plannedTransferRuntime.run(") !== 1 ||
    count(product, "const transferId = createDutyMigrationTransferId();") !== 1 ||
    !product.includes("return `xfer-${encoded}`;")
  ) {
    failures.push("planned anchor transfer stop gate or strict product identity drifted");
  }
  const publicText = [...product.matchAll(
    /(?:console\.log|TypeError)\((?:`([^`]*)`|"([^"]*)"|'([^']*)')/gu,
  )].map((match) => match[1] ?? match[2] ?? match[3] ?? "").join(" ");
  if (/anchor|epoch|issuer|catalog/iu.test(publicText)) {
    failures.push("planned anchor transfer public journey leaks internal topology terms");
  }
  return failures;
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
      "resolveDurableUncertain",
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
    ["packages/cli/src/serve/post-adoption-review.ts", undefined],
    ["packages/cli/src/serve/command.ts", undefined],
    ["packages/cli/src/runtime/rpc-confirmation-broker.ts", undefined],
    ["packages/cli/src/repl.ts", undefined],
    ["packages/rpc/src/confirmation-bridge.ts", undefined],
    ["packages/server/src/context.ts", undefined],
    ["packages/server/src/rpc/handlers.ts", undefined],
    ["packages/server/src/rpc/methods/index.ts", undefined],
    ["packages/server/src/rpc/methods/session.ts", undefined],
    ["packages/server/src/rpc/methods/confirmation.ts", undefined],
    ["packages/owner-kernel/src/conversation-run-contracts.ts", undefined],
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
    !/this\.#firstPartyConversationTarget\s*=\s*roles\.has\("anchor"\)[\s\S]*?new\s+FirstPartyConversationMeshTarget\s*\(\s*\{[\s\S]*?isReady:\s*\(\)\s*=>\s*this\.plannedCurrentOwnerReady\(\)/u.test(mesh.text) ||
    !/registerFirstPartyConversationMeshService\s*\([\s\S]*?this\.#firstPartyConversationTarget/u.test(mesh.text)
  ) {
    failures.push(`${mesh.relative}: anchor must own the single finite first-party conversation relay target`);
  }
  const startBoundary = mesh.text.search(/  async start\([^)]*\): Promise<void> \{/u);
  const stopBoundary = mesh.text.indexOf("  async stop(): Promise<void> {");
  if (startBoundary < 0 || stopBoundary < 0 || startBoundary > stopBoundary) {
    failures.push(`${mesh.relative}: mesh lifecycle start/stop boundary is missing`);
  } else {
    const startBody = mesh.text.slice(startBoundary, stopBoundary);
    const recoveryCall = startBody.indexOf(
      "await this.#recoverStartupState(options.lifecycleAdmissionClosed === true)",
    );
    const admission = startBody.indexOf("await this.#startControl()", recoveryCall);
    const recoveryBoundary = mesh.text.indexOf("  async #recoverStartupState(");
    const recoveryEnd = mesh.text.indexOf("  currentAnchorDeviceId():", recoveryBoundary);
    const recoveryBody = recoveryBoundary >= 0 && recoveryEnd > recoveryBoundary
      ? mesh.text.slice(recoveryBoundary, recoveryEnd)
      : "";
    const restore = recoveryBody.indexOf("await this.#restoreCommittedTransfers()");
    const prematureAdmission = recoveryBody.indexOf("await this.#startControl()");
    const lifecycleResume = mesh.text.slice(
      mesh.text.indexOf("  async recoverAcceptedWorkForLifecycle():"),
      mesh.text.indexOf("  resumeAcceptingAfterLifecycle():"),
    );
    const resumedRecovery = lifecycleResume.indexOf("await this.#recoverStartupState(true)");
    const resumedAdmission = lifecycleResume.indexOf("await this.#startControl()", resumedRecovery);
    if (
      recoveryCall < 0 || admission < recoveryCall || restore < 0 ||
      (prematureAdmission >= 0 && prematureAdmission < restore) ||
      resumedRecovery < 0 || resumedAdmission < resumedRecovery
    ) {
      failures.push(`${mesh.relative}: committed transfers must restore before mesh admission opens`);
    }
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
  requireCount(executorRoot, /new\s+ExecutorFirstPartyRpcRouter\s*\(/gu, 1, "first-party executor ownership composite construction");
  requireCount(executorRoot, /new\s+CurrentAnchorFirstPartyRpcRouter\s*\(/gu, 1, "first-party current-anchor router construction");
  requireCount(executorRoot, /conversationRpc\s*,/gu, 1, "first-party ownership composite injection");

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
  const registry = required.get("packages/server/src/rpc/methods/index.ts");
  if (
    !/captureCurrentAnchorRelayMethods\s*\(\)[\s\S]*?captureBuiltinRegistryDescriptor\s*\(\)[\s\S]*?\.filter\(\(name\)\s*=>\s*!local\.has\(name\)\)/u.test(registry.text) ||
    !/export\s+const\s+LOCAL_CONVERSATION_RPC_METHODS[\s\S]*?"session\.resolve"/u.test(router.text) ||
    !/if\s*\(LOCAL_METHODS\.has\(input\.method\)\)\s*return\s+this\.input\.local\.dispatch\(input\);[\s\S]*?if\s*\(isCurrentAnchorRelayMethod\(input\.method\)\)/u.test(router.text)
  ) {
    failures.push("packages/cli/src/serve/local-conversation-rpc.ts: executor-only first-party method ownership exact-set drifted");
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
  requireCount(command, /new\s+PostAdoptionReviewCoordinator\s*\(/gu, 1, "anchor post-adoption review construction");
  requireCount(command, /bindPostAdoptionReview\s*\(/gu, 1, "anchor post-adoption review binding");
  const reviewBinding = command.text.indexOf("await ctx.meshRuntime.bindPostAdoptionReview(");
  const publicServer = command.text.indexOf("runner = await runServer(");
  if (
    reviewBinding < 0 || publicServer < 0 || reviewBinding > publicServer
  ) {
    failures.push(`${command.relative}: adoption review recovery must bind before public server admission`);
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
    !/const\s+METHODS\s*=\s*new\s+Set\s*\(CURRENT_ANCHOR_RELAY_METHODS\)/u.test(firstParty.text) ||
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

  const retiredMemoryOwners = [
    mesh,
    command,
    required.get("packages/owner-kernel/src/conversation-run-contracts.ts"),
  ];
  for (const record of retiredMemoryOwners) {
    if (/PostAdoptionMemory|post-adoption-memory|bindPostAdoptionMemory|conversationMemoryFlushes/u.test(record.text)) {
      failures.push(`${record.relative}: retired post-adoption memory production or durable record semantics must stay absent`);
    }
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
  "packages/cli/src/runtime/surface-core-host-link.ts",
  "packages/cli/src/serve/stop.ts",
]);
const coreHostConnectionOwners = new Set([
  "packages/cli/src/repl.ts",
  "packages/cli/src/runtime/anchor-uninstall-command.ts",
  "packages/cli/src/runtime/device-removal-command.ts",
  "packages/cli/src/runtime/duty-migration-command.ts",
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
