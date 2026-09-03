import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FEISHU_INBOUND_EVENT_NAMES } from "../packages/channels/feishu/src/adapter.ts";
import { SKILL_COMMAND_SOURCE_DESCRIPTOR } from "../packages/cli/src/commands/skill-command-source.ts";
import { captureCliCommandDescriptor } from "../packages/cli/src/index.ts";
import { captureChannelAdapterFactoryDescriptor } from "../packages/cli/src/serve/channels.ts";
import { planServeTopology } from "../packages/cli/src/serve/role-topology.ts";
import { createAnchorRuntimeProjectionAssembly } from "../packages/cli/src/serve/workscene-runtime-projection.ts";
import { SEGMENT_TRANSITION_HOOK_PHASES } from "../packages/core/src/context/segment/types.ts";
import { AGENT_RUNTIME_LIFECYCLE_PHASES } from "../packages/orchestrator/src/runtime/lifecycle.ts";
import { TASK_TOOL_CAPABILITY_DESCRIPTOR } from "../packages/orchestrator/src/tools/task.ts";
import {
  BUILTIN_EXTRA_TOOL_CAPABILITIES,
  createBuiltinExtraToolsAssembly,
} from "../packages/cli/src/serve/builtin-extra-tools.ts";
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

export function inspectChannelRuntimeBoundary(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const channels = byPath.get("packages/cli/src/serve/channels.ts");
  const access = byPath.get("packages/cli/src/serve/access-surfaces.ts");
  const binding = byPath.get(
    "packages/cli/src/serve/channel-conversation-product-binding.ts",
  );
  const command = byPath.get("packages/cli/src/serve/command.ts");
  const conversationApplication = byPath.get(
    "packages/core/src/conversation/application.ts",
  );
  const admission = byPath.get(
    "packages/owner-kernel/src/conversation-agent-turn-admission.ts",
  );
  const runControl = byPath.get(
    "packages/cli/src/serve/conversation-run-control-binding.ts",
  );
  const context = byPath.get("packages/server/src/context.ts");
  const server = byPath.get("packages/server/src/server.ts");
  const inbound = byPath.get("packages/server/src/channels/inbound-router.ts");
  const confirmation = byPath.get("packages/server/src/confirmation/text-renderer.ts");
  const delivery = byPath.get("packages/core/src/delivery/channel-effect.ts");
  const lossless = byPath.get("packages/cli/src/serve/lossless-data-plane-runtime.ts");
  const coordinator = byPath.get("packages/cli/src/serve/channel-interaction-coordinator.ts");
  const setupDelivery = byPath.get("packages/cli/src/setup-delivery.ts");
  if (
    !channels || !access || !binding || !command || !conversationApplication ||
    !admission || !runControl || !context || !server || !inbound ||
    !confirmation || !delivery || !lossless || !coordinator || !setupDelivery
  ) {
    return ["channel runtime boundary production sources are missing"];
  }
  const count = (text, token) => text.split(token).length - 1;
  const resultContract = channels.match(
    /export interface SetupChannelsResult\s*\{([\s\S]*?)\n\}/u,
  )?.[1] ?? "";
  const returnedResult = channels.match(
    /\n  return \{\n    router,([\s\S]*?)\n  \};\n\}/u,
  )?.[1] ?? "";
  if (
    count(channels, "new ChannelRegistry({") !== 1 ||
    count(channels, 'import("@zhixing/channel-feishu")') !== 1 ||
    !channels.includes("satisfies ChannelDeliveryEffectSource") ||
    count(channels, "const inbound = Object.freeze({") !== 1 ||
    count(channels, "satisfies InboundChannelPort") !== 1 ||
    count(channels, "channels: inbound") !== 1 ||
    !channels.includes("satisfies ChannelChallengeDeliveryPort") ||
    !channels.includes("statusSnapshot") ||
    !channels.includes("dispose: () => registry.dispose()") ||
    resultContract.includes("ChannelRegistry") ||
    /\bregistry\s*:/u.test(resultContract)
  ) {
    failures.push("channel registry, adapter factory or finite Host port assembly drifted");
  }
  if (
    /\b(?:readonly\s+)?inbound\s*:/u.test(resultContract) ||
    /\b(?:ChannelRegistry|ChannelAdapter)\b/u.test(resultContract) ||
    /^\s*inbound,\s*$/mu.test(returnedResult)
  ) {
    failures.push("SetupChannelsResult exposes an unconsumed Channel capability");
  }
  const concreteForbidden = records.filter((record) =>
    record.relative !== "packages/cli/src/serve/channels.ts" &&
    !record.relative.startsWith("packages/core/src/channels/") &&
    !record.relative.startsWith("packages/channels/feishu/src/") &&
    /\b(?:ChannelRegistry|ChannelAdapter|isChallengeChannel)\b/u.test(record.text)
  );
  if (concreteForbidden.length > 0) {
    failures.push("concrete Channel registry or adapter escaped the Host infrastructure edge");
  }
  if (
    !access.includes("ctx.channelStatuses = result.statusSnapshot") ||
    !access.includes("ctx.channelDelivery = result.delivery") ||
    !access.includes("ctx.channelChallenges = result.challenges") ||
    !access.includes("losslessDataPlane.bindChannelChallenges(result.challenges)") ||
    access.includes("result.registry") ||
    !setupDelivery.includes("channels: ChannelDeliveryEffectSource") ||
    setupDelivery.includes("ChannelRegistry")
  ) {
    failures.push("Host consumers do not receive separate finite Channel ports");
  }
  if (
    !context.includes("channelStatuses?: () => readonly Readonly<ChannelStatus>[]") ||
    /\bchannels\??:\s*ChannelRegistry/u.test(context) ||
    server.includes("ctx.channels") ||
    !inbound.includes("export interface InboundChannelPort") ||
    inbound.includes("ChannelRegistry") ||
    !confirmation.includes("export interface ConfirmationChannelPort") ||
    confirmation.includes("ChannelRegistry")
  ) {
    failures.push("Server status, inbound or confirmation demand boundary drifted");
  }
  if (
    !delivery.includes("export interface ChannelDeliveryEffectSource") ||
    delivery.includes("ChannelAdapter") ||
    !lossless.includes("export interface ChannelChallengeDeliveryPort") ||
    lossless.includes("ChannelRegistry") ||
    lossless.includes("isChallengeChannel") ||
    coordinator.includes("ChannelRegistry") ||
    coordinator.includes("isChallengeChannel")
  ) {
    failures.push("Delivery or signed-challenge demand boundary drifted");
  }
  if (
    !inbound.includes("export interface InboundConversationApplicationPort") ||
    !inbound.includes("this.conversation.prepareAgentTurn({") ||
    !inbound.includes("this.conversation.admitAgentTurn({") ||
    !inbound.includes("this.conversation.abort({") ||
    /ConversationManager|ManagedSession|projectSessionTurn|usesDurableTurnProtocol|admitDurableTurn|cancelDurableRuns|durableControlPrincipal|\.setBusy\(/u.test(
      inbound,
    ) ||
    !channels.includes("conversation?: InboundConversationApplicationPort") ||
    !channels.includes("      conversation,") ||
    /ConversationManager|ManagedSession|conversations:/u.test(channels)
  ) {
    failures.push(
      "Channel Surface bypasses the finite Conversation application boundary",
    );
  }
  if (
    count(binding, "export class ChannelConversationProductBinding") !== 1 ||
    count(binding, "productApi.command(") !== 3 ||
    !binding.includes("CONVERSATION_PREPARE_AGENT_TURN_IDENTITY_COMMAND") ||
    !binding.includes("CONVERSATION_ADMIT_AGENT_TURN_COMMAND") ||
    !binding.includes("CONVERSATION_ABORT_COMMAND") ||
    !binding.includes('source: "channel"') ||
    !binding.includes("projectSessionTurn({") ||
    !binding.includes("close(): void") ||
    /\.admitTurn\(|\.admitDurableTurn\(|\.cancelDurableRuns\(/u.test(binding) ||
    count(access, "new ChannelConversationProductBinding(") !== 1 ||
    !access.includes("conversation: conversationProduct") ||
    !access.includes("conversationProduct.close()") ||
    count(command, "ctx.channelConversationProduct?.bind(productApi)") !== 1
  ) {
    failures.push(
      "Channel Conversation Product API binding or unique Host composition drifted",
    );
  }
  if (
    !conversationApplication.includes('source?: "interactive" | "channel"') ||
    !conversationApplication.includes("command.source ?? \"interactive\"") ||
    !conversationApplication.includes("abstract class ConversationCancellationResponseEffect") ||
    !conversationApplication.includes('readonly kind = "authoritative-response"') ||
    /class ConversationCancellationResponseEffect\s*\{[^}]*\b(?:channelId|threadId|replyTarget)\b/u.test(
      conversationApplication,
    ) ||
    !conversationApplication.includes("cancellation.authoritativeResponse") ||
    !admission.includes('request.source ?? "interactive"') ||
    !runControl.includes("createChannelCancellationResponseEffect(") ||
    !runControl.includes("requireChannelCancellationResponse(") ||
    !runControl.includes("request.response") ||
    !runControl.includes("authoritativeResponse: true")
  ) {
    failures.push(
      "Conversation admission or durable cancellation mechanism binding drifted",
    );
  }
  return failures;
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
    inert,
  );
  const productAssembly = createAnchorRuntimeProjectionAssembly({
    workscenes: inert,
    worksceneAssignmentTools: inert,
    extraTools: assembly,
    mcpTools: { snapshot: () => ({ tools: [], serverIds: [] }) },
    scheduler: () => inert,
  });
  const assembledNames = (kind) => {
    const projection = kind === "main"
      ? productAssembly.main()
      : productAssembly.scene({
          scene: {
            sceneId: "coverage",
            name: "coverage",
          },
          absolutePath: "/coverage",
        });
    return new Set(projection.runtimeTools.extraTools.map((tool) => tool.name));
  };
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

/** A4 Kernel runs have one finite Envelope owner and three production bindings. */
export function inspectKernelRunEnvelopeOwnership(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const required = (relative) => {
    const text = byPath.get(relative);
    if (text === undefined) failures.push(`${relative}: Kernel Run Envelope source is missing`);
    return text ?? "";
  };
  const envelopePath = "packages/orchestrator/src/runtime/kernel-run-envelope.ts";
  const envelopeSource = required(envelopePath);
  const runtimeSource = required(
    "packages/orchestrator/src/runtime/create-agent-runtime.ts",
  );
  const runtimeIndex = required("packages/orchestrator/src/runtime/index.ts");
  const sessionAdapter = required("packages/runtime-host/src/session-adapter.ts");
  const ephemeral = required("packages/cli/src/serve/ephemeral-executor.ts");
  const durableJob = required("packages/cli/src/serve/agent-job-runtime.ts");
  const runtimeHost = required("packages/runtime-host/src/runtime-host.ts");
  const worksceneProjection = required(
    "packages/cli/src/serve/workscene-runtime-projection.ts",
  );

  const sourceFile = ts.createSourceFile(
    envelopePath,
    envelopeSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const envelopeDeclarations = sourceFile.statements.filter(
    (statement) =>
      ts.isInterfaceDeclaration(statement) &&
      statement.name.text === "KernelRunEnvelope",
  );
  const envelopeDeclaration = envelopeDeclarations[0];
  const expectedPartitions = {
    modelInput: ["messages"],
    identity: [
      "turnIndex",
      "conversationId",
      "source",
      "advancement",
      "turnContext",
    ],
    control: ["abortSignal", "watchdog", "modelCallResourceMeter"],
    correctness: [
      "toolSideEffectObserver",
      "authorizeToolExecution",
      "stageScheduleMutation",
      "assignmentMutations",
      "globalQuery",
      "assignmentIssuedAt",
      "resourceReservation",
    ],
    observation: ["onEvent", "onProtocolEvent"],
  };
  if (envelopeDeclarations.length !== 1 || !envelopeDeclaration) {
    failures.push("Kernel Run Envelope lacks one interface owner");
  } else {
    const partitionNames = envelopeDeclaration.members
      .filter(ts.isPropertySignature)
      .map((member) => member.name.getText(sourceFile));
    if (JSON.stringify(partitionNames) !== JSON.stringify(Object.keys(expectedPartitions))) {
      failures.push("Kernel Run Envelope top-level partition exact-set drifted");
    }
    for (const member of envelopeDeclaration.members) {
      if (!ts.isPropertySignature(member)) {
        failures.push("Kernel Run Envelope admits a non-property or dictionary member");
        continue;
      }
      const name = member.name.getText(sourceFile);
      const expected = expectedPartitions[name];
      const readonly = member.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
      );
      if (!readonly || member.questionToken || !expected || !member.type || !ts.isTypeLiteralNode(member.type)) {
        failures.push(`Kernel Run Envelope partition is not required, readonly and finite: ${name}`);
        continue;
      }
      const fields = member.type.members
        .filter(ts.isPropertySignature)
        .map((field) => field.name.getText(sourceFile));
      if (JSON.stringify(fields) !== JSON.stringify(expected)) {
        failures.push(`Kernel Run Envelope ${name} field exact-set drifted`);
      }
      if (
        member.type.members.some(
          (field) =>
            !ts.isPropertySignature(field) ||
            !field.modifiers?.some(
              (modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
            ),
        )
      ) {
        failures.push(`Kernel Run Envelope ${name} fields are not all readonly properties`);
      }
    }
  }

  const declarationOwners = records
    .filter((record) => {
      const file = ts.createSourceFile(
        record.relative,
        record.text,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      return file.statements.some(
        (statement) =>
          (ts.isInterfaceDeclaration(statement) ||
            ts.isTypeAliasDeclaration(statement)) &&
          statement.name.text === "KernelRunEnvelope",
      );
    })
    .map((record) => record.relative);
  if (
    declarationOwners.length !== 1 ||
    declarationOwners[0] !== envelopePath ||
    records.some((record) => /\bRunParams\b/u.test(record.text))
  ) {
    failures.push("Kernel run input has a second owner or the retired RunParams contract remains");
  }
  if (
    !runtimeSource.includes("run: (envelope: KernelRunEnvelope) => Promise<KernelRunCompletion>") ||
    !runtimeSource.includes("async run(input: KernelRunEnvelope): Promise<KernelRunCompletion>") ||
    !runtimeSource.includes("const envelope = captureKernelRunEnvelope(input);") ||
    runtimeSource.includes("runV2") ||
    !runtimeIndex.includes('export type { KernelRunEnvelope } from "./kernel-run-envelope.js";')
  ) {
    failures.push("AgentRuntime does not expose one captured Kernel Run Envelope entry");
  }

  const assertRunBinding = (relative, text, receiver) => {
    const file = ts.createSourceFile(
      relative,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const calls = [];
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "run" &&
        node.expression.expression.getText(file) === receiver
      ) {
        calls.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    const argument = calls[0]?.arguments[0];
    const keys = argument && ts.isObjectLiteralExpression(argument)
      ? argument.properties.map((property) => property.name?.getText(file) ?? "")
      : [];
    if (
      calls.length !== 1 ||
      JSON.stringify(keys) !== JSON.stringify(Object.keys(expectedPartitions))
    ) {
      failures.push(`${relative}: production run binding bypasses the five-part Kernel Envelope`);
    }
  };
  assertRunBinding(
    "packages/runtime-host/src/session-adapter.ts",
    sessionAdapter,
    "agentRuntime",
  );
  assertRunBinding(
    "packages/cli/src/serve/ephemeral-executor.ts",
    ephemeral,
    "opts.runtime",
  );
  assertRunBinding(
    "packages/cli/src/serve/agent-job-runtime.ts",
    durableJob,
    "runtime!",
  );

  if (
    runtimeHost.split("createAgentRuntime({").length - 1 !== 1 ||
    runtimeHost.split("return this.assemble(").length - 1 < 3 ||
    !worksceneProjection.includes('primaryRole: "power"') ||
    !worksceneProjection.includes("input.projections.scene({ scene: current.scene")
  ) {
    failures.push("Conversation, workscene/power or ephemeral runtime gained a second Kernel assembly path");
  }
  return failures;
}

/** A4 Kernel runs have one finite Event owner and explicit projections on both sides. */
export function inspectKernelRunEventOwnership(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const required = (relative) => {
    const text = byPath.get(relative);
    if (text === undefined) failures.push(`${relative}: Kernel Run Event source is missing`);
    return text ?? "";
  };
  const eventPath = "packages/orchestrator/src/runtime/kernel-run-event.ts";
  const eventSource = required(eventPath);
  const envelopeSource = required(
    "packages/orchestrator/src/runtime/kernel-run-envelope.ts",
  );
  const runtimeSource = required(
    "packages/orchestrator/src/runtime/create-agent-runtime.ts",
  );
  const runtimeIndex = required("packages/orchestrator/src/runtime/index.ts");
  const orchestratorRootIndex = required("packages/orchestrator/src/index.ts");
  const consumerSpecs = [
    {
      relative: "packages/runtime-host/src/session-adapter.ts",
      projector: "projectKernelEventToConversationYield",
    },
    {
      relative: "packages/cli/src/serve/ephemeral-executor.ts",
      projector: "projectKernelEventToEphemeralYield",
    },
    {
      relative: "packages/cli/src/serve/agent-job-runtime.ts",
      projector: "projectKernelEventToDurableJobYield",
    },
  ];
  const expectedVariants = {
    text_delta: ["type", "text"],
    thinking_block_start: ["type"],
    thinking_delta: ["type", "thinking"],
    thinking_block_end: ["type"],
    assistant_message: ["type", "message"],
    tool_start: ["type", "id", "name", "input"],
    tool_end: ["type", "id", "name", "result", "duration"],
    turn_complete: ["type", "turnCount", "usage"],
  };

  const sourceFile = ts.createSourceFile(
    eventPath,
    eventSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const aliases = sourceFile.statements.filter(
    (statement) =>
      ts.isTypeAliasDeclaration(statement) &&
      statement.name.text === "KernelRunEvent",
  );
  const alias = aliases[0];
  if (aliases.length !== 1 || !alias || !ts.isUnionTypeNode(alias.type)) {
    failures.push("Kernel Run Event lacks one finite union owner");
  } else {
    const observed = new Map();
    for (const member of alias.type.types) {
      if (!ts.isTypeLiteralNode(member)) {
        failures.push("Kernel Run Event includes a non-literal variant");
        continue;
      }
      const properties = member.members.filter(ts.isPropertySignature);
      const typeProperty = properties.find(
        (property) => property.name.getText(sourceFile) === "type",
      );
      const typeNode = typeProperty?.type;
      const identity =
        typeNode &&
        ts.isLiteralTypeNode(typeNode) &&
        ts.isStringLiteral(typeNode.literal)
          ? typeNode.literal.text
          : undefined;
      if (!identity || observed.has(identity)) {
        failures.push("Kernel Run Event variant identity is missing or duplicated");
        continue;
      }
      observed.set(
        identity,
        properties.map((property) => property.name.getText(sourceFile)),
      );
      if (
        member.members.some(
          (property) =>
            !ts.isPropertySignature(property) ||
            property.questionToken ||
            !property.modifiers?.some(
              (modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
            ),
        )
      ) {
        failures.push(`Kernel Run Event variant is not required and readonly: ${identity}`);
      }
    }
    if (
      JSON.stringify([...observed]) !==
      JSON.stringify(Object.entries(expectedVariants))
    ) {
      failures.push("Kernel Run Event variant or field exact-set drifted");
    }
  }

  const declarationOwners = records
    .filter((record) => {
      const file = ts.createSourceFile(
        record.relative,
        record.text,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      return file.statements.some(
        (statement) =>
          (ts.isInterfaceDeclaration(statement) ||
            ts.isTypeAliasDeclaration(statement)) &&
          statement.name.text === "KernelRunEvent",
      );
    })
    .map((record) => record.relative);
  if (
    declarationOwners.length !== 1 ||
    declarationOwners[0] !== eventPath ||
    eventSource.includes("type KernelRunEvent = AgentYield")
  ) {
    failures.push("Kernel Run Event has a second owner or AgentYield alias");
  }
  if (
    !runtimeIndex.includes("assertKernelRunEvent,") ||
    !runtimeIndex.includes("type KernelRunEvent,") ||
    !runtimeIndex.includes('from "./kernel-run-event.js";') ||
    envelopeSource.includes("AgentYield") ||
    envelopeSource.includes("onYield") ||
    !envelopeSource.includes("readonly onEvent?: (event: KernelRunEvent)") ||
    !runtimeSource.includes("projectAgentYieldToKernelRunEvent(value)") ||
    !runtimeSource.includes("envelope.observation.onEvent?.(") ||
    runtimeSource.includes("envelope.observation.onYield")
  ) {
    failures.push("Agent Loop to Kernel Event boundary is bypassed or leaked");
  }
  if (
    orchestratorRootIndex.includes("KernelRunEvent") ||
    orchestratorRootIndex.includes("assertKernelRunEvent") ||
    orchestratorRootIndex.includes('export * from "./runtime/index.js"')
  ) {
    failures.push("Kernel Run Event leaked through the orchestrator package root");
  }
  if (
    eventSource.includes("SessionEventProjection") ||
    !envelopeSource.includes("readonly onProtocolEvent?: (")
  ) {
    failures.push("Kernel Run Event and the out-of-band protocol projection share an owner");
  }

  for (const spec of consumerSpecs) {
    const source = required(spec.relative);
    const file = ts.createSourceFile(
      spec.relative,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const projector = file.statements.find(
      (statement) =>
        ts.isFunctionDeclaration(statement) &&
        statement.name?.text === spec.projector,
    );
    const projectorSource = projector?.getText(file) ?? "";
    const cases = [];
    if (projector) {
      const visit = (node) => {
        if (
          ts.isCaseClause(node) &&
          ts.isStringLiteral(node.expression)
        ) {
          cases.push(node.expression.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(projector);
    }
    if (
      !projector ||
      JSON.stringify(cases) !== JSON.stringify(Object.keys(expectedVariants)) ||
      !projectorSource.includes("assertKernelRunEvent(event);") ||
      /return\s+event\s*;/u.test(projectorSource) ||
      /\bas\s+(?:AgentYield|KernelRunEvent)\b/u.test(projectorSource) ||
      !source.includes("onEvent: (event) =>") ||
      !source.includes(`${spec.projector}(event)`) ||
      source.includes("observation.onYield")
    ) {
      failures.push(`${spec.relative}: Kernel Event product projection is not explicit and exhaustive`);
    }
  }
  return failures;
}

/** A4 Kernel runs have one finite Terminal owner and three explicit product projections. */
export function inspectKernelTerminalOwnership(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const required = (relative) => {
    const text = byPath.get(relative);
    if (text === undefined) failures.push(`${relative}: Kernel Terminal source is missing`);
    return text ?? "";
  };
  const terminalPath = "packages/orchestrator/src/runtime/kernel-terminal.ts";
  const terminalSource = required(terminalPath);
  const runtimeSource = required(
    "packages/orchestrator/src/runtime/create-agent-runtime.ts",
  );
  const runtimeIndex = required("packages/orchestrator/src/runtime/index.ts");
  const orchestratorRootIndex = required("packages/orchestrator/src/index.ts");
  const consumerSpecs = [
    {
      relative: "packages/runtime-host/src/session-adapter.ts",
      projector: "projectKernelTerminalToConversationAgentResult",
      completionProjector: "projectKernelCompletionToConversationRunResult",
    },
    {
      relative: "packages/cli/src/serve/ephemeral-executor.ts",
      projector: "projectKernelTerminalToEphemeralResult",
    },
    {
      relative: "packages/cli/src/serve/agent-job-runtime.ts",
      projector: "projectKernelTerminalToDurableJobOutcome",
    },
  ];
  const expectedVariants = {
    completed: ["reason", "message", "usage"],
    max_turns: ["reason", "maxTurns", "usage"],
    aborted: ["reason", "usage", "abortReason", "exitDelayMs"],
    error: ["reason", "error", "usage"],
  };
  const terminalFile = ts.createSourceFile(
    terminalPath,
    terminalSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const aliases = terminalFile.statements.filter(
    (statement) =>
      ts.isTypeAliasDeclaration(statement) &&
      statement.name.text === "KernelTerminal",
  );
  const alias = aliases[0];
  if (aliases.length !== 1 || !alias || !ts.isUnionTypeNode(alias.type)) {
    failures.push("Kernel Terminal lacks one finite union owner");
  } else {
    const observed = new Map();
    for (const member of alias.type.types) {
      if (!ts.isTypeLiteralNode(member)) {
        failures.push("Kernel Terminal includes a non-literal variant");
        continue;
      }
      const properties = member.members.filter(ts.isPropertySignature);
      const reasonProperty = properties.find(
        (property) => property.name.getText(terminalFile) === "reason",
      );
      const reasonType = reasonProperty?.type;
      const identity =
        reasonType &&
        ts.isLiteralTypeNode(reasonType) &&
        ts.isStringLiteral(reasonType.literal)
          ? reasonType.literal.text
          : undefined;
      if (!identity || observed.has(identity)) {
        failures.push("Kernel Terminal variant identity is missing or duplicated");
        continue;
      }
      observed.set(
        identity,
        properties.map((property) => property.name.getText(terminalFile)),
      );
      if (
        member.members.some(
          (property) =>
            !ts.isPropertySignature(property) ||
            !property.modifiers?.some(
              (modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
            ),
        )
      ) {
        failures.push(`Kernel Terminal variant is not readonly: ${identity}`);
      }
    }
    if (
      JSON.stringify([...observed]) !==
      JSON.stringify(Object.entries(expectedVariants))
    ) {
      failures.push("Kernel Terminal variant or field exact-set drifted");
    }
  }

  const interfaceFields = (name) => {
    const declaration = terminalFile.statements.find(
      (statement) =>
        ts.isInterfaceDeclaration(statement) && statement.name.text === name,
    );
    if (!declaration) return undefined;
    return declaration.members.filter(ts.isPropertySignature);
  };
  const artifacts = interfaceFields("KernelRunArtifacts");
  const completion = interfaceFields("KernelRunCompletion");
  if (
    !artifacts ||
    JSON.stringify(artifacts.map((field) => field.name.getText(terminalFile))) !==
      JSON.stringify([
        "runRecord",
        "windowCompact",
        "newMessages",
        "durationMs",
        "pendingPostTurnControl",
      ]) ||
    artifacts.some(
      (field) =>
        !field.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
        ),
    ) ||
    !completion ||
    JSON.stringify(completion.map((field) => field.name.getText(terminalFile))) !==
      JSON.stringify(["terminal", "artifacts"]) ||
    completion.some(
      (field) =>
        field.questionToken ||
        !field.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
        ),
    )
  ) {
    failures.push("Kernel completion does not separate one terminal from the artifact exact-set");
  }

  const declarationOwners = records
    .filter((record) => {
      const file = ts.createSourceFile(
        record.relative,
        record.text,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      return file.statements.some(
        (statement) =>
          (ts.isInterfaceDeclaration(statement) ||
            ts.isTypeAliasDeclaration(statement)) &&
          statement.name.text === "KernelTerminal",
      );
    })
    .map((record) => record.relative);
  if (
    declarationOwners.length !== 1 ||
    declarationOwners[0] !== terminalPath ||
    terminalSource.includes("type KernelTerminal = AgentResult")
  ) {
    failures.push("Kernel Terminal has a second owner or AgentResult alias");
  }
  if (
    !terminalSource.includes("projectAgentResultToKernelTerminal(") ||
    !runtimeSource.includes("projectAgentResultToKernelTerminal(value)") ||
    !runtimeSource.includes("createKernelRunCompletion(") ||
    runtimeSource.includes("Promise<RunResult>") ||
    /return\s*\{\s*agentResult:/u.test(runtimeSource) ||
    !runtimeIndex.includes("assertKernelTerminal,") ||
    !runtimeIndex.includes("type KernelRunCompletion,") ||
    !runtimeIndex.includes("type KernelTerminal,") ||
    !runtimeIndex.includes('from "./kernel-terminal.js";')
  ) {
    failures.push("Agent Loop to Kernel Terminal boundary is bypassed or leaked");
  }
  const completionFactory = terminalFile.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "createKernelRunCompletion",
  );
  const completionFactorySource = completionFactory?.getText(terminalFile) ?? "";
  if (
    !completionFactory ||
    !completionFactorySource.includes("terminal,") ||
    !completionFactorySource.includes("artifacts: Object.freeze({ ...artifacts }),") ||
    /(?:structuredClone|cloneAndFreeze|deepFreeze)\s*\(\s*(?:terminal|artifacts)\b/u.test(
      completionFactorySource,
    )
  ) {
    failures.push(
      "Kernel completion must shallow-seal one transferred artifact graph without deep cloning",
    );
  }
  if (
    orchestratorRootIndex.includes("KernelTerminal") ||
    orchestratorRootIndex.includes("KernelRunCompletion") ||
    orchestratorRootIndex.includes("assertKernelTerminal") ||
    orchestratorRootIndex.includes("RunResult") ||
    orchestratorRootIndex.includes('export * from "./runtime/index.js"')
  ) {
    failures.push("Kernel Terminal or retired Kernel RunResult leaked through the package root");
  }

  for (const spec of consumerSpecs) {
    const source = required(spec.relative);
    const file = ts.createSourceFile(
      spec.relative,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const projector = file.statements.find(
      (statement) =>
        ts.isFunctionDeclaration(statement) &&
        statement.name?.text === spec.projector,
    );
    const projectorSource = projector?.getText(file) ?? "";
    const cases = [];
    if (projector) {
      const visit = (node) => {
        if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression)) {
          cases.push(node.expression.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(projector);
    }
    if (
      !projector ||
      JSON.stringify(cases) !== JSON.stringify(Object.keys(expectedVariants)) ||
      !projectorSource.includes("assertKernelTerminal(terminal);") ||
      /return\s+terminal\s*;/u.test(projectorSource) ||
      /structuredClone\s*\(/u.test(projectorSource) ||
      /\bas\s+(?:AgentResult|RunResult|KernelTerminal|KernelRunCompletion)\b/u.test(
        projectorSource,
      ) ||
      source.includes("outcome.result.agentResult") ||
      source.includes("runResult.agentResult")
    ) {
      failures.push(`${spec.relative}: Kernel Terminal product projection is not explicit and exhaustive`);
    }
    if (
      spec.completionProjector &&
      !source.includes(`function ${spec.completionProjector}(`)
    ) {
      failures.push(`${spec.relative}: Kernel completion artifacts lack a product projection`);
    }
    if (spec.completionProjector) {
      const completionProjector = file.statements.find(
        (statement) =>
          ts.isFunctionDeclaration(statement) &&
          statement.name?.text === spec.completionProjector,
      );
      const completionProjectorSource = completionProjector?.getText(file) ?? "";
      if (
        !completionProjector ||
        /structuredClone\s*\(/u.test(completionProjectorSource) ||
        !completionProjectorSource.includes(
          "newMessages: [...artifacts.newMessages]",
        )
      ) {
        failures.push(
          `${spec.relative}: product projection repeats the Kernel artifact object graph`,
        );
      }
    }
  }
  return failures;
}

/** A4 Kernel Conformance covers every production binding and freezes AgentRuntime's finite API. */
export function inspectKernelConformanceAndAgentRuntimeBudget(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const required = (relative) => {
    const text = byPath.get(relative);
    if (text === undefined) failures.push(`${relative}: Kernel Conformance source is missing`);
    return text ?? "";
  };
  const runtimePath = "packages/orchestrator/src/runtime/create-agent-runtime.ts";
  const runtimeSource = required(runtimePath);
  const runtimeIndex = required("packages/orchestrator/src/runtime/index.ts");
  const rootIndex = required("packages/orchestrator/src/index.ts");
  const sessionAdapter = required("packages/runtime-host/src/session-adapter.ts");
  const ephemeral = required("packages/cli/src/serve/ephemeral-executor.ts");
  const durableJob = required("packages/cli/src/serve/agent-job-runtime.ts");
  const executorRole = required("packages/executor/src/runtime-role.ts");
  const executorComposition = required(
    "packages/cli/src/serve/executor-role-runtime.ts",
  );
  const conformance = required(
    "packages/cli/src/serve/__tests__/kernel-runtime-conformance.test.ts",
  );
  const lifecycle = required("packages/cli/src/serve/assembly-lifecycle.ts");
  const command = required("packages/cli/src/serve/command.ts");

  const expectedMembers = [
    "run",
    "estimateConversationRequestBudget",
    "estimateMessagesTokens",
    "forceCompact",
    "callText",
    "callTextWithUsage",
    "runOrchestrationV1",
    "subAgentUsages",
    "securitySnapshot",
    "executionPermissionRules",
    "executionProfile",
    "calibrationFactor",
    "confirmationBroker",
    "drainLifecycleDiagnostics",
    "dispose",
    "onAttentionWindowChange",
  ];
  const runtimeFile = ts.createSourceFile(
    runtimePath,
    runtimeSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const rootFile = ts.createSourceFile(
    "packages/orchestrator/src/index.ts",
    rootIndex,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const rootExports = new Set(
    rootFile.statements.flatMap((statement) =>
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
        ? statement.exportClause.elements.map((element) => element.name.text)
        : [],
    ),
  );
  const declarations = records.flatMap((record) => {
    const file = ts.createSourceFile(
      record.relative,
      record.text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    return file.statements
      .filter(
        (statement) =>
          ts.isInterfaceDeclaration(statement) &&
          statement.name.text === "AgentRuntime",
      )
      .map((statement) => ({ relative: record.relative, statement, file }));
  });
  const declaration = declarations[0];
  const memberNames = declaration
    ? declaration.statement.members.map((member) =>
        member.name ? propertyNameText(member.name) : undefined,
      )
    : [];
  if (
    declarations.length !== 1 ||
    declaration?.relative !== runtimePath ||
    memberNames.some((name) => !name) ||
    JSON.stringify([...memberNames].sort()) !==
      JSON.stringify([...expectedMembers].sort())
  ) {
    failures.push("AgentRuntime public member exact-set drifted or gained a second owner");
  }
  if (
    declaration &&
    declaration.statement.members.some((member) =>
      /\b(?:Provider|SecurityPipeline|IPermissionStore|ResolvedWorkspace|WorkspaceDirStatus|Tool)\b/u.test(
        member.getText(declaration.file),
      ),
    )
  ) {
    failures.push("AgentRuntime public query/effect ports expose an implementation object");
  }

  const createFactory = runtimeFile.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "createAgentRuntime",
  );
  const returnedCandidates = [];
  if (createFactory?.body) {
    const visit = (node) => {
      if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) {
        const names = node.expression.properties
          .map((property) => property.name && propertyNameText(property.name))
          .filter(Boolean);
        if (names.includes("confirmationBroker") && names.includes("run")) {
          returnedCandidates.push(names);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(createFactory.body);
  }
  if (
    returnedCandidates.length !== 1 ||
    JSON.stringify([...returnedCandidates[0]].sort()) !==
      JSON.stringify([...expectedMembers].sort())
  ) {
    failures.push("createAgentRuntime return object does not match the public member exact-set");
  }
  if (
    /\b(?:registerConversationStateReset|resetConversationState|ResetConversationStateError)\b/u.test(
      runtimeSource,
    )
  ) {
    failures.push("AgentRuntime retained a post-publication host management entry");
  }
  if (
    records.some((record) =>
      /\b(?:Resettable|registerConversationStateReset|resetConversationState|ResetConversationStateError)\b/u.test(
        record.text,
      ),
    )
  ) {
    failures.push("retired runtime state-reset injection chain remains reachable");
  }
  if (
    !runtimeIndex.includes("type AgentRuntime,") ||
    !runtimeIndex.includes("createAgentRuntime,") ||
    !runtimeIndex.includes("export type { KernelRunEnvelope }") ||
    !runtimeIndex.includes("type KernelRunEvent") ||
    !runtimeIndex.includes("type KernelRunCompletion") ||
    !runtimeIndex.includes("type KernelTerminal") ||
    [
      "AgentRuntime",
      "createAgentRuntime",
      "KernelRunEnvelope",
      "KernelRunEvent",
      "KernelRunCompletion",
      "KernelTerminal",
    ].some((name) => rootExports.has(name))
  ) {
    failures.push("Kernel runtime contract is not confined to the runtime subpath");
  }

  const bindingChecks = [
    [
      "packages/runtime-host/src/session-adapter.ts",
      sessionAdapter,
      "agentRuntime\n        .run({",
    ],
    [
      "packages/cli/src/serve/ephemeral-executor.ts",
      ephemeral,
      "opts.runtime.run({",
    ],
    [
      "packages/cli/src/serve/agent-job-runtime.ts",
      durableJob,
      "runtime!.run({",
    ],
    [
      "packages/executor/src/runtime-role.ts",
      executorRole,
      "createAssignmentRuntimeAdapter(sessionId, runtime)",
    ],
    [
      "packages/cli/src/serve/executor-role-runtime.ts",
      executorComposition,
      "executor.createInProcessAssignmentRuntimeFactory(role)",
    ],
  ];
  for (const [relative, source, token] of bindingChecks) {
    if ((source.split(token).length - 1) !== 1) {
      failures.push(`${relative}: Kernel production binding is missing or duplicated`);
    }
  }

  const conformanceFile = ts.createSourceFile(
    "packages/cli/src/serve/__tests__/kernel-runtime-conformance.test.ts",
    conformance,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const casesDeclaration = conformanceFile.statements.find(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === "CASES",
      ),
  );
  const caseVariable = casesDeclaration?.declarationList.declarations.find(
    (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === "CASES",
  );
  const unwrapExpression = (expression) => {
    let current = expression;
    while (
      current &&
      (ts.isAsExpression(current) ||
        ts.isSatisfiesExpression(current) ||
        ts.isParenthesizedExpression(current))
    ) {
      current = current.expression;
    }
    return current;
  };
  const caseArray = unwrapExpression(caseVariable?.initializer);
  const caseNames = [];
  if (caseArray && ts.isArrayLiteralExpression(caseArray)) {
    for (const element of caseArray.elements) {
      if (!ts.isObjectLiteralExpression(element)) continue;
      const name = element.properties.find(
        (property) => property.name && propertyNameText(property.name) === "name",
      );
      if (
        name &&
        ts.isPropertyAssignment(name) &&
        ts.isStringLiteralLike(name.initializer)
      ) {
        caseNames.push(name.initializer.text);
      }
    }
  }
  const expectedCases = [
    "conversation",
    "scheduled ephemeral",
    "local durable job",
    "remote Executor assignment",
  ];
  if (
    JSON.stringify(caseNames) !== JSON.stringify(expectedCases) ||
    !conformance.includes("describe.each(CASES)") ||
    (conformance.match(/\bit\(/gu) ?? []).length !== 4 ||
    !conformance.includes("createOwnerRuntimeAdapter(identity, probe.runtime)") ||
    !conformance.includes("runEphemeralTurn({") ||
    !conformance.includes("createAgentJobRuntimePort({") ||
    !conformance.includes("createExecutorRole({") ||
    !conformance.includes("createInProcessAssignmentRuntimeFactory(role)") ||
    !conformance.includes("KernelRunEnvelope") ||
    !conformance.includes("KernelRunEvent") ||
    !conformance.includes("KernelRunCompletion") ||
    !conformance.includes("KernelTerminal") ||
    !conformance.includes(
      'expect(observation).toEqual({ status: "completed", events: EVENTS });',
    ) ||
    !conformance.includes("expect(binding.cancel(ABORT_REASON)).toBe(true);") ||
    !conformance.includes(
      "expect(binding.cancel(REPLACEMENT_ABORT_REASON)).toBe(false);",
    ) ||
    !conformance.includes("expect(probe.terminals).toEqual([]);") ||
    !conformance.includes("expect(probe.dispose).toHaveBeenCalledTimes(1);") ||
    !conformance.includes(
      "expect(first.confirmationBroker).not.toBe(second.confirmationBroker);",
    )
  ) {
    failures.push("shared Kernel Conformance does not cover the four real production bindings");
  }
  if (
    (lifecycle.match(/id: "ephemeralRuntime\.dispose"/gu) ?? []).length !== 1 ||
    (command.match(/lifecycleContributions\.acquire\("ephemeralRuntime\.dispose"/gu) ?? [])
      .length !== 1 ||
    !command.includes('ephemeralRuntime.dispose("session-dispose")')
  ) {
    failures.push("scheduled ephemeral runtime lacks one typed production lifecycle owner");
  }
  return failures;
}

/** A4 AgentRuntime exposes finite security projections/effects, never implementation objects. */
export function inspectAgentRuntimeSecurityEncapsulation(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const runtimePath = "packages/orchestrator/src/runtime/create-agent-runtime.ts";
  const runtimeSource = byPath.get(runtimePath);
  if (runtimeSource === undefined) {
    return [`${runtimePath}: AgentRuntime security boundary source is missing`];
  }
  const runtimeFile = ts.createSourceFile(
    runtimePath,
    runtimeSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const runtimeDeclarations = records.flatMap((record) => {
    const file = ts.createSourceFile(
      record.relative,
      record.text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    return file.statements
      .filter(
        (statement) =>
          ts.isInterfaceDeclaration(statement) &&
          statement.name.text === "AgentRuntime",
      )
      .map(() => record.relative);
  });
  const declaration = runtimeFile.statements.find(
    (statement) =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === "AgentRuntime",
  );
  if (
    runtimeDeclarations.length !== 1 ||
    runtimeDeclarations[0] !== runtimePath ||
    !declaration ||
    !ts.isInterfaceDeclaration(declaration)
  ) {
    failures.push("AgentRuntime lacks one public contract owner");
  } else {
    const forbiddenNames = new Set(["securityPipeline", "permissionStore"]);
    for (const member of declaration.members) {
      const name = member.name ? propertyNameText(member.name) : undefined;
      const text = member.getText(runtimeFile);
      if (
        (name && forbiddenNames.has(name)) ||
        /\b(?:SecurityPipeline|IPermissionStore)\b/u.test(text) ||
        /(?:security.*pipeline|permission.*store)/iu.test(name ?? "")
      ) {
        failures.push("AgentRuntime exposes a security implementation field, getter or alias");
      }
    }
  }

  const factory = runtimeFile.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "createAgentRuntime",
  );
  if (
    !factory ||
    factory.type?.getText(runtimeFile) !== "Promise<AgentRuntime>" ||
    !factory.body
  ) {
    failures.push("createAgentRuntime no longer returns the one AgentRuntime contract");
  } else {
    const candidates = [];
    const visit = (node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const names = new Set(
          node.properties
            .map((property) => property.name && propertyNameText(property.name))
            .filter(Boolean),
        );
        if (
          names.has("confirmationBroker") &&
          names.has("securitySnapshot") &&
          names.has("executionPermissionRules") &&
          names.has("executionProfile") &&
          names.has("dispose") &&
          names.has("run")
        ) {
          candidates.push(node);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(factory.body);
    const returnedRuntime = candidates[0];
    if (candidates.length !== 1 || !returnedRuntime) {
      failures.push("createAgentRuntime return object is missing or duplicated");
    } else {
      const allowedInternalClosures = new Set([
        "run",
        "runOrchestrationV1",
        "securitySnapshot",
        "executionPermissionRules",
      ]);
      for (const property of returnedRuntime.properties) {
        const name = property.name ? propertyNameText(property.name) : undefined;
        const text = property.getText(runtimeFile);
        if (
          name === "securityPipeline" ||
          name === "permissionStore" ||
          /(?:security.*pipeline|permission.*store)/iu.test(name ?? "") ||
          (!allowedInternalClosures.has(name ?? "") &&
            /\b(?:securityPipeline|persistentStore)\b/u.test(text))
        ) {
          failures.push(
            "createAgentRuntime returns a security implementation field, getter or alias",
          );
        }
      }
    }
  }

  const pipelineConstructions =
    runtimeSource.match(/new SecurityPipeline\s*\(/gu) ?? [];
  const storeConstructions =
    runtimeSource.match(/new PermissionStore\s*\(/gu) ?? [];
  const permissionStorageAssemblies =
    runtimeSource.match(/assembleKernelPermissionStorage\s*\(/gu) ?? [];
  const permissionRuleBindings =
    runtimeSource.match(/bindKernelPermissionRuleSource\s*\(/gu) ?? [];
  const trustApplicationConstructions =
    runtimeSource.match(
      /new TrustAdministrationExecutionApplicationService\s*\(/gu,
    ) ?? [];
  const securityBindings = new Map([
    [
      "createSecureExecuteTool",
      { property: "pipeline", expected: "securityPipeline" },
    ],
    [
      "createTaskTool",
      { property: "securityPipeline", expected: "securityPipeline" },
    ],
    [
      "createAgentNodeExecutorV1",
      { property: "securityPipeline", expected: "securityPipeline" },
    ],
  ]);
  const observedBindings = new Map(
    [...securityBindings].map(([name]) => [name, []]),
  );
  const visitSecurityBindings = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      securityBindings.has(node.expression.text)
    ) {
      const spec = securityBindings.get(node.expression.text);
      const options = node.arguments[0];
      const property =
        options && ts.isObjectLiteralExpression(options)
          ? options.properties.find(
              (candidate) =>
                candidate.name &&
                propertyNameText(candidate.name) === spec.property,
            )
          : undefined;
      const value = property
        ? ts.isShorthandPropertyAssignment(property)
          ? property.name.text
          : ts.isPropertyAssignment(property)
            ? property.initializer.getText(runtimeFile)
            : undefined
        : undefined;
      observedBindings.get(node.expression.text).push(value);
    }
    ts.forEachChild(node, visitSecurityBindings);
  };
  visitSecurityBindings(runtimeFile);
  if (
    pipelineConstructions.length !== 1 ||
    storeConstructions.length !== 0 ||
    permissionStorageAssemblies.length !== 1 ||
    permissionRuleBindings.length !== 1 ||
    trustApplicationConstructions.length !== 1 ||
    !runtimeSource.includes("const securityPipeline = new SecurityPipeline({") ||
    /createPermissionStoreTrustAdministrationRepository|\bIPermissionStore\b/u.test(
      runtimeSource,
    ) ||
    [...securityBindings].some(
      ([name, spec]) =>
        JSON.stringify(observedBindings.get(name)) !==
        JSON.stringify([spec.expected]),
    )
  ) {
    failures.push("AgentRuntime internal security chain is no longer single and shared");
  }

  for (const record of records) {
    if (
      record.relative === runtimePath ||
      record.relative.startsWith("packages/orchestrator/") ||
      record.relative.startsWith("packages/core/")
    ) continue;
    const file = ts.createSourceFile(
      record.relative,
      record.text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    let leaked = false;
    const visit = (node) => {
      if (
        (ts.isPropertyAccessExpression(node) &&
          (node.name.text === "securityPipeline" ||
            node.name.text === "permissionStore")) ||
        (ts.isElementAccessExpression(node) &&
          ts.isStringLiteral(node.argumentExpression) &&
          (node.argumentExpression.text === "securityPipeline" ||
            node.argumentExpression.text === "permissionStore"))
      ) {
        leaked = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (leaked) {
      failures.push(`${record.relative}: external production code reads AgentRuntime security internals`);
    }
  }
  return failures;
}

export function inspectAgentRuntimeWorkspaceEncapsulation(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const runtimePath = "packages/orchestrator/src/runtime/create-agent-runtime.ts";
  const hostProjectionPath = "packages/cli/src/serve/host-default-workspace.ts";
  const commandPath = "packages/cli/src/serve/command.ts";
  const runtimeSource = byPath.get(runtimePath);
  const hostProjectionSource = byPath.get(hostProjectionPath);
  const commandSource = byPath.get(commandPath);
  if (runtimeSource === undefined) {
    return [`${runtimePath}: AgentRuntime workspace boundary source is missing`];
  }

  const runtimeFile = ts.createSourceFile(
    runtimePath,
    runtimeSource,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const runtimeDeclarations = records.flatMap((record) => {
    const file = ts.createSourceFile(
      record.relative,
      record.text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    return file.statements
      .filter(
        (statement) =>
          ts.isInterfaceDeclaration(statement) &&
          statement.name.text === "AgentRuntime",
      )
      .map(() => record.relative);
  });
  const declaration = runtimeFile.statements.find(
    (statement) =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === "AgentRuntime",
  );
  if (
    runtimeDeclarations.length !== 1 ||
    runtimeDeclarations[0] !== runtimePath ||
    !declaration ||
    !ts.isInterfaceDeclaration(declaration)
  ) {
    failures.push("AgentRuntime lacks one public contract owner for workspace encapsulation");
  } else {
    for (const member of declaration.members) {
      const name = member.name ? propertyNameText(member.name) : undefined;
      const text = member.getText(runtimeFile);
      if (
        /workspace/iu.test(name ?? "") ||
        /\b(?:ResolvedWorkspace|WorkspaceDirStatus)\b/u.test(text)
      ) {
        failures.push("AgentRuntime exposes workspace resolution or directory management");
      }
    }
  }

  const factory = runtimeFile.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "createAgentRuntime",
  );
  if (!factory?.body) {
    failures.push("createAgentRuntime workspace return boundary is missing");
  } else {
    const candidates = [];
    const visit = (node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const names = new Set(
          node.properties
            .map((property) => property.name && propertyNameText(property.name))
            .filter(Boolean),
        );
        if (
          names.has("confirmationBroker") &&
          names.has("executionProfile") &&
          names.has("dispose") &&
          names.has("run")
        ) {
          candidates.push(node);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(factory.body);
    const returnedRuntime = candidates[0];
    if (candidates.length !== 1 || !returnedRuntime) {
      failures.push("createAgentRuntime return object is missing or duplicated");
    } else if (
      returnedRuntime.properties.some((property) =>
        /workspace/iu.test(
          property.name ? propertyNameText(property.name) ?? "" : "",
        )
      )
    ) {
      failures.push("createAgentRuntime returns workspace resolution or directory management");
    }
  }

  for (const record of records) {
    if (record.relative === runtimePath) continue;
    const file = ts.createSourceFile(
      record.relative,
      record.text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    let leaked = false;
    const isRetiredWorkspaceProperty = (name) =>
      /^(?:resolvedWorkspace|workspaceDirStatus)$/u.test(name) ||
      /workspace(?:Resolution|DirectoryStatus|Metadata|Info)$/iu.test(name);
    const visit = (node) => {
      if (
        (ts.isPropertyAccessExpression(node) &&
          /runtime/iu.test(node.expression.getText(file)) &&
          isRetiredWorkspaceProperty(node.name.text)) ||
        (ts.isElementAccessExpression(node) &&
          /runtime/iu.test(node.expression.getText(file)) &&
          ts.isStringLiteral(node.argumentExpression) &&
          isRetiredWorkspaceProperty(node.argumentExpression.text))
      ) {
        leaked = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (leaked) {
      failures.push(`${record.relative}: external production code reads AgentRuntime workspace internals`);
    }
  }

  if (
    hostProjectionSource === undefined ||
    (hostProjectionSource.match(/\bresolveWorkspace\s*\(/gu) ?? []).length !== 1 ||
    !hostProjectionSource.includes("resolveWorkspace(configuration, { sessionType })") ||
    hostProjectionSource.includes("ensureWorkspaceDir")
  ) {
    failures.push("Host default workspace projection no longer delegates once to the authority resolver");
  }
  if (
    commandSource === undefined ||
    (commandSource.match(/\bcreateHostDefaultWorkspaceProjection\s*\(\s*workspaceConfiguration,?\s*\)/gu) ?? []).length !== 1 ||
    (commandSource.match(/hostDefaultWorkspace\.postAdoptionReviewWorkingDirectory/gu) ?? []).length !== 1 ||
    (commandSource.match(/hostDefaultWorkspace\.hostInfoWorkspace/gu) ?? []).length !== 1 ||
    /ephemeralRuntime\.(?:resolvedWorkspace|workspaceDirStatus)/u.test(commandSource) ||
    /(?:^|[^.])\bresolveWorkspace\s*\(/u.test(commandSource)
  ) {
    failures.push("Anchor host consumers do not share the one default workspace projection");
  }

  return failures;
}

/** A4 TurnContext providers are immutable assembly input, never runtime management. */
export function inspectTurnContextProviderAssembly(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const required = (relative) => {
    const source = byPath.get(relative);
    if (source === undefined) failures.push(`${relative}: turn-context assembly source is missing`);
    return source ?? "";
  };
  const runtime = required("packages/orchestrator/src/runtime/create-agent-runtime.ts");
  const host = required("packages/runtime-host/src/runtime-host.ts");
  const providers = required("packages/cli/src/runtime/turn-context-providers.ts");
  const command = required("packages/cli/src/serve/command.ts");
  const executor = required("packages/cli/src/serve/executor-role-runtime.ts");

  const runtimeFile = ts.createSourceFile(
    "packages/orchestrator/src/runtime/create-agent-runtime.ts",
    runtime,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const agentRuntime = runtimeFile.statements.find(
    (statement) =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === "AgentRuntime",
  );
  const createOptions = runtimeFile.statements.find(
    (statement) =>
      ts.isInterfaceDeclaration(statement) &&
      statement.name.text === "CreateAgentRuntimeOptions",
  );
  const agentRuntimeText = agentRuntime?.getText(runtimeFile) ?? "";
  const createOptionsText = createOptions?.getText(runtimeFile) ?? "";
  if (
    !agentRuntime ||
    /registerTurnContextProvider|turnContextProviders/iu.test(agentRuntimeText) ||
    !/readonly turnContextProviders\?: readonly TurnContextProvider\[\];/u.test(createOptionsText)
  ) {
    failures.push("AgentRuntime turn-context boundary is not assembly-only");
  }

  const captureIndex = runtime.indexOf(
    "const assembledTurnContextProviders = captureTurnContextProviders(\n    options.turnContextProviders,\n  );",
  );
  const roleAssemblyIndex = runtime.indexOf("} = options.modelProvider;");
  const injectorIndex = runtime.indexOf("const turnContextInjector = new TurnContextInjector();");
  const timeIndex = runtime.indexOf("new TimeProvider(", injectorIndex);
  const contributionIndex = runtime.indexOf(
    "for (const provider of assembledTurnContextProviders)",
    injectorIndex,
  );
  const returnIndex = runtime.indexOf("return {\n    confirmationBroker,", contributionIndex);
  if (
    captureIndex < 0 ||
    roleAssemblyIndex < 0 ||
    captureIndex > roleAssemblyIndex ||
    injectorIndex < 0 ||
    timeIndex < injectorIndex ||
    contributionIndex < timeIndex ||
    returnIndex < contributionIndex ||
    !runtime.includes('const ids = new Set(["time"]);') ||
    !runtime.includes("return Object.freeze(captured);") ||
    runtime.includes("registerTurnContextProvider")
  ) {
    failures.push("createAgentRuntime does not capture and register the fixed provider input before publication");
  }

  if (
    host.includes("onRuntimeCreated") ||
    host.includes("registerTurnContextProvider") ||
    !host.includes("readonly turnContextProviders?: () => TurnContextProvidersOption;") ||
    !host.includes("const turnContextProviders = this.opts.turnContextProviders?.();") ||
    !host.includes("...(turnContextProviders ? { turnContextProviders } : {}),") ||
    host.indexOf("const turnContextProviders = this.opts.turnContextProviders?.();") >
      host.indexOf("return createAgentRuntime({") ||
    (host.match(/return this\.assemble\s*\(/gu) ?? []).length !== 3
  ) {
    failures.push("RuntimeHost does not pass one pre-publication provider projection to every issuance path");
  }

  const schedulerCount = (providers.match(/new SchedulerProvider\s*\(/gu) ?? []).length;
  const taskListCount = (providers.match(/new TaskListProvider\s*\(/gu) ?? []).length;
  if (
    !providers.includes("export function createCliTurnContextProviders(") ||
    !providers.includes("return Object.freeze([") ||
    schedulerCount !== 1 ||
    taskListCount !== 1 ||
    providers.indexOf("new SchedulerProvider(") > providers.indexOf("new TaskListProvider(") ||
    /\bAgentRuntime\b|registerTurnContextProvider/iu.test(providers)
  ) {
    failures.push("CLI turn-context provider exact-set is not the frozen scheduler/task-list sequence");
  }

  if (
    command.includes("onRuntimeCreated") ||
    command.includes("registerTurnContextProvider") ||
    command.includes("registerCliTurnContextProviders") ||
    !command.includes("turnContextProviders: () =>") ||
    !command.includes("createCliTurnContextProviders({")
  ) {
    failures.push("Anchor does not supply the one CLI provider assembly factory");
  }
  if (executor.includes("turnContextProviders")) {
    failures.push("ExecutorRuntimeSubstrate received Anchor turn-context providers");
  }

  for (const record of records) {
    if (
      record.text.includes("registerTurnContextProvider") ||
      record.text.includes("onRuntimeCreated")
    ) {
      failures.push(`${record.relative}: runtime-after-publication turn-context mutation returned`);
    }
  }
  return failures;
}

/** A6 concrete Provider construction stays at the Host edge, outside Kernel assembly. */
export function inspectKernelProviderDependencyInversion(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const required = (relative) => {
    const source = byPath.get(relative);
    if (source === undefined) {
      failures.push(`${relative}: Kernel provider dependency source is missing`);
    }
    return source ?? "";
  };
  const modelContract = required(
    "packages/orchestrator/src/runtime/kernel-model-provider.ts",
  );
  const environmentContract = required(
    "packages/orchestrator/src/runtime/kernel-runtime-environment.ts",
  );
  const runtime = required(
    "packages/orchestrator/src/runtime/create-agent-runtime.ts",
  );
  const runtimeIndex = required("packages/orchestrator/src/runtime/index.ts");
  const orchestratorRoot = required("packages/orchestrator/src/index.ts");
  const host = required("packages/runtime-host/src/runtime-host.ts");
  const edge = required("packages/cli/src/runtime/kernel-runtime-bindings.ts");
  const command = required("packages/cli/src/serve/command.ts");
  const executor = required("packages/cli/src/serve/executor-role-runtime.ts");

  if (
    !modelContract.includes("export interface KernelModelProviderBinding") ||
    !modelContract.includes("export interface KernelModelProviderFactory") ||
    !modelContract.includes("createKernelModelProviderBinding(") ||
    !modelContract.includes("assertKernelModelProviderBinding(") ||
    !modelContract.includes("Object.isFrozen(binding.roles[roleId])") ||
    /ZhixingConfig|ProviderCredential|createProviderRoles|@zhixing\/providers/u.test(
      modelContract,
    )
  ) {
    failures.push("Kernel model provider contract is not finite, immutable and concrete-free");
  }
  if (
    !environmentContract.includes("export interface KernelRuntimeEnvironment") ||
    !environmentContract.includes("export interface KernelRuntimeEnvironmentFactory") ||
    !environmentContract.includes("createKernelRuntimeEnvironment(") ||
    !environmentContract.includes("assertKernelRuntimeEnvironment(") ||
    /ZhixingConfig|resolveWorkspace|ensureWorkspaceDir|@zhixing\/providers/u.test(
      environmentContract,
    )
  ) {
    failures.push("Kernel runtime environment contract is not finite, immutable and concrete-free");
  }
  if (
    !runtimeIndex.includes('from "./kernel-model-provider.js";') ||
    !runtimeIndex.includes('from "./kernel-runtime-environment.js";') ||
    /kernel-(?:model-provider|runtime-environment)/u.test(orchestratorRoot)
  ) {
    failures.push("Kernel provider contracts are not confined to the runtime subpath");
  }
  if (
    !runtime.includes("readonly modelProvider: KernelModelProviderBinding;") ||
    !runtime.includes("readonly runtimeEnvironment: KernelRuntimeEnvironment;") ||
    !runtime.includes("assertKernelModelProviderBinding(options.modelProvider, primaryRole);") ||
    !runtime.includes("assertKernelRuntimeEnvironment(options.runtimeEnvironment);") ||
    /providerConfiguration|ZhixingConfig|ProviderCredential|createProviderRoles|resolveWorkspace|ensureWorkspaceDir|@zhixing\/providers/u.test(
      runtime,
    )
  ) {
    failures.push("AgentRuntime still constructs or consumes concrete Provider/configuration state");
  }
  if (
    !host.includes("readonly modelProvider: KernelModelProviderFactory;") ||
    !host.includes("readonly runtimeEnvironment: KernelRuntimeEnvironmentFactory;") ||
    !host.includes("const modelProvider = this.opts.modelProvider.create({") ||
    !host.includes("const runtimeEnvironment = this.opts.runtimeEnvironment.create({") ||
    !host.includes("modelProvider,") ||
    !host.includes("runtimeEnvironment,") ||
    /providerConfiguration|ZhixingConfig|ProviderCredential|@zhixing\/providers/u.test(host) ||
    (host.match(/return this\.assemble\s*\(/gu) ?? []).length !== 3
  ) {
    failures.push("RuntimeHost does not issue every runtime through the Host-owned provider factories");
  }
  if (
    (edge.match(/\bcreateProviderRoles\s*\(/gu) ?? []).length !== 1 ||
    !edge.includes("createHostKernelModelProviderFactory(") ||
    !edge.includes("createHostKernelRuntimeEnvironmentFactory(") ||
    !edge.includes("readonly configuration: RuntimeModelConfigurationProjection;") ||
    !edge.includes("readonly configuration: RuntimeKernelEnvironmentConfigurationProjection;") ||
    !edge.includes("createKernelModelProviderBinding({") ||
    !edge.includes("createKernelRuntimeEnvironment({") ||
    !edge.includes("const primaryModelCapability = resolveModelCapability(") ||
    !edge.includes("optimalMaxTokens: primaryModelCapability.optimalMaxTokens") ||
    !edge.includes("riskMaxTokens: primaryModelCapability.riskMaxTokens") ||
    edge.includes("attention: resolveModelCapability(")
  ) {
    failures.push("CLI Host edge is not the concrete Provider/configuration adapter owner");
  }
  if (
    !command.includes("modelProvider: createHostKernelModelProviderFactory({") ||
    !command.includes("configuration: modelConfiguration,") ||
    !command.includes("runtimeEnvironment: createHostKernelRuntimeEnvironmentFactory({") ||
    !command.includes("configuration: kernelEnvironmentConfiguration,") ||
    command.includes("providerConfiguration:")
  ) {
    failures.push("Anchor composition does not inject the one concrete Kernel provider edge");
  }
  if (
    !executor.includes("this.#modelProvider = createHostKernelModelProviderFactory({") ||
    !executor.includes("configuration: options.modelConfiguration,") ||
    !executor.includes("this.#runtimeEnvironment = createHostKernelRuntimeEnvironmentFactory({") ||
    !executor.includes("configuration: options.kernelEnvironmentConfiguration,") ||
    (executor.match(/modelProvider: this\.#modelProvider\.create\s*\(/gu) ?? []).length !== 2 ||
    (executor.match(/runtimeEnvironment: this\.#runtimeEnvironment\.create\s*\(/gu) ?? []).length !== 2 ||
    executor.includes("providerConfiguration:") ||
    executor.includes("createProviderRoles(")
  ) {
    failures.push("Executor production issuance bypasses the shared Host provider edge");
  }
  for (const record of records) {
    if (
      record.relative.startsWith("packages/orchestrator/src/") &&
      record.text.includes("@zhixing/providers")
    ) {
      failures.push(`${record.relative}: Orchestrator imports the concrete Provider package`);
    }
  }
  return failures;
}

/** A6 Kernel tool demand is owned by Orchestrator; concrete factories stay at the Host edge. */
export function inspectKernelToolImplementationDependencyInversion(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const required = (relative) => {
    const source = byPath.get(relative);
    if (source === undefined) failures.push(`${relative}: Kernel Tool source is missing`);
    return source ?? "";
  };
  const contract = required("packages/orchestrator/src/runtime/kernel-tool-implementation.ts");
  const runtime = required("packages/orchestrator/src/runtime/create-agent-runtime.ts");
  const runtimeIndex = required("packages/orchestrator/src/runtime/index.ts");
  const rootIndex = required("packages/orchestrator/src/index.ts");
  const manifest = required("packages/orchestrator/package.json");
  const runtimeHost = required("packages/runtime-host/src/runtime-host.ts");
  const edge = required("packages/cli/src/runtime/kernel-tool-implementation.ts");
  const applicationHost = required("packages/cli/src/serve/application-host.ts");
  const topology = required("packages/cli/src/serve/role-topology.ts");
  const command = required("packages/cli/src/serve/command.ts");
  const executor = required("packages/cli/src/serve/executor-role-runtime.ts");
  const workspace = required("packages/cli/src/runtime/workspace-command.ts");
  const conversationApplication = required(
    "packages/core/src/conversation/application.ts",
  );
  const worksceneApplication = required(
    "packages/core/src/workscene/application.ts",
  );
  const taskListBinding = required("packages/tools-builtin/src/task-list.ts");
  const taskListAdapter = required(
    "packages/cli/src/serve/conversation-task-list-application.ts",
  );
  const extraTools = required("packages/cli/src/serve/builtin-extra-tools.ts");
  const worksceneTools = required("packages/cli/src/serve/workmode-tools.ts");
  const worksceneAdapter = required(
    "packages/cli/src/serve/workscene-application-adapter.ts",
  );
  const worksceneProjection = required(
    "packages/cli/src/serve/workscene-runtime-projection.ts",
  );
  const jobToolSelection = required(
    "packages/cli/src/serve/job-runtime-tool-selection.ts",
  );
  const taskTool = required("packages/orchestrator/src/tools/task.ts");
  const taskListToolBinding = taskListBinding.slice(
    taskListBinding.indexOf("export function createTaskListTool("),
  );

  if (
    !contract.includes("export interface KernelToolImplementationPort") ||
    !contract.includes("export interface KernelToolImplementationRequest") ||
    !contract.includes("readonly requestedToolNames: readonly string[];") ||
    !contract.includes("assembleKernelToolImplementation(") ||
    !contract.includes("exact requested sequence") ||
    /@zhixing\/tools-builtin|BUILTIN_TOOL_FACTORIES/u.test(contract)
  ) failures.push("Kernel Tool demand contract is not finite, exact and concrete-free");
  if (
    !runtime.includes("readonly toolImplementation: KernelToolImplementationPort;") ||
    !runtime.includes("assembleKernelToolImplementation(") ||
    !runtime.includes("profile.enabledTools.filter((name) => name !== \"Task\")") ||
    /@zhixing\/tools-builtin|BUILTIN_TOOL_FACTORIES|BUILTIN_TOOL_NAMES|WEB_FETCH_DEFAULT_RULES/u.test(runtime)
  ) failures.push("AgentRuntime does not consume only the demand-owned Tool port");
  if (
    !runtimeIndex.includes('from "./kernel-tool-implementation.js";') ||
    /KernelToolImplementation/u.test(rootIndex)
  ) failures.push("Kernel Tool contract escaped its runtime-only subpath");
  if (manifest.includes('"@zhixing/tools-builtin"')) {
    failures.push("Orchestrator still declares the concrete Tool implementation package");
  }
  if (
    !runtimeHost.includes("readonly toolImplementation: KernelToolImplementationPort;") ||
    !runtimeHost.includes("toolImplementation: this.opts.toolImplementation,")
  ) failures.push("RuntimeHost can publish a runtime without the Host Tool binding");
  if (
    !edge.includes("export function createHostKernelToolImplementation()") ||
    !edge.includes("BUILTIN_TOOL_FACTORIES") ||
    !edge.includes("WEB_FETCH_DEFAULT_RULES") ||
    !edge.includes("Object.hasOwn(BUILTIN_TOOL_FACTORIES, name)") ||
    !edge.includes("tools: Object.freeze(tools)")
  ) failures.push("CLI Host edge does not uniquely select the concrete Tool implementation");
  if (
    !applicationHost.includes("createToolImplementation: () => KernelToolImplementationPort;") ||
    !applicationHost.includes("toolImplementation: this.#dependencies.createToolImplementation(),") ||
    !applicationHost.includes("createToolImplementation: createHostKernelToolImplementation,") ||
    !topology.includes("readonly toolImplementation: KernelToolImplementationPort;") ||
    !command.includes("toolImplementation: bootstrap.toolImplementation,")
  ) failures.push("Persistent Host topology does not carry one explicit Tool binding");
  if (
    !executor.includes("readonly toolImplementation: KernelToolImplementationPort;") ||
    (executor.match(/toolImplementation: this\.options\.toolImplementation,/gu) ?? []).length !== 2 ||
    !executor.includes("toolImplementation: bootstrap.toolImplementation,")
  ) failures.push("Executor runtime issuance bypasses the explicit Tool binding");
  if (!workspace.includes("toolImplementation: createHostKernelToolImplementation(),")) {
    failures.push("Transient workspace runtime lacks the Host Tool binding");
  }
  if (
    !conversationApplication.includes(
      "export interface ConversationTaskListToolStagePort",
    ) ||
    !conversationApplication.includes(
      "export class ConversationTaskListToolApplicationService",
    ) ||
    !conversationApplication.includes(
      "const operationId = `task-list:${input.toolCallId}`",
    ) ||
    !taskListBinding.includes("export function createTaskListTool(") ||
    !taskListToolBinding.includes("application.replace({") ||
    /runContextStorage|AssignmentMutationPort|protocolDigest|randomUUID|TaskListService\.prototype\.createTool|this\.set\s*\(/u.test(
      taskListToolBinding,
    ) ||
    !taskListAdapter.includes("createAnchorConversationTaskListToolApplication(") ||
    !taskListAdapter.includes("assignment.stage({") ||
    !extraTools.includes("createTaskListTool(") ||
    !command.includes("createAnchorConversationTaskListToolApplication()")
  ) {
    failures.push(
      "task_list does not have one Conversation-owned command and finite Correctness adapter",
    );
  }
  if (
    !worksceneApplication.includes("export interface WorksceneAssignmentToolPort") ||
    !worksceneApplication.includes(
      "export class WorksceneAssignmentToolApplicationService",
    ) ||
    !worksceneApplication.includes("applyAssignmentOverlay(") ||
    !worksceneApplication.includes("expectedRevision: previous.revision") ||
    !worksceneTools.includes(
      'from "@zhixing/core/workscene/application"',
    ) ||
    /runContextStorage|AssignmentMutation|GlobalStagedMutation|assignmentMutations\.stage/u.test(
      worksceneTools,
    ) ||
    !worksceneAdapter.includes("createAnchorWorksceneAssignmentToolApplication(") ||
    !worksceneAdapter.includes("assignmentMutations.readOverlay()") ||
    !worksceneAdapter.includes("assignmentMutations.stage({") ||
    !worksceneProjection.includes("worksceneAssignmentTools:") ||
    !command.includes("createAnchorWorksceneAssignmentToolApplication()")
  ) {
    failures.push(
      "Workscene tools do not have one domain application and finite assignment adapter",
    );
  }
  if (
    !jobToolSelection.includes("export function selectJobRuntimeTools(") ||
    !jobToolSelection.includes("new Set(input.instruction.tools)") ||
    !jobToolSelection.includes("Job requested unavailable tools:") ||
    !worksceneProjection.includes("selectJobRuntimeTools({") ||
    !executor.includes("selectJobRuntimeTools({") ||
    /new Set\(instruction\.tools\)|Job requested unavailable tools:/u.test(
      worksceneProjection,
    ) ||
    /new Set\(instruction\.tools\)|Job requested unavailable tools:/u.test(executor)
  ) {
    failures.push("Anchor and Executor jobs do not share one requested-tool selector");
  }
  const jobPolicyOwners = records.filter((record) =>
    record.text.includes("Job requested unavailable tools:")
  );
  if (
    jobPolicyOwners.length !== 1 ||
    jobPolicyOwners[0]?.relative !==
      "packages/cli/src/serve/job-runtime-tool-selection.ts"
  ) {
    failures.push("job requested-tool policy has more than one production owner");
  }
  if (
    !runtime.includes("const taskTool = createTaskTool({") ||
    !runtime.includes("securityPipeline,") ||
    !runtime.includes("parentBroker: confirmationBroker,") ||
    !runtime.includes("parentTools: baseTools,") ||
    !taskTool.includes("securityPipeline: env.securityPipeline,") ||
    !taskTool.includes("parentBroker: env.parentBroker,") ||
    !taskTool.includes("authorizeToolExecution: runCtx.authorizeToolExecution,")
  ) {
    failures.push("Task no longer reuses the parent controlled-effect chain");
  }
  for (const record of records) {
    if (
      record.relative.startsWith("packages/orchestrator/src/") &&
      /(?:from\s+|import\s*\()["']@zhixing\/tools-builtin/u.test(record.text)
    ) failures.push(`${record.relative}: Orchestrator imports the concrete Tool package`);
  }
  return failures;
}

/** A6 Advancement model calls consume one demand-owned binding; concrete Provider state stays at the Host edge. */
export function inspectAdvancementProviderDependencyInversion(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const required = (relative) => {
    const source = byPath.get(relative);
    if (source === undefined) {
      failures.push(`${relative}: Advancement provider dependency source is missing`);
    }
    return source ?? "";
  };
  const contract = required(
    "packages/orchestrator/src/advancement/model-provider.ts",
  );
  const advancementIndex = required(
    "packages/orchestrator/src/advancement/index.ts",
  );
  const orchestratorRoot = required("packages/orchestrator/src/index.ts");
  const edge = required(
    "packages/cli/src/runtime/advancement-model-provider.ts",
  );
  const application = required(
    "packages/cli/src/serve/advancement-controller.ts",
  );
  const command = required("packages/cli/src/serve/command.ts");
  const localOwner = required(
    "packages/cli/src/serve/local-conversation-owner.ts",
  );
  const surfaces = required("packages/cli/src/serve/access-surfaces.ts");
  const executor = required("packages/cli/src/serve/executor-role-runtime.ts");

  if (
    !contract.includes("export interface AdvancementModelProviderBinding") ||
    !contract.includes("export interface AdvancementModelProviderFactory") ||
    !contract.includes("createAdvancementModelProviderBinding(") ||
    !contract.includes("assertAdvancementModelProviderBinding(") ||
    !contract.includes('"completion", "reviewer", "sessionTokenBudget"') ||
    /@zhixing\/providers|ZhixingConfig|ProviderCredential|LLMRole|ModelCapability/u.test(
      contract,
    )
  ) {
    failures.push("Advancement model provider contract is not finite and demand-owned");
  }
  if (
    !advancementIndex.includes('from "./model-provider.js";') ||
    /AdvancementModelProvider/u.test(orchestratorRoot)
  ) {
    failures.push("Advancement model provider contract escaped its narrow subpath");
  }
  if (
    !edge.includes("createHostAdvancementModelProviderFactory(") ||
    !edge.includes("readonly configuration: RuntimeAdvancementConfigurationProjection;") ||
    !edge.includes("createProviderRoles({") ||
    !edge.includes("createControlCompletionPort({") ||
    !edge.includes("createAdvancementRuntime({") ||
    (edge.match(/resolveConfiguredThinking\s*\(/gu) ?? []).length < 3 ||
    !edge.includes("PROTOCOL_BUDGET_DEFAULTS[resolvedRoles.light.resolved.protocol]") ||
    !edge.includes("PROTOCOL_BUDGET_DEFAULTS[resolvedRoles.main.resolved.protocol]") ||
    !edge.includes("resolveWorkspace(config, {") ||
    !edge.includes("workingDirectory: workspace.path ?? undefined") ||
    !edge.includes("resolveModelCapability(") ||
    !edge.includes("optimalMaxTokens: resolvedAttention.optimalMaxTokens") ||
    !edge.includes("riskMaxTokens: resolvedAttention.riskMaxTokens") ||
    !edge.includes("config.advancement?.sessionTokenBudget") ||
    edge.includes("capability: resolvedAttention")
  ) {
    failures.push("CLI Host edge does not own the finite Advancement Provider projection");
  }
  if (
    !application.includes("readonly modelProvider: AdvancementModelProviderFactory;") ||
    !application.includes("deps.modelProvider.create(Object.freeze({") ||
    !application.includes("assertAdvancementModelProviderBinding(modelProvider);") ||
    !application.includes("modelProvider.completion.complete({") ||
    !application.includes("reviewer: modelProvider.reviewer") ||
    !application.includes("modelProvider.sessionTokenBudget") ||
    /@zhixing\/providers|ZhixingConfig|ProviderCredential|createProviderRoles|resolveModelCapability|resolveWorkspace|createAdvancementRuntime|createControlCompletionPort/u.test(
      application,
    )
  ) {
    failures.push("Advancement application assembly still owns concrete Provider configuration");
  }
  if (
    (command.match(/createHostAdvancementModelProviderFactory\s*\(/gu) ?? []).length !== 1 ||
    (surfaces.match(/createHostAdvancementModelProviderFactory\s*\(/gu) ?? []).length !== 1 ||
    (executor.match(/createHostAdvancementModelProviderFactory\s*\(/gu) ?? []).length !== 1 ||
    !localOwner.includes("readonly advancementModelProvider: AdvancementModelProviderFactory;") ||
    !localOwner.includes("modelProvider: options.advancementModelProvider") ||
    /readonly (?:config|credentials):/u.test(localOwner)
  ) {
    failures.push("Advancement production roots do not use the one Host Provider adapter");
  }
  for (const record of records) {
    if (
      record.relative !== "packages/cli/src/runtime/advancement-model-provider.ts" &&
      /createProviderRoles\s*\(/u.test(record.text) &&
      /Advancement|advancement/u.test(record.text)
    ) {
      failures.push(`${record.relative}: a second Advancement Provider constructor returned`);
    }
  }
  return failures;
}

/** A6 raw startup credentials are projected once into frozen, purpose-owned Host inputs. */
export function inspectRuntimeSecretProjectionBoundary(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const required = (relative) => {
    const source = byPath.get(relative);
    if (source === undefined) {
      failures.push(`${relative}: runtime secret projection source is missing`);
    }
    return source ?? "";
  };
  const projection = required(
    "packages/cli/src/runtime/runtime-secret-projections.ts",
  );
  const startup = required("packages/cli/src/startup.ts");
  const topology = required("packages/cli/src/serve/role-topology.ts");
  const host = required("packages/cli/src/serve/application-host.ts");
  const anchor = required("packages/cli/src/serve/command.ts");
  const executor = required("packages/cli/src/serve/executor-role-runtime.ts");
  const workspace = required("packages/cli/src/runtime/workspace-command.ts");
  const readiness = required("packages/cli/src/serve/executor-readiness.ts");
  const rotation = required(
    "packages/cli/src/serve/credential-rotation-publication.ts",
  );

  const exposureStart = projection.indexOf(
    "credentialExposureCredentials: Object.freeze",
  );
  const rotationStart = projection.indexOf(
    "credentialRotationCredentials: Object.freeze",
  );
  const exposureShape = exposureStart >= 0 && rotationStart > exposureStart
    ? projection.slice(exposureStart, rotationStart)
    : "";
  if (
    !projection.includes("export interface RuntimeSecretProjections") ||
    !projection.includes("export function projectRuntimeSecrets(") ||
    !projection.includes("credentials: ZhixingCredentials") ||
    !projection.includes("structuredClone(value)") ||
    !projection.includes("deepFreeze(structuredClone(value))") ||
    !projection.includes("return Object.freeze({") ||
    !projection.includes("providerCredentials: Object.freeze(") ||
    !projection.includes("mcpCredentials: Object.freeze(") ||
    !projection.includes("channelCredentials: Object.freeze(") ||
    !exposureShape.includes("providers") ||
    !exposureShape.includes("mcp") ||
    exposureShape.includes("channels") ||
    !projection.includes("...(channels === undefined ? {} : { channels })") ||
    projection.includes("credentials.version")
  ) {
    failures.push("startup secret edge does not publish the frozen purpose exact-set");
  }

  if (
    !startup.includes("} & RuntimeSecretProjections)") ||
    (startup.match(/\.\.\.projectRuntimeSecrets\s*\(/gu) ?? []).length !== 2 ||
    /kind: "ready";[\s\S]{0,180}credentials:\s*ZhixingCredentials/u.test(startup)
  ) {
    failures.push("StartupCheckResult.ready still exposes raw aggregate credentials");
  }

  const executorContext = topology.slice(
    topology.indexOf("export interface ExecutorServeBootstrapContext"),
    topology.indexOf("export type ServeHostKind"),
  );
  if (
    !topology.includes("export interface AnchorServeBootstrapContext") ||
    !topology.includes("export interface ExecutorServeBootstrapContext") ||
    topology.includes("readonly startup:") ||
    !executorContext.includes("providerCredentials") ||
    !executorContext.includes("mcpCredentials") ||
    !executorContext.includes("credentialExposureCredentials") ||
    /channelCredentials|credentialRotationCredentials/u.test(executorContext)
  ) {
    failures.push("role bootstrap contexts do not preserve purpose and topology isolation");
  }

  if (
    !host.includes("satisfies AnchorServeBootstrapContext") ||
    !host.includes("satisfies ExecutorServeBootstrapContext") ||
    !host.includes("providerCredentials: this.#input.startup.providerCredentials") ||
    !host.includes("channelCredentials: this.#input.startup.channelCredentials") ||
    !host.includes("credentialExposureCredentials:") ||
    !host.includes("credentialRotationCredentials:") ||
    /startup\.credentials|ZhixingCredentials/u.test(host)
  ) {
    failures.push("ApplicationHost does not issue the finite role-specific secret projections");
  }

  const forbiddenRawConsumers = [
    ["Anchor role", anchor],
    ["Executor role", executor],
    ["transient workspace runtime", workspace],
  ];
  for (const [name, source] of forbiddenRawConsumers) {
    if (
      /startup\.credentials|bootstrap\.startup|ZhixingCredentials/u.test(source) ||
      /credentials\.(?:providers|mcp|channels)/u.test(source)
    ) {
      failures.push(`${name} reconstructs or consumes aggregate credentials`);
    }
  }
  if (
    !anchor.includes("credentials: credentialExposureCredentials") ||
    !anchor.includes("credentials: credentialRotationCredentials") ||
    !anchor.includes(").credentialRotationCredentials") ||
    !executor.includes("credentials: bootstrap.credentialExposureCredentials") ||
    !workspace.includes("credentials: startup.credentialExposureCredentials") ||
    !workspace.includes("credentials: startup.providerCredentials") ||
    !readiness.includes("CredentialExposureSecretProjection") ||
    !rotation.includes("CredentialRotationSecretProjection")
  ) {
    failures.push("runtime secret consumers bypass their one purpose-owned projection");
  }

  return failures;
}

/** A6 public configuration is frozen once, then crosses only purpose-owned projections. */
export function inspectRuntimeConfigurationProjectionBoundary(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const required = (relative) => {
    const source = byPath.get(relative);
    if (source === undefined) {
      failures.push(`${relative}: runtime configuration snapshot source is missing`);
    }
    return source ?? "";
  };
  const snapshot = required(
    "packages/cli/src/runtime/runtime-configuration-snapshot.ts",
  );
  const projections = required(
    "packages/cli/src/runtime/runtime-configuration-projections.ts",
  );
  const provider = required(
    "packages/cli/src/runtime/runtime-configuration-provider.ts",
  );
  const replLocalView = required(
    "packages/cli/src/runtime/repl-local-view.ts",
  );
  const surfaceLink = required(
    "packages/cli/src/runtime/surface-core-host-link.ts",
  );
  const repl = required("packages/cli/src/repl.ts");
  const infoCommands = required("packages/cli/src/commands/info-commands.ts");
  const startup = required("packages/cli/src/startup.ts");
  const topology = required("packages/cli/src/serve/role-topology.ts");
  const host = required("packages/cli/src/serve/application-host.ts");
  const anchor = required("packages/cli/src/serve/command.ts");
  const executor = required("packages/cli/src/serve/executor-role-runtime.ts");
  const workspace = required("packages/cli/src/runtime/workspace-command.ts");
  const assembly = required("packages/cli/src/serve/access-surface.ts");
  const surfaces = required("packages/cli/src/serve/access-surfaces.ts");
  const runtimeBindings = required(
    "packages/cli/src/runtime/kernel-runtime-bindings.ts",
  );
  const advancement = required(
    "packages/cli/src/runtime/advancement-model-provider.ts",
  );
  const defaultWorkspace = required(
    "packages/cli/src/serve/host-default-workspace.ts",
  );
  const trust = required(
    "packages/cli/src/serve/trust-administration-adapter.ts",
  );
  const rotation = required(
    "packages/cli/src/serve/credential-rotation-publication.ts",
  );

  if (
    !snapshot.includes("declare const runtimeConfigurationSnapshotBrand: unique symbol") ||
    !snapshot.includes("export type RuntimeConfigurationSnapshot = Readonly<ZhixingConfig>") ||
    !snapshot.includes("export function createRuntimeConfigurationSnapshot(") ||
    !snapshot.includes("deepFreeze(") ||
    !snapshot.includes("structuredClone(configuration)") ||
    !snapshot.includes("Object.values(value as Record<string, unknown>)") ||
    !snapshot.includes("return Object.freeze(value)") ||
    /loadConfig|process\.env|node:path|ZhixingCredentials|SecretStore/u.test(snapshot)
  ) {
    failures.push("runtime configuration snapshot is not uniquely cloned, branded and deeply frozen");
  }

  const exactProjectionKeys = (constant, expected) => {
    const match = new RegExp(
      `const ${constant} = \\[([\\s\\S]*?)\\] as const`,
      "u",
    ).exec(projections);
    const actual = match
      ? [...match[1].matchAll(/"([^"]+)"/gu)].map((item) => item[1])
      : [];
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      failures.push(`${constant}: runtime configuration purpose exact-set drifted`);
    }
  };
  exactProjectionKeys("TOPOLOGY_KEYS", ["mesh"]);
  exactProjectionKeys("MODEL_KEYS", ["llm", "modelCapabilityOverrides"]);
  exactProjectionKeys("KERNEL_ENVIRONMENT_KEYS", [
    "agent",
    "workspace",
    "network",
  ]);
  exactProjectionKeys("ADVANCEMENT_KEYS", [
    "llm",
    "workspace",
    "advancement",
    "modelCapabilityOverrides",
  ]);
  exactProjectionKeys("MCP_KEYS", ["mcp", "network"]);
  exactProjectionKeys("CHANNEL_KEYS", ["messaging", "intent"]);
  exactProjectionKeys("WORKSPACE_KEYS", ["workspace"]);
  exactProjectionKeys("CREDENTIAL_ROTATION_KEYS", ["llm", "messaging"]);
  exactProjectionKeys("AUTHORITY_KEYS", [
    "mesh",
    "llm",
    "messaging",
    "mcp",
    "agent",
    "intent",
    "workspace",
    "network",
    "advancement",
    "modelCapabilityOverrides",
  ]);
  if (
    !projections.includes("declare const runtimeConfigurationProjectionBrand: unique symbol") ||
    !projections.includes("export function projectRuntimeConfiguration(") ||
    !projections.includes("Object.prototype.hasOwnProperty.call(configuration, key)") ||
    !projections.includes("structuredClone(configuration[key])") ||
    !projections.includes("return deepFreeze(selected)") ||
    !projections.includes("return Object.freeze(value)") ||
    /loadConfig|process\.env|node:path|ZhixingCredentials|SecretStore/u.test(projections)
  ) {
    failures.push("runtime configuration purposes are not uniquely cloned, branded and deeply frozen");
  }

  if (
    !provider.includes("export interface RuntimeConfigurationProvider") ||
    !provider.includes("readReplSurface(): ReplRuntimeConfigurationProjection;") ||
    !provider.includes("readTopology(options:") ||
    !provider.includes("export function createRuntimeConfigurationProvider(") ||
    (provider.match(/projectRuntimeConfiguration\s*\(/gu) ?? []).length !== 1 ||
    !provider.includes("primaryModel: Object.freeze({") ||
    !provider.includes("networkProxy: Object.freeze({") ||
    !provider.includes("hasResolvedProxy: proxy.resolved !== null") ||
    !provider.includes("return project(options).topology;") ||
    /readonly (?:config|resolved):|RuntimeConfigurationSnapshot/u.test(provider)
  ) {
    failures.push("Configuration Provider does not publish only finite frozen Surface projections");
  }
  if (
    /@zhixing\/providers|\bloadConfig\b|\bZhixingConfig\b|get config\s*\(/u.test(
      replLocalView,
    ) ||
    !replLocalView.includes("configuration.readReplSurface()") ||
    !replLocalView.includes("get primaryModel(): RuntimePrimaryModelDisplayProjection") ||
    /localView\.config|\bgetConfig\b|\bZhixingConfig\b/u.test(repl) ||
    !repl.includes("localView.primaryModel.providerId") ||
    !repl.includes("getPrimaryModel: () => localView.primaryModel") ||
    /@zhixing\/providers|\bloadConfig\b|\bZhixingConfig\b|\bgetConfig\b/u.test(
      infoCommands,
    ) ||
    !infoCommands.includes("getPrimaryModel: () => RuntimePrimaryModelDisplayProjection")
  ) {
    failures.push("REPL Surface regained a raw or aggregate configuration path");
  }
  if (
    /@zhixing\/providers|\bloadConfig\b|\bZhixingConfig\b/u.test(surfaceLink) ||
    !surfaceLink.includes("createRuntimeConfigurationProvider()") ||
    !surfaceLink.includes(".readTopology({ homeDir }).mesh")
  ) {
    failures.push("current-anchor Surface link bypasses the finite Topology projection");
  }

  const allowedConfigurationSourceOwners = new Set([
    "packages/cli/src/maintenance/doctor.ts",
    "packages/cli/src/runtime/config-command.ts",
    "packages/cli/src/runtime/runtime-configuration-provider.ts",
    "packages/cli/src/serve/backup-command.ts",
    "packages/cli/src/serve/disaster-recovery-command.ts",
    "packages/cli/src/serve/managed-service-runtime.ts",
    "packages/cli/src/serve/mesh-pair-command.ts",
    "packages/cli/src/startup.ts",
  ]);
  for (const record of records) {
    if (
      record.relative.startsWith("packages/cli/src/") &&
      !/\.test\.ts$|\/__tests__\//u.test(record.relative) &&
      /\bloadConfig\b/u.test(record.text) &&
      !allowedConfigurationSourceOwners.has(record.relative)
    ) {
      failures.push(`${record.relative}: ordinary runtime Surface owns a configuration loader`);
    }
  }

  if (
    !startup.includes("runtimeConfiguration: RuntimeConfigurationSnapshot;") ||
    (startup.match(/createRuntimeConfigurationSnapshot\s*\(/gu) ?? []).length !== 2 ||
    /kind: "ready";[\s\S]{0,180}config:\s*ZhixingConfig/u.test(startup) ||
    /kind: "ready",\s*config(?:,|:)/u.test(startup)
  ) {
    failures.push("StartupCheckResult.ready does not publish only the one runtime configuration snapshot");
  }

  for (const field of [
    "modelConfiguration: RuntimeModelConfigurationProjection",
    "kernelEnvironmentConfiguration: RuntimeKernelEnvironmentConfigurationProjection",
    "advancementConfiguration: RuntimeAdvancementConfigurationProjection",
    "mcpConfiguration: RuntimeMcpConfigurationProjection",
    "authorityConfiguration: RuntimeAuthorityConfigurationProjection",
    "channelConfiguration: RuntimeChannelConfigurationProjection",
    "workspaceConfiguration: RuntimeWorkspaceConfigurationProjection",
    "credentialRotationConfiguration: RuntimeCredentialRotationConfigurationProjection",
  ]) {
    if (!topology.includes(field)) {
      failures.push(`role bootstrap misses purpose projection ${field}`);
    }
  }
  if (
    /RuntimeConfigurationSnapshot|ZhixingConfig|runtimeConfiguration|readonly config:|readonly startup:/u.test(
      topology,
    )
  ) {
    failures.push("role bootstrap exposes an aggregate configuration path");
  }
  if (
    !host.includes("this.#configuration = projectRuntimeConfiguration(") ||
    !host.includes("input.startup.runtimeConfiguration") ||
    (host.match(/projectRuntimeConfiguration\s*\(/gu) ?? []).length !== 1 ||
    !host.includes("this.#configuration.topology.mesh") ||
    !host.includes("modelConfiguration: this.#configuration.model") ||
    !host.includes("kernelEnvironmentConfiguration: this.#configuration.kernelEnvironment") ||
    !host.includes("advancementConfiguration: this.#configuration.advancement") ||
    !host.includes("mcpConfiguration: this.#configuration.mcp") ||
    !host.includes("authorityConfiguration: this.#configuration.authority") ||
    !host.includes("channelConfiguration: this.#configuration.channel") ||
    !host.includes("workspaceConfiguration: this.#configuration.workspace") ||
    !host.includes("this.#configuration.credentialRotation") ||
    /startup\.config\b|bootstrap\.config\b|loadConfig\s*\(|createRuntimeConfigurationSnapshot\s*\(/u.test(
      host,
    )
  ) {
    failures.push("ApplicationHost does not perform the one purpose-owned projection and static handoff");
  }

  const downstreamConsumers = [
    ["Anchor role", anchor],
    ["Executor role", executor],
    ["Anchor assembly", assembly],
    ["Anchor surfaces", surfaces],
    ["Kernel Provider edge", runtimeBindings],
    ["Advancement Provider edge", advancement],
    ["default workspace edge", defaultWorkspace],
    ["Trust Administration edge", trust],
    ["credential rotation edge", rotation],
  ];
  for (const [name, source] of downstreamConsumers) {
    if (
      /RuntimeConfigurationSnapshot|runtimeConfiguration|startup\.config\b|bootstrap\.config\b|loadConfig\s*\(|type ZhixingConfig|readonly config:|projectRuntimeConfiguration\s*\(/u.test(
        source,
      )
    ) {
      failures.push(`${name} can still consume or reconstruct aggregate configuration`);
    }
  }

  if (
    !assembly.includes("readonly modelConfiguration: RuntimeModelConfigurationProjection;") ||
    !assembly.includes("readonly advancementConfiguration: RuntimeAdvancementConfigurationProjection;") ||
    !assembly.includes("readonly channelConfiguration: RuntimeChannelConfigurationProjection;") ||
    !assembly.includes("readonly authorityConfiguration: RuntimeAuthorityConfigurationProjection;") ||
    !surfaces.includes("config: ctx.authorityConfiguration") ||
    !anchor.includes("optimalMaxTokens: resolveModelCapability(") ||
    !anchor.includes("modelConfiguration.llm?.main?.model") ||
    surfaces.includes("modelConfiguration.llm?.main?.model") ||
    !surfaces.includes("configuration: ctx.advancementConfiguration") ||
    !surfaces.includes("entries: channelConfiguration.messaging") ||
    !surfaces.includes("cancelKeywords: channelConfiguration.intent?.cancelKeywords") ||
    /ctx\.config/u.test(surfaces)
  ) {
    failures.push("Anchor assembly purpose projections are incomplete or bypassed");
  }

  for (const [name, source, expectedType] of [
    ["Kernel model edge", runtimeBindings, "RuntimeModelConfigurationProjection"],
    ["Kernel environment edge", runtimeBindings, "RuntimeKernelEnvironmentConfigurationProjection"],
    ["Advancement edge", advancement, "RuntimeAdvancementConfigurationProjection"],
    ["default workspace edge", defaultWorkspace, "RuntimeWorkspaceConfigurationProjection"],
    ["Trust edge", trust, "RuntimeWorkspaceConfigurationProjection"],
    ["credential rotation edge", rotation, "RuntimeCredentialRotationConfigurationProjection"],
  ]) {
    if (!new RegExp(`(?:readonly\\s+)?configuration:\\s*${expectedType}`, "u").test(source)) {
      failures.push(`${name} misses its finite runtime configuration projection`);
    }
  }

  if (
    (workspace.match(/projectRuntimeConfiguration\s*\(/gu) ?? []).length !== 1 ||
    (workspace.match(/startup\.runtimeConfiguration/gu) ?? []).length !== 1 ||
    !workspace.includes("configuration.topology.mesh") ||
    !workspace.includes("configuration.mcp.mcp") ||
    !workspace.includes("modelConfiguration: configuration.model") ||
    !workspace.includes("kernelEnvironmentConfiguration: configuration.kernelEnvironment") ||
    !workspace.includes("config: configuration.authority") ||
    /loadConfig\s*\(|createRuntimeConfigurationSnapshot\s*\(/u.test(workspace)
  ) {
    failures.push("transient workspace root does not perform one finite configuration projection");
  }

  const snapshotConstructors = records.filter((record) =>
    record.text.includes("createRuntimeConfigurationSnapshot("));
  if (
    snapshotConstructors.length !== 2 ||
    !snapshotConstructors.some((record) =>
      record.relative === "packages/cli/src/runtime/runtime-configuration-snapshot.ts") ||
    !snapshotConstructors.some((record) =>
      record.relative === "packages/cli/src/startup.ts")
  ) {
    failures.push("runtime configuration snapshot has a second constructor or misses the startup edge");
  }

  const projectionCallers = records.filter((record) =>
    record.text.includes("projectRuntimeConfiguration("));
  const expectedProjectionCallers = new Set([
    "packages/cli/src/runtime/runtime-configuration-projections.ts",
    "packages/cli/src/runtime/runtime-configuration-provider.ts",
    "packages/cli/src/runtime/workspace-command.ts",
    "packages/cli/src/serve/application-host.ts",
  ]);
  if (
    projectionCallers.length !== expectedProjectionCallers.size ||
    projectionCallers.some((record) => !expectedProjectionCallers.has(record.relative))
  ) {
    failures.push("runtime configuration has a second projector or a downstream projection bypass");
  }

  const snapshotTypeOwners = records.filter((record) =>
    record.text.includes("RuntimeConfigurationSnapshot"));
  const expectedSnapshotTypeOwners = new Set([
    "packages/cli/src/runtime/runtime-configuration-projections.ts",
    "packages/cli/src/runtime/runtime-configuration-snapshot.ts",
    "packages/cli/src/startup.ts",
  ]);
  if (
    snapshotTypeOwners.some((record) => !expectedSnapshotTypeOwners.has(record.relative))
  ) {
    failures.push("complete runtime configuration snapshot crossed a composition root");
  }

  return failures;
}

/** A4 Anchor product tools and MCP inputs are projected before the generic RuntimeHost boundary. */
export function inspectWorksceneRuntimeProjectionBoundary(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const required = (relative) => {
    const source = byPath.get(relative);
    if (source === undefined) failures.push(`${relative}: Workscene runtime projection source is missing`);
    return source ?? "";
  };
  const host = required("packages/runtime-host/src/runtime-host.ts");
  const hostRoot = required("packages/runtime-host/src/index.ts");
  const projection = required(
    "packages/runtime-host/src/conversation-runtime-projection.ts",
  );
  const kernelIdentity = required(
    "packages/orchestrator/src/runtime/kernel-runtime-identity.ts",
  );
  const kernelAssembly = required(
    "packages/orchestrator/src/runtime/create-agent-runtime.ts",
  );
  const baseTools = required("packages/cli/src/serve/builtin-extra-tools.ts");
  required("packages/cli/src/serve/segment-deps.ts");
  required("packages/cli/src/serve/workmode-tools.ts");
  required("packages/cli/src/serve/workscene-port.ts");
  const runtimeHostBuild = required("packages/runtime-host/tsup.config.ts");
  const schedulerAdapter = required(
    "packages/cli/src/serve/execution-scheduler-facade.ts",
  );
  const product = required("packages/cli/src/serve/workscene-runtime-projection.ts");
  const command = required("packages/cli/src/serve/command.ts");
  const executor = required("packages/cli/src/serve/executor-role-runtime.ts");

  if (
    /\b(?:WorksceneDto|WorksceneToolDirectory|powerProfile|createWorksceneRuntime|worksceneDirectory|capabilityCatalog)\b/iu.test(
      host,
    ) ||
    /\bworkscene\b/iu.test(host) ||
    /\bsceneId\b/u.test(host) ||
    !host.includes("projection: ConversationRuntimeProjection") ||
    !host.includes("assertConversationRuntimeProjection(projection);") ||
    !host.includes("conversation: projection") ||
    !host.includes("assertRuntimeToolProjection(runtimeTools);") ||
    !host.includes("extraTools: [...runtimeTools.extraTools]") ||
    !host.includes("executionMcpServers: runtimeTools.executionMcpServers") ||
    !host.includes("runtimeIdentity: conversation?.runtimeIdentity")
  ) {
    failures.push("RuntimeHost still owns or can bypass Workscene product projection");
  }

  if (
    !projection.includes("export interface RuntimeToolProjection") ||
    !projection.includes("export function createRuntimeToolProjection(") ||
    !projection.includes("export function assertRuntimeToolProjection(") ||
    !projection.includes("Runtime tool projection must be finite and immutable") ||
    !projection.includes("assertRuntimeToolProjection(input.runtimeTools);") ||
    !projection.includes("export interface ConversationRuntimeProjection") ||
    !projection.includes("export function createConversationRuntimeProjection(") ||
    !projection.includes("export function assertConversationRuntimeProjection(") ||
    !projection.includes("return Object.freeze({") ||
    !projection.includes("assertKernelRuntimeIdentityContribution(") ||
    !projection.includes("Conversation runtime projection must be immutable") ||
    /\bsceneId\b|Record<string, unknown>|metadata/iu.test(projection)
  ) {
    failures.push("generic conversation projection is not finite, immutable and fail closed");
  }

  if (
    hostRoot.includes("conversation-runtime-projection") ||
    /\bConversationRuntimeProjection\b/u.test(hostRoot)
  ) {
    failures.push("conversation projection leaked through the RuntimeHost package root");
  }

  if (
    !kernelIdentity.includes("export interface KernelRuntimeIdentityContribution") ||
    !kernelIdentity.includes("export function createKernelRuntimeIdentityContribution(") ||
    !kernelIdentity.includes("export function assertKernelRuntimeIdentityContribution(") ||
    !kernelIdentity.includes("kernelRuntimeIdentityProvenance") ||
    !kernelIdentity.includes("keys.length !== 1") ||
    !kernelIdentity.includes("Object.isFrozen(identity)") ||
    /Record<string, unknown>|metadata/iu.test(kernelIdentity) ||
    !kernelAssembly.includes(
      "assertKernelRuntimeIdentityContribution(options.runtimeIdentity);",
    ) ||
    !kernelAssembly.includes("const sceneId = options.runtimeIdentity?.sceneId;")
  ) {
    failures.push("Kernel runtime identity contribution is not finite and fail closed");
  }

  if (
    /\bspec\??:|worksceneDirectory|createWorkmode|WorksceneToolDirectory/iu.test(baseTools) ||
    !/export interface ExtraToolsRuntimeContext\s*\{\s*scheduler: \(\) => SchedulerFacade;\s*\}/u.test(
      baseTools,
    )
  ) {
    failures.push("BuiltinExtraToolsAssembly still selects Workscene product tools");
  }

  if (
    /BuiltinExtraToolsAssembly|SchedulerFacade|ExecutionSchedulerFacade|JobExecutionInstruction|taskListService|mcpHub|assembleTools|createBuiltinExtraToolsAssembly/u.test(
      host,
    ) ||
    byPath.has("packages/runtime-host/src/execution-scheduler-facade.ts")
  ) {
    failures.push("RuntimeHost still owns Anchor Schedule, Task or MCP assembly");
  }

  const retiredRuntimeHostProductPaths = [
    "packages/runtime-host/src/builtin-extra-tools.ts",
    "packages/runtime-host/src/segment-deps.ts",
    "packages/runtime-host/src/workmode-tools.ts",
    "packages/runtime-host/src/workscene-port.ts",
  ];
  if (
    retiredRuntimeHostProductPaths.some((relative) => byPath.has(relative)) ||
    /builtin-extra-tools|segment-deps|workmode-tools|workscene-port/u.test(
      hostRoot,
    ) ||
    /builtin-extra-tools|segment-deps|workmode-tools|workscene-port/u.test(
      runtimeHostBuild,
    ) ||
    records.some(
      (record) =>
        record.relative.startsWith("packages/runtime-host/src/") &&
        /(?:BuiltinExtraToolsAssembly|WorksceneToolDirectory|TaskListService|McpHub|createPersistentSegmentDeps|createTransientSegmentDeps|createWorkmodeEnterTool|@zhixing\/(?:mcp|tools-builtin))/u.test(
          record.text,
        ),
    ) ||
    records.some((record) =>
      /@zhixing\/runtime-host\/(?:builtin-extra-tools|segment-deps|workmode-tools|workscene-port)/u.test(
        record.text,
      ),
    )
  ) {
    failures.push("RuntimeHost retained a product implementation, export, build entry or consumer path");
  }

  if (
    !schedulerAdapter.includes("export class ExecutionSchedulerFacade") ||
    !schedulerAdapter.includes("stageScheduleMutation") ||
    schedulerAdapter.includes("@zhixing/runtime-host")
  ) {
    failures.push("Anchor staged scheduler adapter is not owned by product composition");
  }

  const expectedProductTools = [
    "createWorkmodeEnterTool",
    "createWorkmodeExitTool",
    "createWorksceneChangeApproveTool",
    "createWorksceneClearWorkdirCurrentTool",
    "createWorksceneListTool",
    "createWorksceneRenameCurrentTool",
    "createWorksceneSetWorkdirCurrentTool",
  ];
  if (
    !product.includes("export function createAnchorRuntimeProjectionAssembly(") ||
    !product.includes("export function createWorksceneConversationRuntimeFactory(") ||
    !product.includes("new ExecutionSchedulerFacade(input.scheduler)") ||
    !product.includes("const runtimeTools = (") ||
    !product.includes("createRuntimeToolProjection({") ||
    !product.includes("createConversationRuntimeProjection({") ||
    !product.includes("createKernelRuntimeIdentityContribution(options.scene.sceneId)") ||
    !product.includes("profile: mainProfile(") ||
    !product.includes("profile: powerProfile(") ||
    !product.includes("const ephemeral = (): RuntimeToolProjection => runtimeTools();") ||
    !product.includes("const job = (instruction: JobExecutionInstruction) =>") ||
    !product.includes("selectJobRuntimeTools({") ||
    !product.includes("const mainProjection = main();") ||
    !product.includes("mcpServers: mainProjection.runtimeTools.executionMcpServers") ||
    !product.includes("addProjection(mainProjection);") ||
    (product.match(/addProjection\(scene\(/gu) ?? []).length !== 2 ||
    expectedProductTools.some(
      (factory) => (product.match(new RegExp(`\\b${factory}\\s*\\(`, "gu")) ?? []).length !== 1,
    )
  ) {
    failures.push("Workscene product owner projection or capability exact-set drifted");
  }

  if (
    (command.match(/createAnchorRuntimeProjectionAssembly\s*\(/gu) ?? []).length !== 1 ||
    (command.match(/createWorksceneConversationRuntimeFactory\s*\(/gu) ?? []).length !== 1 ||
    (command.match(/runtimeHost\.createConversationRuntime\s*\(/gu) ?? []).length !== 1 ||
    !command.includes("createAgentRuntime: createConversationAgentRuntime") ||
    !command.includes("runtime: anchorRuntimeProjections") ||
    !command.includes("const projection = anchorRuntimeProjections.job(instruction);") ||
    !command.includes("anchorRuntimeProjections.ephemeral()") ||
    !command.includes("capabilities: anchorRuntimeProjections.capabilityCatalog()") ||
    /runtimeHost\.(?:createWorksceneRuntime|capabilityCatalog)\s*\(/u.test(command)
  ) {
    failures.push("Anchor production graph does not use the one Workscene projection owner");
  }

  if (
    executor.includes("createAnchorRuntimeProjectionAssembly") ||
    executor.includes("createWorksceneConversationRuntimeFactory")
  ) {
    failures.push("ExecutorRuntimeSubstrate received the Anchor Workscene product owner");
  }

  for (const record of records) {
    if (
      record.relative !== "packages/cli/src/serve/workscene-runtime-projection.ts" &&
      record.text.includes("createWorksceneRuntime(")
    ) {
      failures.push(`${record.relative}: retired Workscene RuntimeHost entry returned`);
    }
  }
  return failures;
}

/** A6 concrete MCP runtime stays behind finite demand-owned Host ports. */
export function inspectMcpRuntimeBoundary(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const required = (relative) => {
    const source = byPath.get(relative);
    if (source === undefined) failures.push(`${relative}: MCP runtime boundary source is missing`);
    return source ?? "";
  };
  const ports = required("packages/cli/src/runtime/mcp-runtime-ports.ts");
  const adapter = required("packages/cli/src/runtime/mcp-runtime-adapter.ts");
  const command = required("packages/cli/src/serve/command.ts");
  const access = required("packages/cli/src/serve/access-surface.ts");
  const surfaces = required("packages/cli/src/serve/access-surfaces.ts");
  const tools = required("packages/cli/src/serve/builtin-extra-tools.ts");
  const projection = required("packages/cli/src/serve/workscene-runtime-projection.ts");
  const executor = required("packages/cli/src/serve/executor-role-runtime.ts");
  const workspace = required("packages/cli/src/runtime/workspace-command.ts");

  if (
    !ports.includes("export interface McpRuntimeToolProjectionPort") ||
    !ports.includes("export interface McpRuntimeStatusProjectionPort") ||
    !ports.includes("export interface McpRuntimeLifecyclePort") ||
    !ports.includes("readonly tools: readonly Readonly<ToolDefinition>[]") ||
    !ports.includes("readonly serverIds: readonly string[]") ||
    /@zhixing\/mcp|McpHub|catalog\(|applyConfig|Record<string|metadata|\bany\b/u.test(ports)
  ) {
    failures.push("MCP demand ports are not finite or leak the concrete implementation");
  }

  if (
    !adapter.includes("adaptMcpHub(createMcpHub(specs, options))") ||
    !adapter.includes("mapServerTools(server, descriptors, hub.callTool)") ||
    !adapter.includes("const catalog = hub.catalog();") ||
    !adapter.includes("hub.serverStatuses().map") ||
    !adapter.includes("connect: () => hub.connectAll()") ||
    !adapter.includes("close: () => hub.dispose()") ||
    !adapter.includes(".map((tool) => Object.freeze({ ...tool }))") ||
    !adapter.includes("Object.freeze(catalog.map(({ server }) => server.serverId).sort())")
  ) {
    failures.push("MCP infrastructure adapter does not own one coherent frozen mapping/lifecycle");
  }

  const concreteLeaks = [command, access, surfaces, tools, projection, executor, workspace]
    .some((source) => /@zhixing\/mcp|\bMcpHub\b|createMcpHub|mapServerTools|\.catalog\(\)|\.serverStatuses\(\)/u.test(source));
  if (concreteLeaks) {
    failures.push("MCP concrete Hub/catalog/mapping leaked past the Host infrastructure adapter");
  }

  if (
    !command.includes("mcpTools: mcpRuntime.tools") ||
    !command.includes("mcpLifecycle: mcpRuntime.lifecycle") ||
    !command.includes("mcpStatus: mcpRuntime.status") ||
    !projection.includes("const mcp = input.mcpTools.snapshot();") ||
    !executor.includes("readonly mcpTools: McpRuntimeToolProjectionPort") ||
    (executor.match(/this\.options\.mcpTools\.snapshot\(\)/gu)?.length ?? 0) !== 3 ||
    !workspace.includes("mcpTools: mcpRuntime.tools") ||
    !surfaces.includes("await ctx.mcpLifecycle.connect()") ||
    !surfaces.includes("ctx.mcpLifecycle.close()")
  ) {
    failures.push("Anchor, Executor or workspace fallback bypasses the finite MCP runtime ports");
  }

  if (
    /@zhixing\/mcp|\bMcpHub\b|mcpHub|mcpTools|McpRuntime|mapServerTools|\.catalog\(\)/u.test(
      tools,
    ) ||
    projection.includes(".catalog()") ||
    executor.includes("mapMcpTools") ||
    ports.includes("applyConfig")
  ) {
    failures.push("MCP runtime consumers regained catalog/configuration ownership");
  }
  return failures;
}

/** A6 MCP management owns finite UI contracts while concrete discovery stays at the Host edge. */
export function inspectMcpManagementBoundary(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const required = (relative) => {
    const source = byPath.get(relative);
    if (source === undefined) failures.push(`${relative}: MCP management boundary source is missing`);
    return source ?? "";
  };
  const contract = required("packages/cli/src/config-editor/mcp-management-contract.ts");
  const adapter = required("packages/cli/src/runtime/mcp-management-adapter.ts");
  const setup = required("packages/cli/src/config-editor/mcp-setup.ts");
  const discovery = required("packages/cli/src/config-editor/mcp-discovery.ts");
  const editorTypes = required("packages/cli/src/config-editor/types.ts");
  const panel = required("packages/cli/src/config-editor/panels/mcp.ts");
  const section = required("packages/cli/src/config-editor/sections/mcp.ts");
  const configCommand = required("packages/cli/src/runtime/config-command.ts");
  const commandRegistration = required("packages/cli/src/commands/config-commands.ts");

  if (
    !contract.includes("export interface McpManagementServerDraft") ||
    !contract.includes("export interface McpManagementServerStatus") ||
    !contract.includes("export interface McpManagementProbePort") ||
    !contract.includes("export interface McpManagementDiscoveryPort") ||
    !contract.includes("export interface McpManagementInfrastructurePort") ||
    !contract.includes("readonly credentials: Readonly<Record<string, string>>") ||
    /@zhixing\/mcp|McpServerSpec|McpToolDescriptor|NetworkPolicy|Record<string, unknown>|\bany\b/u.test(contract)
  ) {
    failures.push("MCP management demand contract is not finite or leaks infrastructure types");
  }

  if (
    !adapter.includes("fetchMcpServerSource") ||
    !adapter.includes("searchMcpServers") ||
    !adapter.includes("probeServer") ||
    !adapter.includes("isValidServerId") ||
    !adapter.includes("toServerSpec(") ||
    !adapter.includes("{ ...draft.credentials }") ||
    !adapter.includes("decodeStatusSnapshot(await options.readStatusWire())") ||
    !adapter.includes("proxy: options.proxy")
  ) {
    failures.push("MCP Host adapter does not own status decoding, spec conversion, probe and discovery");
  }

  const managementConsumers = [
    setup,
    discovery,
    editorTypes,
    panel,
    section,
    configCommand,
    commandRegistration,
  ];
  if (managementConsumers.some((source) =>
    /@zhixing\/mcp|McpServerSpec|McpToolDescriptor|McpSearchResult|McpSourceResult|ProbeResult|probeServer|searchMcpServers|fetchMcpServerSource|toServerSpec\(|isValidServerId/u.test(source)
  )) {
    failures.push("MCP management UI or product command regained concrete MCP ownership");
  }

  if (
    !setup.includes("probe.probe({") ||
    !setup.includes("credentials: { ...secrets }") ||
    !configCommand.includes("createMcpManagementAdapter({") ||
    !configCommand.includes("const statusSnapshot = await management.snapshot()") ||
    !configCommand.includes("mcpProbe: management") ||
    !configCommand.includes("management.readSource") ||
    !configCommand.includes("management.search") ||
    !configCommand.includes('deps.llmComplete(prompt, "main", signal)') ||
    !commandRegistration.includes("readMcpStatusWire: async () =>") ||
    /applyConfig/u.test([setup, discovery, editorTypes, panel, section, configCommand, commandRegistration].join("\n"))
  ) {
    failures.push("MCP management production graph bypasses its finite adapter or hot-applies config");
  }

  const concreteImporters = records
    .filter((record) => /from\s+["']@zhixing\/mcp["']/u.test(record.text))
    .map((record) => record.relative)
    .sort();
  const allowedConcreteImporters = [
    "packages/cli/src/runtime/mcp-config.ts",
    "packages/cli/src/runtime/mcp-management-adapter.ts",
    "packages/cli/src/runtime/mcp-runtime-adapter.ts",
  ];
  const cliConcreteImporters = concreteImporters.filter((relative) =>
    relative.startsWith("packages/cli/src/"),
  );
  if (
    cliConcreteImporters.length !== allowedConcreteImporters.length ||
    cliConcreteImporters.some((relative, index) => relative !== allowedConcreteImporters[index])
  ) {
    failures.push("Concrete MCP imports escaped the three finite CLI infrastructure adapters");
  }
  return failures;
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
  failures.push(...inspectConversationExecutorDispatchBoundary(records));
  failures.push(...inspectWorksceneRemoteWorkspaceProbeTopologyBoundary(records));
  failures.push(...inspectAssignmentDataPlaneBoundary(records));
  failures.push(...inspectAdvancementEvidenceTopologyBoundary(records));
  failures.push(...inspectAssignmentResourcePortBoundary(records));
  failures.push(...inspectWorkspaceProbePersistenceBoundary(records));
  failures.push(...inspectWorkspaceBindingGenerationPersistenceBoundary(records));
  failures.push(...inspectWorkspaceBindingCatalogPersistenceBoundary(records));
  failures.push(...inspectMeshBootstrapProjectionBoundary(records));
  failures.push(...inspectMeshPairingContinuationPersistenceBoundary(records));
  failures.push(...inspectSurfaceAssetStagingPersistenceBoundary(records));
  failures.push(...inspectAssignmentArtifactReceiverBoundary(records));
  failures.push(...inspectConversationAdoptionAssembly(records));
  failures.push(...inspectConversationDirectoryTopologyBoundary(records));
  failures.push(...inspectConversationStorageBoundary(records));
  failures.push(...inspectWorksceneStorageCleanupBoundary(records));
  failures.push(...inspectStorageRemainderBoundary(records));
  failures.push(...inspectRecoveryBackupAssembly([
    ...records,
    {
      relative: "packages/core/package.json",
      text: await readFile(path.join(root, "packages/core/package.json"), "utf8"),
    },
    {
      relative: "packages/core/tsup.config.ts",
      text: await readFile(path.join(root, "packages/core/tsup.config.ts"), "utf8"),
    },
  ]));
  failures.push(...inspectPlannedAnchorTransferAssembly(records));
  failures.push(...inspectDisasterRecoveryStagingBoundary(records));
  failures.push(...inspectManagedHostAssembly(records));
  failures.push(...inspectDeviceLifecycleAssembly(records));
  failures.push(...inspectDeviceAdministrationReadOwnership([
    ...records,
    {
      relative: "packages/core/package.json",
      text: await readFile(path.join(root, "packages/core/package.json"), "utf8"),
    },
    {
      relative: "packages/core/tsup.config.ts",
      text: await readFile(path.join(root, "packages/core/tsup.config.ts"), "utf8"),
    },
  ]));
  failures.push(...inspectKernelRunEnvelopeOwnership(records));
  failures.push(...inspectKernelRunEventOwnership(records));
  failures.push(...inspectKernelTerminalOwnership(records));
  failures.push(...inspectKernelConformanceAndAgentRuntimeBudget([
    ...records,
    {
      relative: "packages/cli/src/serve/__tests__/kernel-runtime-conformance.test.ts",
      text: await readFile(
        path.join(
          root,
          "packages/cli/src/serve/__tests__/kernel-runtime-conformance.test.ts",
        ),
        "utf8",
      ),
    },
  ]));
  failures.push(...inspectAgentRuntimeSecurityEncapsulation(records));
  failures.push(...inspectAgentRuntimeWorkspaceEncapsulation(records));
  failures.push(...inspectTurnContextProviderAssembly(records));
  failures.push(...inspectKernelProviderDependencyInversion(records));
  failures.push(...inspectKernelToolImplementationDependencyInversion([
    ...records,
    {
      relative: "packages/orchestrator/package.json",
      text: await readFile(path.join(root, "packages/orchestrator/package.json"), "utf8"),
    },
  ]));
  failures.push(...inspectAdvancementProviderDependencyInversion(records));
  failures.push(...inspectRuntimeSecretProjectionBoundary(records));
  failures.push(...inspectRuntimeConfigurationProjectionBoundary(records));
  failures.push(...inspectWorksceneRuntimeProjectionBoundary([
    ...records,
    {
      relative: "packages/runtime-host/tsup.config.ts",
      text: await readFile(
        path.join(root, "packages/runtime-host/tsup.config.ts"),
        "utf8",
      ),
    },
  ]));
  failures.push(...inspectMcpRuntimeBoundary(records));
  failures.push(...inspectMcpManagementBoundary(records));
  failures.push(...inspectChannelRuntimeBoundary(records));
  failures.push(...inspectWorkspaceAdministrationOwnership([
    ...records,
    {
      relative: "packages/core/package.json",
      text: await readFile(path.join(root, "packages/core/package.json"), "utf8"),
    },
    {
      relative: "packages/core/tsup.config.ts",
      text: await readFile(path.join(root, "packages/core/tsup.config.ts"), "utf8"),
    },
  ]));
  failures.push(...inspectTrustAdministrationOwnership([
    ...records,
    {
      relative: "packages/core/package.json",
      text: await readFile(path.join(root, "packages/core/package.json"), "utf8"),
    },
    {
      relative: "packages/core/tsup.config.ts",
      text: await readFile(path.join(root, "packages/core/tsup.config.ts"), "utf8"),
    },
  ]));
  failures.push(...inspectAdvancementDetailApplicationOwnership([
    ...records,
    {
      relative: "packages/core/package.json",
      text: await readFile(path.join(root, "packages/core/package.json"), "utf8"),
    },
    {
      relative: "packages/owner-services/package.json",
      text: await readFile(
        path.join(root, "packages/owner-services/package.json"),
        "utf8",
      ),
    },
    {
      relative: "packages/owner-services/tsup.config.ts",
      text: await readFile(
        path.join(root, "packages/owner-services/tsup.config.ts"),
        "utf8",
      ),
    },
  ]));
  failures.push(...inspectSkillCatalogApplicationOwnership([
    ...records,
    {
      relative: "packages/core/package.json",
      text: await readFile(path.join(root, "packages/core/package.json"), "utf8"),
    },
    {
      relative: "packages/rpc/package.json",
      text: await readFile(path.join(root, "packages/rpc/package.json"), "utf8"),
    },
    {
      relative: "packages/owner-kernel/package.json",
      text: await readFile(
        path.join(root, "packages/owner-kernel/package.json"),
        "utf8",
      ),
    },
    {
      relative: "packages/owner-kernel/tsup.config.ts",
      text: await readFile(
        path.join(root, "packages/owner-kernel/tsup.config.ts"),
        "utf8",
      ),
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

/** Conversation owns directory ordering without learning Host topology. */
export function inspectConversationDirectoryTopologyBoundary(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const applicationPath = "packages/core/src/conversation/application.ts";
  const collectorPath = "packages/cli/src/serve/local-conversation-rpc.ts";
  const application = byPath.get(applicationPath) ?? "";
  const collector = byPath.get(collectorPath) ?? "";
  if (!application) {
    failures.push(`${applicationPath}: Conversation directory application source is missing`);
  }
  if (!collector) {
    failures.push(`${collectorPath}: Conversation directory collector source is missing`);
  }

  for (const record of records) {
    if (record.text.includes("mergeConversationDirectoryViews")) {
      failures.push(`${record.relative}: topology-shaped Conversation directory helper returned`);
    }
  }

  const applicationSource = sourceFile(applicationPath, application);
  const directoryFunctions = applicationSource.statements.filter((statement) =>
    ts.isFunctionDeclaration(statement) &&
    statement.name?.text === "mergeConversationDirectoryEntries");
  if (directoryFunctions.length !== 1) {
    failures.push(`${applicationPath}: topology-neutral directory ordering owner is not unique`);
  } else {
    const helper = directoryFunctions[0];
    const helperText = helper.getText(applicationSource);
    if (
      helper.parameters.length !== 1 ||
      !helperText.includes("readonly entries: readonly ConversationDirectoryEntry[]") ||
      !helperText.includes("readonly availability?: ConversationAvailability")
    ) {
      failures.push(`${applicationPath}: directory ordering input is not one finite homogeneous entry projection`);
    }
    if (/\b(?:local|remote|deviceId|route|authority)\b/u.test(helperText)) {
      failures.push(`${applicationPath}: directory ordering owner learned Host topology`);
    }
    if (
      !helperText.includes("const conversations = [...input.entries]") ||
      !helperText.includes("right.lastActiveAt.localeCompare(left.lastActiveAt, \"en-US\")") ||
      !helperText.includes("left.conversationId.localeCompare(right.conversationId, \"en-US\")") ||
      !helperText.includes("conversations: Object.freeze(conversations)") ||
      !helperText.includes("return Object.freeze({")
    ) {
      failures.push(`${applicationPath}: directory ordering or immutable result contract drifted`);
    }
  }

  const consumers = [];
  for (const record of records) {
    const source = sourceFile(record.relative, record.text);
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "mergeConversationDirectoryEntries"
      ) {
        consumers.push(record.relative);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  if (consumers.length !== 1 || consumers[0] !== collectorPath) {
    failures.push("Conversation directory ordering is not consumed once by the unique Host collector");
  }

  const collectorSource = sourceFile(collectorPath, collector);
  let collectorMethod;
  const findCollector = (node) => {
    if (
      ts.isMethodDeclaration(node) &&
      node.name.getText(collectorSource) === "#listAllOwners"
    ) {
      collectorMethod = node;
      return;
    }
    ts.forEachChild(node, findCollector);
  };
  findCollector(collectorSource);
  if (!collectorMethod?.body) {
    failures.push(`${collectorPath}: unique cross-owner directory collector is missing`);
  } else {
    const body = collectorMethod.body.getText(collectorSource);
    if (
      !body.includes("const local = await this.#list()") ||
      !body.includes("this.input.owner.listConversationAuthorities()") ||
      !body.includes("route.authority.deviceId === this.input.deviceId") ||
      !body.includes('route.authority.state !== "fenced"') ||
      !body.includes("const byDevice = new Map<string, Set<string>>()") ||
      !body.includes("for (const [deviceId, ids] of byDevice)") ||
      !/\.dispatch\(\s*"session\.list"/u.test(body) ||
      !body.includes(".filter((item) => ids.has(item.conversationId))") ||
      !body.includes("const collectedEntries: ConversationDirectoryEntry[]") ||
      !body.includes("mergeConversationDirectoryEntries({")
    ) {
      failures.push(`${collectorPath}: Host topology collection, grouping or authority filtering drifted`);
    }
    if (body.includes(".sort(")) {
      failures.push(`${collectorPath}: Host collector copied Conversation directory ordering policy`);
    }
  }
  return failures;
}

/** A6 keeps concrete Conversation file storage at one Host infrastructure edge. */
export function inspectConversationStorageBoundary(records) {
  const failures = [];
  const count = (text, token) => text.split(token).length - 1;
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const required = (relative) => {
    const text = byPath.get(relative);
    if (text === undefined) {
      failures.push(`${relative}: Conversation storage boundary source is missing`);
    }
    return text ?? "";
  };
  const adapterPath =
    "packages/cli/src/serve/conversation-storage-infrastructure.ts";
  const adapter = required(adapterPath);
  const command = required("packages/cli/src/serve/command.ts");
  const context = required("packages/cli/src/serve/access-surface.ts");
  const surfaces = required("packages/cli/src/serve/access-surfaces.ts");
  const directory = required("packages/cli/src/serve/conversation-directory.ts");
  const readOnly = required(
    "packages/cli/src/runtime/read-only-conversation-browser.ts",
  );
  const bootstrap = required(
    "packages/core/src/context/bootstrap/build-startup-bootstrap.ts",
  );
  const application = required(
    "packages/core/src/conversation/application.ts",
  );

  const concreteSymbols = new Set([
    "ConversationRepository",
    "ShardedTranscriptStore",
    "SnapshotStore",
  ]);
  for (const record of records) {
    if (!record.relative.startsWith("packages/cli/src/") ||
        record.relative === adapterPath) continue;
    const source = sourceFile(record.relative, record.text);
    const visit = (node) => {
      if (ts.isImportDeclaration(node) && node.importClause) {
        const bindings = node.importClause.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const imported = element.propertyName?.text ?? element.name.text;
            if (concreteSymbols.has(imported)) {
              failures.push(
                `${record.relative}: concrete Conversation storage ${imported} escaped the Host infrastructure adapter`,
              );
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  if (
    !adapter.includes('from "@zhixing/core/conversation"') ||
    !adapter.includes('from "@zhixing/core/transcript"') ||
    /ConversationRepository[\s\S]*?from\s+["']@zhixing\/core["']/u.test(adapter) ||
    count(adapter, "new ConversationRepository(") !== 1 ||
    count(adapter, "new ShardedTranscriptStore(") !== 1 ||
    count(adapter, "new SnapshotStore(") !== 1 ||
    !adapter.includes("readonly runtime: ConversationRuntimeStoragePort") ||
    !adapter.includes("readonly committedViews: ConversationCommittedViewStorage") ||
    !adapter.includes("readonly maintenance: Readonly<")
  ) {
    failures.push(
      `${adapterPath}: concrete stores are not uniquely owned behind finite Host storage roles`,
    );
  }
  if (
    count(command, "createConversationStorageInfrastructure({") !== 1 ||
    /new\s+(?:ConversationRepository|ShardedTranscriptStore|SnapshotStore)\s*\(/u.test(
      command,
    ) ||
    !command.includes("conversationRuntimeStorage: conversationStorage.runtime") ||
    !command.includes(
      "conversationCommittedViewStorage: conversationStorage.committedViews",
    ) ||
    !command.includes("runSweep: conversationStorage.maintenance.runRetentionSweep")
  ) {
    failures.push(
      "packages/cli/src/serve/command.ts: Host does not compose the single finite Conversation storage boundary",
    );
  }
  if (
    /ConversationRepository|ShardedTranscriptStore|SnapshotStore|conversationsDir/u.test(
      [context, surfaces, readOnly].join("\n"),
    ) ||
    /from\s+["']node:(?:fs|fs\/promises|path)["']/u.test(readOnly) ||
    !readOnly.includes('storage: Pick<ConversationDirectoryStorage, "list" | "readHistory">')
  ) {
    failures.push(
      "Conversation Surface reads concrete storage or physical paths instead of finite projections",
    );
  }
  if (
    !directory.includes("routeConversation(conversationId: string)") ||
    /routeConversation\?/u.test(directory) ||
    /new\s+(?:ConversationRepository|ShardedTranscriptStore|SnapshotStore)\s*\(|conversationsDir/u.test(
      directory,
    )
  ) {
    failures.push(
      "packages/cli/src/serve/conversation-directory.ts: directory routing can recreate a concrete fallback owner",
    );
  }
  if (
    /ShardedTranscriptStore|SnapshotStore/u.test(bootstrap) ||
    !bootstrap.includes("readonly store: TranscriptReadSource") ||
    !bootstrap.includes("readonly snapshots: StartupSnapshotSource") ||
    !application.includes("export interface ConversationCommittedViewStorage")
  ) {
    failures.push(
      "Conversation/Context demand contracts leak concrete transcript or snapshot implementations",
    );
  }
  if (byPath.has("packages/cli/src/serve/advancement-gc.ts")) {
    failures.push(
      "packages/cli/src/serve/advancement-gc.ts: retired physical Conversation liveness bypass returned",
    );
  }
  return failures;
}

/** A6 keeps P03 cursor/walker mechanics at one Host infrastructure edge. */
export function inspectWorksceneStorageCleanupBoundary(records) {
  const failures = [];
  const count = (text, token) => text.split(token).length - 1;
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const required = (relative) => {
    const text = byPath.get(relative);
    if (text === undefined) {
      failures.push(`${relative}: Workscene cleanup boundary source is missing`);
    }
    return text ?? "";
  };
  const adapterPath = "packages/cli/src/serve/workscene-storage-cleanup.ts";
  const adapter = required(adapterPath);
  const ports = required(
    "packages/cli/src/serve/workscene-storage-removal.ts",
  );
  const command = required("packages/cli/src/serve/command.ts");
  const conversationInfrastructure = required(
    "packages/cli/src/serve/conversation-storage-infrastructure.ts",
  );
  const conversationDirectory = required(
    "packages/cli/src/serve/conversation-directory.ts",
  );
  const worksceneDirectory = required(
    "packages/cli/src/serve/workscene-directory.ts",
  );
  const worksceneSessionOwner = required(
    "packages/cli/src/serve/workscene-session-owner.ts",
  );

  const factoryConsumers = records.filter((record) =>
    record.relative !== adapterPath &&
    record.text.includes("createWorksceneStorageCleanupInfrastructure("));
  if (
    factoryConsumers.length !== 1 ||
    factoryConsumers[0]?.relative !== "packages/cli/src/serve/command.ts" ||
    count(command, "createWorksceneStorageCleanupInfrastructure({") !== 1 ||
    !/createWorksceneStorageCleanupInfrastructure\(\{\s*zhixingHome,\s*storageMaintenance:\s*deviceCapacity\.storage/u.test(
      command,
    ) ||
    !command.includes(
      "worksceneConversationStorageRemoval: worksceneStorageCleanup.conversations",
    ) ||
    !command.includes("sceneStorageRemoval: worksceneStorageCleanup.scenes")
  ) {
    failures.push(
      "Workscene cleanup concrete mechanism is not constructed once at the Host edge",
    );
  }
  if (
    !ports.includes("export interface WorksceneConversationStorageRemovalPort") ||
    !ports.includes("export interface WorksceneSceneStorageRemovalPort") ||
    /node:(?:fs|fs\/promises|path)|CleanupCursor|DurableWorksceneStorageCleanup/u.test(
      ports,
    ) ||
    !adapter.includes("readonly conversations: WorksceneConversationStorageRemovalPort") ||
    !adapter.includes("readonly scenes: WorksceneSceneStorageRemovalPort") ||
    !adapter.includes('path.resolve(input.zhixingHome, "workscenes")') ||
    !adapter.includes('path.join(options.workscenesRoot, ".cleanup")') ||
    !adapter.includes("class DurableWorksceneStorageCleanup") ||
    /createWorksceneStorageCleanupInfrastructure\([^)]*=\s*\{\}/u.test(adapter) ||
    /getWorkScenesRoot|getWorkSceneDir|getWorkSceneConversationsRoot/u.test(adapter)
  ) {
    failures.push(
      `${adapterPath}: P03 paths, cursor and bounded walker are not uniquely Host-owned`,
    );
  }
  if (
    !conversationInfrastructure.includes(
      "worksceneConversationStorageRemoval: WorksceneConversationStorageRemovalPort",
    ) ||
    !conversationDirectory.includes(
      "worksceneConversationStorageRemoval: WorksceneConversationStorageRemovalPort",
    ) ||
    !conversationDirectory.includes(
      "deps.worksceneConversationStorageRemoval.removeConversation(",
    ) ||
    !worksceneDirectory.includes(
      "sceneStorageRemoval: WorksceneSceneStorageRemovalPort",
    ) ||
    !worksceneSessionOwner.includes(
      "sceneStorageRemoval: WorksceneSceneStorageRemovalPort",
    ) ||
    !worksceneSessionOwner.includes("this.#sceneStorageRemoval.removeScene(sceneId)")
  ) {
    failures.push(
      "Workscene and Conversation cleanup consumers do not use their finite removal effects",
    );
  }
  const worksceneDemandSources = [worksceneDirectory, worksceneSessionOwner]
    .join("\n");
  const demandSources = [conversationInfrastructure, conversationDirectory,
    worksceneDemandSources].join("\n");
  if (
    /CleanupCursor|DurableWorksceneStorageCleanup|cursorDirectory|workscenes\/\.cleanup/u.test(
      demandSources,
    ) ||
    /node:(?:fs|fs\/promises|path)/u.test(worksceneDemandSources) ||
    /\bWorksceneStorageCleanup(?:Infrastructure|Options)?\b/u.test(demandSources) ||
    /worksceneStorageCleanup:/u.test(demandSources)
  ) {
    failures.push(
      "Workscene or Conversation demand code regained P03 paths, cursor, walker or concrete cleanup",
    );
  }
  const oldFactoryConsumers = records.filter((record) =>
    record.relative !== adapterPath &&
    /createWorksceneStorageCleanup\(/u.test(record.text));
  if (oldFactoryConsumers.length > 0) {
    failures.push("Retired Workscene cleanup constructor or fallback returned");
  }
  return failures;
}

/** A6 keeps non-topology P01/P05/P06/P13-P15 mechanisms at finite edges. */
export function inspectStorageRemainderBoundary(records) {
  const failures = [];
  const count = (text, token) => text.split(token).length - 1;
  const requireMultiplicity = (token, expected, label, excluded = new Set()) => {
    const actual = records
      .filter((record) => !excluded.has(record.relative))
      .map((record) => [record.relative, count(record.text, token)])
      .filter(([, occurrences]) => occurrences > 0)
      .sort(([left], [right]) => left.localeCompare(right));
    const expectedRows = [...expected]
      .sort(([left], [right]) => left.localeCompare(right));
    if (JSON.stringify(actual) !== JSON.stringify(expectedRows)) {
      failures.push(`${label} production multiplicity exact-set drifted`);
    }
  };
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const required = (relative) => {
    const text = byPath.get(relative);
    if (text === undefined) {
      failures.push(`${relative}: storage remainder boundary source is missing`);
    }
    return text ?? "";
  };

  const config = required("packages/providers/src/config-loader.ts");
  const legacyCredentials = required("packages/providers/src/credentials-loader.ts");
  const platformSecrets = required("packages/secrets/src/platform-secret-store.ts");
  const vault = required("packages/secrets/src/vault-secret-store.ts");
  const skillAdapter = required(
    "packages/orchestrator/src/runtime/assignment-skill-port.ts",
  );
  const skillApplication = required(
    "packages/core/src/skills/catalog-application.ts",
  );
  const authoritySetup = required("packages/cli/src/setup-delivery.ts");
  const advancementApplication = required(
    "packages/core/src/advancement/application.ts",
  );
  const advancementRubricLibrary = required(
    "packages/cli/src/serve/advancement-rubric-library.ts",
  );
  const advancementController = required(
    "packages/cli/src/serve/advancement-controller.ts",
  );
  const artifactStore = required("packages/core/src/authority/artifact-store.ts");
  const commitLog = required("packages/core/src/authority/commit-log.ts");
  const projection = required(
    "packages/core/src/authority/durable-projection-index.ts",
  );
  const lifecycleIndex = required(
    "packages/core/src/authority/artifact-lifecycle-index.ts",
  );
  const status = required("packages/cli/src/serve/status.ts");
  const token = required("packages/cli/src/serve/token.ts");
  const anchor = required("packages/cli/src/serve/command.ts");
  const executor = required("packages/cli/src/serve/executor-role-runtime.ts");
  const anchorShell = required(
    "packages/cli/src/serve/anchor-host-shell-lifecycle.ts",
  );
  const executorShell = required(
    "packages/cli/src/serve/executor-server-lifecycle.ts",
  );
  const serverState = required("packages/server/src/server-state.ts");
  const processLock = required("packages/server/src/process-lock.ts");
  const serverLog = required("packages/server/src/server-log-lifecycle.ts");
  const managedService = required("packages/cli/src/serve/managed-service.ts");
  const diagnostics = required("packages/cli/src/output/llm-chunk-dump.ts");
  const keypress = required("packages/cli/src/security/keypress-dump.ts");

  if (
    !config.includes("export function loadConfig(") ||
    !config.includes("export async function writeConfig(") ||
    !legacyCredentials.includes('path.join(homeDir, "credentials.json")') ||
    count(platformSecrets, "new EncryptedVaultSecretStore({") !== 1 ||
    !vault.includes("export class EncryptedVaultSecretStore")
  ) {
    failures.push("P01 config and SecretStore physical owners drifted");
  }
  requireMultiplicity(
    "createPlatformSecretStore(",
    [
      ["packages/cli/src/runtime/config-command.ts", 1],
      ["packages/cli/src/runtime/surface-core-host-link.ts", 1],
      ["packages/cli/src/runtime/workspace-command.ts", 1],
      ["packages/cli/src/serve/backup-command.ts", 2],
      ["packages/cli/src/serve/disaster-recovery-command.ts", 1],
      ["packages/cli/src/serve/managed-service-runtime.ts", 1],
      ["packages/cli/src/serve/mesh-pair-command.ts", 1],
      ["packages/cli/src/serve/topology-command.ts", 1],
      ["packages/cli/src/startup.ts", 1],
    ],
    "P01 SecretStore concrete factory",
    new Set(["packages/secrets/src/platform-secret-store.ts"]),
  );

  if (
    count(skillAdapter, 'path.join(os.tmpdir(), "zhixing-skill-admission")') !== 1 ||
    !skillAdapter.includes("implements SkillCatalogAdmissionCorrectnessPort") ||
    /node:(?:fs|fs\/promises|path|os)|zhixing-skill-admission/u.test(skillApplication)
  ) {
    failures.push("P05 admission temp escaped its single Correctness adapter");
  }
  requireMultiplicity(
    "new AssignmentSkillAdmissionCorrectnessPort(",
    [["packages/orchestrator/src/runtime/assignment-skill-port.ts", 1]],
    "P05 admission temp adapter",
  );

  if (
    !artifactStore.includes("export class FileArtifactStore") ||
    !commitLog.includes("export class FileAuthorityCommitLog") ||
    !projection.includes("export class FileDurableProjectionIndex") ||
    !lifecycleIndex.includes("export class ArtifactLifecycleIndex") ||
    !authoritySetup.includes('path.join(authorityRoot, "artifacts")') ||
    !authoritySetup.includes('path.join(authorityRoot, "authority")') ||
    !authoritySetup.includes('path.join(authorityRoot, "executor-authority")')
  ) {
    failures.push("P06 CAS/WAL/projection physical owner exact-set drifted");
  }
  requireMultiplicity(
    "export class FileArtifactStore",
    [["packages/core/src/authority/artifact-store.ts", 1]],
    "P06 FileArtifactStore definition",
  );
  requireMultiplicity(
    "export class FileAuthorityCommitLog",
    [["packages/core/src/authority/commit-log.ts", 1]],
    "P06 FileAuthorityCommitLog definition",
  );
  requireMultiplicity(
    "export class FileDurableProjectionIndex",
    [["packages/core/src/authority/durable-projection-index.ts", 1]],
    "P06 FileDurableProjectionIndex definition",
  );
  requireMultiplicity(
    "export class ArtifactLifecycleIndex",
    [["packages/core/src/authority/artifact-lifecycle-index.ts", 1]],
    "P06 ArtifactLifecycleIndex definition",
  );
  const rubricPortStart = advancementApplication.indexOf(
    "export interface AdvancementRubricArtifactPort",
  );
  const rubricPortEnd = advancementApplication.indexOf("\n}", rubricPortStart);
  const rubricPort = rubricPortStart < 0 || rubricPortEnd < 0
    ? ""
    : advancementApplication.slice(rubricPortStart, rubricPortEnd);
  if (
    !rubricPort.includes(
      "readByDigest(digest: Digest): Promise<Uint8Array | undefined>;",
    ) ||
    !rubricPort.includes("put(bytes: Uint8Array): Promise<ArtifactRef>;") ||
    /FileArtifactStore|ArtifactStore|referenceForDigest|readRange|rootDir|path|\?:/u.test(
      rubricPort,
    ) ||
    /FileArtifactStore|@zhixing\/core\/authority|referenceForDigest|Pick\s*</u.test(
      `${advancementRubricLibrary}\n${advancementController}`,
    ) ||
    !advancementRubricLibrary.includes(
      "readonly artifacts: () => AdvancementRubricArtifactPort | undefined;",
    ) ||
    !advancementRubricLibrary.includes(
      "return this.#artifacts().readByDigest(digest);",
    ) ||
    !advancementController.includes(
      "readonly artifacts: AdvancementRubricArtifactPort;",
    ) ||
    !authoritySetup.includes(
      "readonly rubricArtifacts: AdvancementRubricArtifactPort;",
    ) ||
    count(authoritySetup, "projectAdvancementRubricArtifacts(") !== 2 ||
    !authoritySetup.includes("const ref = await artifacts.referenceForDigest(digest);") ||
    !anchor.includes("artifacts: authority.rubricArtifacts,")
  ) {
    failures.push("P06 Advancement Rubric artifact demand boundary drifted");
  }
  const p06Concrete = /\b(?:FileArtifactStore|FileAuthorityCommitLog|FileDurableProjectionIndex|ArtifactLifecycleIndex)\b/u;
  const allowedP06Prefixes = [
    "packages/core/src/authority/",
    "packages/cli/src/setup-delivery.ts",
    "packages/cli/src/serve/",
    "packages/executor/src/",
    "packages/owner-kernel/src/conversation-transfer.ts",
  ];
  for (const record of records) {
    if (!p06Concrete.test(record.text)) continue;
    if (!allowedP06Prefixes.some((prefix) => record.relative.startsWith(prefix))) {
      failures.push(`${record.relative}: P06 file concrete escaped Correctness/Infrastructure`);
    }
  }

  if (
    !serverState.includes(
      "export function readServerStateSnapshot(): Promise<ServerStateSnapshot | null>",
    ) ||
    !serverState.includes("return readServerStateSnapshotAt(getDefaultStatePath())") ||
    !status.includes("return readServerStateSnapshot();") ||
    /\bServerStateFile\b|getDefaultStatePath|getDefaultReadyMarkerPath/u.test(status) ||
    count(anchor, "await loadOrCreateToken()") !== 1 ||
    count(executor, "await loadOrCreateToken()") !== 1 ||
    !token.includes("export async function loadOrCreateToken(") ||
    !anchorShell.includes("implements ServerLifecycleOwner") ||
    !executorShell.includes("export class ExecutorServerLifecycle") ||
    !processLock.includes("export async function acquireLock(") ||
    !processLock.includes("export async function releaseLock(") ||
    !serverLog.includes("export class ServerLogLifecycle")
  ) {
    failures.push("P13 discovery/auth/state/log ownership or read-only demand boundary drifted");
  }
  requireMultiplicity(
    "new ServerStateFile(",
    [
      ["packages/cli/src/serve/command.ts", 1],
      ["packages/cli/src/serve/executor-role-runtime.ts", 1],
    ],
    "P13 ServerStateFile constructor",
  );
  requireMultiplicity(
    "readServerStateSnapshot(",
    [
      ["packages/cli/src/serve/status.ts", 1],
      ["packages/server/src/server-state.ts", 1],
    ],
    "P13 read-only state projection definition/consumer",
  );

  if (
    !managedService.includes("export function buildManagedServiceSpec(") ||
    !managedService.includes("managedServiceDefinitionBytes(spec)")
  ) {
    failures.push("P14 managed-service file/manager adapter ownership drifted");
  }
  requireMultiplicity(
    "new NodeManagedServiceAdapter(",
    [["packages/cli/src/serve/managed-service.ts", 1]],
    "P14 NodeManagedServiceAdapter constructor",
  );

  if (
    !diagnostics.includes('"logs", "llm-raw"') ||
    !diagnostics.includes('"logs", "llm-error"') ||
    !diagnostics.includes("export function pruneAllLogs()") ||
    !keypress.includes("export function recordKeypressEvent(") ||
    !keypress.includes('`keypress-${process.pid}-${ts}.log`')
  ) {
    failures.push("P15 diagnostic writer/retention exact-set drifted");
  }
  requireMultiplicity(
    '"logs", "llm-raw"',
    [["packages/cli/src/output/llm-chunk-dump.ts", 1]],
    "P15 llm-raw path writer",
  );
  requireMultiplicity(
    '"logs", "llm-error"',
    [["packages/cli/src/output/llm-chunk-dump.ts", 1]],
    "P15 llm-error path writer",
  );
  requireMultiplicity(
    '`keypress-${process.pid}-${ts}.log`',
    [["packages/cli/src/security/keypress-dump.ts", 1]],
    "P15 keypress path writer",
  );

  const forbiddenDemandPrefixes = [
    "packages/core/src/conversation/",
    "packages/core/src/workscene/",
    "packages/core/src/schedule/",
    "packages/core/src/delivery/",
    "packages/runtime-host/src/",
    "packages/rpc/src/",
    "packages/tools-builtin/src/",
  ];
  const forbiddenMechanisms = /@zhixing\/secrets|\bEncryptedVaultSecretStore\b|\bNodeManagedServiceAdapter\b|\bServerStateFile\b|zhixing-skill-admission|\b(?:FileArtifactStore|FileAuthorityCommitLog|FileDurableProjectionIndex|ArtifactLifecycleIndex)\b|llm-(?:raw|error)|keypress-\$\{/u;
  for (const record of records) {
    if (
      forbiddenDemandPrefixes.some((prefix) => record.relative.startsWith(prefix)) &&
      forbiddenMechanisms.test(record.text)
    ) {
      failures.push(`${record.relative}: storage/platform mechanism returned to a demand owner`);
    }
    if (/\b(?:UniversalStorage|StorageFacade|StorageServiceLocator)\b/u.test(record.text)) {
      failures.push(`${record.relative}: a unified Storage facade returned`);
    }
  }
  return failures;
}

/** A5 Device Administration owns finite reads, removal, duty migration and current removal. */
export function inspectDeviceAdministrationReadOwnership(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const required = (relative) => {
    const text = byPath.get(relative);
    if (text === undefined) {
      failures.push(`${relative}: Device Administration source is missing`);
    }
    return text ?? "";
  };
  const application = required(
    "packages/core/src/device-administration/application.ts",
  );
  const correctness = required(
    "packages/core/src/device-administration/correctness.ts",
  );
  const backupRecovery = required(
    "packages/core/src/backup-recovery/application.ts",
  );
  const coreIndex = required("packages/core/src/index.ts");
  const manifestText = required("packages/core/package.json");
  const build = required("packages/core/tsup.config.ts");
  const context = required("packages/server/src/context.ts");
  const handler = required("packages/server/src/rpc/methods/server.ts");
  const composition = required("packages/cli/src/serve/command.ts");
  const mesh = required("packages/cli/src/serve/mesh-runtime-assembly.ts");
  const retirementTransaction = required(
    "packages/cli/src/serve/current-device-retirement-transaction.ts",
  );
  const currentRemovalAssembly = composition.match(
    /currentRemovalAdmission,[\s\S]*?removalContext:/u,
  )?.[0] ?? "";
  const currentRemovalAuthorityReader = composition.match(
    /const readCurrentRemovalAuthority[\s\S]*?\n {4}: undefined;/u,
  )?.[0] ?? "";
  const currentRemovalAdmissionAdapter = correctness.match(
    /export function createDeviceAdministrationCurrentRemovalAdmissionPort[\s\S]*?\/\*\* Physical current-Authority/u,
  )?.[0] ?? "";
  const currentRemovalMigrationAssembly = composition.match(
    /const currentRemovalMigrationApplication[\s\S]*?await currentRemovalMigrationApplication\?\.resumeActive\(\);/u,
  )?.[0] ?? "";
  const currentRemovalRecoveryAssembly = composition.match(
    /const currentRemovalRecoveryApplication[\s\S]*?await currentRemovalRecoveryApplication\?\.resumeActive\(\);/u,
  )?.[0] ?? "";
  const removalTargetEffects = mesh.match(
    /export class DeviceRemovalTargetEffectAdapter[\s\S]*?\/\*\* Production composition/u,
  )?.[0] ?? "";
  const dutyMigrationAdmission = mesh.match(
    /export class DeviceAdministrationDutyMigrationAdmissionAdapter[\s\S]*?\/\*\* Production composition/u,
  )?.[0] ?? "";
  const manifest = manifestText ? JSON.parse(manifestText) : {};
  const narrow = manifest.exports?.["./device-administration/application"];
  const correctnessNarrow = manifest.exports?.["./device-administration/correctness"];
  const backupNarrow = manifest.exports?.["./backup-recovery/application"];
  const applicationOwners = records
    .filter((record) =>
      record.relative !== "packages/core/src/device-administration/application.ts" &&
      record.text.includes("new DeviceAdministrationApplicationService("),
    )
    .map((record) => record.relative);
  const duplicateExports = Object.entries(manifest.exports ?? {})
    .filter(([subpath, value]) =>
      subpath !== "./device-administration/application" &&
      value && typeof value === "object" &&
      (value.types === narrow?.types || value.import === narrow?.import),
    );

  if (
    !application.includes("class DeviceAdministrationApplicationService") ||
    application.split("defineProductApiQuery<").length - 1 !== 5 ||
    application.split("defineProductApiCommand<").length - 1 !== 8 ||
    application.split("bindProductApiOperation(").length - 1 !== 13 ||
    !application.includes('"device-administration.query.list"') ||
    !application.includes('"device-administration.query.removal-status"') ||
    !application.includes('"device-administration.query.duty-migration-targets"') ||
    !application.includes('"device-administration.query.current-removal-preflight"') ||
    !application.includes('"device-administration.query.current-removal-status"') ||
    !application.includes('"device-administration.command.begin-removal"') ||
    !application.includes('"device-administration.command.continue-removal"') ||
    !application.includes('"device-administration.command.prepare-duty-migration"') ||
    !application.includes('"device-administration.command.commit-duty-migration"') ||
    !application.includes('"device-administration.command.cancel-duty-migration"') ||
    !application.includes('"device-administration.command.begin-current-removal"') ||
    !application.includes('"device-administration.command.continue-current-removal"') ||
    !application.includes('"device-administration.command.cancel-current-removal"') ||
    !application.includes("DeviceAdministrationRemovalAuthorityPort<Accepted, Abort>") ||
    !application.includes("DeviceAdministrationRemovalEffectPort<Accepted, Abort>") ||
    !application.includes("DeviceAdministrationRemovalEffectOutcome<Result>") ||
    !application.includes("DeviceAdministrationDutyMigrationAdmissionPort") ||
    !application.includes("DeviceAdministrationDutyMigrationAdmissionOutcome") ||
    !application.includes("DeviceAdministrationDutyMigrationPort") ||
    !application.includes("DeviceAdministrationCurrentRemovalAdmissionPort") ||
    !application.includes("DeviceAdministrationCurrentRemovalAdmissionOutcome") ||
    !application.includes("DeviceAdministrationCurrentRemovalMigrationTargetReadPort") ||
    !application.includes("DeviceAdministrationCurrentRemovalRecoveryApplication") ||
    !application.includes("class DeviceAdministrationCurrentRemovalRecoveryApplicationService") ||
    !application.includes("DeviceAdministrationCurrentRemovalRecoveryLifecyclePort<Evidence>") ||
    !application.includes("DeviceAdministrationCurrentRemovalRecoveryEffectPort<Evidence>") ||
    !application.includes("DeviceAdministrationCurrentRemovalMechanismPort") ||
    !application.includes("DeviceAdministrationCurrentRemovalLifecycleSnapshot") ||
    !application.includes("class DeviceAdministrationCurrentRemovalMigrationApplicationService") ||
    !application.includes("DeviceAdministrationCurrentRemovalMigrationLifecyclePort<Evidence>") ||
    !application.includes("DeviceAdministrationCurrentRemovalMigrationEffectPort<Evidence>") ||
    !application.includes('if (operation.phase === "accepted")') ||
    !application.includes('if (operation.phase === "gate-frozen")') ||
    !application.includes('if (operation.phase === "transfer-committed")') ||
    !application.includes('if (operation.phase === "cleanup-complete")') ||
    !application.includes("return this.#drive(await this.options.lifecycle.accept(input));") ||
    !application.includes("results.push(await this.#drive(operation));") ||
    !application.includes('strategy: "drain"') ||
    !application.includes('strategy: "immediate"') ||
    !application.includes("timeoutMs: 30_000") ||
    !application.includes("projectCurrentRemovalState(") ||
    !application.includes("assertCurrentRemovalCancellationEligible(") ||
    !application.includes("assertCurrentRemovalCancellationEligible(lifecycle);") ||
    !application.includes("const lifecycle = await port.read({ operationId });") ||
    !application.includes("return projectCurrentRemovalState(await port.abort({ operationId }));") ||
    !application.includes('throw new Error("Current device removal operation is unknown")') ||
    !application.includes('throw new TypeError("Irreversible lifecycle operation cannot be aborted")') ||
    !application.includes("context.currentDutyDeviceId !== context.localDeviceId") ||
    !application.includes("context.currentDutyIssuerKeyId !== context.localIssuerKeyId") ||
    !application.includes("const admission = await admissionPort.read()") ||
    !application.includes('case "paired-device-removal":') ||
    !application.includes(
      'throw new Error("Finish the current device removal before uninstalling this device")',
    ) ||
    !application.includes(
      'throw new TypeError("Current device removal admission outcome is invalid")',
    ) ||
    !application.includes("candidate.ready && candidate.displayName === targetName") ||
    !application.includes('"No ready duty device has that name"') ||
    !application.includes('"More than one ready duty device has that name"') ||
    !application.includes('backup.state === "recoverable"') ||
    !application.includes("DEVICE_ADMINISTRATION_PRODUCT_API_EXACT_SET") ||
    !application.includes("createDeviceAdministrationProductApiContribution") ||
    !application.includes("factEvents: []") ||
    !application.includes("decideCurrentDeviceRetirementCredentialExposures") ||
    !application.includes('rotationHint: record.rotationHint ?? "Rotate this external account credential"')
  ) {
    failures.push("Device Administration Query/Product API exact-set drifted");
  }
  if (
    application.includes("isConnected(") ||
    application.includes("isDeviceRemovalTargetConnected")
  ) {
    failures.push("Device Administration domain regained physical removal connectivity");
  }
  if (
    application.includes("currentOwnerReady") ||
    application.includes("deviceRemovalInProgress") ||
    application.includes("DeviceAdministrationDutyMigrationContextReadPort")
  ) {
    failures.push("Device Administration duty migration regained physical lifecycle flags");
  }
  if (
    application.includes("executorRemovalInProgress") ||
    application.includes("DeviceAdministrationCurrentRemovalContextReadPort") ||
    application.includes('"executor-removal"')
  ) {
    failures.push("Device Administration current-removal regained physical lifecycle facts");
  }
  if (
    application.includes("anchorEpoch") ||
    /\bAnchor\b/u.test(application) ||
    backupRecovery.includes("anchorEpoch") ||
    /\bAnchor\b/u.test(backupRecovery)
  ) {
    failures.push("Backup/Recovery or Device domain regained a physical topology fence");
  }
  if (
    applicationOwners.length !== 1 ||
    applicationOwners[0] !== "packages/cli/src/serve/command.ts" ||
    composition.split("new DeviceAdministrationApplicationService(").length - 1 !== 1 ||
    composition.split("createDeviceAdministrationProductApiContribution(").length - 1 !== 1 ||
    !composition.includes("DEVICE_ADMINISTRATION_PRODUCT_API_EXACT_SET.operations") ||
    !composition.includes("DEVICE_ADMINISTRATION_PRODUCT_API_EXACT_SET.factEvents") ||
    !composition.includes("list: () => ctx.meshRuntime!.removableDevices()") ||
    !composition.includes("ctx.meshRuntime!.deviceRemovalStatus({ targetName })") ||
    !composition.includes("list: () => ctx.meshRuntime!.plannedAnchorTargets()") ||
    !composition.includes("ctx.meshRuntime!.deviceRemovalCommandContext()") ||
    !composition.includes("ctx.meshRuntime!.acceptDeviceRemovalForTarget(input)") ||
    !composition.includes("removalEffects: ctx.meshRuntime!.deviceRemovalTargetEffects") ||
    !composition.includes("dutyMigrationAdmission: ctx.meshRuntime!.dutyMigrationAdmission") ||
    !composition.includes("ctx.meshRuntime!.preparePlannedAnchorTransfer(input)") ||
    !composition.includes("ctx.meshRuntime!.commitPlannedAnchorTransfer(input)") ||
    !composition.includes("ctx.meshRuntime!.abortPlannedAnchorTransfer(input)") ||
    !composition.includes("currentRemovalAdmission,") ||
    !composition.includes("currentRemovalMigrationTargets: {") ||
    !composition.includes("currentRemovalRecovery: currentRemovalRecoveryApplication") ||
    !composition.includes("currentRemovalMigration: currentRemovalMigrationApplication") ||
    !composition.includes("currentDeviceRemoval,") ||
    !composition.includes("const readCurrentRemovalAuthority") ||
    composition.split("createDeviceAdministrationCurrentRemovalAdmissionPort({").length - 1 !== 1 ||
    !composition.includes("createDeviceAdministrationCurrentRemovalMechanismPort({") ||
    !composition.includes("createDeviceAdministrationCurrentRemovalMigrationLifecyclePort({") ||
    !composition.includes("createDeviceAdministrationCurrentRemovalRecoveryLifecyclePort({") ||
    !composition.includes("ctx.authorityCheckpointOwner.status()") ||
    composition.includes("AnchorUninstallCoordinator") ||
    composition.includes("new CurrentRemovalCoordinator") ||
    composition.includes("anchorUninstall.") ||
    composition.includes("anchorUninstall: {") ||
    currentRemovalAssembly.includes("recoveryBackupReady:") ||
    currentRemovalAssembly.includes(".filter((candidate)") ||
    currentRemovalAssembly.includes("No ready duty device has that name") ||
    currentRemovalAssembly.includes("nextAction:") ||
    currentRemovalAssembly.includes("moving-duty-device") ||
    currentRemovalAssembly.includes("ready-to-uninstall") ||
    composition.includes("currentRemovalAdmission: {") ||
    composition.includes('return { stage: "ready" as const }') ||
    composition.includes('return { stage: "completed" as const }') ||
    composition.includes('return { stage: "cancelled" as const }') ||
    composition.includes("deviceLifecycle:")
  ) {
    failures.push("Device Administration unique Host application composition drifted");
  }
  if (
    composition.split("currentRemovalJournal.active()").length - 1 !== 1 ||
    currentRemovalAuthorityReader.split("currentRemovalJournal.active()").length - 1 !== 1 ||
    currentRemovalAuthorityReader.split('operation.identity.kind === "executor-removal"').length -
        1 !== 1 ||
    currentRemovalAdmissionAdapter.split("options.readAuthority()").length - 1 !== 1 ||
    !currentRemovalAdmissionAdapter.includes(
      "kind: authority.executorRemovalInProgress",
    ) ||
    !currentRemovalAdmissionAdapter.includes('? "paired-device-removal" as const') ||
    !currentRemovalAdmissionAdapter.includes(': "allowed" as const') ||
    !currentRemovalAdmissionAdapter.includes("localDeviceId: authority.localDeviceId") ||
    !currentRemovalAdmissionAdapter.includes(
      "currentDutyIssuerKeyId: authority.currentDutyIssuerKeyId",
    ) ||
    currentRemovalAdmissionAdapter.includes("currentRemovalJournal") ||
    currentRemovalAdmissionAdapter.includes('"executor-removal"')
  ) {
    failures.push("Device Administration current-removal admission adapter drifted");
  }
  if (
    composition.includes("isDeviceRemovalTargetConnected") ||
    mesh.includes("isDeviceRemovalTargetConnected") ||
    mesh.split("new DeviceRemovalTargetEffectAdapter(this.connections)").length - 1 !== 1 ||
    removalTargetEffects.split("this.connections.has(input.targetDeviceId)").length - 1 !== 3 ||
    removalTargetEffects.split('kind: "unavailable"').length - 1 !== 3 ||
    removalTargetEffects.split('kind: "completed"').length - 1 !== 3
  ) {
    failures.push("Device Administration physical removal outcome adapter drifted");
  }
  if (
    mesh.split("new DeviceAdministrationDutyMigrationAdmissionAdapter(").length - 1 !== 1 ||
    !mesh.includes(
      "readonly dutyMigrationAdmission: DeviceAdministrationDutyMigrationAdmissionPort",
    ) ||
    !mesh.includes("currentOwnerReady: this.plannedCurrentOwnerReady()") ||
    !mesh.includes("deviceRemovalInProgress: this.#deviceRemovalGuards.size > 0") ||
    !dutyMigrationAdmission.includes("!snapshot.currentOwnerReady") ||
    !dutyMigrationAdmission.includes("snapshot.deviceRemovalInProgress") ||
    !dutyMigrationAdmission.includes('kind: "current-owner-transition"') ||
    !dutyMigrationAdmission.includes('kind: "paired-device-removal"') ||
    !dutyMigrationAdmission.includes('kind: "allowed"') ||
    mesh.includes("dutyMigrationCommandContext()")
  ) {
    failures.push("Device Administration duty migration admission adapter drifted");
  }
  if (
    application.split("#assertDutyMigrationAdmission(false)").length - 1 !== 2 ||
    application.split("#assertDutyMigrationAdmission(true)").length - 1 !== 1 ||
    !application.includes('case "current-owner-transition":') ||
    !application.includes('case "paired-device-removal":') ||
    !application.includes(
      'throw new Error("Current duty device is completing its durable migration consumers")',
    ) ||
    !application.includes(
      '"Duty-device migration is unavailable while a paired device is being removed"',
    ) ||
    !application.includes('throw new Error("This device is not the current duty device")')
  ) {
    failures.push("Device Administration duty migration product admission policy drifted");
  }
  if (
    records.some((record) => record.relative.endsWith("/anchor-uninstall.ts")) ||
    records.some((record) => /class\s+(?:AnchorUninstall|CurrentRemoval)Coordinator\b/u.test(record.text)) ||
    correctness.includes("readonly targetName: string") ||
    correctness.includes("migrationTargets:") ||
    correctness.includes("projectCurrentRemovalState")
  ) {
    failures.push("Anchor uninstall coordinator or product path selection returned");
  }
  if (
    composition.split("new DeviceAdministrationCurrentRemovalMigrationApplicationService<").length -
        1 !== 1 ||
    composition.split("createDeviceAdministrationCurrentRemovalMigrationLifecyclePort({").length -
        1 !== 1 ||
    !composition.includes("lifecycle: currentRemovalMigrationLifecycle") ||
    !composition.includes("await currentRemovalMigrationApplication?.resumeActive();") ||
    !composition.includes("await currentRemovalRecoveryApplication?.resumeActive();") ||
    currentRemovalMigrationAssembly.includes("operation.phase") ||
    correctness.includes("#driveMigration(") ||
    correctness.includes("async resumeActive(") ||
    correctness.includes("commitMigration:") ||
    correctness.includes("verifyMigration:") ||
    correctness.includes("retireMigratedDevice:") ||
    !correctness.includes("createDeviceAdministrationCurrentRemovalMigrationLifecyclePort")
  ) {
    failures.push("Device Administration migration lifecycle has a second phase owner");
  }
  if (
    !backupRecovery.includes("class BackupRecoveryCurrentRemovalApplicationService") ||
    !backupRecovery.includes("decodeCurrentPackage(value: string)") ||
    !backupRecovery.includes("prepareAcceptedBinding(input:") ||
    !backupRecovery.includes("verifyAcceptedBinding(input:") ||
    !backupRecovery.includes("acceptedRecoveryBinding: string") ||
    !backupRecovery.includes("checkpointBinding: string") ||
    !backupRecovery.includes("verifyCheckpoint(input:") ||
    !backupRecovery.includes("minimumUpToLsn?: number") ||
    !correctness.includes("Recovery package changes the accepted uninstall generation") ||
    !backupNarrow ||
    backupNarrow.types !== "./dist/backup-recovery/application.d.ts" ||
    backupNarrow.import !== "./dist/backup-recovery/application.js" ||
    !build.includes('"src/backup-recovery/application.ts"') ||
    coreIndex.includes("backup-recovery/application") ||
    composition.split("new BackupRecoveryCurrentRemovalApplicationService(").length - 1 !== 1 ||
    composition.split("new DeviceAdministrationCurrentRemovalRecoveryApplicationService<").length -
        1 !== 1 ||
    composition.split("createDeviceAdministrationCurrentRemovalRecoveryLifecyclePort({").length -
        1 !== 1 ||
    !composition.includes("lifecycle: currentRemovalRecoveryLifecycle") ||
    !composition.includes("await currentRemovalRecoveryApplication?.resumeActive();") ||
    currentRemovalRecoveryAssembly.includes("operation.phase") ||
    correctness.includes("beginRecoveryBackup(") ||
    correctness.includes("confirmRecoveryBackup(") ||
    correctness.includes("resumeRecoveryActive(") ||
    correctness.includes("#driveRecovery(") ||
    correctness.includes("decodeRecoveryPackage") ||
    correctness.includes("checkpointOwner") ||
    !correctness.includes("createDeviceAdministrationCurrentRemovalRecoveryLifecyclePort") ||
    !correctness.includes("createDeviceAdministrationCurrentRemovalRecoveryBindingPort") ||
    !correctness.includes('protocolDigest("AnchorUninstallCheckpointGeneration", 1, {') ||
    !correctness.includes('protocolDigest("AnchorUninstallAcceptedRecoveryBinding", 1, {') ||
    !correctness.includes("options.binding.assertAuthorityCurrent({ authority, binding: input.binding })") ||
    !correctness.includes("checkpointGeneration: input.binding.checkpointBinding") ||
    !correctness.includes("binding: binding.restore(operation.identity)") ||
    !retirementTransaction.includes("decideCurrentDeviceRetirementCredentialExposures({") ||
    !retirementTransaction.includes("assertDeviceAdministrationRetirementAuthority({") ||
    retirementTransaction.includes("Rotate this external account credential") ||
    !application.includes('if (operation.phase === "checkpoint-verified")') ||
    !application.includes('if (operation.phase === "retirement-decided")') ||
    !application.includes('if (operation.phase === "gate-closed")') ||
    !application.includes('if (operation.phase === "work-settled")') ||
    !application.includes('if (operation.phase === "flushed")') ||
    !application.includes('if (operation.phase === "final-checkpoint-verified")')
  ) {
    failures.push("Backup/Recovery and Device Administration recovery ownership drifted");
  }
  if (
    !composition.includes("createDeviceAdministrationCurrentRemovalRecoveryBindingPort()") ||
    !composition.includes("binding: currentRemovalRecoveryBinding") ||
    !composition.includes("prepareAcceptedBinding: async (input) =>") ||
    !composition.includes("verifyAcceptedBinding: async (input) =>") ||
    !composition.includes("currentRemovalRecoveryBinding.assertCurrent({") ||
    !composition.includes("anchorEpoch: ctx.authorityRuntime!.anchorEpoch")
  ) {
    failures.push("Current-removal physical recovery binding is not uniquely Host-composed");
  }
  if (
    correctness.includes("AnchorUninstallPublicState") ||
    correctness.includes("function projectState(") ||
    correctness.includes("nextAction:") ||
    !correctness.includes("createDeviceAdministrationCurrentRemovalMechanismPort") ||
    !correctness.includes("createSignedDeviceLifecycleAbort") &&
      !correctness.includes("signAbort:")
  ) {
    failures.push("Current-removal correctness regained product state or lost signed mechanism");
  }
  if (
    !handler.includes('from "@zhixing/core/device-administration/application"') ||
    handler.split("productApi?.supports(DEVICE_ADMINISTRATION_").length - 1 !== 8 ||
    handler.split("productApi?.supports(descriptor)").length - 1 !== 1 ||
    handler.split("productApi.query(DEVICE_ADMINISTRATION_").length - 1 !== 5 ||
    handler.split("productApi.command(DEVICE_ADMINISTRATION_").length - 1 !== 9 ||
    handler.includes("ctx.server.deviceLifecycle.list") ||
    handler.includes("ctx.server.deviceLifecycle.status") ||
    handler.includes("ctx.server.deviceLifecycle.remove") ||
    handler.includes("ctx.server.deviceLifecycle.continue") ||
    handler.includes("ctx.server.dutyMigration") ||
    handler.includes("ctx.server.anchorUninstall")
  ) {
    failures.push("Device Administration RPC pure read binding drifted");
  }
  if (
    context.includes("targets(): Promise<readonly") ||
    context.includes("list(): Promise<readonly") ||
    context.includes("deviceLifecycle?:") ||
    context.includes("dutyMigration?: {") ||
    context.includes("anchorUninstall?:") ||
    !context.includes("productApi?: ProductApiDispatcher")
  ) {
    failures.push("Device Administration ServerContext owner returned");
  }
  if (
    mesh.includes("beginDeviceRemoval(") ||
    mesh.includes("continueDeviceRemoval(") ||
    !mesh.includes("deviceRemovalCommandContext()") ||
    !mesh.includes("acceptDeviceRemovalForTarget(input:") ||
    !mesh.includes("deviceRemovalOperationForTarget(") ||
    !mesh.includes("abortDeviceRemoval(operationId:") ||
    !mesh.includes("commitLostDeviceRemoval(operationId:") ||
    !mesh.includes("class DeviceRemovalTargetEffectAdapter") ||
    !mesh.includes("readonly deviceRemovalTargetEffects: DeviceRemovalTargetEffectAdapter") ||
    !mesh.includes(
      "readonly dutyMigrationAdmission: DeviceAdministrationDutyMigrationAdmissionPort",
    )
  ) {
    failures.push("Device Administration decision returned to Mesh runtime");
  }
  if (
    narrow?.types !== "./dist/device-administration/application.d.ts" ||
    narrow?.import !== "./dist/device-administration/application.js" ||
    correctnessNarrow?.types !== "./dist/device-administration/correctness.d.ts" ||
    correctnessNarrow?.import !== "./dist/device-administration/correctness.js" ||
    duplicateExports.length !== 0 ||
    build.split('"src/device-administration/application.ts"').length - 1 !== 1 ||
    build.split('"src/device-administration/correctness.ts"').length - 1 !== 1 ||
    /device-administration|DeviceAdministration/u.test(coreIndex)
  ) {
    failures.push("Device Administration narrow export/build boundary drifted");
  }
  return failures;
}

/** A5 Workspace Administration owns binding CRUD and reset lifecycle decisions. */
export function inspectWorkspaceAdministrationOwnership(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const required = (relative) => {
    const text = byPath.get(relative);
    if (text === undefined) {
      failures.push(`${relative}: Workspace Administration production source is missing`);
    }
    return text ?? "";
  };
  const application = required(
    "packages/core/src/environment/workspace-administration.ts",
  );
  const environmentIndex = required("packages/core/src/environment/index.ts");
  const coreIndex = required("packages/core/src/index.ts");
  const manifestText = required("packages/core/package.json");
  const build = required("packages/core/tsup.config.ts");
  const host = required(
    "packages/cli/src/runtime/local-workspace-management-host.ts",
  );
  const outbox = required(
    "packages/cli/src/runtime/local-workspace-operation-outbox.ts",
  );
  const lifecycleAdapter = required(
    "packages/cli/src/runtime/local-workspace-durable-lifecycle-adapter.ts",
  );
  const bootstrap = required(
    "packages/cli/src/runtime/local-workspace-bootstrap.ts",
  );
  const accessSurfaces = required("packages/cli/src/serve/access-surfaces.ts");
  const executorRole = required(
    "packages/cli/src/serve/executor-role-runtime.ts",
  );
  const control = required(
    "packages/cli/src/runtime/local-workspace-control.ts",
  );
  const command = required("packages/cli/src/runtime/workspace-command.ts");
  const repl = required("packages/cli/src/repl.ts");
  const manifest = manifestText ? JSON.parse(manifestText) : {};

  const finiteWorkspaceResourcePort =
    /Pick<\s*ResourceReservationPort,\s*"acquireRoot"\s*\|\s*"settle"\s*\|\s*"release"\s*>/u;
  const workspaceResourceDemandSources = [control, host, bootstrap];
  const controlOwners = records
    .filter((record) => record.text.includes("new ExecutorWorkspaceAdministrationControl("))
    .map((record) => record.relative);
  if (
    workspaceResourceDemandSources.some((source) =>
      /ExecutorResourceGovernor|@zhixing\/executor/u.test(source)
    ) ||
    !finiteWorkspaceResourcePort.test(control) ||
    !finiteWorkspaceResourcePort.test(host) ||
    /readonly\s+resources\s*\?/u.test(control) ||
    /readonly\s+resources\s*\?/u.test(host) ||
    controlOwners.length !== 1 ||
    controlOwners[0] !==
      "packages/cli/src/runtime/local-workspace-management-host.ts"
  ) {
    failures.push(
      "Workspace resource admission escaped its required finite Host projection",
    );
  }

  const resourceRoots = new Map([
    ["packages/cli/src/serve/access-surfaces.ts", "authorityRuntime.executorResourceGovernor"],
    ["packages/cli/src/serve/executor-role-runtime.ts", "authority.executorResourceGovernor"],
    ["packages/cli/src/runtime/workspace-command.ts", "runtime.executorResourceGovernor"],
  ]);
  for (const [relative, expected] of resourceRoots) {
    const text = required(relative);
    const source = sourceFile(relative, text);
    const calls = [];
    const collectCalls = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "createExecutorLocalWorkspaceHost"
      ) {
        calls.push(node);
      }
      ts.forEachChild(node, collectCalls);
    };
    collectCalls(source);
    const input = calls[0]?.arguments[0];
    const property = (object, name) => object?.properties.find((candidate) =>
      ts.isPropertyAssignment(candidate) &&
      candidate.name &&
      propertyNameText(candidate.name) === name
    );
    const hostProperty = input && ts.isObjectLiteralExpression(input)
      ? property(input, "host")
      : undefined;
    const hostInput = hostProperty && ts.isPropertyAssignment(hostProperty) &&
      ts.isObjectLiteralExpression(hostProperty.initializer)
      ? hostProperty.initializer
      : undefined;
    const managementProperty = property(hostInput, "management");
    const management = managementProperty && ts.isPropertyAssignment(managementProperty) &&
      ts.isObjectLiteralExpression(managementProperty.initializer)
      ? managementProperty.initializer
      : undefined;
    const resourcesProperty = property(management, "resources");
    const actual = resourcesProperty && ts.isPropertyAssignment(resourcesProperty)
      ? resourcesProperty.initializer.getText(source)
      : undefined;
    if (calls.length !== 1 || actual !== expected) {
      failures.push(
        `${relative}: Workspace resource port must be projected once from ${expected}`,
      );
    }
  }

  const constructionOwners = records
    .filter((record) => record.text.includes("new WorkspaceAdministrationApplicationService("))
    .map((record) => record.relative);
  const narrowExports = Object.entries(manifest.exports ?? {})
    .filter(([, value]) =>
      JSON.stringify(value).includes("workspace-administration"),
    )
    .map(([name]) => name);
  if (
    !application.includes("interface WorkspaceAdministrationApplication") ||
    !application.includes("class WorkspaceAdministrationApplicationService") ||
    !application.includes("class WorkspaceAdministrationBusinessError") ||
    !application.includes("interface WorkspaceAdministrationControlPort") ||
    !application.includes("WorkspaceBindingRecoveryPort") ||
    !application.includes("WORKSPACE_CATALOG_RESET_IMPACT") ||
    !application.includes("async status()") ||
    !application.includes("async previewReset(input:") ||
    !application.includes("async reset(") ||
    !application.includes("this.#recovery.beginReset(") ||
    !application.includes("this.#recovery.completeReset(requestId, abort)") ||
    !application.includes("confirmationIssuedAt") ||
    !application.includes("operationNonce(execution.operation)") ||
    !application.includes("type WorkspaceAdministrationDurableOperation =") ||
    !application.includes("interface WorkspaceAdministrationDurableOperationMechanismPort") ||
    !application.includes("interface WorkspaceAdministrationDurableLifecycleApplication") ||
    !application.includes("class WorkspaceAdministrationDurableLifecycleApplicationService") ||
    !application.includes("interface WorkspaceAdministrationResultDeliveryApplication") ||
    !application.includes("class WorkspaceAdministrationResultDeliveryApplicationService") ||
    !application.includes("type WorkspaceAdministrationDeliveryClaim =") ||
    !application.includes('readonly kind: "current"') ||
    !application.includes('readonly kind: "operation-input"') ||
    !application.includes("RecoveredWorkspaceAdministrationOperationsError") ||
    !application.includes("CompletedWorkspaceAdministrationOperationError") ||
    !application.includes("async #readPendingDelivery()") ||
    !application.includes("forgetCurrentClaim(): void") ||
    !application.includes("matchesWorkspaceAdministrationConsumptionCredential(") ||
    !application.includes("this.#mechanism.acknowledge({") ||
    !application.includes("workspaceAdministrationResultValue(") ||
    !application.includes("interface WorkspaceAdministrationDurableExecution") ||
    !application.includes("type WorkspaceAdministrationDurableResult =") ||
    !application.includes("async executeDurableOperation(") ||
    !application.includes("validateWorkspaceAdministrationDurableOperation(input)") ||
    !application.includes("switch (operation.kind)") ||
    !application.includes("workspaceAdministrationOperationTarget(") ||
    !application.includes("validateWorkspaceAdministrationDurableResult(") ||
    !application.includes("validateWorkspaceAdministrationDurableValue(") ||
    !application.includes("workspaceAdministrationDurableSuccess(") ||
    !application.includes("workspaceAdministrationDurableFailure(") ||
    !application.includes("this.#mechanism.oldestCommitted()") ||
    !application.includes("this.#application.executeDurableOperation(") ||
    !application.includes("this.#mechanism.complete(operation, decision.result)") ||
    !application.includes("isWorkspaceAdministrationDurableBusinessFailure(error)") ||
    !application.includes("this.#observeInfrastructureFailure(error)") ||
    !application.includes("this.#attemptAbort?.abort()") ||
    !application.includes('["bindingRef", "deviceId"]') ||
    !application.includes("async viewByName(displayName: string)") ||
    !application.includes(
      "toView(await this.#bindingByName(displayName, control))",
    ) ||
    !application.includes("#bindingByName(") ||
    !application.includes('"LOCAL_WORKSPACE_NOT_FOUND"') ||
    !application.includes('"LOCAL_WORKSPACE_NAME_CONFLICT"') ||
    !application.includes('"workspace-operation"') ||
    !/return Object\.freeze\(\{\s*deviceId: this\.#deviceId,\s*bindingRef: binding\.bindingRef,\s*\}\)/u.test(
      application,
    ) ||
    /@zhixing\/(?:cli|executor)|LocalWorkspaceManagementHost|Workscene|ExecutorBackpressure|DeviceCapacity|StorageMaintenanceAdmission/u.test(
      application,
    )
  ) {
    failures.push(
      "Workspace Administration does not uniquely own CRUD, reset, durable lifecycle and result delivery",
    );
  }
  if (
    byPath.has("packages/cli/src/runtime/local-workspace-facade.ts") ||
    byPath.has("packages/cli/src/runtime/local-workspace-recovery.ts") ||
    byPath.has("packages/cli/src/runtime/workspace-reset-impact.ts") ||
    records.some((record) =>
      /\bLocalWorkspaceFacade\b|withLocalWorkspaceFacade|\bLocalWorkspaceRecovery\b/u.test(
        record.text,
      ),
    ) ||
    constructionOwners.length !== 1 ||
    constructionOwners[0] !==
      "packages/cli/src/runtime/local-workspace-management-host.ts" ||
    !host.includes('from "@zhixing/core/environment/workspace-administration"') ||
    !host.includes("new ExecutorWorkspaceAdministrationControl(") ||
    (host.match(/new WorkspaceAdministrationApplicationService\s*\(/gu) ?? [])
      .length !== 1 ||
    (host.match(/new WorkspaceAdministrationDurableLifecycleApplicationService\s*\(/gu) ?? [])
      .length !== 1 ||
    !host.includes("recovery: input.management.recovery") ||
    !host.includes("application: workspace") ||
    !host.includes("mechanism: outbox") ||
    !host.includes("observeLocalWorkspaceDurableInfrastructureFailure") ||
    !host.includes("lifecycle,") ||
    !host.includes("new WorkspaceAdministrationResultDeliveryApplicationService({") ||
    !host.includes("createWorkspaceAdministrationResultDeliveryMechanism(") ||
    (host.match(/delivery\.forgetCurrentClaim\(\)/gu) ?? []).length !== 2 ||
    !host.includes("this.#lifecycle.prepare(request.input)") ||
    !host.includes("this.#lifecycle.commit(request.identity, request.confirmation)") ||
    !host.includes("this.#lifecycle.assertDeliveryMechanismReady()") ||
    !host.includes("return this.#lifecycle.pending(request.afterSeq)") ||
    !host.includes("return this.#lifecycle.acknowledge(request)") ||
    !host.includes("return this.#lifecycle.viewByName(request.displayName)") ||
    !host.includes("validateWorkspaceAdministrationDurableResult(") ||
    !host.includes("workspaceAdministrationResultValue(input, completed.result)") ||
    host.includes("delivery: outbox") ||
    host.includes("this.#delivery") ||
    host.includes("function readPendingDelivery(") ||
    host.includes("function acknowledgeDelivery(") ||
    host.includes("function reportUnclaimedResults(") ||
    host.includes("function consumptionCredentialOf(") ||
    host.includes("function matchesConsumptionCredential(") ||
    host.includes("class RecoveredLocalWorkspaceOperationsError") ||
    host.includes("class CompletedLocalWorkspaceOperationError") ||
    host.includes("LocalWorkspaceWriteOperation") ||
    host.includes("validateLocalWorkspaceWriteOperation") ||
    host.includes("interface OperationResult") ||
    host.includes("function validateOperationResult") ||
    host.includes("#drainLoop(") ||
    host.includes("#executeDecision(") ||
    host.includes("#classifyInfrastructureFailure(") ||
    host.includes("#requireWritable(") ||
    host.includes("this.#applications") ||
    /ExecutorBackpressure|DeviceCapacity|StorageMaintenanceAdmission|WorkspaceBindingCancelledError/u.test(
      host,
    ) ||
    host.includes("this.#applications.create(") ||
    host.includes("this.#applications.authorizeForControl(") ||
    host.includes("this.#applications.rename(") ||
    host.includes("this.#applications.repath(") ||
    host.includes("this.#applications.remove(") ||
    host.includes("this.#applications.reset(") ||
    host.includes("#bindingByName(") ||
    !control.includes("implements WorkspaceAdministrationControlPort") ||
    !control.includes("this.#resources.acquireRoot(") ||
    !control.includes("this.#resources.settle(") ||
    !control.includes("this.#resources.release(") ||
    host.includes("requestNonce") ||
    host.includes("catalogGeneration !== request.input.expectedCatalogGeneration")
  ) {
    failures.push(
      "Workspace Host retains a second durable/result-delivery lifecycle owner or bypasses the domain application",
    );
  }
  if (
    !lifecycleAdapter.includes("observeLocalWorkspaceDurableInfrastructureFailure") ||
    !lifecycleAdapter.includes("ExecutorResourceBackpressureError") ||
    !lifecycleAdapter.includes("DeviceCapacityAdmissionError") ||
    !lifecycleAdapter.includes("StorageMaintenanceAdmissionError") ||
    !lifecycleAdapter.includes("retryAfterMs") ||
    /WorkspaceAdministrationDurableLifecycleApplicationService|\.complete\(|oldestCommitted|setTimeout|LOCAL_WORKSPACE_RECOVERING|LOCAL_WORKSPACE_DRAINING/u.test(
      lifecycleAdapter,
    )
  ) {
    failures.push(
      "Workspace Correctness adapter does not remain a finite infrastructure-failure projection",
    );
  }
  if (
    !outbox.includes("type WorkspaceAdministrationDurableOperation") ||
    !outbox.includes("type WorkspaceAdministrationDurableOperationRecord") ||
    !outbox.includes("validateWorkspaceAdministrationDurableOperation") ||
    !outbox.includes('recoveryOwner: "WorkspaceAdministrationDurableLifecycleApplicationService"') ||
    outbox.includes("type LocalWorkspaceWriteOperation") ||
    outbox.includes("function validateLocalWorkspaceWriteOperation") ||
    outbox.includes('case "create"') ||
    outbox.includes('case "rename"') ||
    outbox.includes('case "repath"') ||
    outbox.includes('case "remove"') ||
    /#drainLoop|#executeDecision|classifyInfrastructureFailure|LOCAL_WORKSPACE_RECOVERING|LOCAL_WORKSPACE_DRAINING/u.test(
      outbox,
    )
  ) {
    failures.push(
      "Workspace outbox redefines the domain contract or owns lifecycle admission and settlement decisions",
    );
  }
  if (
    !command.includes("withLocalWorkspaceClient(") ||
    command.includes("withLocalWorkspaceFacade") ||
    /views\.filter\(\(\{ name \}\)/u.test(command) ||
    command.includes("workspace.list(") ||
    command.includes("created.scene.workspace?.workspaceBindingRevision") ||
    !command.includes("created.workspace.workspaceBindingRevision") ||
    !command.includes("workspace: await workspace.viewByName(sceneName)") ||
    !command.includes("deviceId: authorization.deviceId") ||
    !command.includes("bindingRef: authorization.bindingRef") ||
    !command.includes("validateWorkspaceControlAuthorization(result.value)") ||
    !command.includes("workspaceAdministrationOperationTarget(operation.input)") ||
    command.includes("function operationTarget(") ||
    command.includes("WORKSPACE_CATALOG_RESET_IMPACT") ||
    !repl.includes("withLocalWorkspaceClient(") ||
    !repl.includes("createWorksceneFromLocalWorkspaceAuthorization(") ||
    repl.includes("withLocalWorkspaceFacade")
  ) {
    failures.push(
      "Workspace CLI or Workscene binding still interprets Workspace Administration facts or reset impact",
    );
  }
  if (
    (bootstrap.match(/createLocalWorkspaceManagementHost\s*\(/gu) ?? [])
      .length !== 1 ||
    (accessSurfaces.match(/createExecutorLocalWorkspaceHost\s*\(/gu) ?? [])
      .length !== 1 ||
    (executorRole.match(/createExecutorLocalWorkspaceHost\s*\(/gu) ?? [])
      .length !== 1 ||
    (command.match(/createExecutorLocalWorkspaceHost\s*\(/gu) ?? [])
      .length !== 1
  ) {
    failures.push(
      "Workspace Administration three production roots do not converge through one shared Host factory",
    );
  }
  if (
    JSON.stringify(narrowExports) !==
      JSON.stringify(["./environment/workspace-administration"]) ||
    !build.includes('"src/environment/workspace-administration.ts"') ||
    /WorkspaceAdministration|workspace-administration/u.test(environmentIndex) ||
    /WorkspaceAdministration|workspace-administration/u.test(coreIndex)
  ) {
    failures.push(
      "Workspace Administration application must have one narrow non-root core subpath",
    );
  }
  return failures;
}

/** A5 Trust Administration owns user-visible rule management semantics. */
export function inspectTrustAdministrationOwnership(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const required = (relative) => {
    const text = byPath.get(relative);
    if (text === undefined) {
      failures.push(`${relative}: Trust Administration production source is missing`);
    }
    return text ?? "";
  };

  const application = required(
    "packages/core/src/trust-administration/application.ts",
  );
  const execution = required(
    "packages/core/src/trust-administration/execution.ts",
  );
  const mechanismAdapter = required(
    "packages/core/src/security/trust-administration-adapter.ts",
  );
  const securityPipeline = required(
    "packages/core/src/security/security-pipeline.ts",
  );
  const secureExecutor = required(
    "packages/orchestrator/src/security/secure-executor.ts",
  );
  const agentRuntime = required(
    "packages/orchestrator/src/runtime/create-agent-runtime.ts",
  );
  const taskTool = required("packages/orchestrator/src/tools/task.ts");
  const childFactory = required("packages/orchestrator/src/subagent/factory.ts");
  const childLoop = required("packages/orchestrator/src/subagent/loop-runner.ts");
  const agentNode = required(
    "packages/orchestrator/src/orchestration/agent-node-executor.ts",
  );
  const productApi = required("packages/core/src/product-api/catalog.ts");
  const handler = required("packages/server/src/rpc/methods/trust.ts");
  const context = required("packages/server/src/context.ts");
  const serverIndex = required("packages/server/src/index.ts");
  const adapter = required(
    "packages/cli/src/serve/trust-administration-adapter.ts",
  );
  const permissionInfrastructure = required(
    "packages/cli/src/serve/permission-storage-infrastructure.ts",
  );
  const permissionContract = required(
    "packages/orchestrator/src/runtime/kernel-permission-storage.ts",
  );
  const runtimeHost = required("packages/runtime-host/src/runtime-host.ts");
  const executorRole = required(
    "packages/cli/src/serve/executor-role-runtime.ts",
  );
  const workspaceCommand = required(
    "packages/cli/src/runtime/workspace-command.ts",
  );
  const composition = required("packages/cli/src/serve/command.ts");
  const managementFacade = required(
    "packages/cli/src/runtime/rpc-management-facade.ts",
  );
  const trustCommand = required("packages/cli/src/security/commands.ts");
  const trustArgumentProvider = required(
    "packages/cli/src/security/trust-rule-arg-provider.ts",
  );
  const coreIndex = required("packages/core/src/index.ts");
  const manifestText = required("packages/core/package.json");
  const build = required("packages/core/tsup.config.ts");

  if (
    !application.includes("export interface TrustAdministrationRule") ||
    !application.includes("export interface TrustAdministrationRepository") ||
    !application.includes("export class TrustAdministrationApplicationService") ||
    !application.includes("parseConversationId(id)") ||
    !application.includes('scope.kind === "workscene"') ||
    !application.includes("filter(isManageableTrustAdministrationRule)") ||
    !application.includes(
      'return rule.scope === "context" || rule.scope === "global"',
    ) ||
    !application.includes("await this.options.repository.list(context)") ||
    !application.includes("await this.options.repository.revoke(context, ruleId)") ||
    !application.includes('kind: "trust-administration-rule-revoked"') ||
    !application.includes("createTrustAdministrationProductApiContribution") ||
    !application.includes("TRUST_ADMINISTRATION_PRODUCT_API_EXACT_SET") ||
    /PermissionRule|PermissionContextId|PermissionStore|SecurityPipeline/u.test(application)
  ) {
    failures.push(
      "Trust Administration does not uniquely own context, visibility, revoke, and committed fact semantics",
    );
  }

  if (
    !execution.includes("export class TrustAdministrationExecutionApplicationService") ||
    !execution.includes("recordApproval(") ||
    !execution.includes('kind: "rule-sedimented"') ||
    !execution.includes("SUGGESTION_THRESHOLDS") ||
    !execution.includes("highestRisk") ||
    !execution.includes("contributors") ||
    /PermissionStore|SecurityPipeline|IPermissionStore|PermissionRuleExecutionSource/u.test(execution)
  ) {
    failures.push(
      "Trust Administration does not uniquely own explicit rules, contributions, sedimentation, and execution projections",
    );
  }

  if (
    !mechanismAdapter.includes("createPermissionStoreTrustAdministrationRepository") ||
    !mechanismAdapter.includes("createExecutionRule(") ||
    !mechanismAdapter.includes("snapshotExecutionRules(") ||
    !mechanismAdapter.includes("toPermissionContext(") ||
    /parseConversationId|SUGGESTION_THRESHOLDS|recordApproval/u.test(mechanismAdapter)
  ) {
    failures.push(
      "PermissionStore is not confined to the one Trust Administration mechanism adapter",
    );
  }

  if (
    /ConfirmationTracker|permissionStore|getPermissionStore|getConfirmationTracker|getContextId|getWorkspace/u.test(
      securityPipeline,
    ) ||
    !securityPipeline.includes("PermissionRuleExecutionSource")
  ) {
    failures.push(
      "SecurityPipeline retains mutable Trust Administration state or writer access",
    );
  }

  if (
    !secureExecutor.includes("trustAdministration.recordApproval({") ||
    /PermissionStore|ConfirmationTracker|getPermissionStore|getConfirmationTracker|createExecutionRule/u.test(
      secureExecutor,
    )
  ) {
    failures.push(
      "secure-executor retains Trust rule creation or sedimentation ownership",
    );
  }

  if (
    !agentRuntime.includes("new TrustAdministrationExecutionApplicationService({") ||
    !agentRuntime.includes("assembleKernelPermissionStorage(") ||
    !agentRuntime.includes("bindKernelPermissionRuleSource(") ||
    !agentRuntime.includes("trustAdministration.securitySnapshot()") ||
    !agentRuntime.includes("trustAdministration.executionRules()") ||
    /new PermissionStore|createPermissionStoreTrustAdministrationRepository|\bIPermissionStore\b/u.test(
      agentRuntime,
    )
  ) {
    failures.push(
      "Agent runtime does not compose the one Trust application and readonly Security projection",
    );
  }

  for (const [relative, text, binding] of [
    [
      "packages/orchestrator/src/tools/task.ts",
      taskTool,
      "trustAdministration: env.trustAdministration,",
    ],
    [
      "packages/orchestrator/src/subagent/factory.ts",
      childFactory,
      "trustAdministration: opts.trustAdministration,",
    ],
    [
      "packages/orchestrator/src/subagent/loop-runner.ts",
      childLoop,
      "trustAdministration: opts.trustAdministration,",
    ],
    [
      "packages/orchestrator/src/orchestration/agent-node-executor.ts",
      agentNode,
      "trustAdministration: this.options.trustAdministration,",
    ],
  ]) {
    if (
      !text.includes("TrustAdministrationExecutionApplication") ||
      !text.includes(binding)
    ) {
      failures.push(`${relative}: child execution can bypass the one Trust application`);
    }
  }

  if (
    byPath.has("packages/core/src/security/confirmation-tracker.ts") ||
    byPath.has("packages/core/src/security/trust-rules.ts") ||
    records.some((record) => record.text.includes("A5-TRUST-STORE-01"))
  ) {
    failures.push("retired Trust tracker, helper, or temporary store bridge remains reachable");
  }

  if (
    !handler.includes('from "@zhixing/core/trust-administration"') ||
    !handler.includes(".query(\n        TRUST_ADMINISTRATION_LIST_QUERY") ||
    !handler.includes(".command(\n          TRUST_ADMINISTRATION_REVOKE_COMMAND") ||
    handler.includes("TrustDirectory") ||
    handler.includes("ctx.server.trust") ||
    handler.includes("../../runtime/management-directories")
  ) {
    failures.push("Trust RPC binding bypasses the Product API dispatcher");
  }

  if (
    /trust\?:|TrustDirectory|management-directories/u.test(context) ||
    /TrustDirectory|management-directories/u.test(serverIndex) ||
    byPath.has("packages/server/src/runtime/management-directories.ts") ||
    byPath.has("packages/cli/src/serve/management-directories.ts")
  ) {
    failures.push("Server or CLI retains the retired TrustDirectory application path");
  }

  if (
    !adapter.includes('from "@zhixing/core/trust-administration"') ||
    !adapter.includes("repository: deps.repository") ||
    !adapter.includes("deps.workspaceIdentity(workspace.path)") ||
    !adapter.includes("resolveWorkspace(deps.config") ||
    /PermissionStore|createPermissionStoreTrustAdministrationRepository|new\s+\w*Store/u.test(
      adapter,
    ) ||
    adapter.includes("parseConversationId") ||
    adapter.includes('.filter((rule) => rule.scope !== "builtin")')
  ) {
    failures.push(
      "Trust PermissionStore bridge owns product context or visibility semantics",
    );
  }

  const concreteConstructors = records.filter((record) =>
    /new PermissionStore\s*\(/u.test(record.text),
  );
  if (
    concreteConstructors.length !== 1 ||
    concreteConstructors[0]?.relative !==
      "packages/cli/src/serve/permission-storage-infrastructure.ts" ||
    (permissionInfrastructure.match(/new PermissionStore\s*\(/gu) ?? []).length !==
      1 ||
    !permissionInfrastructure.includes('path.join(input.zhixingHome, "permissions")') ||
    !permissionInfrastructure.includes(
      "createPermissionStoreTrustAdministrationRepository(",
    ) ||
    !permissionInfrastructure.includes("store.registerBuiltinRules(") ||
    !permissionInfrastructure.includes("bindPermissionRuleExecutionSource(") ||
    !permissionInfrastructure.includes("toPermissionContext(context)") ||
    /resolveWorkspace|parseConversationId|SUGGESTION_THRESHOLDS|recordApproval/u.test(
      permissionInfrastructure,
    )
  ) {
    failures.push(
      "Permission file mechanism is not confined to the one Host infrastructure adapter",
    );
  }

  if (
    !permissionContract.includes("export interface KernelPermissionStorageFactory") ||
    !permissionContract.includes("export interface KernelPermissionStorageBinding") ||
    !permissionContract.includes("TrustAdministrationExecutionRepository") ||
    !permissionContract.includes("PermissionRuleExecutionSource") ||
    /PermissionStore|rootDir|node:path|node:fs/u.test(permissionContract)
  ) {
    failures.push(
      "Kernel permission storage contract exposes a concrete store or physical path",
    );
  }

  if (
    (composition.match(/createPermissionStorageInfrastructure\s*\(/gu) ?? [])
      .length !== 1 ||
    !composition.includes("repository: permissionStorage.management") ||
    !composition.includes("permissionStorage: permissionStorage.runtime") ||
    !runtimeHost.includes("permissionStorage: this.opts.permissionStorage") ||
    (executorRole.match(/createPermissionStorageInfrastructure\s*\(/gu) ?? [])
      .length !== 1 ||
    !executorRole.includes("permissionStorage: permissionStorage.runtime") ||
    !executorRole.includes("permissionStorage: this.options.permissionStorage") ||
    (workspaceCommand.match(/createPermissionStorageInfrastructure\s*\(/gu) ?? [])
      .length !== 1 ||
    !workspaceCommand.includes(
      "createPermissionStorageInfrastructure({ zhixingHome }).runtime",
    )
  ) {
    failures.push(
      "Anchor, Executor or workspace fallback bypasses the one Host permission storage adapter",
    );
  }

  if (
    composition.split("new ProductApiDispatcher(").length - 1 !== 1 ||
    composition.split("createTrustAdministrationApplication({").length - 1 !== 1 ||
    composition.split("createTrustAdministrationProductApiContribution(").length - 1 !== 1 ||
    !composition.includes("...TRUST_ADMINISTRATION_PRODUCT_API_EXACT_SET.operations") ||
    !composition.includes("...TRUST_ADMINISTRATION_PRODUCT_API_EXACT_SET.factEvents") ||
    /\btrust:\s*trust/u.test(composition)
  ) {
    failures.push(
      "Anchor Host does not compose Trust Administration into the one sealed Product API dispatcher",
    );
  }

  for (const [relative, text] of [
    ["packages/cli/src/runtime/rpc-management-facade.ts", managementFacade],
    ["packages/cli/src/security/commands.ts", trustCommand],
    ["packages/cli/src/security/trust-rule-arg-provider.ts", trustArgumentProvider],
  ]) {
    if (
      !text.includes('from "@zhixing/core/trust-administration"') ||
      /\bPermissionRule\b/u.test(text) && relative !== "packages/cli/src/security/commands.ts"
    ) {
      failures.push(`${relative}: Trust Surface bypasses its domain projection`);
    }
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    failures.push("Core manifest is invalid while checking Trust Administration");
  }
  const narrow = manifest?.exports?.["./trust-administration"];
  const duplicate = Object.entries(manifest?.exports ?? {}).filter(
    ([subpath, conditions]) =>
      subpath !== "./trust-administration" &&
      conditions &&
      typeof conditions === "object" &&
      (conditions.types === narrow?.types || conditions.import === narrow?.import),
  );
  if (
    narrow?.types !== "./dist/trust-administration/application.d.ts" ||
    narrow?.import !== "./dist/trust-administration/application.js" ||
    duplicate.length > 0 ||
    build.split('"src/trust-administration/application.ts"').length - 1 !== 1 ||
    /trust-administration|TrustAdministration/u.test(coreIndex) ||
    /TrustAdministration|trust\.list|PermissionRule/u.test(productApi)
  ) {
    failures.push(
      "Trust Administration must have one narrow non-root domain subpath and a domain-neutral Product API",
    );
  }

  return failures;
}

export const ADVANCEMENT_APPLICATION_OWNER_EXACT_SET = Object.freeze([
  Object.freeze({ family: "active-state", owner: "AdvancementReviewAttemptApplicationService" }),
  Object.freeze({ family: "detail", owner: "AdvancementApplicationService" }),
  Object.freeze({ family: "rubric-lifecycle/publication", owner: "AdvancementApplicationService" }),
  Object.freeze({ family: "original-task-admission", owner: "AdvancementApplicationService" }),
  Object.freeze({ family: "active-user-turn", owner: "AdvancementApplicationService" }),
  Object.freeze({ family: "conversation-retirement", owner: "AdvancementConversationLifecycleApplicationService" }),
  Object.freeze({ family: "accepted-turn", owner: "AdvancementAcceptedTurnApplicationService" }),
  Object.freeze({ family: "review-attempt/outcome", owner: "AdvancementReviewAttemptApplicationService" }),
  Object.freeze({ family: "review-result-projection", owner: "AdvancementReviewResultProjectionApplicationService" }),
  Object.freeze({ family: "recovery", owner: "AdvancementRecoveryMaintenance" }),
  Object.freeze({ family: "proxy-scheduling", owner: "AdvancementProxyScheduler" }),
  Object.freeze({ family: "evidence", owner: "AdvancementEvidenceCoordinator" }),
  Object.freeze({ family: "persistence-correctness", owner: "AdvancementSessionStore" }),
]);

/** A5 Advancement has one finite set of domain application and mechanism owners. */
export function inspectAdvancementDetailApplicationOwnership(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const required = (relative) => {
    const text = byPath.get(relative);
    if (text === undefined) {
      failures.push(`${relative}: Advancement detail production source is missing`);
    }
    return text ?? "";
  };

  const application = required("packages/core/src/advancement/application.ts");
  const advancementIndex = required("packages/core/src/advancement/index.ts");
  const coreIndex = required("packages/core/src/index.ts");
  const manifestText = required("packages/core/package.json");
  const build = required("packages/core/tsup.config.ts");
  const controller = required(
    "packages/owner-services/src/advancement/controller.ts",
  );
  const sessionStore = required(
    "packages/owner-services/src/advancement/session-store.ts",
  );
  const conversationApplication = required(
    "packages/core/src/conversation/application.ts",
  );
  const handler = required("packages/server/src/rpc/methods/session.ts");
  const serverContext = required("packages/server/src/context.ts");
  const systemHandlers = required("packages/server/src/system-handlers.ts");
  const composition = required("packages/cli/src/serve/command.ts");
  const accessSurfaces = required(
    "packages/cli/src/serve/access-surfaces.ts",
  );
  const deleteBinding = required(
    "packages/cli/src/serve/conversation-delete-binding.ts",
  );
  const originalTaskAdapter = required(
    "packages/cli/src/serve/advancement-original-task-application.ts",
  );
  const reviewExternalMechanism = required(
    "packages/owner-services/src/advancement/review-external-mechanism.ts",
  );
  const proxyScheduler = required(
    "packages/owner-services/src/advancement/proxy-scheduler.ts",
  );
  const reviewAttemptCorrectness = required(
    "packages/owner-services/src/advancement/review-attempt-correctness.ts",
  );
  const recovery = required(
    "packages/owner-services/src/advancement/recovery-maintenance.ts",
  );
  const ownerIndex = required(
    "packages/owner-services/src/advancement/index.ts",
  );
  const ownerManifestText = required("packages/owner-services/package.json");
  const ownerBuild = required("packages/owner-services/tsup.config.ts");
  const localOwner = required(
    "packages/cli/src/serve/local-conversation-owner.ts",
  );
  const advancementAdapters = required(
    "packages/server/src/advancement/adapters.ts",
  );
  const conversationManager = required(
    "packages/owner-kernel/src/conversation-manager.ts",
  );
  const conversationProtocol = required(
    "packages/cli/src/serve/conversation-protocol-runtime.ts",
  );
  const advancementComposition = required(
    "packages/cli/src/serve/advancement-controller.ts",
  );

  const detailStart = handler.indexOf(
    "export function buildSessionAdvancementDetailMethod()",
  );
  const detailEnd = handler.indexOf("// ─── session.history", detailStart);
  const detail = detailStart >= 0 && detailEnd > detailStart
    ? handler.slice(detailStart, detailEnd)
    : "";
  const reviseStart = handler.indexOf(
    "export function buildSessionAdvancementReviseMethod()",
  );
  const confirmStart = handler.indexOf(
    "export function buildSessionAdvancementConfirmMethod()",
  );
  const confirm = confirmStart >= 0 && reviseStart > confirmStart
    ? handler.slice(confirmStart, reviseStart)
    : "";
  const reviseEnd = handler.indexOf(
    "export function buildSessionAdvancementCancelMethod()",
    reviseStart,
  );
  const revise = reviseStart >= 0 && reviseEnd > reviseStart
    ? handler.slice(reviseStart, reviseEnd)
    : "";
  const cancelStart = reviseEnd;
  const cancelEnd = handler.indexOf(
    "function createAdvancementOriginalTaskSurface",
    cancelStart,
  );
  const cancel = cancelStart >= 0 && cancelEnd > cancelStart
    ? handler.slice(cancelStart, cancelEnd)
    : "";
  const cancellationFact = application.lastIndexOf(
    "await command.fact.publish(decision.fact)",
  );
  const originalTaskHandoff = application.lastIndexOf(
    "await this.#originalTask.execute",
  );
  const confirmationFact = application.indexOf(
    "await command.fact.publish(decision.fact)",
  );
  const confirmedAdmission = application.indexOf(
    "await this.#confirmedOriginalTask.admit",
  );
  const awaitingControlStart = application.indexOf(
    "async controlAwaitingRubric(",
  );
  const awaitingControlEnd = application.indexOf(
    "async cancelRubric(",
    awaitingControlStart,
  );
  const awaitingControl =
    awaitingControlStart >= 0 && awaitingControlEnd > awaitingControlStart
      ? application.slice(awaitingControlStart, awaitingControlEnd)
      : "";
  const newTaskStart = application.indexOf("async prepareNewTask(");
  const newTaskEnd = application.indexOf(
    "async reviseRubricDraft(",
    newTaskStart,
  );
  const newTask =
    newTaskStart >= 0 && newTaskEnd > newTaskStart
      ? application.slice(newTaskStart, newTaskEnd)
      : "";
  const activeUserTurnStart = application.indexOf(
    "async prepareActiveUserTurn(",
  );
  const activeUserTurnEnd = application.indexOf(
    "async prepareNewTask(",
    activeUserTurnStart,
  );
  const activeUserTurn =
    activeUserTurnStart >= 0 && activeUserTurnEnd > activeUserTurnStart
      ? application.slice(activeUserTurnStart, activeUserTurnEnd)
      : "";
  const sendStart = handler.indexOf("export function buildSessionSendMethod()");
  const sendEnd = handler.indexOf(
    "export function buildSessionAdvancementConfirmMethod()",
    sendStart,
  );
  const send = sendStart >= 0 && sendEnd > sendStart
    ? handler.slice(sendStart, sendEnd)
    : "";
  const deleteProjectionStart = conversationApplication.indexOf(
    "export async function projectConversationDelete(",
  );
  const deleteProjectionEnd = conversationApplication.indexOf(
    "function conversationDeletedFact(",
    deleteProjectionStart,
  );
  const deleteProjection =
    deleteProjectionStart >= 0 && deleteProjectionEnd > deleteProjectionStart
      ? conversationApplication.slice(deleteProjectionStart, deleteProjectionEnd)
      : "";
  const deleteRuntimeIndex = deleteProjection.indexOf("deleteRuntimeAndStorage({");
  const cancelDependentIndex = deleteProjection.indexOf(
    "input.projection.cancelDependentLifecycle!(input.conversationId)",
  );
  const removeDependentIndex = deleteProjection.indexOf(
    "input.projection.removeDependentData!(input.conversationId)",
  );
  const commitStart = deleteBinding.indexOf(
    "export function createAnchorConversationDeleteCommitPort(",
  );
  const deleteCommit = commitStart >= 0 ? deleteBinding.slice(commitStart) : "";
  const lifecycleApplicationStart = application.indexOf(
    "export class AdvancementConversationLifecycleApplicationService",
  );
  const lifecycleApplicationEnd = application.indexOf(
    "/** Path-free mechanisms used by the no-open-session new-task decision. */",
    lifecycleApplicationStart,
  );
  const lifecycleApplication =
    lifecycleApplicationStart >= 0 &&
    lifecycleApplicationEnd > lifecycleApplicationStart
      ? application.slice(lifecycleApplicationStart, lifecycleApplicationEnd)
      : "";
  const detailApplicationStart = application.indexOf(
    "export class AdvancementApplicationService",
  );
  const detailApplication =
    detailApplicationStart >= 0 ? application.slice(detailApplicationStart) : "";

  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    failures.push("Core manifest is invalid while checking Advancement detail");
  }
  const narrow = manifest?.exports?.["./advancement/application"];
  const duplicate = Object.entries(manifest?.exports ?? {}).filter(
    ([subpath, conditions]) =>
      subpath !== "./advancement/application" &&
      conditions &&
      typeof conditions === "object" &&
      (conditions.types === narrow?.types || conditions.import === narrow?.import),
  );
  let ownerManifest;
  try {
    ownerManifest = JSON.parse(ownerManifestText);
  } catch {
    failures.push("Owner-services manifest is invalid while checking Advancement review");
  }
  const acceptedTurnApplication = application.slice(
    application.indexOf("export class AdvancementAcceptedTurnApplicationService"),
    application.indexOf("/** Path-free read mechanism", 1),
  );
  const reviewMechanismStart = application.indexOf(
    "export interface AdvancementReviewAttemptMechanismPort",
  );
  const reviewMechanismEnd = application.indexOf(
    "export interface AdvancementClosureSynthesizer",
    reviewMechanismStart,
  );
  const reviewMechanism =
    reviewMechanismStart >= 0 && reviewMechanismEnd > reviewMechanismStart
      ? application.slice(reviewMechanismStart, reviewMechanismEnd)
      : "";
  const reviewMechanismMethods = [
    ...reviewMechanism.matchAll(/^  ([A-Za-z][A-Za-z0-9]*)\(/gmu),
  ].map((match) => match[1]);

  if (
    !application.includes("interface AdvancementDetailReadPort") ||
    !application.includes("class AdvancementApplicationService") ||
    !application.includes("ADVANCEMENT_DETAIL_QUERY") ||
    !application.includes('"advancement.query.detail"') ||
    !application.includes("interface AdvancementConversationMaintenancePort") ||
    !application.includes("interface AdvancementConversationLifecycleMechanismPort") ||
    !application.includes("interface AdvancementAcceptedTurnCatchUpPort") ||
    application.includes("interface AdvancementAcceptedTurnReviewMechanismPort") ||
    !application.includes("interface AdvancementReviewAttemptStatePort") ||
    !application.includes("interface AdvancementReviewRootLifecyclePort") ||
    !application.includes("interface AdvancementReviewAttemptMechanismPort") ||
    !application.includes("type AdvancementReviewRootBinding = string &") ||
    application.includes("AdvancementReviewRootTarget") ||
    JSON.stringify(reviewMechanismMethods) !==
      JSON.stringify([
        "resolveRootBinding",
        "materializeReviewRoot",
        "reviewRootMatchesBinding",
        "prepareEvidence",
        "invokeReviewer",
      ]) ||
    !application.includes("class AdvancementReviewAttemptApplicationService") ||
    application.split("class AdvancementReviewAttemptApplicationService").length - 1 !== 1 ||
    !application.includes("readonly #flights = new Map<string, Promise<AdvancementTurnReviewResult>>();") ||
    !application.includes("readonly #mechanism: AdvancementReviewAttemptMechanismPort;") ||
    !application.includes("this.#mechanism = options.mechanism;") ||
    !application.includes("this.#mechanism.resolveRootBinding(") ||
    !application.includes("this.#mechanism.materializeReviewRoot({") ||
    !application.includes("this.#mechanism.reviewRootMatchesBinding({") ||
    !application.includes("this.#mechanism.prepareEvidence({") ||
    !application.includes("this.#mechanism.invokeReviewer({") ||
    /reviewAcceptedRun\([\s\S]{0,180}mechanism:/u.test(application) ||
    !application.includes("const legacyGeneration =") ||
    !application.includes('attempt.phase === "invoking"') ||
    application.includes("reviewRootTargetMatches") ||
    application.includes("target.executorId") ||
    application.includes("target.ownerEpoch") ||
    !application.includes("const afterAcquire = await this.#state.loadSession(") ||
    !application.includes("async #cleanupTerminalRoot(") ||
    !application.includes("async reconcileConversation(") ||
    !application.includes("async #prepareEligibility(") ||
    !application.includes("async #settleAcceptedProxyRun(") ||
    !application.includes("async #persistReviewOutcome(") ||
    !application.includes("async rebuildMissingProxyMessage(") ||
    !application.includes("commitReviewOutcome(") ||
    !application.includes("settleProxyMessage(") ||
    !application.includes("buildAdvancementProxyMessage(") ||
    !application.includes("selectFailureHandling(") ||
    !application.includes("interface AdvancementReviewResultProjectionApplication") ||
    !application.includes("class AdvancementReviewResultProjectionApplicationService") ||
    !application.includes("class AdvancementAcceptedTurnApplicationService") ||
    application.split("class AdvancementAcceptedTurnApplicationService").length - 1 !== 1 ||
    !acceptedTurnApplication.includes("readonly #chains = new Map<string, Promise<void>>()") ||
    !acceptedTurnApplication.includes("catchUpAcceptedTurn(") ||
    !acceptedTurnApplication.includes("if (!catchUpProvedContinuous(catchUp.status)) return") ||
    !acceptedTurnApplication.includes("reviewAcceptedRun({") ||
    !acceptedTurnApplication.includes("projectReviewResult({") ||
    !application.includes('status === "closed-run-recovered"') ||
    !reviewExternalMechanism.includes("createAdvancementReviewExternalMechanism(") ||
    !reviewExternalMechanism.includes("new WeakMap<") ||
    !reviewExternalMechanism.includes("encodeReviewRootBinding(input.conversationId, carried)") ||
    !reviewExternalMechanism.includes("encodeReviewRootBinding(input.conversationId, target)") ||
    !reviewExternalMechanism.includes("materializeReviewRoot({ root, binding })") ||
    !reviewExternalMechanism.includes("reviewRootMatchesBinding({ root, binding })") ||
    reviewExternalMechanism.split("decodeReviewRootBinding(binding)").length - 1 !== 2 ||
    !reviewExternalMechanism.includes('isExactRecord(audience, ["executorId"])') ||
    !reviewExternalMechanism.includes(
      'isExactRecord(scope, ["conversationId", "kind", "ownerEpoch"])',
    ) ||
    !reviewExternalMechanism.includes("options.evidence.resolveTarget(") ||
    !reviewExternalMechanism.includes("options.evidence.collect({") ||
    !reviewExternalMechanism.includes("options.reviewer.review(") ||
    /AdvancementSessionStore|transitionReviewAttempt|commitReviewOutcome|prepareEligibility|persistReviewOutcome|buildAdvancementProxyMessage/u.test(
      reviewExternalMechanism,
    ) ||
    !proxyScheduler.includes("createAdvancementReviewProxySchedulePort(") ||
    !proxyScheduler.includes("proxyTurns: AdvancementProxyTurnPort") ||
    proxyScheduler.includes("proxyTurns: () =>") ||
    /ConversationManager|SessionBroadcast|@zhixing\/(?:server|rpc)|\.current/u.test(
      proxyScheduler,
    ) ||
    !reviewAttemptCorrectness.includes("createAdvancementReviewAttemptApplication(") ||
    !reviewAttemptCorrectness.includes("new AdvancementReviewAttemptApplicationService({") ||
    !reviewAttemptCorrectness.includes("mechanism: options.mechanism,") ||
    !reviewAttemptCorrectness.includes("options.store.transitionReviewAttempt(") ||
    !reviewAttemptCorrectness.includes("options.store.settleProxyMessage(") ||
    !reviewAttemptCorrectness.includes("options.store.enqueueProxyMessage(") ||
    !reviewAttemptCorrectness.includes("options.store.appendTerminalRunReview(") ||
    !reviewAttemptCorrectness.includes("options.store.appendRunReviewWithProxyMessage(") ||
    !reviewAttemptCorrectness.includes("options.resources.inspectImmediateRoot(") ||
    !reviewAttemptCorrectness.includes("options.resources.acquireRoot(") ||
    /generation\s*=|phase\s*===|terminalReviewAttempt|reviewRootMatchesBinding/u.test(
      reviewAttemptCorrectness,
    ) ||
    /afterTurnCommitted|reviewAttemptMechanism|reviewAttempts|AdvancementEvidenceCoordinator|AdvancementReviewerPort|readonly reviewer\?|readonly evidence\?/u.test(
      controller,
    ) ||
    /prepareEligibility|commitMissingDurableRun|commitConsumed|settleAcceptedProxyRun|systemExitReview|persistReviewOutcome|persistProxyOutcome|buildAdvancementProxyMessage|selectFailureHandling/u.test(
      controller,
    ) ||
    /store\.(?:appendTerminalRunReview|appendRunReviewWithProxyMessage)/u.test(
      controller,
    ) ||
    /advancementReview(?:LineageId|AttemptId|RootRequestId)|inspectImmediateRoot|acquireRoot\(|transitionReviewAttempt\(|cleanupReviewAttemptRoot|reviewFlights/u.test(
      controller,
    ) ||
    !advancementComposition.includes(
      'from "@zhixing/owner-services/advancement/review-attempt-correctness"',
    ) ||
    !advancementComposition.includes("createAdvancementReviewAttemptApplication({") ||
    advancementComposition.split("createAdvancementReviewAttemptApplication(").length - 1 !== 1 ||
    !advancementComposition.includes("createAdvancementReviewExternalMechanism({") ||
    !advancementComposition.includes("return Object.freeze({ controller, reviews });") ||
    !recovery.includes("readonly reviews: AdvancementReviewAttemptApplication;") ||
    !recovery.includes("this.options.reviews.reconcileConversation(conversationId)") ||
    !recovery.includes("this.options.reviews.reviewAcceptedRun({") ||
    !recovery.includes("this.options.reviews.rebuildMissingProxyMessage(session)") ||
    !composition.includes("reviews: advancementReviews,") ||
    !composition.includes("advancementReviews,") ||
    !recovery.includes("this.options.reviewResults.projectReviewResult({") ||
    recovery.includes("dispatchAdvancementReviewResult") ||
    !accessSurfaces.includes("new AdvancementAcceptedTurnApplicationService({") ||
    !accessSurfaces.includes("reviews: ctx.advancementReviews,") ||
    !accessSurfaces.includes("review: ctx.advancementReviews,") ||
    !accessSurfaces.includes("advancementAcceptedTurns?.acceptCommittedTurn(info)") ||
    !accessSurfaces.includes("manager.bindTurnCommittedListener((info) =>") ||
    !accessSurfaces.includes("manager.assertTurnCommittedListenerBound()") ||
    !accessSurfaces.includes("protocol.bindManager(manager)") ||
    !accessSurfaces.includes("protocol.assertManagerBound()") ||
    accessSurfaces.includes("manager: () => manager") ||
    !accessSurfaces.includes("protocol.bindAuxiliaryRecovery(async (conversationId) =>") ||
    /createAdvancementProxyTurnPort\(\{[\s\S]*?manager:\s*\(\)\s*=>\s*manager/u.test(
      accessSurfaces,
    ) ||
    /createAdvancementOriginalTaskAdmissionPort\(\s*\(\)\s*=>\s*manager/u.test(
      accessSurfaces,
    ) ||
    accessSurfaces.indexOf("manager.bindTurnCommittedListener((info) =>") >
      accessSurfaces.indexOf("ctx.conversations = manager") ||
    accessSurfaces.includes("createAdvancementReviewMaintenance") ||
    accessSurfaces.includes("advancementRecoveryRef") ||
    !localOwner.includes("new AdvancementAcceptedTurnApplicationService({") ||
    !localOwner.includes("const { controller: advancement, reviews }") ||
    !localOwner.includes("review: reviews,") ||
    !localOwner.includes("acceptedTurns.acceptCommittedTurn(info)") ||
    !localOwner.includes("manager.bindTurnCommittedListener((info) =>") ||
    !localOwner.includes("manager.assertTurnCommittedListenerBound()") ||
    !localOwner.includes("protocol.bindManager(manager)") ||
    !localOwner.includes("protocol.assertManagerBound()") ||
    localOwner.includes("manager: () => manager") ||
    !localOwner.includes("protocol.bindAuxiliaryRecovery(async (conversationId) =>") ||
    /createAdvancementProxyTurnPort\(\{[\s\S]*?manager:\s*\(\)\s*=>\s*manager/u.test(
      localOwner,
    ) ||
    /createAdvancementOriginalTaskAdmissionPort\(\s*\(\)\s*=>\s*manager/u.test(
      localOwner,
    ) ||
    localOwner.indexOf("manager.bindTurnCommittedListener((info) =>") >
      localOwner.indexOf("return new LocalConversationOwnerAssembly({") ||
    localOwner.includes("reviewCommitted") ||
    localOwner.includes("createAdvancementReviewMaintenance") ||
    !advancementAdapters.includes("readonly manager: ConversationManager;") ||
    advancementAdapters.includes("ConversationManager | (() => ConversationManager)") ||
    advancementAdapters.includes("resolveManager(") ||
    !conversationManager.includes("bindTurnCommittedListener(") ||
    !conversationManager.includes("assertTurnCommittedListenerBound()") ||
    !conversationManager.includes("turn-committed listener is already bound") ||
    !conversationManager.includes("turn-committed listener is not bound") ||
    !conversationProtocol.includes("bindAuxiliaryRecovery(") ||
    !conversationProtocol.includes("bindManager(manager: ConversationManager)") ||
    !conversationProtocol.includes("assertManagerBound()") ||
    conversationProtocol.includes("#recoverAuxiliaryRef") ||
    ownerIndex.includes("dispatchAdvancementReviewResult") ||
    ownerIndex.includes("createAdvancementAcceptedTurnReviewMechanism") ||
    ownerIndex.includes("createAdvancementReviewAttemptApplication") ||
    accessSurfaces.includes("review-application-bridge") ||
    localOwner.includes("review-application-bridge") ||
    ownerBuild.includes("review-dispatch.ts") ||
    ownerManifest?.exports?.["./advancement/review-dispatch"] !== undefined ||
    ownerManifest?.exports?.["./advancement/review-application-bridge"] !== undefined ||
    ownerManifest?.exports?.["./advancement/review-external-mechanism"] === undefined ||
    ownerManifest?.exports?.["./advancement/review-attempt-correctness"] === undefined ||
    ownerManifest?.exports?.["./advancement/proxy-content"] !== undefined ||
    !ownerBuild.includes("src/advancement/review-attempt-correctness.ts") ||
    !ownerBuild.includes("src/advancement/review-external-mechanism.ts") ||
    ownerBuild.includes("src/advancement/review-application-bridge.ts") ||
    ownerBuild.includes("src/advancement/proxy-content.ts") ||
    ownerIndex.includes("buildAdvancementProxyMessage") ||
    byPath.has("packages/owner-services/src/advancement/proxy-content.ts") ||
    byPath.has("packages/cli/src/serve/advancement-review-maintenance.ts") ||
    byPath.has("packages/owner-services/src/advancement/review-dispatch.ts") ||
    byPath.has("packages/owner-services/src/advancement/review-application-bridge.ts") ||
    !application.includes("interface AdvancementConversationLifecycleApplication") ||
    !application.includes("interface AdvancementConversationAlivePort") ||
    lifecycleApplication.length === 0 ||
    application.split("class AdvancementConversationLifecycleApplicationService")
      .length -
      1 !==
      1 ||
    !lifecycleApplication.includes("async cancelConversationLifecycle(") ||
    !lifecycleApplication.includes("loadOpenConversationLifecycleSession(") ||
    !lifecycleApplication.includes("persistConversationLifecycleCancellation(") ||
    !lifecycleApplication.includes('reason: "user-cancelled"') ||
    !lifecycleApplication.includes('message: "原始对话已删除，推进会话已取消。"') ||
    !lifecycleApplication.includes("async removeConversationData(") ||
    !lifecycleApplication.includes("async sweepOrphanData(") ||
    !lifecycleApplication.includes("listConversationDataCandidates()") ||
    !lifecycleApplication.includes("isConversationDataAlive(candidateId)") ||
    !lifecycleApplication.includes("removeConversationDataCandidate(") ||
    detailApplication.includes("cancelConversationLifecycle(") ||
    detailApplication.includes("sweepOrphanData(") ||
    !application.includes("interface AdvancementNewTaskMechanismPort") ||
    !application.includes("interface AdvancementNewTaskConversationPort") ||
    !application.includes("interface AdvancementActiveUserTurnMechanismPort") ||
    !application.includes("interface AdvancementActiveUserTurnRuntimePort") ||
    !application.includes("interface AdvancementActiveUserTurnSurfacePort") ||
    !application.includes("ADVANCEMENT_PREPARE_ACTIVE_USER_TURN_COMMAND") ||
    !application.includes('"advancement.command.prepare-active-user-turn"') ||
    !application.includes("ADVANCEMENT_SESSION_EXITED_FACT_EVENT") ||
    !application.includes('"advancement-session-exited"') ||
    !application.includes("interface AdvancementRubricRevisionMechanismPort") ||
    !application.includes("ADVANCEMENT_PREPARE_NEW_TASK_COMMAND") ||
    !application.includes('"advancement.command.prepare-new-task"') ||
    !application.includes("ADVANCEMENT_CONTRACT_DRAFT_CREATED_FACT_EVENT") ||
    !application.includes('"advancement-contract-draft-created"') ||
    application.split("ADVANCEMENT_PREPARE_NEW_TASK_COMMAND").length - 1 !== 3 ||
    application.split("ADVANCEMENT_CONTRACT_DRAFT_CREATED_FACT_EVENT").length - 1 !== 5 ||
    !application.includes("ADVANCEMENT_REVISE_RUBRIC_COMMAND") ||
    !application.includes('"advancement.command.revise-rubric"') ||
    !application.includes("ADVANCEMENT_CONTRACT_DRAFT_REVISED_FACT_EVENT") ||
    !application.includes('"advancement-contract-draft-revised"') ||
    !application.includes('session.status !== "awaiting-rubric-confirmation"') ||
    !application.includes("session.pendingRubricDraft") ||
    !application.includes("persistRubricDraftRevision") ||
    !application.includes("const committedDraft = updated.pendingRubricDraft") ||
    !application.includes("interface AdvancementRubricCancellationMechanismPort") ||
    !application.includes("interface AdvancementAwaitingRubricAdmissionMechanismPort") ||
    !application.includes("interface AdvancementRubricConfirmationMechanismPort") ||
    !application.includes("interface AdvancementConfirmedOriginalTaskAdmissionPort") ||
    !application.includes("interface AdvancementOriginalTaskExecutionPort") ||
    !application.includes("interface AdvancementOriginalTaskSurfacePort") ||
    !application.includes("ADVANCEMENT_CANCEL_RUBRIC_COMMAND") ||
    !application.includes('"advancement.command.cancel-rubric"') ||
    !application.includes("ADVANCEMENT_CONTROL_AWAITING_RUBRIC_COMMAND") ||
    !application.includes('"advancement.command.control-awaiting-rubric"') ||
    !application.includes('factEmission: "subset"') ||
    !application.includes("ADVANCEMENT_CONTRACT_CANCELLED_FACT_EVENT") ||
    !application.includes('"advancement-contract-cancelled"') ||
    !application.includes("ADVANCEMENT_CONFIRM_RUBRIC_COMMAND") ||
    !application.includes('"advancement.command.confirm-rubric"') ||
    !application.includes("ADVANCEMENT_CONTRACT_CONFIRMED_FACT_EVENT") ||
    !application.includes('"advancement-contract-confirmed"') ||
    application.split("ADVANCEMENT_CONFIRM_RUBRIC_COMMAND").length - 1 !== 3 ||
    application.split("ADVANCEMENT_CONTRACT_CONFIRMED_FACT_EVENT").length - 1 !== 4 ||
    application.split("ADVANCEMENT_CANCEL_RUBRIC_COMMAND").length - 1 !== 3 ||
    application.split("ADVANCEMENT_CONTRACT_CANCELLED_FACT_EVENT").length - 1 !== 5 ||
    application.split("ADVANCEMENT_CONTROL_AWAITING_RUBRIC_COMMAND").length - 1 !== 3 ||
    !application.includes("loadRubricCancellationSession(") ||
    !application.includes("session.conversationId !== command.conversationId") ||
    !application.includes("session.id !== command.advancementSessionId") ||
    !application.includes("persistRubricCancellation({") ||
    !application.includes('message: command.executeOriginal') ||
    !application.includes('committed.status !== "cancelled"') ||
    !application.includes("committed.conversationId !== command.conversationId") ||
    !application.includes("committed.id !== command.advancementSessionId") ||
    cancellationFact < 0 ||
    originalTaskHandoff < 0 ||
    cancellationFact > originalTaskHandoff ||
    confirmationFact < 0 ||
    confirmedAdmission < 0 ||
    confirmationFact > confirmedAdmission ||
    !application.includes("persistRubricConfirmation({") ||
    !application.includes("persistOriginalTaskAdmissionSettlement({") ||
    !application.includes('error.reason === "conversation-not-found"') ||
    !application.includes('error.reason === "idempotency-conflict"') ||
    !application.includes('reason: "original-task-admission-failed"') ||
    awaitingControl.length === 0 ||
    !awaitingControl.includes("decideAwaitingRubricAdmission({") ||
    !awaitingControl.includes('admission.action === "keep-awaiting-confirmation"') ||
    !awaitingControl.includes('admission.action === "downgrade-to-direct"') ||
    !awaitingControl.includes('admission.action !== "cancel-pending-task"') ||
    !awaitingControl.includes('message: executeOriginal') ||
    !awaitingControl.includes('reason: "user-cancelled"') ||
    awaitingControl.indexOf("await command.fact.publish(decision.fact)") < 0 ||
    awaitingControl.indexOf("await this.#originalTask.execute") < 0 ||
    awaitingControl.indexOf("await command.fact.publish(decision.fact)") >
      awaitingControl.indexOf("await this.#originalTask.execute") ||
    newTask.length === 0 ||
    !newTask.includes("loadOpenNewTaskSession(") ||
    !newTask.includes("if (open)") ||
    !newTask.includes('kind: "not-applicable"') ||
    !newTask.includes("decideNewTaskAdmission({") ||
    !newTask.includes('admission.action !== "start-advancement"') ||
    !newTask.includes('admission.action !== "run-direct"') ||
    !newTask.includes("buildNewTaskRubricDraft({") ||
    !newTask.includes('command.conversationScope === "new"') ||
    !newTask.includes("await this.#newTaskConversation.ensureShell(") ||
    !newTask.includes("persistNewTaskAwaitingSession({") ||
    !newTask.includes("assertCommittedNewTaskSession(") ||
    newTask.indexOf("await this.#newTaskConversation.ensureShell(") >
      newTask.indexOf("persistNewTaskAwaitingSession({") ||
    !newTask.includes('kind: "advancement-contract-draft-created"') ||
    !newTask.includes("this.#maintenance.runExisting(") ||
    !newTask.includes("this.#maintenance.runNew(") ||
    activeUserTurn.length === 0 ||
    !activeUserTurn.includes("loadActiveUserTurnSession(") ||
    !activeUserTurn.includes("this.#maintenance.runExisting(") ||
    !activeUserTurn.includes(
      "const interruption = await this.#activeUserTurnRuntime.interruptProxy({",
    ) ||
    !activeUserTurn.includes("decideActiveUserTurnAdmission({") ||
    !activeUserTurn.includes("persistActiveUserTurnExit({") ||
    !activeUserTurn.includes("persistRegeneratedRubricSession({") ||
    !activeUserTurn.includes("settleInterruptedProxy({") ||
    !activeUserTurn.includes("await command.surface.publishExit(") ||
    !activeUserTurn.includes("await command.surface.publishDraft(") ||
    !activeUserTurn.includes("await command.surface.publishContractFailure(") ||
    !activeUserTurn.includes("await command.surface.handoff({") ||
    !activeUserTurn.includes("recoverInterruptedProxy(") ||
    activeUserTurn.split("loadActiveUserTurnSession(").length - 1 !== 2 ||
    activeUserTurn.lastIndexOf("loadActiveUserTurnSession(") >
      activeUserTurn.indexOf(
        "const interruption = await this.#activeUserTurnRuntime.interruptProxy({",
      ) ||
    activeUserTurn.indexOf("persistActiveUserTurnExit({") >
      activeUserTurn.indexOf("persistRegeneratedRubricSession({") ||
    activeUserTurn.indexOf("await command.surface.publishExit(") >
      activeUserTurn.indexOf("await command.surface.handoff({") ||
    activeUserTurn.indexOf("await command.surface.publishContractFailure(") >
      activeUserTurn.indexOf("recoverInterruptedProxy(") ||
    application.includes("freezeSnapshot(revisedDraft)") ||
    !application.includes("ADVANCEMENT_PRODUCT_API_EXACT_SET") ||
    !application.includes("createAdvancementProductApiContribution") ||
    !application.includes("buildClosureFacts(session)") ||
    application.split("defineProductApiQuery<").length - 1 !== 2 ||
    application.split("defineProductApiCommand<").length - 1 !== 6 ||
    application.split("defineProductApiFactEvent<").length - 1 !== 5 ||
    /@zhixing\/(?:server|rpc|owner-services)|\.\.\/\.\.\/server|\.\.\/\.\.\/owner-services/u.test(
      application,
    ) ||
    narrow?.types !== "./dist/advancement/application.d.ts" ||
    narrow?.import !== "./dist/advancement/application.js" ||
    duplicate.length > 0 ||
    build.split('"src/advancement/application.ts"').length - 1 !== 1 ||
    advancementIndex.includes("./application.js") ||
    coreIndex.includes("advancement/application") ||
    detail.length === 0 ||
    !handler.includes('from "@zhixing/core/advancement/application"') ||
    !detail.includes("productApi?.supports(ADVANCEMENT_DETAIL_QUERY)") ||
    !detail.includes("productApi.query(ADVANCEMENT_DETAIL_QUERY") ||
    !detail.includes("projectAdvancementDetail(detail)") ||
    /buildClosureFacts|ctx\.server\.advancement|loadLatestSession/u.test(detail) ||
    revise.length === 0 ||
    !revise.includes("requireAdvancementProductApi(") ||
    !revise.includes("productApi.command(") ||
    !revise.includes("ADVANCEMENT_REVISE_RUBRIC_COMMAND") ||
    !revise.includes("fact.rubricDraftVersion") ||
    !revise.includes('event: "advancement:contract_draft"') ||
    /requireAdvancement\(|requireConversations\(|runAdvancementMaintenance\(|\.reviseRubricDraft\(/u.test(
      revise,
    ) ||
    confirm.length === 0 ||
    !confirm.includes("requireAdvancementProductApi(") ||
    !confirm.includes("ADVANCEMENT_CONFIRM_RUBRIC_COMMAND") ||
    !confirm.includes("productApi.command(") ||
    !confirm.includes("publishAdvancementRubricConfirmationFact(") ||
    !confirm.includes("surface: createAdvancementOriginalTaskSurface({") ||
    !confirm.includes("mapAdvancementRubricConfirmationError(") ||
    /requireAdvancement\(|runAdvancementMaintenance\(|\.confirmRubric\(|admitAndMaybeStartTurn\(|prepareConversationAgentTurnIdentity\(|settleOriginalTaskAdmission\(/u.test(
      confirm,
    ) ||
    cancel.length === 0 ||
    !cancel.includes("requireAdvancementProductApi(") ||
    !cancel.includes("ADVANCEMENT_CANCEL_RUBRIC_COMMAND") ||
    !cancel.includes("productApi.command(") ||
    !cancel.includes("publishAdvancementCancellationFact(") ||
    !cancel.includes("surface: createAdvancementOriginalTaskSurface({") ||
    send.length === 0 ||
    !send.includes("ADVANCEMENT_CONTROL_AWAITING_RUBRIC_COMMAND") ||
    send.split("ADVANCEMENT_CONTROL_AWAITING_RUBRIC_COMMAND").length - 1 !== 2 ||
    !send.includes("productApi.command(") ||
    !send.includes('controlled.result.kind === "keep-awaiting"') ||
    !send.includes('controlled.result.kind === "direct-original-task"') ||
    !send.includes('controlled.result.kind === "cancelled"') ||
    !send.includes("publishAdvancementCancellationFact(") ||
    !send.includes("ADVANCEMENT_PREPARE_NEW_TASK_COMMAND") ||
    send.split("ADVANCEMENT_PREPARE_NEW_TASK_COMMAND").length - 1 !== 2 ||
    !send.includes(
      "return await productApi.command(\n                ADVANCEMENT_PREPARE_NEW_TASK_COMMAND,",
    ) ||
    !send.includes('conversationScope: id ? "existing" : "new"') ||
    !send.includes('prepared.kind === "owner-busy"') ||
    !send.includes('prepared.kind === "awaiting-rubric-confirmation"') ||
    !send.includes('prepared.kind === "contract-failed"') ||
    !send.includes("newTaskNotApplicable") ||
    !send.includes("const dispatchActiveAdvancementUserTurn = async () =>") ||
    !send.includes("ADVANCEMENT_PREPARE_ACTIVE_USER_TURN_COMMAND") ||
    send.split("ADVANCEMENT_PREPARE_ACTIVE_USER_TURN_COMMAND").length - 1 !== 3 ||
    !send.includes("productApi?.supports(\n        ADVANCEMENT_PREPARE_ACTIVE_USER_TURN_COMMAND,") ||
    send.split("dispatchActiveAdvancementUserTurn()").length - 1 !== 2 ||
    send.split("projectActiveAdvancementPreparation(").length - 1 !== 2 ||
    !send.includes(
      "if (newTaskNotApplicable) {\n            const racedActiveResponse = projectActiveAdvancementPreparation(\n              await dispatchActiveAdvancementUserTurn(),",
    ) ||
    send.includes("Advancement state changed before new-task dispatch") ||
    send.includes("prepareActiveAdvancementUserTurn") ||
    send.includes("interruptAdvancementProxy") ||
    send.includes("prepareAdvancementUserTurn(") ||
    send.includes("hasAwaitingAdvancementConfirmation") ||
    send.includes('prepared.kind === "await-existing-confirmation"') ||
    send.includes('prepared.kind === "cancelled-pending-task"') ||
    !handler.includes("function sessionAgentTurnAdmissionRpcError(") ||
    !handler.includes('error.reason === "turn-conversation-not-found"') ||
    !handler.includes('error.reason === "turn-queue-full"') ||
    !handler.includes('error.reason === "turn-lifecycle-busy"') ||
    !handler.includes("const mapped = sessionAgentTurnAdmissionRpcError(") ||
    !handler.includes("const admissionError = sessionAgentTurnAdmissionRpcError(") ||
    handler.split("const admissionError = sessionAgentTurnAdmissionRpcError(").length - 1 !== 2 ||
    /runAdvancementMaintenance\(|requireAdvancement\(|\.cancelRubric\(|admitAndMaybeStartTurn\(|prepareConversationAgentTurnIdentity\(|cancelled\.session|cancelled\.originalUserTask/u.test(
      cancel,
    ) ||
    !controller.includes("async loadLatestSession(") ||
    !controller.includes("return open ?? sessions[sessions.length - 1]!") ||
    controller.includes("async reviseRubricDraft(input:") ||
    !controller.includes("loadRubricRevisionSession(") ||
    !controller.includes("reviseRubricDraftContent(") ||
    !controller.includes("persistRubricDraftRevision(") ||
    controller.includes("async cancelRubric(input:") ||
    !controller.includes("loadRubricCancellationSession(") ||
    controller.includes("persistRubricCancellation(input:") ||
    !controller.includes("decideAwaitingRubricAdmission(") ||
    !controller.includes("loadOpenNewTaskSession(") ||
    !controller.includes("decideNewTaskAdmission(") ||
    !controller.includes("buildNewTaskRubricDraft(") ||
    !controller.includes("persistNewTaskAwaitingSession(") ||
    controller.includes('readonly kind: "run-direct"') ||
    controller.includes('readonly kind: "awaiting-rubric-confirmation"') ||
    controller.includes("this.contractBuilder.buildDraft({") ||
    controller.split("this.store.createSession({").length - 1 !== 2 ||
    !controller.includes("hasOpenAdvancementSession: true") ||
    controller.includes('readonly kind: "await-existing-confirmation"') ||
    controller.includes('readonly kind: "cancelled-pending-task"') ||
    controller.includes('readonly kind: "direct-original-task"') ||
    controller.includes('admission.action === "downgrade-to-direct"') ||
    controller.includes("async confirmRubric(input:") ||
    controller.includes("async settleOriginalTaskAdmission(input:") ||
    !controller.includes("loadRubricConfirmationSession(") ||
    !controller.includes("confirmRubricDraftContent(") ||
    !controller.includes("persistRubricConfirmation(input:") ||
    !controller.includes("persistOriginalTaskAdmissionSettlement(input:") ||
    !controller.includes("loadActiveUserTurnSession(") ||
    !controller.includes("decideActiveUserTurnAdmission(") ||
    !controller.includes("persistActiveUserTurnExit(") ||
    !controller.includes("persistRegeneratedRubricSession(") ||
    !controller.includes("settleInterruptedProxy(") ||
    controller.includes("async prepareUserTurn(") ||
    controller.includes("regenerateRubricContract(") ||
    controller.includes("cancelOpenConversationSession(") ||
    controller.includes("removeConversationData(") ||
    controller.includes("sweepOrphanData(") ||
    !controller.includes("loadOpenConversationLifecycleSession(") ||
    controller.includes("persistConversationLifecycleCancellation(") ||
    !controller.includes("removeConversationLifecycleData(") ||
    !controller.includes("listConversationLifecycleDataCandidates(") ||
    !controller.includes("removeConversationLifecycleDataCandidate(") ||
    sessionStore.includes("sweepOrphanDirs(") ||
    !sessionStore.includes("listConversationDataCandidates()") ||
    !sessionStore.includes("removeConversationDataCandidate(") ||
    deleteProjection.length === 0 ||
    deleteRuntimeIndex < 0 ||
    cancelDependentIndex < 0 ||
    removeDependentIndex < 0 ||
    deleteRuntimeIndex > cancelDependentIndex ||
    cancelDependentIndex > removeDependentIndex ||
    !deleteProjection.includes('"cancel-lifecycle"') ||
    !deleteProjection.includes('"remove-data"') ||
    deleteCommit.length === 0 ||
    deleteCommit.includes("cancelDependentLifecycle?.(conversationId)") ||
    !accessSurfaces.includes(
      "ctx.advancementConversationLifecycle.cancelConversationLifecycle(",
    ) ||
    !accessSurfaces.includes(
      "ctx.advancementConversationLifecycle.removeConversationData(",
    ) ||
    /advancementDetailController\.(?:cancelOpenConversationSession|removeConversationData|sweepOrphanData)/u.test(
      accessSurfaces,
    ) ||
    !systemHandlers.includes("interface AdvancementGcDeps") ||
    !systemHandlers.includes("const r = await deps.runSweep()") ||
    !composition.includes('from "@zhixing/core/advancement/application"') ||
    composition.split("new AdvancementApplicationService(").length - 1 !== 1 ||
    composition.split("createAdvancementProductApiContribution(").length - 1 !== 1 ||
    !composition.includes("advancementDetailController.loadLatestSession(conversationId)") ||
    !composition.includes("newTask: advancementDetailController") ||
    !composition.includes("newTaskConversation: {") ||
    !composition.includes("activeUserTurn: advancementDetailController") ||
    !composition.includes("activeUserTurnRuntime: {") ||
    composition.split("new AdvancementConversationLifecycleApplicationService(")
      .length -
      1 !==
      1 ||
    !composition.includes("const advancementConversationLifecycle =") ||
    !composition.includes("mechanism: {") ||
    !composition.includes(
      "runSweep: () => advancementConversationLifecycle.sweepOrphanData()",
    ) ||
    !composition.includes("conversationAlive: {") ||
    composition.includes("let advancementLifecycleApplication") ||
    composition.includes("requireAdvancementLifecycleApplication") ||
    composition.includes("advancementLifecycleApplication =") ||
    /advancementDetailController\.(?:cancelOpenConversationSession|removeConversationData|sweepOrphanData)/u.test(
      composition,
    ) ||
    !composition.includes("cancelPendingBySource(") ||
    !composition.includes("getBusySource(conversationId)") ||
    !composition.includes("abortInFlight(conversationId, {") ||
    !composition.includes("recoverConversation(conversationId)") ||
    !composition.includes("ctx.conversations!.runMaintenance(conversationId, operation)") ||
    !composition.includes('.ensureShell({ kind: "ensure-shell", conversationId })') ||
    !composition.includes("ctx.conversations!.runMaintenanceExisting(") ||
    !composition.includes("rubricRevision: advancementDetailController") ||
    !composition.includes("rubricCancellation: {") ||
    !composition.includes(
      "advancementDetailController.loadRubricCancellationSession(",
    ) ||
    !composition.includes("ctx.advancementReviews.cancelSession(input)") ||
    composition.includes("rubricCancellation: advancementDetailController") ||
    !composition.includes("awaitingRubricAdmission: advancementDetailController") ||
    !composition.includes("rubricConfirmation: advancementDetailController") ||
    !composition.includes("rubricPublication: {") ||
    !composition.includes("createAnchorAdvancementOriginalTaskExecutionPort(") ||
    !composition.includes("createAnchorAdvancementConfirmedOriginalTaskAdmissionPort(") ||
    !composition.includes("conversationApplication,") ||
    !originalTaskAdapter.includes("createAnchorAdvancementOriginalTaskExecutionPort(") ||
    !originalTaskAdapter.includes("conversations.prepareAgentTurnIdentity({") ||
    !originalTaskAdapter.includes("await conversations.admitAgentTurn({") ||
    originalTaskAdapter.split("await conversations.admitAgentTurn({").length - 1 !== 2 ||
    !originalTaskAdapter.includes("createAnchorAdvancementConfirmedOriginalTaskAdmissionPort(") ||
    !originalTaskAdapter.includes("new AdvancementOriginalTaskAdmissionError(") ||
    originalTaskAdapter.split("new AdvancementOriginalTaskAdmissionError(").length - 1 !== 2 ||
    /@zhixing\/(?:server|rpc)|\.\.\/\.\.\/server/u.test(originalTaskAdapter) ||
    !composition.includes("? ADVANCEMENT_PRODUCT_API_EXACT_SET.operations") ||
    !composition.includes("? ADVANCEMENT_PRODUCT_API_EXACT_SET.factEvents") ||
    !composition.includes("...(advancementProductApi ? [advancementProductApi] : [])")
  ) {
    failures.push(
      "Advancement detail/rubric lacks one Product API application or conversation lifecycle lacks one independent application owner",
    );
  }

  const allowedStoreWriteOwners = new Set([
    "packages/owner-services/src/advancement/controller.ts",
    "packages/owner-services/src/advancement/evidence.ts",
    "packages/owner-services/src/advancement/review-attempt-correctness.ts",
  ]);
  const storeWriteMethods = [
    "createSession",
    "confirmRubric",
    "settleOriginalTaskAdmission",
    "reviseRubricDraft",
    "appendEvidenceRequest",
    "appendEvidenceResult",
    "settleEvidence",
    "transitionReviewAttempt",
    "appendRunReview",
    "appendTerminalRunReview",
    "appendRunReviewWithProxyMessage",
    "enqueueProxyMessage",
    "settleProxyMessage",
    "completeSession",
    "exitSession",
    "cancelSession",
    "removeConversation",
    "removeConversationDataCandidate",
  ];
  const storeWritePattern = new RegExp(
    String.raw`(?:this\.|options\.|#options\.)?(?:#?store)\.(?:${storeWriteMethods.join("|")})\(`,
    "u",
  );
  const foreignStoreWrite = records.find((record) =>
    record.relative.startsWith("packages/") &&
    !record.relative.includes("/dist/") &&
    !record.relative.includes(".test.") &&
    !record.relative.endsWith("/advancement/session-store.ts") &&
    !record.relative.endsWith("/advancement/store.ts") &&
    storeWritePattern.test(record.text) &&
    !allowedStoreWriteOwners.has(record.relative),
  );
  const legacyStoreProductionReachability = records.find((record) =>
    record.relative.startsWith("packages/") &&
    !record.relative.includes("/dist/") &&
    !record.relative.includes(".test.") &&
    !record.relative.endsWith("/advancement/store.ts") &&
    /(?:new\s+AdvancementStore\b|(?:import|export)\s*\{[^}]*\bAdvancementStore\b[^}]*\}\s*from)/u.test(
      record.text,
    ),
  );
  if (
    ADVANCEMENT_APPLICATION_OWNER_EXACT_SET.length !== 13 ||
    !application.includes('"advancement.query.active-state"') ||
    !application.includes("async queryActiveState(") ||
    !application.includes("function projectAdvancementActiveState(") ||
    !application.includes("return await this.#activeState.queryActiveState(query.conversationId)") ||
    !application.includes("async settleProxyRun(") ||
    !application.includes("bindProductApiOperation(ADVANCEMENT_ACTIVE_STATE_QUERY") ||
    !composition.includes("activeState: ctx.advancementReviews") ||
    !composition.includes("ctx.advancementReviews.queryActiveState(conversationId)") ||
    !composition.includes("ctx.advancementReviews\n                  .settleProxyRun(") ||
    !recovery.includes("this.options.reviews.settleProxyRun({") ||
    recovery.includes("this.options.advancement.settleProxyMessage(") ||
    controller.includes("async settleProxyMessage(") ||
    controller.split("this.store.settleProxyMessage(").length - 1 !== 1 ||
    !handler.includes("productApi?.supports(ADVANCEMENT_ACTIVE_STATE_QUERY)") ||
    !handler.includes("productApi.query(ADVANCEMENT_ACTIVE_STATE_QUERY") ||
    /server\.advancement|loadActiveSession\(/u.test(
      handler.slice(
        handler.indexOf("export async function loadAdvancementState("),
        handler.indexOf("function requireUserFeedback(", handler.indexOf("export async function loadAdvancementState(")),
      ),
    ) ||
    /AdvancementController|readonly advancement\??:/u.test(serverContext) ||
    advancementIndex.includes("AdvancementStore") ||
    advancementIndex.includes('"./store.js"') ||
    legacyStoreProductionReachability ||
    foreignStoreWrite
  ) {
    failures.push(
      "Advancement whole-domain exact-set has a second active-state, proxy-settlement, ServerContext, legacy Store export, or Store-write owner",
    );
  }

  return failures;
}

/** A2 Skill Catalog applications and immutable execution projection have one owner. */
export function inspectSkillCatalogApplicationOwnership(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const required = (relative) => {
    const text = byPath.get(relative);
    if (text === undefined) failures.push(`${relative}: Skill Catalog production source is missing`);
    return text ?? "";
  };

  const application = required("packages/core/src/skills/catalog-application.ts");
  const skillManagementCorrectness = required(
    "packages/core/src/skills/catalog-management-correctness.ts",
  );
  const worksceneApplication = required(
    "packages/core/src/workscene/application.ts",
  );
  const conversationApplication = required(
    "packages/core/src/conversation/application.ts",
  );
  const conversationIndex = required(
    "packages/core/src/conversation/index.ts",
  );
  const scheduleApplication = required(
    "packages/core/src/scheduler/application.ts",
  );
  const scheduleRuntimePolicy = required(
    "packages/core/src/scheduler/runtime-policy.ts",
  );
  const scheduleFacade = required("packages/core/src/scheduler/facade.ts");
  const deliveryApplication = required(
    "packages/core/src/delivery/application.ts",
  );
  if (byPath.has("packages/core/src/delivery/resolution-application.ts")) {
    failures.push("Delivery resolution-only source path remains alongside the canonical application");
  }
  const deliveryIndex = required("packages/core/src/delivery/index.ts");
  const deliveryAuthority = required("packages/core/src/delivery/authority.ts");
  const deliveryPipeline = required(
    "packages/core/src/delivery/authority-pipeline.ts",
  );
  const deliveryTypes = required("packages/core/src/delivery/types.ts");
  const deliveryOutbox = required("packages/core/src/delivery/outbox.ts");
  const channelDeliveryEffect = required(
    "packages/core/src/delivery/channel-effect.ts",
  );
  const deliveryLifecyclePolicy = required(
    "packages/core/src/delivery/lifecycle-policy.ts",
  );
  const deliveryControl = required("packages/owner-kernel/src/delivery-control.ts");
  const deliveryObligationCorrectness = required(
    "packages/owner-kernel/src/delivery-obligation-correctness.ts",
  );
  const deliveryParticipant = required(
    "packages/owner-kernel/src/delivery-participant.ts",
  );
  const ownerKernelIndex = required("packages/owner-kernel/src/index.ts");
  const conversationAgentTurnAdmission = required(
    "packages/owner-kernel/src/conversation-agent-turn-admission.ts",
  );
  const conversationControl = required(
    "packages/owner-kernel/src/conversation-control.ts",
  );
  const ownerKernelManifestText = required(
    "packages/owner-kernel/package.json",
  );
  const ownerKernelBuild = required("packages/owner-kernel/tsup.config.ts");
  const ownerKernelDelivery = required("packages/owner-kernel/src/delivery.ts");
  const conversationAssignment = required(
    "packages/owner-kernel/src/conversation-assignment.ts",
  );
  const jobAssignment = required("packages/owner-kernel/src/job-assignment.ts");
  const schedulerUserNotices = required(
    "packages/owner-kernel/src/scheduler-user-notices.ts",
  );
  const productApi = required("packages/core/src/product-api/catalog.ts");
  const coreIndex = required("packages/core/src/index.ts");
  const skillIndex = required("packages/core/src/skills/index.ts");
  const skillAuthority = required(
    "packages/core/src/skills/global-state-adapter.ts",
  );
  const setupDelivery = required("packages/cli/src/setup-delivery.ts");
  const accessSurfaceContext = required(
    "packages/cli/src/serve/access-surface.ts",
  );
  const accessSurfaces = required("packages/cli/src/serve/access-surfaces.ts");
  const executorRoleRuntime = required(
    "packages/cli/src/serve/executor-role-runtime.ts",
  );
  const coreManifestText = required("packages/core/package.json");
  const coreBuild = required("packages/core/tsup.config.ts");
  const rpcIndex = required("packages/rpc/src/index.ts");
  const sessionWire = required("packages/rpc/src/session-wire.ts");
  const rpcManifestText = required("packages/rpc/package.json");
  const rpcBuild = required("packages/rpc/tsup.config.ts");
  const handler = required("packages/server/src/rpc/methods/skill.ts");
  const scheduleHandler = required(
    "packages/server/src/rpc/methods/schedule.ts",
  );
  const deliveryHandler = required("packages/server/src/rpc/methods/server.ts");
  const context = required("packages/server/src/context.ts");
  const composition = required("packages/cli/src/serve/command.ts");
  const conversationStorage = required(
    "packages/cli/src/serve/conversation-directory.ts",
  );
  const conversationClearBinding = required(
    "packages/cli/src/serve/conversation-clear-binding.ts",
  );
  const conversationResumeBinding = required(
    "packages/cli/src/serve/conversation-resume-binding.ts",
  );
  const conversationProtocolRuntime = required(
    "packages/cli/src/serve/conversation-protocol-runtime.ts",
  );
  const conversationRunControlBinding = required(
    "packages/cli/src/serve/conversation-run-control-binding.ts",
  );
  const conversationTaskListApplication = required(
    "packages/cli/src/serve/conversation-task-list-application.ts",
  );
  const conversationCompactApplication = required(
    "packages/cli/src/serve/conversation-compact-application.ts",
  );
  const conversationUsageApplication = required(
    "packages/cli/src/serve/conversation-usage-application.ts",
  );
  const conversationSecurityApplication = required(
    "packages/cli/src/serve/conversation-security-application.ts",
  );
  const conversationDeleteBinding = required(
    "packages/cli/src/serve/conversation-delete-binding.ts",
  );
  const worksceneDirectory = required(
    "packages/cli/src/serve/workscene-directory.ts",
  );
  const worksceneTools = required(
    "packages/cli/src/serve/workmode-tools.ts",
  );
  const worksceneRuntimeProjection = required(
    "packages/cli/src/serve/workscene-runtime-projection.ts",
  );
  const worksceneApplicationAdapter = required(
    "packages/cli/src/serve/workscene-application-adapter.ts",
  );
  const worksceneToolPort = required(
    "packages/cli/src/serve/workscene-port.ts",
  );
  const worksceneHandler = required(
    "packages/server/src/rpc/methods/workscene.ts",
  );
  const serverIndex = required("packages/server/src/index.ts");
  const worksceneSessionOwner = required(
    "packages/cli/src/serve/workscene-session-owner.ts",
  );
  const localConversationApplication = required(
    "packages/cli/src/serve/local-conversation-directory-application.ts",
  );
  const localConversationRpc = required(
    "packages/cli/src/serve/local-conversation-rpc.ts",
  );
  const localConversationOwner = required(
    "packages/cli/src/serve/local-conversation-owner.ts",
  );
  const sessionHandler = required(
    "packages/server/src/rpc/methods/session.ts",
  );
  const executionSchedule = required(
    "packages/cli/src/serve/execution-scheduler-facade.ts",
  );
  const rpcSchedule = required(
    "packages/cli/src/runtime/rpc-scheduler-facade.ts",
  );
  const scheduleTool = required("packages/tools-builtin/src/schedule.ts");
  const scheduleCorrectness = required(
    "packages/owner-kernel/src/scheduler-global-state.ts",
  );
  const scheduleAuthority = required(
    "packages/owner-kernel/src/scheduler-authority.ts",
  );
  const scheduleRuntimeMechanism = required(
    "packages/cli/src/serve/anchor-scheduler-runtime.ts",
  );
  const scheduleEventBridge = required(
    "packages/rpc/src/event-bridge.ts",
  );
  const serverRuntime = required("packages/server/src/server.ts");
  const serverLifecycle = required("packages/server/src/lifecycle.ts");
  const authHandler = required("packages/server/src/rpc/methods/auth.ts");
  const skillClientBinding = required(
    "packages/rpc/src/skill-catalog-client.ts",
  );
  const managementFacade = required(
    "packages/cli/src/runtime/rpc-management-facade.ts",
  );
  const repl = required("packages/cli/src/repl.ts");
  const infoCommands = required("packages/cli/src/commands/info-commands.ts");
  const skillManager = required(
    "packages/cli/src/skills/manager-controller.ts",
  );
  const skillManagerCommand = required(
    "packages/cli/src/skills/manager-command.ts",
  );
  const skillCommandSource = required(
    "packages/cli/src/commands/skill-command-source.ts",
  );
  const cliDirectories = required(
    "packages/cli/src/serve/trust-administration-adapter.ts",
  );
  const assignmentSkillPort = required(
    "packages/orchestrator/src/runtime/assignment-skill-port.ts",
  );
  const assignmentMutationIdentity = required(
    "packages/core/src/protocol/assignment-mutation.ts",
  );
  const assignmentMutationPort = required(
    "packages/cli/src/serve/assignment-schedule-stager.ts",
  );
  const taskSurfaceStart = infoCommands.indexOf(
    'dispatcher.registerHandler("tasks:repl"',
  );
  const taskSurfaceEnd = infoCommands.indexOf(
    "function formatRecoveryBackupState(",
    taskSurfaceStart,
  );
  const taskSurface = taskSurfaceStart >= 0 && taskSurfaceEnd > taskSurfaceStart
    ? infoCommands.slice(taskSurfaceStart, taskSurfaceEnd)
    : "";
  const worksceneConversationCleanupFactoryConsumers = records.filter(
    (record) =>
      record.relative !==
        "packages/cli/src/serve/workscene-application-adapter.ts" &&
      record.text.includes(
        "createAnchorWorksceneConversationStorageProjectionCleanup(",
      ),
  );
  const worksceneConversationCleanupConsumers = records.filter(
    (record) =>
      record.relative !==
        "packages/core/src/workscene/application.ts" &&
      record.text.includes(".removeCommittedProjection("),
  );
  const directConversationStorageDeleteConsumers = records.filter(
    (record) =>
      ![
        "packages/cli/src/serve/conversation-delete-binding.ts",
        "packages/cli/src/serve/conversation-directory.ts",
        "packages/cli/src/serve/access-surfaces.ts",
        "packages/cli/src/serve/command.ts",
        "packages/cli/src/serve/workscene-application-adapter.ts",
      ].includes(record.relative) &&
      record.text.includes(".deleteStoredConversation("),
  );
  const worksceneRemoveSceneStart = worksceneSessionOwner.indexOf(
    "async removeScene(",
  );
  const worksceneRemoveSceneEnd = worksceneSessionOwner.indexOf(
    "async #recordAuthority(",
    worksceneRemoveSceneStart,
  );
  const worksceneRemoveScene =
    worksceneRemoveSceneStart >= 0 && worksceneRemoveSceneEnd > worksceneRemoveSceneStart
      ? worksceneSessionOwner.slice(
          worksceneRemoveSceneStart,
          worksceneRemoveSceneEnd,
        )
      : "";
  const sessionResumeStart = sessionHandler.indexOf(
    'export function buildSessionResumeMethod()',
  );
  const sessionResumeEnd = sessionHandler.indexOf(
    "// ─── 工具 ───",
    sessionResumeStart,
  );
  const sessionResume = sessionResumeStart >= 0 && sessionResumeEnd > sessionResumeStart
    ? sessionHandler.slice(sessionResumeStart, sessionResumeEnd)
    : "";
  const localResumeStart = localConversationRpc.indexOf(
    'case "session.resume":',
  );
  const localResumeEnd = localConversationRpc.indexOf(
    'case "session.subscribe":',
    localResumeStart,
  );
  const localResume = localResumeStart >= 0 && localResumeEnd > localResumeStart
    ? localConversationRpc.slice(localResumeStart, localResumeEnd)
    : "";
  const sessionSendStart = sessionHandler.indexOf(
    "export function buildSessionSendMethod()",
  );
  const sessionSendEnd = sessionHandler.indexOf(
    "// ─── session.advancementConfirm",
    sessionSendStart,
  );
  const sessionSend =
    sessionSendStart >= 0 && sessionSendEnd > sessionSendStart
      ? sessionHandler.slice(sessionSendStart, sessionSendEnd)
      : "";
  const sessionTurnIdentityPreparation = sessionSend.indexOf(
    "const turnIdentity = await prepareSessionSendTurnIdentity(",
  );
  const sessionConversationManagerLookup = sessionSend.indexOf(
    "const manager = requireConversations(ctx.server);",
  );
  const sessionAgentAdmissionStart = sessionHandler.indexOf(
    "async function admitAndMaybeStartTurn(",
  );
  const sessionAgentAdmissionEnd = sessionHandler.indexOf(
    "function throwWorksceneBusyAsRpc(",
    sessionAgentAdmissionStart,
  );
  const sessionAgentAdmission =
    sessionAgentAdmissionStart >= 0 &&
      sessionAgentAdmissionEnd > sessionAgentAdmissionStart
      ? sessionHandler.slice(
          sessionAgentAdmissionStart,
          sessionAgentAdmissionEnd,
        )
      : "";

  const worksceneApplicationStart = worksceneHandler.indexOf(
    "export function buildWorksceneListMethod()",
  );
  const worksceneApplicationHandlers =
    worksceneApplicationStart >= 0
      ? worksceneHandler.slice(worksceneApplicationStart)
      : "";
  if (
    !worksceneApplication.includes("class WorksceneApplicationService") ||
    !worksceneApplication.includes("interface WorksceneManagementPort") ||
    !worksceneApplication.includes("interface WorksceneEntryPort") ||
    !worksceneApplication.includes("interface WorksceneWorkspaceAdministrationReadPort") ||
    !worksceneApplication.includes("interface WorksceneRuntimeProjectionReadPort") ||
    !worksceneApplication.includes("projectConversationRuntime(") ||
    !worksceneApplication.includes("type WorksceneConversationRuntimeProjection") ||
    !worksceneApplication.includes("WORKSCENE_PRODUCT_API_EXACT_SET") ||
    !worksceneApplication.includes("createWorksceneProductApiContribution") ||
    worksceneApplication.split("defineProductApiQuery<").length - 1 !== 1 ||
    worksceneApplication.split("defineProductApiCommand<").length - 1 !== 6 ||
    !worksceneApplication.includes("factEvents: []") ||
    !worksceneApplicationAdapter.includes(
      'from "@zhixing/core/workscene/application"',
    ) ||
    !worksceneApplicationAdapter.includes("createAnchorWorksceneApplicationPorts") ||
    !worksceneApplicationAdapter.includes("readonly entry: WorksceneEntryPort") ||
    !worksceneApplicationAdapter.includes("readonly runtime: WorksceneRuntimeProjectionReadPort") ||
    !worksceneDirectory.includes("export type AnchorWorksceneDirectory = WorksceneToolDirectory &") ||
    !worksceneDirectory.includes("WorksceneToolDirectory & {") ||
    /\bWorksceneDirectory\b/u.test(worksceneDirectory) ||
    worksceneDirectory.includes('from "@zhixing/server"') ||
    /export interface AnchorWorksceneDirectory\s+extends/u.test(worksceneDirectory) ||
    /\b(?:list|create|rename|setWorkdir|remove)\s*\(/u.test(worksceneToolPort) ||
    worksceneTools.includes('Pick<WorksceneToolDirectory, "rename">') ||
    !/createWorksceneRenameCurrentTool\(\s*scene:\s*WorksceneCurrentToolContext,\s*application:/u.test(
      worksceneTools,
    ) ||
    !worksceneRuntimeProjection.includes(
      "createWorksceneRenameCurrentTool(identity, application)",
    ) ||
    !worksceneRuntimeProjection.includes("type WorksceneConversationRuntimeProjection") ||
    worksceneRuntimeProjection.split("input.projectConversationRuntime(").length - 1 !== 2 ||
    worksceneRuntimeProjection.includes("getScene:") ||
    worksceneRuntimeProjection.includes("parseConversationId") ||
    worksceneRuntimeProjection.includes("WorksceneDto") ||
    worksceneRuntimeProjection.includes(
      "createWorksceneRenameCurrentTool(workscenes, identity)",
    ) ||
    !worksceneHandler.includes(
      'from "@zhixing/core/workscene/application"',
    ) ||
    !worksceneApplicationHandlers.includes("requireWorksceneApplication(ctx.server)") ||
    !worksceneApplicationHandlers.includes("WORKSCENE_ENTRY_ENTER_COMMAND") ||
    !worksceneApplicationHandlers.includes("WORKSCENE_ENTRY_EXIT_COMMAND") ||
    worksceneApplicationHandlers.includes("requireWorkscenes(ctx.server)") ||
    worksceneApplicationHandlers.includes("server.workscenes") ||
    worksceneApplicationHandlers.includes("sceneSummary(") ||
    !composition.includes("createWorksceneProductApiContribution(") ||
    !composition.includes("new WorksceneApplicationService(") ||
    !composition.includes("createAnchorWorksceneApplicationPorts(") ||
    composition.includes("worksceneDirectory.get(") ||
    composition.split("worksceneApplication.projectConversationRuntime(").length - 1 !== 2 ||
    !composition.includes("...WORKSCENE_PRODUCT_API_EXACT_SET.operations") ||
    context.includes("WorksceneDirectory") ||
    /\bworkscenes\??\s*:/u.test(context) ||
    serverIndex.includes("workscene-directory") ||
    byPath.has("packages/server/src/runtime/workscene-directory.ts") ||
    byPath.has("packages/cli/src/serve/workscene-management-adapter.ts") ||
    !coreManifestText.includes('"./workscene/application"') ||
    !coreBuild.includes('"src/workscene/application.ts"') ||
    coreIndex.includes("workscene/application")
  ) {
    failures.push("Workscene management and entry lack one domain application and Product API owner");
  }

  if (
    !scheduleApplication.includes("class ScheduleManagementApplicationService") ||
    !scheduleApplication.includes("interface ScheduleManagementRepository") ||
    !scheduleApplication.includes("interface ScheduleManualExecutionPort") ||
    !scheduleApplication.includes("draft.enabled ?? true") ||
    !scheduleApplication.includes('draft.priority ?? "normal"') ||
    !scheduleApplication.includes("validateTaskDefinition({") ||
    scheduleApplication.split("normalizeOperation(command.operation, true)").length - 1 !== 2 ||
    scheduleApplication.split("normalizeOperation(command.operation, false)").length - 1 !== 3 ||
    scheduleApplication.split('requireString(command.taskId, "Schedule task id")').length - 1 !== 3 ||
    scheduleApplication.split("SCHEDULE_MANUAL_RUN_COMMAND").length - 1 !== 3 ||
    scheduleApplication.split("SCHEDULE_MANUAL_ABORT_COMMAND").length - 1 !== 3 ||
    !scheduleApplication.includes("await this.#requiredUserTask(taskId);") ||
    !scheduleApplication.includes("await this.execution.run({ taskId, operation })") ||
    !scheduleApplication.includes("await this.execution.abort({ runId, operation })") ||
    scheduleApplication.includes("nonEmpty(command.taskId") ||
    !scheduleApplication.includes("if (task.system)") ||
    !scheduleApplication.includes("createScheduleManagementProductApiContribution") ||
    !scheduleApplication.includes("SCHEDULE_MANAGEMENT_PRODUCT_API_EXACT_SET")
  ) {
    failures.push("Schedule definition management lacks one domain application owner");
  }
  if (
    !scheduleHandler.includes('from "@zhixing/core/scheduler/application"') ||
    !scheduleHandler.includes("SCHEDULE_MANAGEMENT_LIST_QUERY") ||
    !scheduleHandler.includes("SCHEDULE_MANAGEMENT_CREATE_COMMAND") ||
    !scheduleHandler.includes("SCHEDULE_MANAGEMENT_UPDATE_COMMAND") ||
    !scheduleHandler.includes("SCHEDULE_MANAGEMENT_DELETE_COMMAND") ||
    !scheduleHandler.includes("SCHEDULE_MANUAL_RUN_COMMAND") ||
    !scheduleHandler.includes("SCHEDULE_MANUAL_ABORT_COMMAND") ||
    scheduleHandler.includes("function requireScheduler(") ||
    /\.scheduler\.(?:runTask|abortRun)\(/u.test(scheduleHandler) ||
    !/case "system-task":\s*return error;/u.test(scheduleHandler) ||
    !/case "invalid-command":\s*return method === "schedule\.create"\s*\?/u.test(
      scheduleHandler,
    ) ||
    /\.createTask\(|\.updateTask\(|\.deleteTask\(|validateTaskDefinition|enabled:\s*params\.enabled\s*\?\?|priority:\s*params\.priority\s*\?\?/u.test(
      scheduleHandler,
    )
  ) {
    failures.push("Schedule RPC management binding bypasses its Product API application");
  }
  if (
    !scheduleFacade.includes("this.management.execute({") ||
    !scheduleFacade.includes("this.management.query({ kind: \"list\" })") ||
    !scheduleFacade.includes('kind: "run"') ||
    /this\.scheduler\.(?:createTask|updateTask|deleteTask|runTask|abortRun)\(/u.test(scheduleFacade) ||
    !executionSchedule.includes("new ScheduleManagementApplicationService(repository, {") ||
    /Cannot modify system task|\.\.\.structuredClone\(patch\)/u.test(executionSchedule) ||
    !scheduleCorrectness.includes("ScheduleRuntimeProjectionPort") ||
    !scheduleCorrectness.includes("ScheduleManagementRepository,") ||
    !scheduleCorrectness.includes("ScheduleManualExecutionPort,") ||
    /SchedulerBackend/u.test(scheduleCorrectness) ||
    !scheduleCorrectness.includes("commitCreate(input:") ||
    !scheduleCorrectness.includes("commitUpdate(input:") ||
    !scheduleCorrectness.includes("commitDelete(input:") ||
    !scheduleCorrectness.includes("return this.scheduler.runTask(") ||
    !scheduleCorrectness.includes("return this.scheduler.abortRun(") ||
    !scheduleCorrectness.includes("return this.scheduler.listTaskProjections();") ||
    scheduleCorrectness.includes("async list(): Promise<readonly TaskView[]> {\n    return this.scheduler.listTasks();")
  ) {
    failures.push("Schedule facades or Correctness adapter retain a second management decision path");
  }
  if (
    !scheduleRuntimePolicy.includes("function selectDueScheduleEntries(") ||
    !scheduleRuntimePolicy.includes("DEFAULT_SCHEDULE_FAILURE_THRESHOLD = 5") ||
    !scheduleRuntimePolicy.includes("function scheduleTimerDelay(") ||
    !scheduleRuntimePolicy.includes("function decideScheduleTrigger(") ||
    !scheduleRuntimePolicy.includes("function deriveScheduleNextRun(") ||
    !scheduleRuntimePolicy.includes("function countScheduleConsecutiveFailures(") ||
    !scheduleRuntimePolicy.includes("function decideScheduleFailurePolicy(") ||
    !scheduleRuntimePolicy.includes("function scheduleAutoDisableOperationId(") ||
    !scheduleRuntimePolicy.includes("function selectPendingScheduleAutoDisable<") ||
    !scheduleAuthority.includes("selectDueScheduleEntries(this.#nextRunByTask, now)") ||
    !scheduleAuthority.includes("const decision = decideScheduleTrigger({") ||
    !scheduleAuthority.includes("deriveScheduleNextRun(view.schedule, occurrences") ||
    !scheduleAuthority.includes("countScheduleConsecutiveFailures(input.occurrences)") ||
    !scheduleAuthority.includes("scheduleAutoDisableOperationId({") ||
    !jobAssignment.includes("policy = decideScheduleFailurePolicy({") ||
    !jobAssignment.includes("pendingAutoDisable: selectPendingScheduleAutoDisable(") ||
    !/options\.schedulerFailureThreshold\s*\?\?\s*DEFAULT_SCHEDULE_FAILURE_THRESHOLD/u.test(jobAssignment) ||
    !jobAssignment.includes("error instanceof ScheduleRuntimePolicyError") ||
    /function (?:consecutiveSchedulerFailures|frozenFailureNextFire)\(/u.test(jobAssignment) ||
    /pendingAutoDisable:\s*\[\.\.\.state\.failurePolicyByRun\.values\(\)\]/u.test(
      jobAssignment,
    ) ||
    /function (?:deriveNextRun|countConsecutiveFailures|scheduledJobRunId)\(/u.test(scheduleAuthority) ||
    /const offlineMiss\s*=/u.test(scheduleAuthority)
  ) {
    failures.push("Schedule timing, offline and failure policy escaped its domain owner");
  }
  if (
    !scheduleApplication.includes("class ScheduleApplicationService") ||
    !scheduleApplication.includes("interface ScheduleRuntimeProjectionPort") ||
    !scheduleApplication.includes("interface ScheduleLifecycleMechanismPort") ||
    /\b(?:anchorEpoch|currentAnchorEpoch)\b/u.test(scheduleApplication) ||
    !scheduleApplication.includes("projectScheduleRuntimeEvent(signal)") ||
    !scheduleApplication.includes("freezeStatusSummary(computeStatusSummary") ||
    !scheduleApplication.includes("return freezeAcceptedWork(await") ||
    !scheduleApplication.includes("assertAcceptedWorkSubset(await mechanism.listAcceptedWork(), frozen)") ||
    !scheduleApplication.includes("assertSettlementStrategy(input.strategy);") ||
    scheduleApplication.split("await mechanism.pauseAndSettle();").length - 1 !== 1 ||
    /switch\s*\(input\.strategy\)|input\.strategy\s*[!=]==?/u.test(scheduleApplication) ||
    !scheduleApplication.includes("Schedule lifecycle mechanism is already installed") ||
    !scheduleRuntimeMechanism.includes("implements AnchorScheduleLifecycleMechanism") ||
    !scheduleRuntimeMechanism.includes("interface AnchorScheduleLifecycleMechanism") ||
    !scheduleRuntimeMechanism.includes("class AnchorSchedulerHostLifecycle") ||
    !scheduleRuntimeMechanism.includes("readonly installedAnchorEpoch: number") ||
    !scheduleRuntimeMechanism.includes("createProductBoundary()") ||
    !scheduleRuntimeMechanism.includes("return this.#scheduler.acceptedWorkItems()") ||
    !scheduleRuntimeMechanism.includes("return this.#scheduler.pauseForAuthorityTransfer()") ||
    /readonly scheduler: AnchorScheduler/u.test(scheduleRuntimeMechanism) ||
    !composition.includes("const schedulerApplication = new ScheduleApplicationService(") ||
    composition.split("new ScheduleApplicationService(").length - 1 !== 1 ||
    !composition.includes("const schedulerGenerationOwner = new AnchorSchedulerHostLifecycle({") ||
    !composition.includes("await schedulerGenerationOwner.installInitial({") ||
    !composition.includes("schedulerGenerationOwner.stopAndRelease()") ||
    !composition.includes("schedulerGenerationOwner.recoverInstalledAuthority({") ||
    composition.split("bind: bindSchedulerGeneration,").length - 1 !== 2 ||
    !composition.includes("currentAnchorEpoch: authority.anchorEpoch") ||
    /schedulerApplication\.currentAnchorEpoch/u.test(composition) ||
    !composition.includes("createScheduleRuntimeProductApiContribution(schedulerApplication)") ||
    !composition.includes("scheduleRuntimeEvents: schedulerApplication") ||
    /schedulerLifecycle|ScheduleLifecycleApplicationService/u.test(composition) ||
    /schedulerRuntime\??\.activate\(/u.test(composition)
  ) {
    failures.push("Schedule runtime and lifecycle lack one finite domain application boundary");
  }
  const scheduleGenerationRecovery = scheduleRuntimeMechanism.indexOf(
    "async recoverInstalledAuthority(input:",
  );
  const schedulerMechanismConstructor = scheduleRuntimeMechanism.slice(
    scheduleRuntimeMechanism.indexOf("private constructor(options:"),
    scheduleRuntimeMechanism.indexOf("static async create("),
  );
  const scheduleGenerationCompare = scheduleRuntimeMechanism.indexOf(
    "current.installedAnchorEpoch === input.currentAnchorEpoch",
    scheduleGenerationRecovery,
  );
  const scheduleGenerationCreate = scheduleRuntimeMechanism.indexOf(
    "const replacement = await input.create();",
    scheduleGenerationCompare,
  );
  const scheduleGenerationValidate = scheduleRuntimeMechanism.indexOf(
    "replacement.installedAnchorEpoch !== input.currentAnchorEpoch",
    scheduleGenerationCreate,
  );
  const scheduleGenerationPrepare = scheduleRuntimeMechanism.indexOf(
    "await input.prepare(replacement);",
    scheduleGenerationValidate,
  );
  const scheduleCurrentBindingRelease = scheduleRuntimeMechanism.indexOf(
    "currentBindingRelease();",
    scheduleGenerationPrepare,
  );
  const scheduleGenerationBind = scheduleRuntimeMechanism.indexOf(
    "replacementBindingRelease = input.bind(replacement);",
    scheduleCurrentBindingRelease,
  );
  const scheduleGenerationRelease = scheduleRuntimeMechanism.indexOf(
    "this.#application.release(current);",
    scheduleGenerationBind,
  );
  const scheduleGenerationInstall = scheduleRuntimeMechanism.indexOf(
    "this.#application.install(replacement);",
    scheduleGenerationRelease,
  );
  const scheduleCurrentPublicationRelease = scheduleRuntimeMechanism.indexOf(
    "currentPublicationRelease();",
    scheduleGenerationInstall,
  );
  const scheduleGenerationPublish = scheduleRuntimeMechanism.indexOf(
    "replacementPublicationRelease = input.publish(replacement);",
    scheduleCurrentPublicationRelease,
  );
  const scheduleGenerationCommit = scheduleRuntimeMechanism.indexOf(
    "this.#current = replacement;",
    scheduleGenerationPublish,
  );
  const scheduleGenerationActivate = scheduleRuntimeMechanism.indexOf(
    "input.activate(replacement);",
    scheduleGenerationCommit,
  );
  const scheduleGenerationResume = scheduleRuntimeMechanism.indexOf(
    "await input.resume(replacement);",
    scheduleGenerationActivate,
  );
  const scheduleGenerationReset = scheduleRuntimeMechanism.indexOf(
    "this.#postAdoptionReviewCoordinator.resetForInstalledGeneration();",
    scheduleGenerationResume,
  );
  const scheduleGenerationStop = scheduleRuntimeMechanism.indexOf(
    "await current.stop();",
    scheduleGenerationReset,
  );
  const initialInstall = scheduleRuntimeMechanism.slice(
    scheduleRuntimeMechanism.indexOf("async installInitial(input:"),
    scheduleRuntimeMechanism.indexOf("stopAndRelease(): Promise<void>"),
  );
  if (
    scheduleGenerationRecovery < 0 ||
    scheduleGenerationCompare < scheduleGenerationRecovery ||
    scheduleGenerationCreate < scheduleGenerationCompare ||
    scheduleGenerationValidate < scheduleGenerationCreate ||
    scheduleGenerationPrepare < scheduleGenerationValidate ||
    scheduleCurrentBindingRelease < scheduleGenerationPrepare ||
    scheduleGenerationBind < scheduleCurrentBindingRelease ||
    scheduleGenerationRelease < scheduleGenerationBind ||
    scheduleGenerationInstall < scheduleGenerationRelease ||
    scheduleCurrentPublicationRelease < scheduleGenerationInstall ||
    scheduleGenerationPublish < scheduleCurrentPublicationRelease ||
    scheduleGenerationCommit < scheduleGenerationPublish ||
    scheduleGenerationActivate < scheduleGenerationCommit ||
    scheduleGenerationResume < scheduleGenerationActivate ||
    scheduleGenerationReset < scheduleGenerationResume ||
    scheduleGenerationStop < scheduleGenerationReset ||
    !scheduleRuntimeMechanism.includes("this.#application.install(current);") ||
    !scheduleRuntimeMechanism.includes("await stopFailedGeneration(replacement, error);") ||
    !scheduleRuntimeMechanism.includes("attemptGenerationRelease(replacementBindingRelease, rollbackFailures)") ||
    !scheduleRuntimeMechanism.includes("this.#bindingRelease = input.bind(current);") ||
    !scheduleRuntimeMechanism.includes("this.#publicationRelease = input.publish(current);") ||
    !scheduleRuntimeMechanism.includes("bindGeneration(): () => void") ||
    !scheduleRuntimeMechanism.includes("if (this.#generationBound)") ||
    !scheduleRuntimeMechanism.includes("this.#options.protocol.bindMutationPublisher(this.#mutationPublisher)") ||
    scheduleRuntimeMechanism.split("bindMutationPublisher(").length - 1 !== 1 ||
    conversationProtocolRuntime.includes("beginInstalledAuthorityGeneration") ||
    conversationProtocolRuntime.split("bindMutationPublisher(").length - 1 !== 1 ||
    conversationProtocolRuntime.split("this.#mutationPublisher = undefined;").length - 1 !== 1 ||
    composition.includes("conversationProtocol.bindMutationPublisher(") ||
    !/await input\.prepare\(input\.mechanism\);[\s\S]*?bindingRelease = input\.bind\(input\.mechanism\);[\s\S]*?this\.#application\.install\(input\.mechanism\);[\s\S]*?publicationRelease = input\.publish\(input\.mechanism\);[\s\S]*?this\.#current = input\.mechanism;[\s\S]*?input\.activate\(input\.mechanism\);[\s\S]*?await input\.resume\(input\.mechanism\)/u.test(
      initialInstall,
    ) ||
    !/publicationRelease\?\.\(\);[\s\S]*?this\.#application\.release\(input\.mechanism\);[\s\S]*?bindingRelease\?\.\(\);[\s\S]*?stopFailedGeneration\(input\.mechanism, error\)/u.test(
      initialInstall,
    ) ||
    !/installSchedulerGlobalState:\s*\(state:\s*GlobalStatePort\)\s*=>\s*\(\)\s*=>\s*void/u.test(
      setupDelivery,
    ) ||
    !/if\s*\(schedulerGlobalState === state\)\s*schedulerGlobalState = undefined/u.test(
      setupDelivery,
    ) ||
    !/const releaseGlobalState\s*=\s*[\s\S]*?installSchedulerGlobalState\(boundary\.globalState\);[\s\S]*?if \(schedulerProductRef === product\) schedulerProductRef = undefined;[\s\S]*?releaseGlobalState\(\);/u.test(
      composition,
    ) ||
    !/const activateSchedulerGeneration[\s\S]*?runtime\.activate\(\);/u.test(composition) ||
    !/const resumeSchedulerGeneration[\s\S]*?await runtime\.resumeManualSurfaces\(\);/u.test(
      composition,
    ) ||
    /input\.activate\(replacement\);/u.test(
      scheduleRuntimeMechanism.slice(scheduleGenerationPrepare, scheduleGenerationCommit),
    ) ||
    /await current\.stop\(\);/u.test(
      scheduleRuntimeMechanism.slice(scheduleGenerationPrepare, scheduleGenerationReset),
    ) ||
    /jobStatus\.register(?:Scheduler)?\(|executorCapabilities\.onAccepted\(|bindMutationPublisher\(/u.test(
      schedulerMechanismConstructor,
    ) ||
    /await this\.#application\.stop\(\);[\s\S]*?const replacement = await input\.create\(\)/u.test(
      scheduleRuntimeMechanism,
    )
  ) {
    failures.push("Schedule physical generation replacement escaped its Host boundary");
  }
  if (
    /SchedulerBackend|schedulerEventBus|SchedulerEventMap|isInternal/u.test(context) ||
    /SchedulerBackend|schedulerEventBus/u.test(serverRuntime) ||
    /SchedulerBackend|scheduler\.stop/u.test(serverLifecycle) ||
    !scheduleEventBridge.includes("Pick<ScheduleRuntimeApplication, \"onEvent\">") ||
    /SchedulerEventMap|isInternal|scheduler:task-/u.test(scheduleEventBridge) ||
    !authHandler.includes("productApi?.supports(SCHEDULE_MANAGEMENT_LIST_QUERY)") ||
    /server\.scheduler/u.test(authHandler) ||
    /createEventBus<SchedulerEventMap>|scheduler:task-failed/u.test(repl)
  ) {
    failures.push("Host, Server or Surface retains a raw Schedule runtime decision path");
  }
  if (
    scheduleTool.includes(".filter((t) => !isInternal(t))") ||
    scheduleTool.includes("enabled: true") ||
    scheduleTool.includes('?? "normal"') ||
    taskSurfaceStart < 0 ||
    taskSurface.length === 0 ||
    !taskSurface.includes("const tasks = await deps.getScheduler().list();") ||
    /\bisInternal\b|\.filter\s*\(/u.test(taskSurface) ||
    !rpcSchedule.includes('client.request<TaskView>("schedule.create"') ||
    !rpcSchedule.includes('client.request<AgentTurnResult>("schedule.run"') ||
    !rpcSchedule.includes("function exactRecord(") ||
    !rpcSchedule.includes("Invalid schedule.completed notification") ||
    !composition.includes("createScheduleManagementProductApiContribution(schedulerManagement)") ||
    composition.split("createScheduleManagementProductApiContribution(").length - 1 !== 1 ||
    composition.split("new ScheduleManagementApplicationService(").length - 1 !== 1 ||
    !composition.includes("const schedulerManualExecution: ScheduleManualExecutionPort") ||
    /schedulerBackend[\s\S]*?(?:runTask|abortRun)\s*:/u.test(composition)
  ) {
    failures.push("Schedule consumers do not converge on the one management application");
  }
  const agentRuntime = required(
    "packages/orchestrator/src/runtime/create-agent-runtime.ts",
  );
  const executionSnapshot = required(
    "packages/core/src/protocol/execution-asset-snapshot.ts",
  );
  const executionAssetCache = required(
    "packages/cli/src/serve/execution-asset-cache.ts",
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
  let ownerKernelManifest;
  try {
    ownerKernelManifest = JSON.parse(ownerKernelManifestText);
  } catch {
    failures.push(
      "Owner Kernel manifest is invalid while checking Conversation turn admission",
    );
  }
  const conversationAgentTurnAdmissionExport =
    ownerKernelManifest?.exports?.["./conversation-agent-turn-admission"];
  const duplicateConversationAgentTurnAdmissionExports = Object.entries(
    ownerKernelManifest?.exports ?? {},
  ).filter(([subpath, conditions]) =>
    subpath !== "./conversation-agent-turn-admission" &&
    conditions &&
    typeof conditions === "object" &&
    (conditions.types === conversationAgentTurnAdmissionExport?.types ||
      conditions.import === conversationAgentTurnAdmissionExport?.import)
  );
  const conversationControlExport =
    ownerKernelManifest?.exports?.["./conversation-control"];
  const duplicateConversationControlExports = Object.entries(
    ownerKernelManifest?.exports ?? {},
  ).filter(([subpath, conditions]) =>
    subpath !== "./conversation-control" &&
    conditions &&
    typeof conditions === "object" &&
    (conditions.types === conversationControlExport?.types ||
      conditions.import === conversationControlExport?.import)
  );
  const scheduleApplicationExport = coreManifest?.exports?.["./scheduler/application"];
  const duplicateScheduleApplicationExports = Object.entries(coreManifest?.exports ?? {})
    .filter(([subpath, conditions]) =>
      subpath !== "./scheduler/application" &&
      conditions &&
      typeof conditions === "object" &&
      (conditions.types === scheduleApplicationExport?.types ||
        conditions.import === scheduleApplicationExport?.import)
    );
  if (
    scheduleApplicationExport?.types !== "./dist/scheduler/application.d.ts" ||
    scheduleApplicationExport?.import !== "./dist/scheduler/application.js" ||
    duplicateScheduleApplicationExports.length > 0 ||
    coreBuild.split('"src/scheduler/application.ts"').length - 1 !== 1 ||
    /ScheduleManagementApplication|scheduler\/application/u.test(coreIndex)
  ) {
    failures.push("Schedule management application must have one narrow non-root core subpath");
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
  const skillCatalogCorrectnessExport =
    coreManifest?.exports?.["./skills/catalog-correctness"];
  const duplicateSkillCatalogCorrectnessExports = Object.entries(
    coreManifest?.exports ?? {},
  ).filter(([subpath, conditions]) =>
    subpath !== "./skills/catalog-correctness" &&
    conditions &&
    typeof conditions === "object" &&
    (conditions.types === skillCatalogCorrectnessExport?.types ||
      conditions.import === skillCatalogCorrectnessExport?.import)
  );
  if (
    skillCatalogCorrectnessExport?.types !==
      "./dist/skills/catalog-management-correctness.d.ts" ||
    skillCatalogCorrectnessExport?.import !==
      "./dist/skills/catalog-management-correctness.js" ||
    duplicateSkillCatalogCorrectnessExports.length > 0 ||
    coreBuild.split('"src/skills/catalog-management-correctness.ts"').length - 1 !== 1
  ) {
    failures.push(
      "Skill Catalog management Correctness adapter must have one narrow non-root subpath",
    );
  }
  if (
    coreIndex.includes("catalog-application") ||
    coreIndex.includes("catalog-management-correctness") ||
    skillIndex.includes("catalog-application") ||
    skillIndex.includes("catalog-management-correctness") ||
    skillIndex.includes("createAnchorSkillCatalogManagementCorrectnessPort") ||
    skillIndex.includes("SkillCatalogClient") ||
    skillIndex.includes("SkillCatalogApplication") ||
    skillIndex.includes("SkillCatalogAdmissionApplication") ||
    skillIndex.includes("SkillCatalogKernelProjectionApplication") ||
    skillIndex.includes("SkillCatalogLoadApplication") ||
    skillIndex.includes("SkillCatalogSaveApplication") ||
    skillIndex.includes("runSkillSavePipeline")
  ) {
    failures.push("Skill Catalog application contract leaked into the core root barrel");
  }
  if (coreBuild.split('"src/skills/catalog-application.ts"').length - 1 !== 1) {
    failures.push("Skill Catalog canonical subpath lacks one dedicated build entry");
  }
  let rpcManifest;
  try {
    rpcManifest = JSON.parse(rpcManifestText);
  } catch {
    failures.push("RPC manifest is invalid while checking the Skill client binding subpath");
  }
  const skillClientExport = rpcManifest?.exports?.["./skill-catalog-client"];
  const duplicateSkillClientExports = Object.entries(rpcManifest?.exports ?? {})
    .filter(([subpath, conditions]) =>
      subpath !== "./skill-catalog-client" &&
      conditions &&
      typeof conditions === "object" &&
      (conditions.types === skillClientExport?.types ||
        conditions.import === skillClientExport?.import)
    );
  if (
    skillClientExport?.types !== "./dist/skill-catalog-client.d.ts" ||
    skillClientExport?.import !== "./dist/skill-catalog-client.js" ||
    duplicateSkillClientExports.length > 0 ||
    rpcBuild.split('"src/skill-catalog-client.ts"').length - 1 !== 1 ||
    rpcIndex.includes("skill-catalog-client") ||
    rpcIndex.includes("SkillCatalogRpcClient")
  ) {
    failures.push("Skill RPC client binding must have one narrow non-root RPC subpath");
  }
  const productApiExport = coreManifest?.exports?.["./product-api"];
  const duplicateProductApiExports = Object.entries(coreManifest?.exports ?? {})
    .filter(([subpath, conditions]) =>
      subpath !== "./product-api" &&
      conditions &&
      typeof conditions === "object" &&
      (conditions.types === productApiExport?.types ||
        conditions.import === productApiExport?.import)
    );
  if (
    productApiExport?.types !== "./dist/product-api/catalog.d.ts" ||
    productApiExport?.import !== "./dist/product-api/catalog.js" ||
    duplicateProductApiExports.length > 0 ||
    coreBuild.split('"src/product-api/catalog.ts"').length - 1 !== 1 ||
    coreIndex.includes("product-api") ||
    skillIndex.includes("ProductApiDispatcher")
  ) {
    failures.push("Product API catalog must have one narrow non-root core subpath");
  }
  const conversationApplicationExport =
    coreManifest?.exports?.["./conversation/application"];
  const duplicateConversationApplicationExports = Object.entries(
    coreManifest?.exports ?? {},
  ).filter(([subpath, conditions]) =>
    subpath !== "./conversation/application" &&
    conditions &&
    typeof conditions === "object" &&
    (conditions.types === conversationApplicationExport?.types ||
      conditions.import === conversationApplicationExport?.import)
  );
  if (
    conversationApplicationExport?.types !==
      "./dist/conversation/application.d.ts" ||
    conversationApplicationExport?.import !==
      "./dist/conversation/application.js" ||
    duplicateConversationApplicationExports.length > 0 ||
    coreBuild.split('"src/conversation/application.ts"').length - 1 !== 1 ||
    coreIndex.includes("conversation/application") ||
    conversationIndex.includes("./application.js") ||
    !conversationApplication.includes(
      "class ConversationDirectoryApplicationService",
    ) ||
    !conversationApplication.includes(
      "CONVERSATION_DIRECTORY_PRODUCT_API_EXACT_SET",
    ) ||
    !conversationApplication.includes(
      "createConversationDirectoryProductApiContribution",
    ) ||
    !conversationApplication.includes("CONVERSATION_CLEAR_COMMAND") ||
    !conversationApplication.includes("CONVERSATION_CLEARED_FACT_EVENT") ||
    !conversationApplication.includes("projectConversationClear(") ||
    !conversationApplication.includes("CONVERSATION_DELETE_COMMAND") ||
    !conversationApplication.includes("CONVERSATION_DELETED_FACT_EVENT") ||
    !conversationApplication.includes("projectConversationDelete(") ||
    !conversationApplication.includes("CONVERSATION_RESUME_COMMAND") ||
    !conversationApplication.includes("interface ConversationResumePort") ||
    !conversationApplication.includes("async resume(") ||
    !conversationApplication.includes("interface ConversationRunControlPort") ||
    !conversationApplication.includes("CONVERSATION_ABORT_COMMAND") ||
    !conversationApplication.includes("CONVERSATION_RESOLVE_UNCERTAIN_COMMAND") ||
    !conversationApplication.includes(
      "CONVERSATION_PREPARE_AGENT_TURN_IDENTITY_COMMAND",
    ) ||
    !conversationApplication.includes("CONVERSATION_IDENTITY_EXISTS_QUERY") ||
    !conversationApplication.includes("CONVERSATION_ENSURE_SHELL_COMMAND") ||
    !conversationApplication.includes("async queryIdentityExists(") ||
    !conversationApplication.includes("async ensureShell(") ||
    !conversationApplication.includes("CONVERSATION_ADMIT_AGENT_TURN_COMMAND") ||
    !conversationApplication.includes("interface ConversationTaskListPort") ||
    !conversationApplication.includes("CONVERSATION_TASK_LIST_QUERY") ||
    !conversationApplication.includes("CONVERSATION_UPDATE_TASK_LIST_COMMAND") ||
    !conversationApplication.includes(
      "CONVERSATION_TASK_LIST_CHANGED_FACT_EVENT",
    ) ||
    !conversationApplication.includes('factEmission: "subset"') ||
    !conversationApplication.includes("interface ConversationTaskListUpdateOutcome") ||
    /interface ConversationTaskListUpdateResult\s*\{[^}]*\b(?:fact|facts)\??\s*:/su.test(
      conversationApplication,
    ) ||
    !conversationApplication.includes("result: outcome.result") ||
    !conversationApplication.includes("facts: outcome.fact ? [outcome.fact] : []") ||
    !conversationApplication.includes("async queryTaskList(") ||
    !conversationApplication.includes("async updateTaskList(") ||
    !conversationApplication.includes("interface ConversationCompactPort") ||
    !conversationApplication.includes("CONVERSATION_COMPACT_COMMAND") ||
    !conversationApplication.includes("async compact(") ||
    !conversationApplication.includes(
      "modified: outcome.runtimeModified && outcome.windowApplied",
    ) ||
    !conversationApplication.includes("interface ConversationUsageProjectionPort") ||
    !conversationApplication.includes("CONVERSATION_CONTEXT_BUDGET_QUERY") ||
    !conversationApplication.includes("CONVERSATION_USAGE_QUERY") ||
    !conversationApplication.includes("interface ConversationSecurityProjectionPort") ||
    !conversationApplication.includes("CONVERSATION_SECURITY_QUERY") ||
    !conversationApplication.includes("async queryContextBudget(") ||
    !conversationApplication.includes("async queryUsage(") ||
    !conversationApplication.includes("async querySecurity(") ||
    !sessionWire.includes(
      "export type SessionSecurityResult = ConversationSecurityResult",
    ) ||
    sessionWire.includes("RuntimeSecuritySnapshot") ||
    !conversationApplication.includes("interface ConversationAgentTurnAdmissionPort") ||
    !conversationApplication.includes(
      "interface ConversationPreparedAgentTurnIdentity",
    ) ||
    !conversationApplication.includes("prepareAgentTurnIdentity(") ||
    !conversationApplication.includes("isPreparedAgentTurnIdentity(") ||
    !conversationApplication.includes("async admitAgentTurn(") ||
    !conversationApplication.includes("admission.requiresStableTurnIdentity") ||
    conversationApplication.includes("command.turnIdentitySource") ||
    !conversationApplication.includes("async abort(") ||
    !conversationApplication.includes("async resolveUncertain(") ||
    conversationApplication.includes("ownerEpoch") ||
    conversationApplication.split("resolutionFence: ConversationResolutionFence").length - 1 !== 2 ||
    !conversationApplication.includes("type ConversationResolutionFence = string") ||
    !conversationApplication.includes("HISTORY_DEFAULT_LIMIT = 20") ||
    !conversationApplication.includes("HISTORY_MAX_LIMIT = 200") ||
    conversationApplication.includes('../advancement/') ||
    !conversationApplication.includes("orderDurableConversationRecords(") ||
    !sessionHandler.includes(
      'from "@zhixing/core/conversation/application"',
    ) ||
    !sessionHandler.includes("CONVERSATION_LIST_QUERY") ||
    !sessionHandler.includes("CONVERSATION_HISTORY_QUERY") ||
    !sessionHandler.includes("CONVERSATION_CREATE_COMMAND") ||
    !sessionHandler.includes("CONVERSATION_RENAME_COMMAND") ||
    !sessionHandler.includes("CONVERSATION_CLEAR_COMMAND") ||
    !sessionHandler.includes("CONVERSATION_DELETE_COMMAND") ||
    !sessionHandler.includes("CONVERSATION_RESUME_COMMAND") ||
    !sessionHandler.includes("CONVERSATION_ABORT_COMMAND") ||
    !sessionHandler.includes("CONVERSATION_RESOLVE_UNCERTAIN_COMMAND") ||
    !sessionHandler.includes(
      "CONVERSATION_PREPARE_AGENT_TURN_IDENTITY_COMMAND",
    ) ||
    !sessionHandler.includes("CONVERSATION_IDENTITY_EXISTS_QUERY") ||
    !sessionHandler.includes("CONVERSATION_ENSURE_SHELL_COMMAND") ||
    !sessionHandler.includes("CONVERSATION_ADMIT_AGENT_TURN_COMMAND") ||
    !sessionHandler.includes("CONVERSATION_TASK_LIST_QUERY") ||
    !sessionHandler.includes("CONVERSATION_UPDATE_TASK_LIST_COMMAND") ||
    !sessionHandler.includes("CONVERSATION_COMPACT_COMMAND") ||
    !/productApi\.command\(\s*CONVERSATION_COMPACT_COMMAND/u.test(
      sessionHandler,
    ) ||
    /\.compactExisting\s*\(/u.test(sessionHandler) ||
    !sessionHandler.includes("CONVERSATION_CONTEXT_BUDGET_QUERY") ||
    !sessionHandler.includes("CONVERSATION_USAGE_QUERY") ||
    !sessionHandler.includes("CONVERSATION_SECURITY_QUERY") ||
    !/productApi\.query\(\s*CONVERSATION_CONTEXT_BUDGET_QUERY/u.test(
      sessionHandler,
    ) ||
    !/productApi\.query\(\s*CONVERSATION_USAGE_QUERY/u.test(sessionHandler) ||
    !/productApi\.query\(\s*CONVERSATION_SECURITY_QUERY/u.test(sessionHandler) ||
    /\.inspect(?:ContextBudget|Usage|Security)Existing\s*\(/u.test(sessionHandler) ||
    !sessionHandler.includes("const fact = dispatch.facts[0]") ||
    sessionHandler.includes("dispatch.result.fact") ||
    sessionSend.length === 0 ||
    sessionTurnIdentityPreparation < 0 ||
    sessionConversationManagerLookup < 0 ||
    sessionTurnIdentityPreparation > sessionConversationManagerLookup ||
    /usesDurableTurnProtocol|generateTurnId|validateTurnId/u.test(sessionSend) ||
    !sessionHandler.includes(
      "productApi.command(\n    CONVERSATION_PREPARE_AGENT_TURN_IDENTITY_COMMAND",
    ) ||
    !sessionHandler.includes("productApi.command(CONVERSATION_ABORT_COMMAND") ||
    !/productApi\.command\(\s*CONVERSATION_RESOLVE_UNCERTAIN_COMMAND/u.test(
      sessionHandler,
    ) ||
    !sessionHandler.includes(
      "resolutionFence: createConversationResolutionFence(params.ownerEpoch)",
    ) ||
    !sessionHandler.includes(
      'from "@zhixing/owner-kernel/conversation-control"',
    ) ||
    /requireConversations\(ctx\.server\)\.(?:cancelDurableRuns|resolveDurableUncertain|abort)\s*\(/u.test(
      sessionHandler,
    ) ||
    /requireDirectory\(ctx\.server\)\.(?:list|create|rename|readRunsReverse|readHistory)/u.test(
      sessionHandler,
    ) ||
    /ctx\.server\.(?:taskListSnapshot|taskListUpdate)\s*\(/u.test(
      sessionHandler,
    ) ||
    /conversationDirectory\??\s*:/u.test(context) ||
    /ctx\.server\.conversationDirectory|requireDirectory\(/u.test(sessionHandler) ||
    !/productApi\.query\(\s*CONVERSATION_IDENTITY_EXISTS_QUERY/u.test(
      sessionHandler,
    ) ||
    !/productApi\.command\(\s*CONVERSATION_ENSURE_SHELL_COMMAND/u.test(
      sessionHandler,
    ) ||
    byPath.has("packages/server/src/runtime/conversation-directory.ts") ||
    byPath.has("packages/server/src/runtime/index.ts") ||
    serverIndex.includes("./runtime/index.js") ||
    !conversationApplication.includes(
      "interface ConversationIdentityLifecycleApplication",
    ) ||
    !conversationApplication.includes(
      "createConversationIdentityLifecycleApplication(",
    ) ||
    !conversationApplication.includes(
      'parseConversationId(conversationId).scope.kind === "workscene"',
    ) ||
    !conversationApplication.includes(
      "await mechanism.ensureTranscript(conversationId)",
    ) ||
    !conversationApplication.includes("await mechanism.ensure(conversationId)") ||
    coreIndex.includes("ConversationIdentityLifecycle") ||
    conversationIndex.includes("ConversationIdentityLifecycle") ||
    !accessSurfaceContext.includes(
      "readonly conversationIdentityLifecycle: ConversationIdentityLifecycleApplication",
    ) ||
    /AnchorConversationDirectoryMechanism|readonly conversationDirectory\s*:/u.test(
      accessSurfaceContext,
    ) ||
    accessSurfaces.split("ctx.conversationIdentityLifecycle.").length - 1 !== 4 ||
    /ctx\.conversationDirectory\.(?:exists|ensure|ensureTranscript)\s*\(/u.test(
      accessSurfaces,
    ) ||
    !accessSurfaces.includes(
      "ctx.conversationIdentityLifecycle.identityExists(conversationId)",
    ) ||
    !accessSurfaces.includes(
      "ctx.conversationIdentityLifecycle.ensureShell(",
    ) ||
    !accessSurfaces.includes(
      "ctx.conversationIdentityLifecycle.initializeRuntimeStorage(",
    ) ||
    !composition.includes(
      "createConversationIdentityLifecycleApplication({",
    ) ||
    composition.split("createConversationIdentityLifecycleApplication({").length - 1 !== 1 ||
    !composition.includes("conversationIdentityLifecycle,") ||
    conversationStorage.includes("AnchorConversationDirectoryMechanism") ||
    records.some((record) =>
      record.text.includes("AnchorConversationDirectoryMechanism"),
    ) ||
    !conversationStorage.includes("implements") &&
      !conversationStorage.includes("ConversationDirectoryStorage") ||
    !composition.includes("new ConversationDirectoryApplicationService({") ||
    composition.split("new ConversationDirectoryApplicationService({").length - 1 !== 1 ||
    !composition.includes("createConversationDirectoryProductApiContribution(") ||
    !composition.includes("...CONVERSATION_DIRECTORY_PRODUCT_API_EXACT_SET.operations") ||
    !localConversationApplication.includes(
      "new ConversationDirectoryApplicationService({",
    ) ||
    !localConversationApplication.includes("resume: {") ||
    !localConversationRpc.includes("this.#application.queryList()") ||
    !localConversationRpc.includes("this.#application.queryHistory({") ||
    !localConversationRpc.includes("this.#application.create()") ||
    !localConversationRpc.includes("this.#application.rename({") ||
    !localConversationRpc.includes("this.#application.clear({") ||
    !localConversationRpc.includes("this.#application.delete({") ||
    !localConversationRpc.includes("this.#application.resume({") ||
    !localConversationRpc.includes("this.#application.abort({") ||
    !localConversationRpc.includes("this.#application.resolveUncertain({") ||
    !localConversationRpc.includes(
      "resolutionFence: createConversationResolutionFence(value.ownerEpoch)",
    ) ||
    !localConversationRpc.includes(
      'from "@zhixing/owner-kernel/conversation-control"',
    ) ||
    !localConversationRpc.includes(
      "this.#application.prepareAgentTurnIdentity({",
    ) ||
    !localConversationRpc.includes("this.#application.admitAgentTurn({") ||
    !localConversationRpc.includes("this.#application.queryTaskList({") ||
    !localConversationRpc.includes("this.#application.updateTaskList({") ||
    !localConversationRpc.includes("this.#application.compact({") ||
    !localConversationRpc.includes("this.#application.queryContextBudget({") ||
    !localConversationRpc.includes("this.#application.queryUsage({") ||
    !localConversationRpc.includes("this.#application.querySecurity({") ||
    !localConversationRpc.includes("return outcome.result;") ||
    localConversationRpc.includes("return outcome;") ||
    localConversationRpc.indexOf(
      "this.#application.prepareAgentTurnIdentity({",
    ) > localConversationRpc.indexOf("this.#application.admitAgentTurn({") ||
    /this\.input\.owner\.admitTurn\s*\(/u.test(localConversationRpc) ||
    /this\.input\.owner\.(?:cancelTurns|cancelConversationRuns|resolveDurableUncertain|resolveConversationUncertain)\s*\(/u.test(
      localConversationRpc,
    ) ||
    /this\.input\.owner\.(?:mutateSession|sessionState\.readTaskList)\s*\(/u.test(
      localConversationRpc,
    ) ||
    /case "session\.clear":(?:(?!case "session\.delete")[\s\S])*?this\.#mutate\(/u.test(
      localConversationRpc,
    ) ||
    /case "session\.delete":(?:(?!case "session\.taskList")[\s\S])*?this\.#mutate\(/u.test(
      localConversationRpc,
    ) ||
    !localConversationOwner.includes("commitConversationClear:") ||
    !localConversationOwner.includes("projectConversationClear({") ||
    !localConversationOwner.includes("commitConversationDelete:") ||
    !localConversationOwner.includes("projectConversationDelete({") ||
    !accessSurfaces.includes("projectConversationClear({") ||
    !accessSurfaces.includes("projectConversationDelete({") ||
    !composition.includes("clear: createAnchorConversationClearCommitPort({") ||
    !composition.includes("delete: createAnchorConversationDeleteCommitPort({") ||
    !composition.includes("resume: createAnchorConversationResumePort({") ||
    !composition.includes(
      "runControl: createAnchorConversationRunControlPort({",
    ) ||
    !composition.includes(
      "taskLists: createAnchorConversationTaskListPort({",
    ) ||
    !composition.includes(
      "compact: createAnchorConversationCompactPort({",
    ) ||
    !composition.includes(
      "usage: createAnchorConversationUsageProjectionPort({",
    ) ||
    !composition.includes(
      "security: createAnchorConversationSecurityProjectionPort({",
    ) ||
    !conversationTaskListApplication.includes(
      "createAnchorConversationTaskListPort",
    ) ||
    !conversationTaskListApplication.includes(
      "input.conversations.runMaintenanceExisting",
    ) ||
    !conversationTaskListApplication.includes("input.taskLists.set(") ||
    !conversationCompactApplication.includes(
      "createAnchorConversationCompactPort",
    ) ||
    !conversationCompactApplication.includes(
      "input.conversations.compactExisting(",
    ) ||
    !localConversationApplication.includes(
      'compactExisting: async () => ({ status: "unavailable" as const })',
    ) ||
    !localConversationApplication.includes(
      "inspectContextBudgetExisting: async () => ({",
    ) ||
    !localConversationApplication.includes(
      "inspectUsageExisting: async () => ({ status: \"unavailable\" as const })",
    ) ||
    !localConversationApplication.includes(
      "inspectSecurityExisting: async () => ({ status: \"unavailable\" as const })",
    ) ||
    !conversationUsageApplication.includes(
      "createAnchorConversationUsageProjectionPort",
    ) ||
    !conversationUsageApplication.includes(
      "input.conversations.inspectContextBudgetExisting(",
    ) ||
    !conversationUsageApplication.includes(
      "input.conversations.inspectUsageExisting(",
    ) ||
    !conversationSecurityApplication.includes(
      "createAnchorConversationSecurityProjectionPort",
    ) ||
    !conversationSecurityApplication.includes(
      "input.conversations.inspectSecurityExisting(",
    ) ||
    !localConversationApplication.includes("taskLists: input.owner.taskLists") ||
    !localConversationOwner.includes("readonly taskLists: ConversationTaskListPort") ||
    !localConversationOwner.includes("taskLists,") ||
    !accessSurfaces.includes("createConversationTaskListChangedFact(") ||
    context.includes("taskListSnapshot") ||
    context.includes("taskListUpdate") ||
    byPath.has("packages/cli/src/runtime/task-list-actions.ts") ||
    !conversationRunControlBinding.includes(
      "createAnchorConversationRunControlPort",
    ) ||
    !conversationRunControlBinding.includes("cancelDurableRuns({") ||
    !conversationRunControlBinding.includes("resolveDurableUncertain({") ||
    !conversationRunControlBinding.includes(
      "ownerEpoch: parseConversationResolutionFence(resolutionFence)",
    ) ||
    !conversationRunControlBinding.includes(
      'from "@zhixing/owner-kernel/conversation-control"',
    ) ||
    !conversationRunControlBinding.includes("durableControlPrincipal({") ||
    !localConversationApplication.includes("runControl: {") ||
    !localConversationOwner.includes("cancelConversationRuns:") ||
    !localConversationOwner.includes("resolveConversationUncertain:") ||
    !localConversationOwner.includes(
      "ownerEpoch: parseConversationResolutionFence(input.resolutionFence)",
    ) ||
    !localConversationOwner.includes(
      'from "@zhixing/owner-kernel/conversation-control"',
    ) ||
    !localConversationOwner.includes("createConversationAgentTurnAdmissionPort({") ||
    !localConversationOwner.includes("createAgentTurnExecution:") ||
    /\b(?:runTurn|admitTurn):/u.test(localConversationOwner) ||
    localConversationOwner.includes("cancelTurns:") ||
    !conversationResumeBinding.includes("createAnchorConversationResumePort") ||
    !conversationResumeBinding.includes("restoreIdentity:") ||
    !conversationResumeBinding.includes("recoverDependentLifecycle:") ||
    !conversationResumeBinding.includes("reviewAdoption:") ||
    sessionResume.length === 0 ||
    !/const alreadyObserved\s*=\s*manager\s*\.getObserverConnectionIds\(params\.conversationId\)\s*\.has\(connectionId\)/u.test(
      sessionResume,
    ) ||
    !/const observerAdded\s*=\s*manager\.addObserver\(\s*params\.conversationId,\s*connectionId/u.test(
      sessionResume,
    ) ||
    !sessionResume.includes("manager.addObserver(") ||
    !sessionResume.includes("productApi.command(CONVERSATION_RESUME_COMMAND") ||
    sessionResume.indexOf("manager.addObserver(") >
      sessionResume.indexOf("productApi.command(CONVERSATION_RESUME_COMMAND") ||
    !/error\.code === "not-found"\s*&&\s*observerAdded\s*&&\s*!alreadyObserved[\s\S]*?manager\.removeObserver\(params\.conversationId, connectionId\)/u.test(
      sessionResume,
    ) ||
    /requireDirectory\(|\.advancementRecovery|conversationAdoptionReview/u.test(
      sessionResume,
    ) ||
    localResume.length === 0 ||
    !localResume.includes("this.#subscribe(conversationId, connection)") ||
    !localResume.includes("this.#application.resume({") ||
    localResume.indexOf("this.#subscribe(conversationId, connection)") >
      localResume.indexOf("this.#application.resume({") ||
    /input\.owner\.(?:listConversations|sessionState\.readSessionMeta)/u.test(
      localResume,
    ) ||
    context.includes("conversationAdoptionReview") ||
    !conversationClearBinding.includes(
      "clearStoredView: (id) => input.directory.clearStoredView(id)",
    ) ||
    /(?:input\.directory|conversationDirectory)\.ensure\(/u.test(
      conversationClearBinding,
    ) ||
    !conversationStorage.includes("clearStoredView(id)") ||
    /conversationDirectory\.clear\(/u.test(composition) ||
    /conversationDirectory\.clear\(/u.test(accessSurfaces) ||
    !conversationDeleteBinding.includes("createAnchorConversationDeleteCommitPort") ||
    !conversationDeleteBinding.includes("projectConversationDelete({") ||
    conversationDeleteBinding.includes("ConversationWorksceneDeleteProjectionBridge") ||
    conversationDeleteBinding.includes("createConversationWorksceneDeleteProjectionBridge(") ||
    !conversationDeleteBinding.includes("!deletionAlreadyCommitted ||") ||
    /(?:input\.storage|conversationDirectory)\.ensure\(/u.test(
      conversationDeleteBinding,
    ) ||
    !worksceneApplication.includes(
      "interface WorksceneConversationStorageProjectionCleanupPort",
    ) ||
    !worksceneApplicationAdapter.includes(
      "createAnchorWorksceneConversationStorageProjectionCleanup(",
    ) ||
    !worksceneApplicationAdapter.includes("parseConversationId(conversationId)") ||
    !worksceneApplicationAdapter.includes("storage.deleteStoredConversation(conversationId)") ||
    worksceneConversationCleanupFactoryConsumers.length !== 1 ||
    worksceneConversationCleanupFactoryConsumers[0]?.relative !==
      "packages/cli/src/serve/command.ts" ||
    worksceneConversationCleanupConsumers.length !== 1 ||
    worksceneConversationCleanupConsumers[0]?.relative !==
      "packages/cli/src/serve/workscene-session-owner.ts" ||
    directConversationStorageDeleteConsumers.length !== 0 ||
    !/conversationStorageProjectionCleanup:\s*worksceneConversationStorageProjectionCleanup/u.test(
      composition,
    ) ||
    !worksceneDirectory.includes(
      "conversationStorageProjectionCleanup: WorksceneConversationStorageProjectionCleanupPort",
    ) ||
    worksceneDirectory.includes("deleteStoredConversation") ||
    !worksceneSessionOwner.includes(
      ".removeCommittedProjection({",
    ) ||
    worksceneSessionOwner.includes("deleteStoredConversation") ||
    records.some((record) =>
      /ConversationWorksceneDeleteProjectionBridge|createConversationWorksceneDeleteProjectionBridge|conversationDeleteProjectionBridge|deleteConversationStorageProjection/u.test(
        record.text,
      ),
    ) ||
    worksceneRemoveScene.length === 0 ||
    worksceneRemoveScene.indexOf("authority.deleteWorksceneSession({") < 0 ||
    worksceneRemoveScene.indexOf(".removeCommittedProjection({") <
      worksceneRemoveScene.indexOf("authority.deleteWorksceneSession({") ||
    worksceneRemoveScene.indexOf("this.#sceneStorageRemoval.removeScene(sceneId)") <
      worksceneRemoveScene.indexOf(".removeCommittedProjection({") ||
    !conversationStorage.includes("deleteStoredConversation(id)") ||
    /manager\.writeDurableSession\([\s\S]*?mutation: \{ kind: "conversation-delete" \}/u.test(
      sessionHandler,
    ) ||
    /requireConversations\(ctx\.server\)\.delete\(/u.test(sessionHandler) ||
    /manager\.writeDurableSession\([\s\S]*?mutation: \{ kind: "window-op", op: "clear" \}/u.test(
      sessionHandler,
    ) ||
    /input\.owner\.(?:createConversation|sessionState\.readTranscriptTail)\(/u.test(
      localConversationRpc,
    ) ||
    sessionAgentAdmission.length === 0 ||
    !sessionAgentAdmission.includes(
      "productApi.command(\n      CONVERSATION_ADMIT_AGENT_TURN_COMMAND",
    ) ||
    !sessionAgentAdmission.includes("turnIdentity: input.turnIdentity") ||
    /turnIdentitySource|usesDurableTurnProtocol/u.test(sessionAgentAdmission) ||
    /input\.manager\.(?:admitTurn|admitDurableTurn)\s*\(/u.test(
      sessionAgentAdmission,
    ) ||
    !conversationAgentTurnAdmission.includes(
      "createConversationAgentTurnAdmissionPort",
    ) ||
    !conversationAgentTurnAdmission.includes("input.manager.admitTurn({") ||
    !conversationAgentTurnAdmission.includes("input.manager.admitDurableTurn({") ||
    !conversationAgentTurnAdmission.includes("start: admitted.task.execute") ||
    ownerKernelIndex.includes("conversation-agent-turn-admission") ||
    conversationAgentTurnAdmissionExport?.types !==
      "./dist/conversation-agent-turn-admission.d.ts" ||
    conversationAgentTurnAdmissionExport?.import !==
      "./dist/conversation-agent-turn-admission.js" ||
    duplicateConversationAgentTurnAdmissionExports.length > 0 ||
    ownerKernelBuild.split(
      '"src/conversation-agent-turn-admission.ts"',
    ).length - 1 !== 1 ||
    !composition.includes(
      'from "@zhixing/owner-kernel/conversation-agent-turn-admission"',
    ) ||
    !composition.includes("agentTurns: createConversationAgentTurnAdmissionPort({") ||
    !localConversationApplication.includes("agentTurns: input.owner.agentTurnAdmission") ||
    !conversationControl.includes("createConversationResolutionFence") ||
    !conversationControl.includes("parseConversationResolutionFence") ||
    !conversationControl.includes("CONVERSATION_RESOLUTION_FENCE_PREFIX") ||
    ownerKernelIndex.includes("conversation-control") ||
    ownerKernelIndex.includes("createConversationResolutionFence") ||
    conversationControlExport?.types !== "./dist/conversation-control.d.ts" ||
    conversationControlExport?.import !== "./dist/conversation-control.js" ||
    duplicateConversationControlExports.length > 0 ||
    ownerKernelBuild.split('"src/conversation-control.ts"').length - 1 !== 1
  ) {
    failures.push(
      "Conversation directory management lacks one domain application and Product API owner",
    );
  }
  const deliveryApplicationExport = coreManifest?.exports?.["./delivery/application"];
  const duplicateDeliveryApplicationExports = Object.entries(coreManifest?.exports ?? {})
    .filter(([subpath, conditions]) =>
      subpath !== "./delivery/application" &&
      conditions &&
      typeof conditions === "object" &&
      (conditions.types === deliveryApplicationExport?.types ||
        conditions.import === deliveryApplicationExport?.import)
    );
  if (
    deliveryApplicationExport?.types !==
      "./dist/delivery/application.d.ts" ||
    deliveryApplicationExport?.import !==
      "./dist/delivery/application.js" ||
    duplicateDeliveryApplicationExports.length > 0 ||
    coreBuild.split('"src/delivery/application.ts"').length - 1 !== 1 ||
    coreBuild.includes("resolution-application") ||
    coreIndex.includes("delivery/application") ||
    deliveryIndex.includes("./application.js") ||
    deliveryApplication.includes("../authority/") ||
    deliveryApplication.includes("AuthorityStorageError") ||
    !deliveryApplication.includes("class DeliveryProjectionInvariantError")
  ) {
    failures.push("Delivery application must have one narrow non-root core subpath");
  }
  const channelDeliveryEffectExport = coreManifest?.exports?.["./delivery/channel-effect"];
  const duplicateChannelDeliveryEffectExports = Object.entries(coreManifest?.exports ?? {})
    .filter(([subpath, conditions]) =>
      subpath !== "./delivery/channel-effect" &&
      conditions &&
      typeof conditions === "object" &&
      (conditions.types === channelDeliveryEffectExport?.types ||
        conditions.import === channelDeliveryEffectExport?.import)
    );
  if (
    channelDeliveryEffectExport?.types !== "./dist/delivery/channel-effect.d.ts" ||
    channelDeliveryEffectExport?.import !== "./dist/delivery/channel-effect.js" ||
    duplicateChannelDeliveryEffectExports.length > 0 ||
    coreBuild.split('"src/delivery/channel-effect.ts"').length - 1 !== 1 ||
    coreIndex.includes("channel-effect") ||
    deliveryIndex.includes("channel-effect")
  ) {
    failures.push("Delivery Channel effect must have one narrow non-root adapter subpath");
  }
  for (const retiredPath of [
    "packages/core/src/skills/store.ts",
    "packages/core/src/skills/paths.ts",
  ]) {
    if (byPath.has(retiredPath)) {
      failures.push(`${retiredPath}: retired filesystem Skill owner remains reachable`);
    }
  }
  if (
    /\b(?:SkillStore|getSkillsRoot)\b|skill-(?:legacy|materialized)|intent:skill-materialization|SKILL_PENDING_PREFIX|#importLegacyCatalog|materialize(?:Authority|Usage|Archive)/u.test(
      skillAuthority,
    ) ||
    /from\s+["']node:fs|\b(?:readFile|writeFile|readdir|mkdir|rename|rm)\s*\(/u.test(
      skillAuthority,
    )
  ) {
    failures.push(
      "Skill Authority adapter retains legacy directory import or filesystem materialization",
    );
  }
  if (
    !skillAuthority.includes("reducerVersion: 2") ||
    skillAuthority.split("#assertCommittedMutation(").length - 1 < 3 ||
    !skillAuthority.includes("await this.#refreshDurableProjection()") ||
    skillAuthority.includes("skillPendingKey(")
  ) {
    failures.push(
      "Skill staged participant does not validate committed Authority replay without a second effect stream",
    );
  }
  if (/\b(?:SkillStore|getSkillsRoot)\b/u.test(setupDelivery)) {
    failures.push("Anchor composition still constructs the retired filesystem Skill owner");
  }
  if (
    /(?:\.\/store\.js|\.\/paths\.js|\bSkillStore\b|\bgetSkillsRoot\b)/u.test(
      skillIndex,
    )
  ) {
    failures.push("core Skill root barrel exposes retired filesystem storage");
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
  const managementStart = application.indexOf(
    "export type SkillCatalogManagementStatePatch",
  );
  const managementEnd = application.indexOf(
    "function requireSkillId(",
  );
  const managementApplication = managementStart >= 0 && managementEnd > managementStart
    ? application.slice(managementStart, managementEnd)
    : "";
  if (
    !managementApplication.includes("interface SkillCatalogManagementCorrectnessPort") ||
    !managementApplication.includes("class SkillCatalogApplicationService") ||
    !managementApplication.includes("this.#correctness.readCatalog({ includeDisabled: true })") ||
    !managementApplication.includes("this.#correctness.readEntry(skillId)") ||
    !managementApplication.includes("await this.#correctness.commit(mutation)") ||
    /\b(?:GlobalStatePort|GlobalControlCallContext|anchorEpoch|SkillMutationConflictError)\b|randomUUID|global-state-adapter/u.test(
      managementApplication,
    )
  ) {
    failures.push(
      "Skill Catalog management application is not topology-neutral or lacks one finite Correctness port",
    );
  }
  if (
    !skillManagementCorrectness.includes(
      "createAnchorSkillCatalogManagementCorrectnessPort",
    ) ||
    !skillManagementCorrectness.includes("GlobalStatePort") ||
    !skillManagementCorrectness.includes("GlobalControlCallContext") ||
    !skillManagementCorrectness.includes("typeof options.globalState === \"function\"") ||
    !skillManagementCorrectness.includes("typeof options.anchorEpoch === \"function\"") ||
    !skillManagementCorrectness.includes('context("skill-list")') ||
    !skillManagementCorrectness.includes('context("skill-get")') ||
    !skillManagementCorrectness.includes("context(`skill-${mutation.kind}`)") ||
    !skillManagementCorrectness.includes("error instanceof SkillMutationConflictError")
  ) {
    failures.push(
      "Skill Catalog management topology fence lacks one current-generation Correctness adapter",
    );
  }
  const projectionStart = application.indexOf(
    "export interface SkillCatalogKernelProjectionSource",
  );
  const projectionEnd = application.indexOf(
    "/** Skill-owned input for the save_skill create/update use case.",
  );
  const projectionApplication = projectionStart >= 0 && projectionEnd > projectionStart
    ? application.slice(projectionStart, projectionEnd)
    : "";
  if (
    !projectionApplication.includes(
      "class SkillCatalogKernelProjectionApplicationService",
    ) ||
    !projectionApplication.includes("interface SkillCatalogKernelProjectionSource") ||
    !projectionApplication.includes("entry.mode === mode && !entry.disabled") ||
    !projectionApplication.includes(".slice(0, SKILL_CATALOG_KERNEL_TOP_N)") ||
    !projectionApplication.includes("builtinIndexEntries(mode, userIds)") ||
    !projectionApplication.includes("content: renderSkillIndex([") ||
    !projectionApplication.includes("return Object.freeze({") ||
    !projectionApplication.includes("catalogRevision: snapshot.catalogRevision")
  ) {
    failures.push(
      "Skill Catalog Kernel projection rules lack one immutable domain application owner",
    );
  }
  if (
    !executionSnapshot.includes("skills: [...input.skills],") ||
    /skills:\s*\[\.\.\.input\.skills\]\.sort/u.test(executionSnapshot)
  ) {
    failures.push(
      "Signed execution assets do not preserve Skill Authority order",
    );
  }
  if (
    executionAssetCache.includes("filterReadableSkills") ||
    executionAssetCache.split("assertReadableSkills(").length - 1 < 4 ||
    !executionAssetCache.includes("await assertReadableSkill(entry, this.artifacts)") ||
    executionAssetCache.includes("#safeCurrent")
  ) {
    failures.push(
      "Executor execution assets can expose a partial or corrupt Skill catalog",
    );
  }
  if (
    executionAssetCache.split("assertSkillCatalogTransition(").length - 1 < 3 ||
    !executionAssetCache.includes("nextRevision < current.skillCatalogRevision") ||
    !executionAssetCache.includes("nextRevision === current.skillCatalogRevision") ||
    !executionAssetCache.includes(
      "skillCatalogIdentity(nextRevision, nextSkills)",
    )
  ) {
    failures.push(
      "Executor execution assets do not reject Skill rollback or same-revision equivocation",
    );
  }
  if (
    /(?:SkillCatalogKernelProjection|renderSkillIndex|builtinIndexEntries)/u.test(
      executionAssetCache,
    )
  ) {
    failures.push(
      "Executor execution asset cache became a second Skill projection owner",
    );
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
  const commit = application.indexOf("await this.#correctness.commit(mutation)");
  const fact = application.lastIndexOf('kind: "skill-catalog-changed"');
  if (
    !(commit >= 0 && fact > commit) ||
    !application.includes("catalogRevision: committed.catalogRevision")
  ) {
    failures.push("Skill Catalog fact must use the exact revision returned after authority commit");
  }
  if (
    !context.includes("productApi?: ProductApiDispatcher") ||
    !context.includes('from "@zhixing/core/product-api"') ||
    /import\s+(?:type\s+)?\{[^}]*ProductApiDispatcher[^}]*\}\s+from\s+["']@zhixing\/core["']/u.test(context) ||
    context.includes("skillCatalog") ||
    context.includes("SkillCatalogApplication") ||
    context.includes("SkillDirectory") ||
    context.includes("resolveDelivery")
  ) {
    failures.push("ServerContext must expose only the Product API dispatcher binding");
  }
  for (const [relative, text] of [
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
  if (
    composition.split("new ProductApiDispatcher(").length - 1 !== 1 ||
    composition.split("createSkillCatalogProductApiContribution(").length - 1 !== 1 ||
    composition.split("createDeliveryResolutionProductApiContribution(").length - 1 !== 1 ||
    composition.split("new SkillCatalogApplicationService(").length - 1 !== 1 ||
    composition.split("createAnchorSkillCatalogManagementCorrectnessPort({").length - 1 !== 1 ||
    !composition.includes('from "@zhixing/core/skills/catalog-correctness"') ||
    !composition.includes("globalState: () => authorityRuntime.globalState!") ||
    !composition.includes("anchorEpoch: () => authorityRuntime.anchorEpoch")
  ) {
    failures.push(
      "Anchor composition root must install one Product API dispatcher with Skill and Delivery contributions",
    );
  }
  const productApiConstructions = records.reduce(
    (count, record) => count + (record.text.split("new ProductApiDispatcher(").length - 1),
    0,
  );
  if (productApiConstructions !== 1) {
    failures.push("Persistent production Host must have exactly one Product API dispatcher construction");
  }
  if (
    !productApi.includes("export class ProductApiDispatcher") ||
    !productApi.includes("Duplicate Product API operation contribution") ||
    !productApi.includes("Missing Product API operation contribution") ||
    !productApi.includes("Unknown Product API operation") ||
    !productApi.includes("Product API operation kind mismatch") ||
    !productApi.includes("Product API operation descriptor mismatch") ||
    !productApi.includes("Product API command fact set mismatch") ||
    !productApi.includes("Product API operation descriptor is not sealed") ||
    !productApi.includes("supports(descriptor: ProductApiOperationDescriptor)") ||
    !productApi.includes("Object.freeze(this)") ||
    /SkillCatalog|skillId|pinned|disabled|skill\.list|skill\.changed/u.test(productApi)
  ) {
    failures.push("Product API dispatcher is not finite, fail-closed, sealed or domain-neutral");
  }
  if (
    !deliveryApplication.includes('"delivery.command.resolve-uncertain"') ||
    !deliveryApplication.includes("DeliveryUncertainResolutionApplicationService") ||
    !deliveryApplication.includes("decideDeliveryUncertainResolution(") ||
    !deliveryApplication.includes("readonly resolutionFence: DeliveryResolutionFence") ||
    !deliveryApplication.includes("createDeliveryResolutionProductApiContribution") ||
    !deliveryApplication.includes("DELIVERY_RESOLUTION_PRODUCT_API_EXACT_SET") ||
    !deliveryApplication.includes("facts: []") ||
    /\b(?:anchorEpoch|currentAnchorEpoch|openedAnchorEpoch|resolvedAnchorEpoch)\b/u.test(
      deliveryApplication,
    ) ||
    /\b(?:openedAnchorEpoch|resolvedAnchorEpoch)\b/u.test(deliveryTypes) ||
    deliveryApplication.includes("DeliveryAuthority") ||
    deliveryApplication.includes("ControlAdmissionJournal")
  ) {
    failures.push(
      "Delivery domain does not uniquely own its finite uncertain-resolution application command",
    );
  }
  const deliveryLifecycleTransactionConsumers = records
    .filter((record) => record.text.includes(".transactDeliveryLifecycle"))
    .map((record) => record.relative);
  if (
    !deliveryApplication.includes("interface DeliveryLifecycleApplication") ||
    !deliveryApplication.includes("class DeliveryLifecycleApplicationService") ||
    !deliveryApplication.includes("deliveryUnknownOutcomeDisposition(") ||
    !deliveryApplication.includes("deliveryFailureDisposition(") ||
    !deliveryApplication.includes("deliveryDeadlineAt(") ||
    !deliveryApplication.includes("decideDeliveryAttemptOutcomePolicy(") ||
    !deliveryApplication.includes("responseBindingDigest") ||
    !deliveryLifecyclePolicy.includes("deliveryAttemptAuthorizationMatches") ||
    !deliveryLifecyclePolicy.includes("deliveryUnknownOutcomeDisposition") ||
    !deliveryLifecyclePolicy.includes("deliveryFailureDisposition") ||
    !deliveryAuthority.includes("transactDeliveryLifecycle<Value>") ||
    /\basync\s+(?:claim|recordPreflightFailure|recordOutcome)\s*\(/u.test(deliveryAuthority) ||
    deliveryAuthority.includes("function makeAttemptStarted(") ||
    deliveryAuthority.includes("function deliveryFailureDisposition(") ||
    deliveryAuthority.includes("function deliveryUnknownOutcomeDisposition(") ||
    !deliveryObligationCorrectness.includes("createOwnerDeliveryLifecycleBinding") ||
    !deliveryObligationCorrectness.includes(
      "authority.transactDeliveryLifecycle<DeliveryLifecycleCommit<Value>>",
    ) ||
    !deliveryObligationCorrectness.includes("projectDeliveryApplicationProjection(") ||
    !deliveryObligationCorrectness.includes("bindDeliveryLifecycleDecisionRecords(") ||
    !deliveryAuthority.includes("projectDeliveryApplicationProjection(") ||
    !deliveryAuthority.includes("bindDeliveryLifecycleDecisionRecords(") ||
    !deliveryObligationCorrectness.includes("DeliveryProjectionInvariantError") ||
    !deliveryObligationCorrectness.includes(
      'new AuthorityStorageError("commit-log-corrupt", error.message',
    ) ||
    !deliveryObligationCorrectness.includes("cause: error") ||
    deliveryLifecycleTransactionConsumers.length !== 1 ||
    deliveryLifecycleTransactionConsumers[0] !==
      "packages/owner-kernel/src/delivery-obligation-correctness.ts" ||
    deliveryPipeline.includes("DeliveryAuthority") ||
    deliveryPipeline.includes("readonly authority:") ||
    /#authority\.(?:claim|recordPreflightFailure|recordOutcome)\s*\(/u.test(
      deliveryPipeline,
    ) ||
    !deliveryPipeline.includes("readonly application: DeliveryLifecycleApplication") ||
    !deliveryPipeline.includes("readonly projection: DeliveryLifecycleProjectionPort") ||
    !deliveryPipeline.includes("this.#projection.statusNotice(") ||
    deliveryPipeline.includes("deliveryProjectionStatusNotice(") ||
    !deliveryPipeline.includes("this.#application.claim(") ||
    !deliveryPipeline.includes("this.#application.recordPreflightFailure(") ||
    !deliveryPipeline.includes("this.#application.recordOutcome(") ||
    deliveryPipeline.includes("baseRetryDelayMs") ||
    !setupDelivery.includes("createOwnerDeliveryLifecycleBinding") ||
    !setupDelivery.includes("application: deliveryLifecycle().application") ||
    !setupDelivery.includes("projection: deliveryLifecycle().projection") ||
    deliveryIndex.includes("DeliveryLifecycleApplication") ||
    coreIndex.includes("DeliveryLifecycleApplication")
  ) {
    failures.push(
      "Delivery attempt lifecycle does not have one domain application and one narrow Correctness transaction",
    );
  }
  if (
    !channelDeliveryEffect.includes("createChannelDeliveryEffect(") ||
    !channelDeliveryEffect.includes("new OutboxRegistry(") ||
    !channelDeliveryEffect.includes('endpointKind: "channel"') ||
    !channelDeliveryEffect.includes("responseLossEvidence(") ||
    !channelDeliveryEffect.includes('kind: "unverified"') ||
    channelDeliveryEffect.includes('kind: "manual-resolution"') ||
    channelDeliveryEffect.includes('kind: "idempotent-redrive"') ||
    !channelDeliveryEffect.includes("export interface ChannelDeliveryEffectSource") ||
    !channelDeliveryEffect.includes("channels.send(target, content") ||
    !channelDeliveryEffect.includes(
      'channels.status(endpoint.target.channelId) === "connected"',
    ) ||
    channelDeliveryEffect.includes("ChannelRegistry") ||
    channelDeliveryEffect.includes("ChannelAdapter") ||
    channelDeliveryEffect.includes("DeliveryLifecycleApplication") ||
    channelDeliveryEffect.includes("DeliveryAuthority") ||
    channelDeliveryEffect.includes("recordOutcome") ||
    deliveryPipeline.includes("DeliverySender") ||
    deliveryPipeline.includes("readonly sender") ||
    deliveryPipeline.includes("channelAuthorityDeliveryTransport") ||
    deliveryPipeline.includes("singleDeliveryTransport") ||
    deliveryTypes.includes("interface DeliverySender") ||
    deliveryTypes.includes("interface DeliverySendMeta") ||
    deliveryOutbox.includes("authorityOrigin") ||
    deliveryOutbox.includes("normalizeAuthorityDeliveryResult") ||
    deliveryOutbox.includes("authorityDeliveryFailure") ||
    !setupDelivery.includes(
      'from "@zhixing/core/delivery/channel-effect"',
    ) ||
    !setupDelivery.includes("createChannelDeliveryEffect(channels") ||
    setupDelivery.includes("createOutboxSender") ||
    setupDelivery.includes("channelAuthorityDeliveryTransport") ||
    setupDelivery.includes("Channel not found") ||
    setupDelivery.includes("adapter.send(")
  ) {
    failures.push(
      "Delivery send effect is not uniquely domain-owned, Channel-implemented and Host-assembled",
    );
  }
  const deliveryAdmissionTransactionConsumers = records
    .filter((record) => record.text.includes(".transactDeliveryAdmission"))
    .map((record) => record.relative);
  if (
    !deliveryApplication.includes("interface DeliveryLifecycleAdmissionState") ||
    !deliveryApplication.includes("decideDeliveryLifecycleBindings(") ||
    !deliveryApplication.includes("decideLifecycleAdmissionInstall(") ||
    !deliveryApplication.includes("lifecycleAcceptedDeliveryItems(") ||
    !deliveryApplication.includes("async settleAcceptedWork(input:") ||
    !deliveryApplication.includes('input.strategy === "immediate"') ||
    !deliveryApplication.includes('item.state === "uncertain"') ||
    !deliveryApplication.includes("Delivery accepted work did not reach a durable terminal state") ||
    !deliveryAuthority.includes("transactDeliveryAdmission<Value>") ||
    deliveryAuthority.includes("installLifecycleAdmission(") ||
    deliveryAuthority.includes("restoreLifecycleAdmission(") ||
    deliveryAuthority.includes("sealLifecycleAdmission(") ||
    deliveryAuthority.includes("releaseLifecycleAdmission(") ||
    deliveryAuthority.includes("lifecycleAcceptedWorkItems(") ||
    deliveryAuthority.includes("#lifecycleBindings(") ||
    !deliveryObligationCorrectness.includes("authority.transactDeliveryAdmission<Value>") ||
    deliveryAdmissionTransactionConsumers.length !== 1 ||
    deliveryAdmissionTransactionConsumers[0] !==
      "packages/owner-kernel/src/delivery-obligation-correctness.ts" ||
    deliveryPipeline.includes("settleAcceptedWorkForLifecycle(") ||
    deliveryPipeline.includes("lifecycleAcceptedWorkItems(") ||
    deliveryPipeline.includes('input.strategy === "immediate"') ||
    deliveryPipeline.includes("requires the existing user decision") ||
    !deliveryPipeline.includes("implements DeliveryLifecycleEffectPort") ||
    !deliveryPipeline.includes("async flushQuiescedOnce(): Promise<void>") ||
    !setupDelivery.includes("readonly lifecycle: DeliveryAcceptedWorkLifecyclePort") ||
    !setupDelivery.includes("deliveryLifecycle().application.settleAcceptedWork({") ||
    !setupDelivery.includes("effects: authorityDelivery!") ||
    !accessSurfaces.includes("await deliveryStack.lifecycle.restore(") ||
    accessSurfaces.includes("authority.restoreLifecycleAdmission") ||
    !composition.includes("ctx.deliveryStack?.lifecycle.install({") ||
    !composition.includes("ctx.deliveryStack?.lifecycle.settle({") ||
    /deliveryStack\?*\.authority\.(?:install|restore|seal|release)LifecycleAdmission/u.test(
      composition,
    ) ||
    /\.authority\.(?:install|restore|seal|release)LifecycleAdmission/u.test(
      executorRoleRuntime,
    )
  ) {
    failures.push(
      "Delivery accepted-work lifecycle does not have one domain application, one admission transaction and effect-only pipeline",
    );
  }
  if (
    !deliveryControl.includes("createDeliveryResolutionCorrectnessPort") ||
    !deliveryControl.includes("input.admission.applyAuthority") ||
    !deliveryControl.includes("input.authority.coordinate") ||
    !deliveryControl.includes("createDeliveryResolutionFence(") ||
    !deliveryControl.includes("parseDeliveryResolutionFence(") ||
    !deliveryControl.includes("requestedAnchorEpoch !== input.authority.anchorEpoch") ||
    !deliveryControl.includes("projection: projectDeliveryApplicationProjection(state)") ||
    !deliveryControl.includes("decideDeliveryResolution(") ||
    deliveryControl.includes("applyDeliveryResolutionControl") ||
    !setupDelivery.includes("resolutionApplication") ||
    !setupDelivery.includes('await import("@zhixing/owner-kernel/delivery")') ||
    setupDelivery.includes("applyDeliveryResolutionControl") ||
    setupDelivery.includes("createDeliveryControlEnvelope")
  ) {
    failures.push(
      "Delivery uncertain-resolution Correctness adapter or application ownership drifted",
    );
  }
  const deliveryPrepareConsumers = records
    .filter((record) => record.text.includes(".prepareEnqueues("))
    .map((record) => record.relative);
  if (
    !deliveryApplication.includes("interface DeliveryObligation") ||
    !deliveryApplication.includes("class DeliveryObligationApplicationService") ||
    !deliveryApplication.includes('Omit<DeliveryIntentDto, "maxAttempts">') ||
    !deliveryApplication.includes("maxAttempts: this.#maxAttempts") ||
    !deliveryApplication.includes("prepareDeliveryEnqueues(") ||
    !deliveryObligationCorrectness.includes("createDeliveryObligationCorrectnessPort") ||
    !deliveryObligationCorrectness.includes("createOwnerDeliveryParticipant") ||
    deliveryPrepareConsumers.length !== 1 ||
    deliveryPrepareConsumers[0] !==
      "packages/owner-kernel/src/delivery-obligation-correctness.ts" ||
    deliveryParticipant.includes("DeliveryAuthority") ||
    deliveryParticipant.includes("prepareEnqueues") ||
    deliveryParticipant.includes("prepareDeliveryEnqueues") ||
    deliveryParticipant.includes("maxAttempts") ||
    !deliveryParticipant.includes('from "@zhixing/core/delivery/application"') ||
    !deliveryParticipant.includes("this.#application.prepare(inputs, commitAt)") ||
    !deliveryAuthority.includes('"Delivery lifecycle admission projection"') ||
    ownerKernelIndex.includes("delivery-obligation-correctness") ||
    !ownerKernelDelivery.includes("delivery-obligation-correctness") ||
    !setupDelivery.includes("createOwnerDeliveryParticipant,") ||
    setupDelivery.includes("ownerRuntime!.createOwnerDeliveryParticipant") ||
    setupDelivery.includes("ownerRuntime.createOwnerDeliveryParticipant")
  ) {
    failures.push(
      "Delivery obligations do not have one domain decision and one narrow Correctness adapter",
    );
  }
  for (const [relative, text, method] of [
    [
      "packages/owner-kernel/src/conversation-assignment.ts",
      conversationAssignment,
      "prepareConversationCommit(",
    ],
    [
      "packages/owner-kernel/src/job-assignment.ts",
      jobAssignment,
      "prepareJobCommit(",
    ],
    [
      "packages/owner-kernel/src/scheduler-user-notices.ts",
      schedulerUserNotices,
      "prepareSchedulerNotices",
    ],
  ]) {
    if (!text.includes(method)) {
      failures.push(`${relative}: Delivery producer bypasses the obligation participant`);
    }
  }
  if (
    !deliveryHandler.includes('from "@zhixing/core/delivery/application"') ||
    !deliveryHandler.includes('from "@zhixing/owner-kernel/delivery"') ||
    !deliveryHandler.includes("productApi.command(DELIVERY_RESOLVE_UNCERTAIN_COMMAND") ||
    !deliveryHandler.includes("resolutionFence: createDeliveryResolutionFence(params.anchorEpoch)") ||
    !deliveryHandler.includes("productApi?.supports(DELIVERY_RESOLVE_UNCERTAIN_COMMAND)") ||
    deliveryHandler.includes("runtimeControl?.resolveDelivery") ||
    deliveryHandler.includes("deliveryStack.resolve")
  ) {
    failures.push("delivery.resolve bypasses the Product API dispatcher");
  }
  if (
    !application.includes('"skill-catalog.query.list"') ||
    !application.includes('"skill-catalog.command.set-state"') ||
    !application.includes('"skill-catalog.command.archive"') ||
    !application.includes('"skill-catalog-changed"') ||
    !application.includes("createSkillCatalogProductApiContribution") ||
    !application.includes("SKILL_CATALOG_PRODUCT_API_EXACT_SET")
  ) {
    failures.push("Skill domain does not own the finite Product API operation and fact contribution");
  }
  if (
    !application.includes("export interface SkillCatalogClient") ||
    !application.includes("query(query: SkillCatalogQuery): Promise<SkillCatalogView>") ||
    !application.includes("command(command: SkillCatalogCommand): Promise<void>") ||
    !application.includes("onFact(handler: (fact: SkillCatalogChangedFact) => void): () => void")
  ) {
    failures.push("Skill domain does not own the stable Query/Command/Fact client contract");
  }
  if (
    !skillClientBinding.includes('from "@zhixing/core/skills/catalog"') ||
    !skillClientBinding.includes("implements SkillCatalogClient") ||
    skillClientBinding.includes('from "@zhixing/core"') ||
    /from\s+["']@zhixing\/(?:cli|server)(?:\/|["'])/u.test(skillClientBinding) ||
    skillClientBinding.includes("as never") ||
    skillClientBinding.includes("[key: string]") ||
    skillClientBinding.includes("?? 0") ||
    !skillClientBinding.includes("decodeSkillCatalogView(") ||
    !skillClientBinding.includes("decodeSkillCatalogChangedFact(") ||
    !skillClientBinding.includes("decodeCommandAcknowledgement(") ||
    !skillClientBinding.includes('requireExactKeys(value, ["skills", "structuralVersion"]);') ||
    !skillClientBinding.includes('requireExactKeys(value, ["structuralVersion"]);') ||
    !skillClientBinding.includes('requireExactKeys(value, ["ok"]);')
  ) {
    failures.push("Skill RPC client binding is not uniquely RPC-owned, domain-bound or strict fail-closed");
  }
  for (const wire of [
    '"skill.list"',
    '"skill.setState"',
    '"skill.archive"',
    '"skill.changed"',
  ]) {
    if (skillClientBinding.split(wire).length - 1 !== 1) {
      failures.push(`Skill RPC client binding wire exact-set drifted: ${wire}`);
    }
  }
  const cliSkillWireOwners = records
    .filter((record) =>
      record.relative.startsWith("packages/cli/src/") &&
      /["']skill\.(?:list|setState|archive|changed)["']/u.test(record.text)
    )
    .map((record) => record.relative);
  if (cliSkillWireOwners.length > 0) {
    failures.push(`Skill wire escaped the unique RPC client binding: ${cliSkillWireOwners.join(", ")}`);
  }
  if (byPath.has("packages/cli/src/runtime/skill-catalog-rpc-client.ts")) {
    failures.push("Skill RPC client binding leaked back into the CLI Surface package");
  }
  if (
    managementFacade.includes("skillList(") ||
    managementFacade.includes("skillSetState(") ||
    managementFacade.includes("skillArchive(") ||
    managementFacade.includes("onSkillChanged(") ||
    /["']skill\.(?:list|setState|archive|changed)["']/u.test(managementFacade)
  ) {
    failures.push("RpcManagementFacade retains a parallel Skill client mainline");
  }
  if (
    repl.split("new SkillCatalogRpcClient(coreHost)").length - 1 !== 1 ||
    !repl.includes('from "@zhixing/rpc/skill-catalog-client"') ||
    repl.includes("./runtime/skill-catalog-rpc-client") ||
    !repl.includes("skillClient,") ||
    !repl.includes("client: skillClient") ||
    !repl.includes("skillClient.onFact(") ||
    !repl.includes("detachSkillCatalogFacts();") ||
    repl.includes("skillStore:") ||
    repl.includes("as never") && repl.includes("managementFacade.skill")
  ) {
    failures.push("REPL does not share one Skill client across manager, dynamic slash and Fact refresh");
  }
  for (const [relative, text] of [
    ["packages/cli/src/skills/manager-controller.ts", skillManager],
    ["packages/cli/src/skills/manager-command.ts", skillManagerCommand],
    ["packages/cli/src/commands/skill-command-source.ts", skillCommandSource],
  ]) {
    if (
      !text.includes('from "@zhixing/core/skills/catalog"') ||
      !text.includes("SkillCatalogClient") ||
      text.includes("SkillManagerStore") ||
      text.includes("listForManagement") ||
      text.includes("listAll()")
    ) {
      failures.push(`${relative}: Skill Surface bypasses the shared domain client contract`);
    }
  }
  const channelSkillSurfaces = records
    .filter((record) =>
      record.relative.startsWith("packages/channels/") &&
      /SkillCatalogClient|skill\.changed|skill\.list|\/skills/u.test(record.text)
    )
    .map((record) => record.relative);
  if (channelSkillSurfaces.length > 0) {
    failures.push("Channel gained an unauthorized empty Skill Product API Surface");
  }
  for (const [relative, text] of [
    ["packages/orchestrator/src/runtime/assignment-skill-port.ts", assignmentSkillPort],
    ["packages/orchestrator/src/runtime/create-agent-runtime.ts", agentRuntime],
    ["packages/tools-builtin/src/skill.ts", builtinSkill],
    ["packages/tools-builtin/src/factories.ts", builtinFactories],
  ]) {
    if (!text.includes('from "@zhixing/core/skills/catalog"')) {
      failures.push(`${relative}: Skill application contract bypasses its domain subpath`);
    }
    for (const match of text.matchAll(
      /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["'](@zhixing\/core)["']/gu,
    )) {
      if (/\bSkillCatalog(?:Save|Admission|Load|KernelProjection)Application(?:Service)?\b/u.test(match[1])) {
        failures.push(`${relative}: Skill application contract leaked back through core root import`);
      }
    }
  }
  if (
    !assignmentSkillPort.includes(
      "createAssignmentSkillProjectionApplication",
    ) ||
    !assignmentSkillPort.includes(
      "new SkillCatalogKernelProjectionApplicationService({",
    ) ||
    !assignmentSkillPort.includes('kind: "skill-catalog"') ||
    !assignmentSkillPort.includes("includeDisabled: true") ||
    !assignmentSkillPort.includes('result.kind !== "skill-catalog"') ||
    assignmentSkillPort.includes("renderAssignmentSkillIndex") ||
    assignmentSkillPort.includes("renderSkillIndex") ||
    assignmentSkillPort.includes("builtinIndexEntries") ||
    assignmentSkillPort.includes("SKILL_INDEX_TOP_N") ||
    assignmentSkillPort.includes("entry.mode === mode") ||
    assignmentSkillPort.includes("entry.disabled")
  ) {
    failures.push(
      "Orchestrator projection adapter interprets Skill fields or omits the raw catalog query",
    );
  }
  if (
    !agentRuntime.includes(
      "new SkillCatalogKernelProjectionApplicationService()",
    ) ||
    !agentRuntime.includes(
      "createAssignmentSkillProjectionApplication(",
    ) ||
    !agentRuntime.includes("entryInstanceEpoch === instanceEpoch") ||
    !agentRuntime.includes("skillIndex.catalogRevision > skillCatalogRevision") ||
    agentRuntime.includes("renderAssignmentSkillIndex") ||
    agentRuntime.includes("renderSkillIndex") ||
    agentRuntime.includes("builtinIndexEntries") ||
    agentRuntime.includes("SKILL_INDEX_TOP_N") ||
    agentRuntime.includes("entry.mode === skillMode") ||
    agentRuntime.includes("entry.disabled")
  ) {
    failures.push(
      "Agent runtime interprets Skill catalog fields or can regress the immutable projection",
    );
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
  if (
    !handler.includes("requireProductApi(ctx.server).query(SKILL_CATALOG_LIST_QUERY") ||
    handler.split("requireProductApi(ctx.server).command(").length - 1 !== 2 ||
    /\bSkillCatalogApplication\b/u.test(handler) ||
    handler.includes(".execute({")
  ) {
    failures.push("Skill RPC binding bypasses the Product API dispatcher");
  }
  const executeCalls = [...handler.matchAll(/const result = await callSkillApplication/gu)]
    .map((match) => match.index);
  const factTransports = [...handler.matchAll(/for \(const fact of result\.facts\) broadcastChanged/gu)]
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
  const contribution = byPath.get(
    "packages/cli/src/serve/device-removal-lifecycle-contribution.ts",
  );
  const access = byPath.get("packages/cli/src/serve/access-surfaces.ts");
  const command = byPath.get("packages/cli/src/serve/command.ts");
  const executor = byPath.get("packages/cli/src/serve/executor-role-runtime.ts");
  const methods = byPath.get("packages/server/src/rpc/methods/index.ts");
  if (
    !protocol || !journal || !removal || !assembly || !contribution || !access ||
    !command || !executor || !methods
  ) {
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
    !executor.includes("const stopCoordinator = new HostStopCoordinator({") ||
    !executor.includes("lifecycleShutdown: stopCoordinator,") ||
    !executor.includes("await waitForExecutorRoleTerminal({") ||
    !executor.includes("server: localConversationServer,") ||
    !executor.includes("deviceRemoved: lifecycleShutdown,")
  ) failures.push("device removal admission, accepted-work or two-root recovery binding drifted");
  const lifecycleEffects = [
    "closeAdmission",
    "captureAcceptedWork",
    "settleAcceptedWork",
    "releaseAdmission",
    "cleanup",
    "finalizeDeviceKey",
    "onRemoved",
  ];
  const meshStart = assembly.slice(
    assembly.indexOf("async start(options:"),
    assembly.indexOf("async stop():"),
  );
  const removalResume = meshStart.indexOf(
    "await this.#deviceRemovalTarget.resumeBeforeAdmission()",
  );
  const startupRecovery = meshStart.indexOf(
    "await this.#recoverStartupState(options.lifecycleAdmissionClosed === true)",
  );
  const controlStart = meshStart.indexOf("await this.#startControl()");
  const targetInstall = meshStart.indexOf(
    "this.#installDeviceRemovalTarget(options.deviceRemovalLifecycle)",
  );
  const anchorAssembly = command.indexOf(
    'await setupAssemblyUnits(assemblyUnits, ctx, "pre-server")',
  );
  const anchorScheduler = command.indexOf(
    "await schedulerGenerationOwner.installInitial({",
  );
  const anchorContribution = command.indexOf(
    "const deviceRemovalLifecycle = defineDeviceRemovalLifecycleContribution({",
  );
  const anchorMeshStart = command.indexOf("await preparedMesh.start({");
  const anchorMeshPublication = command.indexOf("ctx.meshRuntime = activeMesh;");
  const anchorContributionBlock = command.slice(anchorContribution, anchorMeshStart);
  const executorContribution = executor.indexOf(
    "const deviceRemovalLifecycle = defineDeviceRemovalLifecycleContribution({",
  );
  const executorMesh = executor.indexOf("mesh = new MeshRuntimeAssembly({");
  const executorLocalOwnerStart = executor.indexOf("await localConversationOwner.start(");
  const executorJobOwnerStart = executor.indexOf("await jobOwnerLifecycle.start(");
  if (
    lifecycleEffects.some((effect) =>
      count(contribution, `\"${effect}\",`) !== 1 ||
      count(contribution, `readonly ${effect}:`) !== 1
    ) ||
    !contribution.includes("return Object.freeze({ ...input })") ||
    contribution.includes("AssemblyContext") ||
    contribution.includes("MeshRuntimeAssembly") ||
    contribution.includes("LocalConversationOwner") ||
    contribution.includes("DeliveryStack") ||
    !meshStart.includes("readonly deviceRemovalLifecycle: DeviceRemovalLifecycleContribution;") ||
    lifecycleEffects.some((effect) =>
      !assembly.includes(`lifecycle.${effect}`)
    ) ||
    targetInstall < 0 || removalResume <= targetInstall ||
    startupRecovery <= removalResume || controlStart <= startupRecovery ||
    count(command, "defineDeviceRemovalLifecycleContribution({") !== 1 ||
    count(executor, "defineDeviceRemovalLifecycleContribution({") !== 1 ||
    anchorAssembly < 0 || anchorScheduler <= anchorAssembly ||
    anchorContribution <= anchorScheduler || anchorMeshStart <= anchorContribution ||
    anchorMeshPublication <= anchorMeshStart ||
    !command.includes("const assemblyUnits = createAssemblyUnits(channelCredentials)") ||
    !command.includes("const inbound = ctx.inboundRouter === undefined || ctx.inboundRouter === null") ||
    !command.includes("const jobOwner = ctx.executorJobOwner === undefined") ||
    !command.includes("const delivery = ctx.deliveryStack === undefined") ||
    /ctx\.[A-Za-z]+\?\./u.test(anchorContributionBlock) ||
    !access.includes("ctx.meshRuntimePreparation = preparation;") ||
    access.includes("ctx.meshRuntime = mesh;") ||
    count(access, "await mesh.start(") !== 1 ||
    !access.includes("await mesh.start(options)") ||
    !access.includes("connectImmediately: false") ||
    executorContribution < 0 || executorContribution >= executorMesh ||
    executorLocalOwnerStart <= executorMesh ||
    executorJobOwnerStart <= executorLocalOwnerStart ||
    !executor.slice(executorJobOwnerStart, executorJobOwnerStart + 400)
      .includes("deviceRemovalLifecycle,") ||
    executor.slice(executorMesh, executorLocalOwnerStart).includes("deviceRemovalLifecycle,") ||
    [assembly, command, executor].some((source) =>
      source.includes("bindDeviceRemovalLifecycle") ||
      source.includes("#deviceRemovalCleanup") ||
      source.includes("#deviceRemovalRemoved") ||
      source.includes("#deviceRemovalFinalizeKey") ||
      source.includes("#deviceRemovalCloseAdmission") ||
      source.includes("#deviceRemovalCaptureAcceptedWork") ||
      source.includes("#deviceRemovalSettleAcceptedWork") ||
      source.includes("#deviceRemovalReleaseAdmission")
    )
  ) failures.push("device removal static lifecycle contribution ownership drifted");
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
    "mcpRuntime.close",
    "meshRuntime.stop",
    "executorDataPlane.close",
    "jobStatus.dispose",
    "assetMaintenance.stop",
    "executorJobOwner.close",
    "losslessDataPlane.close",
    "ephemeralRuntime.dispose",
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
    "mcpRuntime.close",
  ];
  const executorLifecyclePositions = executorRoleLifecycleIds.map((identity) =>
    executorRoleLifecycle.indexOf(`{ owner: "executor-role", id: "${identity}" }`)
  );
  const executorCleanupTail = executorRoot.slice(
    executorRoot.indexOf("const cleanupFailures: unknown[] = []"),
  );
  const executorMeshConstruction = executorRoot.indexOf("mesh = new MeshRuntimeAssembly({");
  const executorRemovalContribution = executorRoot.indexOf(
    "const deviceRemovalLifecycle = defineDeviceRemovalLifecycleContribution({",
  );
  const executorJobLifecycleConstruction = executorRoot.indexOf(
    "const jobOwnerLifecycle = new ExecutorJobOwnerLifecycle(",
    executorMeshConstruction,
  );
  const executorJobLifecycleContribution = executorRoot.indexOf(
    '"executorJobOwnerLifecycle.close"',
    executorJobLifecycleConstruction,
  );
  const firstAwaitAfterExecutorMesh = executorRoot.indexOf(
    "await ",
    executorMeshConstruction,
  );
  const executorLocalOwnerStart = executorRoot.indexOf(
    "await localConversationOwner.start(",
    executorMeshConstruction,
  );
  const executorJobOwnerStart = executorRoot.indexOf(
    "await jobOwnerLifecycle.start(",
    executorLocalOwnerStart,
  );
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
    executorRemovalContribution < 0 ||
    executorRemovalContribution >= executorMeshConstruction ||
    executorMeshConstruction < 0 ||
    executorJobLifecycleConstruction <= executorMeshConstruction ||
    executorJobLifecycleContribution <= executorJobLifecycleConstruction ||
    firstAwaitAfterExecutorMesh <= executorJobLifecycleContribution ||
    executorLocalOwnerStart <= executorJobLifecycleContribution ||
    executorJobOwnerStart <= executorLocalOwnerStart ||
    !executorRoot.slice(executorJobOwnerStart, executorJobOwnerStart + 400)
      .includes("deviceRemovalLifecycle,") ||
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
      "await mcpRuntime.lifecycle.close()",
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
  const schedulerActivation = command.indexOf("schedulerApplication.activate()", anchorOpenGate);
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
    !scheduler.includes("this.#scheduler.wakeQueuedUserJobs()") ||
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
  const backupTargetContract = byPath.get(
    "packages/cli/src/serve/backup-target-config.ts",
  );
  const backupTargetInfrastructure = byPath.get(
    "packages/cli/src/serve/backup-target-config-infrastructure.ts",
  );
  const doctor = byPath.get("packages/cli/src/maintenance/doctor.ts");
  const cliIndex = byPath.get("packages/cli/src/index.ts");
  const backupApplication = byPath.get("packages/core/src/backup-recovery/application.ts");
  const serverContext = byPath.get("packages/server/src/context.ts");
  const managementFacade = byPath.get("packages/cli/src/runtime/rpc-management-facade.ts");
  const infoCommands = byPath.get("packages/cli/src/commands/info-commands.ts");
  const coreIndex = byPath.get("packages/core/src/index.ts");
  const coreManifestText = byPath.get("packages/core/package.json");
  const coreBuild = byPath.get("packages/core/tsup.config.ts");
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
  const pairedIncomingInfrastructure = byPath.get(
    "packages/cli/src/serve/paired-checkpoint-incoming-infrastructure.ts",
  );
  const pairedCheckpointTarget = byPath.get(
    "packages/cli/src/serve/paired-checkpoint-target.ts",
  );
  const pairedCheckpointTargetInfrastructure = byPath.get(
    "packages/cli/src/serve/paired-checkpoint-target-infrastructure.ts",
  );
  const publishedCheckpointTarget = byPath.get(
    "packages/cli/src/serve/published-checkpoint-target.ts",
  );
  const publishedCheckpointTargetInfrastructure = byPath.get(
    "packages/cli/src/serve/published-checkpoint-target-infrastructure.ts",
  );
  const accessRoot = byPath.get("packages/cli/src/serve/access-surfaces.ts");
  const executorRoot = byPath.get("packages/cli/src/serve/executor-role-runtime.ts");
  const deviceRemovalCleanup = byPath.get(
    "packages/cli/src/serve/device-removal-cleanup.ts",
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
  const exposureAuthority = byPath.get("packages/cli/src/serve/credential-exposure-authority.ts");
  const credentialRotation = byPath.get("packages/cli/src/serve/credential-rotation-publication.ts");
  const startup = byPath.get("packages/cli/src/startup.ts");
  const setupDelivery = byPath.get("packages/cli/src/setup-delivery.ts");
  const checkpointService = byPath.get("packages/mesh/src/checkpoint-service.ts");
  const checkpointTarget = byPath.get("packages/mesh/src/checkpoint-target.ts");
  const checkpointOwner = byPath.get("packages/mesh/src/checkpoint-owner.ts");
  const pairedTarget = byPath.get("packages/mesh/src/paired-checkpoint-target.ts");
  if (
    !command || !owner || !backup || !backupTargetContract || !backupTargetInfrastructure ||
    !doctor || !cliIndex || !backupApplication || !serverContext || !managementFacade ||
    !infoCommands || !coreIndex || !coreManifestText || !coreBuild ||
    !bootstrapStore || !bootstrap || !topology || !applicationHost || !rootEstablishment ||
    !rootActivation || !pairedIncomingInfrastructure || !pairedCheckpointTarget ||
    !pairedCheckpointTargetInfrastructure || !publishedCheckpointTarget ||
    !publishedCheckpointTargetInfrastructure || !accessRoot || !executorRoot ||
    !deviceRemovalCleanup || !controlPlane ||
    !runtime || !pairing || !disasterCommand || !disasterCandidate || !disasterEvidence ||
    !disasterInstallation || !disasterTarget || !artifactRetention || !authorityCommitLog ||
    !exposureAuthority ||
    !credentialRotation || !startup || !setupDelivery || !checkpointService ||
    !checkpointOwner || !checkpointTarget || !pairedTarget
  ) {
    return ["recovery backup production assembly sources are missing"];
  }
  const count = (text, token) => text.split(token).length - 1;
  const backupTargetConcreteOwners = records.filter(({ text }) =>
    text.includes("class FileBackupTargetConfiguration"));
  const backupTargetPhysicalPaths = records.filter(({ text }) =>
    text.includes('"recovery-backup-targets.json"'));
  const backupTargetFactoryConsumers = records
    .filter(({ text }) => text.includes("createBackupTargetConfigurationInfrastructure("))
    .map(({ relative }) => relative)
    .sort();
  const expectedBackupTargetFactoryConsumers = [
    "packages/cli/src/maintenance/doctor.ts",
    "packages/cli/src/serve/backup-command.ts",
    "packages/cli/src/serve/backup-target-config-infrastructure.ts",
    "packages/cli/src/serve/command.ts",
    "packages/cli/src/serve/disaster-recovery-command.ts",
    "packages/cli/src/serve/mesh-pair-command.ts",
  ].sort();
  const backupTargetWrite = backupTargetInfrastructure.indexOf("await writeFile(temporary");
  const backupTargetFileSync = backupTargetInfrastructure.indexOf("await handle.sync()", backupTargetWrite);
  const backupTargetRename = backupTargetInfrastructure.indexOf("await rename(temporary", backupTargetFileSync);
  const backupTargetDirectorySync = backupTargetInfrastructure.indexOf(
    "await syncDirectory(directory)",
    backupTargetRename,
  );
  if (
    count(backupTargetContract, "export interface BackupTargetConfigurationRepository") !== 1 ||
    count(backupTargetContract, "readonly load:") !== 1 ||
    count(backupTargetContract, "readonly select:") !== 1 ||
    count(backupTargetContract, "projectBackupTargetConfigurationRepository(") !== 1 ||
    backupTargetContract.includes("node:fs") ||
    backupTargetContract.includes("node:path") ||
    backupTargetContract.includes("recovery-backup-targets.json") ||
    backupTargetConcreteOwners.length !== 1 ||
    backupTargetConcreteOwners[0]?.relative !==
      "packages/cli/src/serve/backup-target-config-infrastructure.ts" ||
    count(backupTargetInfrastructure, "new FileBackupTargetConfiguration(") !== 1 ||
    backupTargetPhysicalPaths.length !== 1 ||
    backupTargetPhysicalPaths[0]?.relative !==
      "packages/cli/src/serve/backup-target-config-infrastructure.ts" ||
    JSON.stringify(backupTargetFactoryConsumers) !==
      JSON.stringify(expectedBackupTargetFactoryConsumers) ||
    !backupTargetInfrastructure.includes("value.v !== 1") ||
    !backupTargetInfrastructure.includes("canonicalize(value) !== text") ||
    !backupTargetInfrastructure.includes('assertExactKeys(value, ["bindings", "currentTargetId", "v"])') ||
    !backupTargetInfrastructure.includes("new Set(bindings.map((binding) => binding.targetId)).size") ||
    !backupTargetInfrastructure.includes("path.resolve(value.directory)") ||
    !backupTargetInfrastructure.includes('localeCompare(right.targetId, "en-US")') ||
    backupTargetWrite < 0 || backupTargetFileSync < backupTargetWrite ||
    backupTargetRename < backupTargetFileSync ||
    backupTargetDirectorySync < backupTargetRename ||
    backupTargetInfrastructure.includes("unlink(") ||
    backupTargetInfrastructure.includes("rm(") ||
    backupTargetInfrastructure.includes("PairedRecoveryCheckpointTarget") ||
    !backup.includes("readonly backupTargets: BackupTargetConfigurationRepository") ||
    count(backup, "context.backupTargets.load()") !== 2 ||
    count(backup, "context.backupTargets.select(") !== 1 ||
    !owner.includes("readonly backupTargets: BackupTargetConfigurationRepository") ||
    count(owner, "this.input.backupTargets.load()") !== 2 ||
    !disasterCommand.includes("readonly backupTargets: BackupTargetConfigurationRepository") ||
    count(disasterCommand, "context.backupTargets.load()") !== 1 ||
    count(pairing, "readonly backupTargets: BackupTargetConfigurationRepository") !== 2 ||
    count(pairing, "input.backupTargets.load()") !== 1 ||
    count(pairing, "input.backupTargets.select(") !== 1 ||
    !doctor.includes("readonly backupTargets: BackupTargetConfigurationRepository") ||
    count(doctor, "await deps.backupTargets.load()") !== 1 ||
    count(doctor, "createBackupTargetConfigurationInfrastructure(homeDir)") !== 1 ||
    !cliIndex.includes("inspectDefaultLocalHealth") ||
    [backup, owner, command, disasterCommand, pairing, doctor].some((text) =>
      text.includes("backupTargets?:") ||
      text.includes("backupTargets?.") ||
      text.includes("FileBackupTargetConfiguration") ||
      text.includes("recovery-backup-targets.json"))
  ) {
    failures.push(
      "backup target configuration finite repository, physical factory or durability boundary drifted",
    );
  }
  let coreManifest;
  try {
    coreManifest = JSON.parse(coreManifestText);
  } catch {
    return ["recovery backup core package manifest is invalid"];
  }
  const backupApplicationExport = coreManifest.exports?.["./backup-recovery/application"];
  const duplicateBackupApplicationExports = Object.entries(coreManifest.exports ?? {})
    .filter(([subpath, conditions]) =>
      subpath !== "./backup-recovery/application" &&
      conditions &&
      typeof conditions === "object" &&
      (conditions.types === backupApplicationExport?.types ||
        conditions.import === backupApplicationExport?.import));
  if (
    backupApplicationExport?.types !== "./dist/backup-recovery/application.d.ts" ||
    backupApplicationExport?.import !== "./dist/backup-recovery/application.js" ||
    duplicateBackupApplicationExports.length > 0 ||
    count(coreBuild, '"src/backup-recovery/application.ts"') !== 1 ||
    coreIndex.includes("backup-recovery/application") ||
    count(backupApplication, "class BackupRecoveryAdministrationApplicationService") !== 1 ||
    count(backupApplication, "async setup(") !== 1 ||
    count(backupApplication, "async verify()") !== 1 ||
    count(backupApplication, "async status()") !== 1 ||
    count(backupApplication, "export function projectBackupRecoveryPublicStatus(") !== 1 ||
    count(
      backupApplication,
      "`backup-setup:${binding.targetId}:${root.checkpointRevision}`",
    ) !== 2 ||
    !backupApplication.includes("await this.mechanism.replayRootActivation(binding, target)") ||
    !backupApplication.includes("const binding = requireBinding(configured, candidate.targetId, \"verification\")") ||
    !backupApplication.includes('nextAction: "run-backup-verify"') ||
    !backup.includes('from "@zhixing/core/backup-recovery/application"') ||
    count(backup, "new BackupRecoveryAdministrationApplicationService(") !== 1 ||
    count(backup, ".setup(selection.directory !== undefined") !== 1 ||
    count(backup, "createBackupRecoveryAdministration(context, options).verify()") !== 1 ||
    count(backup, "createBackupRecoveryAdministration(context, options).status()") !== 1 ||
    !command.includes("projectBackupRecoveryPublicStatus(ctx.authorityCheckpointOwner") ||
    backup.includes("completeBackupSetup(") ||
    backup.includes("pairedDeviceId") ||
    backupApplication.includes('kind: "device-id"') ||
    owner.includes("projectRecoveryBackupStatus")
  ) {
    failures.push("backup setup, verify and status must have one Backup & Recovery application owner");
  }
  if (
    count(backupApplication, '"restore-backup-connection"') !== 2 ||
    !backupApplication.includes('case "configuration-invalid":') ||
    !backupApplication.includes('return "repair-backup-configuration"') ||
    !backupApplication.includes('case "runtime-unavailable":') ||
    !backupApplication.includes('return "restore-backup-connection"') ||
    !backupApplication.includes('case "target-unavailable":') ||
    !backupApplication.includes('return "check-backup-target"') ||
    !backupApplication.includes("Backup recovery unavailable reason is invalid") ||
    !serverContext.includes(
      'import type { BackupRecoveryPublicStatus } from "@zhixing/core/backup-recovery/application"',
    ) ||
    !serverContext.includes(
      "recoveryBackupStatus?: () => Promise<BackupRecoveryPublicStatus>;",
    ) ||
    serverContext.includes("nextAction?: string") ||
    !managementFacade.includes(
      'import type { BackupRecoveryPublicStatus } from "@zhixing/core/backup-recovery/application"',
    ) ||
    !managementFacade.includes("recoveryBackup?: BackupRecoveryPublicStatus;") ||
    !infoCommands.includes('case "restore-backup-connection":') ||
    !backup.includes('case "restore-backup-connection":') ||
    records.some(({ text }) => text.includes("start-authenticated-mesh"))
  ) {
    failures.push(
      "backup recovery public unavailable actions must stay exact and topology-neutral",
    );
  }
  const disasterAdmissionOwners = records.filter(({ text }) =>
    text.includes("class BackupRecoveryDisasterAdmissionApplicationService"));
  if (
    disasterAdmissionOwners.length !== 1 ||
    disasterAdmissionOwners[0]?.relative !== "packages/core/src/backup-recovery/application.ts" ||
    count(backupApplication, "class BackupRecoveryDisasterAdmissionApplicationService") !== 1 ||
    !backupApplication.includes("#resolveTarget(") ||
    !backupApplication.includes("async #discover(") ||
    !backupApplication.includes("#select(") ||
    count(backupApplication, "validateBackupRecoveryDisasterAdmissionSelection(selection)") !== 1 ||
    !backupApplication.includes("selected.entry.recipientKeyId !== backupKeyId") ||
    !backupApplication.includes("selected.entry.envelopeIdentity.recipientKeyId !== backupKeyId") ||
    !backupApplication.includes("checkpointEnvelopeDigest: selected.entry.envelopeIdentity.digest") ||
    !backupApplication.includes("const transferId = this.mechanism.deriveTransferId(transferInput)") ||
    !backupApplication.includes("const prepare = this.mechanism.signPrepare(intent, recovered.root)") ||
    !disasterCommand.includes('from "@zhixing/core/backup-recovery/application"') ||
    count(disasterCommand, "new BackupRecoveryDisasterAdmissionApplicationService<") !== 1 ||
    count(disasterCommand, "validateBackupRecoveryDisasterAdmissionSelection(selection)") !== 1 ||
    count(disasterCommand, "return await application.admit(selection)") !== 1 ||
    disasterCommand.includes("discoverDisasterRecoveryCandidates") ||
    disasterCommand.includes("selectDisasterRecoveryCandidate") ||
    disasterCommand.includes("selection.pairedDeviceName === undefined") ||
    disasterCommand.includes("selected.entry.recipientKeyId") ||
    disasterCommand.includes("pairedDeviceId") ||
    disasterCommand.includes("DisasterRecoveryInventoryPort") ||
    backupApplication.includes("pairedDeviceId") ||
    records.some(({ relative }) =>
      relative.endsWith("/disaster-recovery-inventory.ts"))
  ) {
    failures.push("disaster recovery candidate discovery and admission must have one domain application owner");
  }
  const disasterLifecycleOwners = records.filter(({ text }) =>
    text.includes("class BackupRecoveryDisasterLifecycleApplicationService"));
  const lifecycleRecover = backupApplication.indexOf(
    "  recover(): Promise<BackupRecoveryDisasterCompletion>",
  );
  const lifecycleCurrent = backupApplication.indexOf(
    "if (currentDeviceId === issuerDeviceId)",
    lifecycleRecover,
  );
  const lifecycleFresh = backupApplication.indexOf(
    "return session.withFreshInstall(async (fresh) =>",
    lifecycleCurrent,
  );
  const lifecycleEvidence = backupApplication.indexOf(
    "const evidence = await fresh.collectPrepareEvidence(admission)",
    lifecycleFresh,
  );
  const lifecycleTry = backupApplication.indexOf("try {", lifecycleEvidence);
  const lifecyclePrepare = backupApplication.indexOf(
    "await fresh.prepareAndImport({ admission, evidence })",
    lifecycleTry,
  );
  const lifecycleCommit = backupApplication.indexOf(
    "await fresh.commit(admission)",
    lifecyclePrepare,
  );
  const lifecycleReceipt = backupApplication.indexOf(
    "await session.waitForPostInstallReceipt(installed.generation)",
    lifecycleCommit,
  );
  const lifecycleAbort = backupApplication.indexOf(
    "await fresh.abort(Object.freeze({",
    lifecycleReceipt,
  );
  const lifecycleFinish = backupApplication.indexOf(
    "  async finish(input:",
    lifecycleAbort,
  );
  const lifecycleConfirmation = backupApplication.indexOf(
    "if (!input.userConfirmedOldDeviceIsolated)",
    lifecycleFinish,
  );
  const lifecycleFinishSession = backupApplication.indexOf(
    "return this.mechanism.withFinishSession(async (session) =>",
    lifecycleConfirmation,
  );
  const lifecycleDisposition = backupApplication.indexOf(
    "const disposition = await session.readTombstoneDisposition(transferId)",
    lifecycleFinishSession,
  );
  const lifecycleTombstone = backupApplication.indexOf(
    "await session.tombstone(transferId)",
    lifecycleDisposition,
  );
  if (
    disasterLifecycleOwners.length !== 1 ||
    disasterLifecycleOwners[0]?.relative !== "packages/core/src/backup-recovery/application.ts" ||
    count(backupApplication, "class BackupRecoveryDisasterLifecycleApplicationService") !== 1 ||
    lifecycleRecover < 0 || lifecycleCurrent < lifecycleRecover ||
    lifecycleFresh < lifecycleCurrent || lifecycleEvidence < lifecycleFresh ||
    lifecycleTry < lifecycleEvidence || lifecyclePrepare < lifecycleTry ||
    lifecycleCommit < lifecyclePrepare || lifecycleReceipt < lifecycleCommit ||
    lifecycleAbort < lifecycleReceipt || lifecycleFinish < lifecycleAbort ||
    lifecycleConfirmation < lifecycleFinish || lifecycleFinishSession < lifecycleConfirmation ||
    lifecycleDisposition < lifecycleFinishSession || lifecycleTombstone < lifecycleDisposition ||
    !backupApplication.includes('reason: "operator-cancelled" as const') ||
    !backupApplication.includes('nextStep: Object.freeze({ kind: "confirm-old-device-isolated" as const })') ||
    !backupApplication.includes('session.presentProgress("recovery-committed")') ||
    !backupApplication.includes("session.presentCompletion(completion)") ||
    count(disasterCommand, "new BackupRecoveryDisasterLifecycleApplicationService({") !== 1 ||
    !disasterCommand.includes("withRecoverySession: async (use) =>") ||
    !disasterCommand.includes("withFreshInstall: async (useFresh) =>") ||
    !disasterCommand.includes("withFinishSession: async (use) =>") ||
    !disasterCommand.includes(
      "readTombstoneDisposition: (transferId) => target.tombstoneDisposition(transferId)",
    ) ||
    count(disasterTarget, "async tombstoneDisposition(") !== 1 ||
    !disasterCommand.includes("renderDisasterRecoveryCompletion(completion, context.writeLine)") ||
    disasterCommand.includes("reportDisasterRecoveryCompleted(") ||
    disasterCommand.includes("context.trust.issuer.deviceId === context.key.deviceId")
  ) {
    failures.push("disaster recovery install, continuation and finish must have one domain application owner");
  }
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
  const pairedMeshTransportConstructions = records.filter(({ text }) =>
    text.includes("new MeshPairedCheckpointTransport("));
  const pairedDemandSources = [owner, backup, disasterCommand, pairing];
  const borrowedPairedTargetStart = command.indexOf(
    "pairedTargets: createBorrowedMeshPairedCheckpointTargetSessions(",
  );
  const borrowedPairedTargetConstruction = borrowedPairedTargetStart < 0
    ? ""
    : command.slice(borrowedPairedTargetStart, borrowedPairedTargetStart + 700);
  if (
    pairedClientConstructions.length !== 1 ||
    pairedClientConstructions[0]?.relative !==
      "packages/cli/src/serve/paired-checkpoint-target-infrastructure.ts" ||
    pairedMeshTransportConstructions.length !== 1 ||
    pairedMeshTransportConstructions[0]?.relative !==
      "packages/cli/src/serve/paired-checkpoint-target-infrastructure.ts" ||
    count(pairedCheckpointTargetInfrastructure, "class PairingSocketCheckpointTransport") !== 1 ||
    !pairedCheckpointTarget.includes("export interface PairedRecoveryRootActivation") ||
    !pairedCheckpointTarget.includes("export interface BorrowedPairedCheckpointTargetSessions") ||
    !pairedCheckpointTarget.includes("projectPairedRecoveryRootActivation(") ||
    count(pairedCheckpointTargetInfrastructure, "close: once(input.closeControlPlane)") !== 2 ||
    count(pairedCheckpointTargetInfrastructure, "input.connections.client(input.binding.targetDeviceId)") !== 1 ||
    !pairedCheckpointTargetInfrastructure.includes('t: "recovery-onboarding-command"') ||
    !pairedCheckpointTargetInfrastructure.includes('frame.t !== "recovery-onboarding-result"') ||
    pairedCheckpointTargetInfrastructure.includes("closeControlPlane?:") ||
    !owner.includes("readonly pairedTargets: BorrowedPairedCheckpointTargetSessions") ||
    owner.includes("meshRuntime") ||
    !borrowedPairedTargetConstruction.includes('kind: "available"') ||
    !borrowedPairedTargetConstruction.includes('kind: "runtime-unavailable"') ||
    !borrowedPairedTargetConstruction.includes(
      "connections: ctx.meshRuntimePreparation.connections",
    ) ||
    !backup.includes("createOwnedMeshPairedCheckpointTargetSession({") ||
    !disasterCommand.includes("createOwnedMeshPairedCheckpointInventorySession({") ||
    !pairing.includes("createPairingSocketPublishedCheckpointTarget({") ||
    !backup.includes("storageMaintenance: context.capacity.storage") ||
    !command.includes("storageMaintenance: ctx.storageMaintenance") ||
    !disasterCommand.includes("storageMaintenance: context.storageMaintenance") ||
    !pairing.includes("storageMaintenance: input.storageMaintenance") ||
    pairedDemandSources.some((text) =>
      text.includes("PairedRecoveryCheckpointTarget") ||
      text.includes("MeshPairedCheckpointTransport") ||
      text.includes("MeshServiceClient") ||
      text.includes("PairingSocketCheckpointTransport") ||
      text.includes("pairedTargets?:") ||
      text.includes("pairedTargets?."))
  ) {
    failures.push("paired checkpoint target finite Infrastructure or lifecycle boundary drifted");
  }
  if (
    !checkpointService.includes("export async function projectDurableRecoveryBackupStatus(") ||
    !checkpointService.includes("canonicalize(record.generation) === canonicalize(generation)") ||
    count(checkpointService, "return projectDurableRecoveryBackupStatus({") !== 1 ||
    !owner.includes("projectDurableRecoveryBackupStatus({") ||
    count(owner, "fullBackupReady: status.fullBackupReady") !== 1
  ) {
    failures.push("durable recovery readiness projector or unavailable consumer drifted");
  }
  const prepareIdentity = backupApplication.indexOf(
    "const prepared = await this.mechanism.prepareInitialRoot();",
  );
  const pairedSelect = backupApplication.indexOf(
    "await this.mechanism.selectTarget(binding);",
    prepareIdentity,
  );
  const pairedConnect = backupApplication.indexOf(
    "return this.mechanism.withSelectedTarget(binding, recipientKeyId",
    pairedSelect,
  );
  if (
    prepareIdentity < 0 ||
    pairedSelect < prepareIdentity ||
    pairedConnect < pairedSelect ||
    !backup.includes("prepared.checkpoint.envelope.recipientKeyId")
  ) {
    failures.push("paired root establishment must freeze package identity before target connection");
  }
  const limitedBranch = applicationHost.indexOf("await this.#dependencies.runRecoveryRoot({");
  const oldBootstrapStop = applicationHost.indexOf("await this.#releaseCurrentMesh();");
  const residentBootstrap = applicationHost.indexOf(
    "mesh = await this.#prepareMesh(",
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
    [...applicationHost.matchAll(
      /await this\.#prepareMesh\(\s*deviceCapacity,\s*plannedAnchorTransferStaging,\s*disasterRecoveryStaging,\s*\)/gu,
    )].length !== 2 ||
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
    !rootEstablishment.includes(
      "readonly pairedCheckpointReceiver: PairedCheckpointCommandReceiver | null",
    ) ||
    rootEstablishment.includes("FilePairedCheckpointStaging") ||
    rootEstablishment.includes("PairedCheckpointReceiver,") ||
    rootEstablishment.includes("recovery-checkpoint-incoming") ||
    !rootEstablishment.includes('result.t === "checkpoint.root-activated"') ||
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
    !backup.includes("await session.rootActivation.activateRoot(replay)") ||
    !backup.includes("await session.rootActivation.activateRoot({") ||
    !pairedIncomingInfrastructure.includes("rootLifecycle: true") ||
    !pairedIncomingInfrastructure.includes("rootEstablishment: true") ||
    count(pairedIncomingInfrastructure, "commitRootActivation:") !== 2 ||
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
    !disasterCommand.includes("admitDisasterRecoveryCandidate(context, selection, options, signal)") ||
    !disasterCommand.includes("await target.prepareAndImport({") ||
    !disasterCommand.includes("transferId: admission.transferId") ||
    !disasterCommand.includes("recoveryRoot: admission.recoveryRoot") ||
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
    "await context.cleanupTransfer()",
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
    !disasterCommand.includes("openInventoryTargets(context, targetSelection, signal)") ||
    !disasterCommand.includes("waitForPeer(control, selection.deviceId, 30_000, signal)") ||
    !disasterCommand.includes("return target.read(checkpointId, signal)") ||
    !disasterCommand.includes("createSignedDisasterRecoveryAbort({") ||
    !disasterCommand.includes("await target.abort({") ||
    !disasterCommand.includes("recoveryRoot: abortIntent.admission.recoveryRoot") ||
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
    "packages/core/src/backup-recovery/application.ts",
    backupApplication,
    "BACKUP_RECOVERY_ROOT_LIFECYCLE_DESCRIPTOR",
  );
  const expectedRootLifecycleDescriptor = {
    owner: "backup-recovery",
    commands: ["rotate", "invalidate", "approve-reset", "reset"],
    checkpointed: ["rotate", "reset"],
  };
  const rootResetStart = backupApplication.indexOf("  async reset(");
  const rootResetConfirmation = backupApplication.indexOf(
    'throw new BackupRecoveryRootLifecycleError("reset-confirmation-required")',
    rootResetStart,
  );
  const rootResetDecode = backupApplication.indexOf("input.decodeApproval()", rootResetStart);
  const rootResetIssuerSession = backupApplication.indexOf(
    "return this.mechanism.withIssuerSession",
    rootResetStart,
  );
  if (
    JSON.stringify(rootLifecycleDescriptor) !== JSON.stringify(expectedRootLifecycleDescriptor) ||
    count(backupApplication, "class BackupRecoveryRootLifecycleApplicationService") !== 1 ||
    count(backupApplication, "async rotate(") !== 1 ||
    count(backupApplication, "async invalidate(") !== 1 ||
    count(backupApplication, "async approveReset(") !== 1 ||
    count(backupApplication, "async reset(") !== 1 ||
    !backupApplication.includes("assertCurrentRoot(context, current.identity)") ||
    !backupApplication.includes("assertApprovalGeneration(context, approval)") ||
    !backupApplication.includes("assertApprovalCoSigner(context, approval.coSign.deviceId)") ||
    count(backup, "new BackupRecoveryRootLifecycleApplicationService({") !== 1 ||
    count(backup, ".rotate(input)") !== 1 ||
    count(backup, ".invalidate(input)") !== 1 ||
    count(backup, ".approveReset(input)") !== 1 ||
    count(backup, ".reset({") !== 1 ||
    !backup.includes("decodeApproval: () => decodeResetApproval(input.approval)") ||
    backup.includes("approval: decodeResetApproval(input.approval)") ||
    rootResetStart < 0 ||
    rootResetConfirmation < rootResetStart ||
    rootResetDecode < rootResetConfirmation ||
    rootResetIssuerSession < rootResetDecode ||
    backup.includes("RecoveryRootLifecycleService") ||
    records.some(({ relative, text }) =>
      relative.endsWith("recovery-root-lifecycle.ts") ||
      text.includes('from "./recovery-root-lifecycle.js"'))
  ) {
    failures.push("recovery root lifecycle application owner, confirmation priority, command exact-set or production binding drifted");
  }
  if (
    count(runtime, "registerPairedCheckpointMeshService(") !== 1 ||
    !runtime.includes(
      "readonly pairedCheckpointReceiver: PairedCheckpointCommandReceiver | null",
    ) ||
    runtime.includes("FilePairedCheckpointStaging") ||
    runtime.includes("PairedCheckpointReceiver,") ||
    runtime.includes("recovery-checkpoint-incoming") ||
    !runtime.includes('member.device.deviceId === options.authority.deviceId') ||
    !runtime.includes('member.state === "active"') ||
    !runtime.includes(
      "requiresPairedCheckpointReceiver !== (options.pairedCheckpointReceiver !== null)",
    )
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
    !backupApplication.includes("assertEligibleCoSigner(context)") ||
    !backupApplication.includes("assertApprovalCoSigner(context, approval.coSign.deviceId)") ||
    !backupApplication.includes("context.activeDeviceIds.includes(context.currentDeviceId)") ||
    !backupApplication.includes("context.activeDeviceIds.includes(deviceId)") ||
    approvalContext.includes('member.state !== "active"') ||
    approvalContext.includes("projection.issuer.deviceId === key.deviceId") ||
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
    !backupApplication.includes("if (currentDeviceId === issuerDeviceId)") ||
    !disasterCommand.includes("await waitForDisasterRecoveryPostInstallReceipt({") ||
    synchronousGate < 0 || liveAwait < synchronousGate ||
    disasterCompletion < 0 || disasterFinish < disasterCompletion || surfaceOpen < disasterFinish
  ) {
    failures.push("disaster installation completion, consumer recovery or public-open order drifted");
  }
  const onboardingStart = pairing.indexOf('t: "recovery-onboarding-start"');
  const onboardingTarget = pairing.indexOf(
    "return createPairingSocketPublishedCheckpointTarget({",
    onboardingStart,
  );
  const enrollment = pairing.indexOf("const trustEvent = createPairingTrustEvent", onboardingTarget);
  if (
    onboardingStart < 0 ||
    onboardingTarget < onboardingStart ||
    enrollment < onboardingTarget ||
    count(pairing, "createPairedCheckpointCommandReceiverInfrastructure({") !== 1 ||
    pairing.includes("FilePairedCheckpointStaging") ||
    pairing.includes("PairedCheckpointReceiver,") ||
    pairing.includes("recovery-checkpoint-incoming")
  ) {
    failures.push("packages/cli/src/serve/mesh-pair-command.ts: authenticated onboarding checkpoint must precede business enrollment");
  }
  const concreteReceiverOwners = records.filter(({ text }) =>
    text.includes("new PairedCheckpointReceiver({"));
  const stagingOwners = records.filter(({ text }) =>
    text.includes("new FilePairedCheckpointStaging({"));
  if (
    concreteReceiverOwners.length !== 1 ||
    concreteReceiverOwners[0]?.relative !==
      "packages/cli/src/serve/paired-checkpoint-incoming-infrastructure.ts" ||
    stagingOwners.length !== 1 ||
    stagingOwners[0]?.relative !==
      "packages/cli/src/serve/paired-checkpoint-incoming-infrastructure.ts" ||
    count(pairedIncomingInfrastructure, "new PairedCheckpointReceiver({") !== 1 ||
    count(pairedIncomingInfrastructure, "new FilePairedCheckpointStaging({") !== 1 ||
    count(pairedIncomingInfrastructure, '"recovery-checkpoint-incoming"') !== 1 ||
    count(accessRoot, "createPersistentPairedCheckpointCommandReceiverInfrastructure({") !== 1 ||
    !accessRoot.includes("const pairedCheckpointDeviceId = ctx.authorityRuntime.deviceId") ||
    !accessRoot.includes("deviceId: pairedCheckpointDeviceId") ||
    count(executorRoot, "createPersistentPairedCheckpointCommandReceiverInfrastructure({") !== 1 ||
    count(applicationHost, "createRecoveryRootPairedCheckpointReceiver") !== 3 ||
    !pairedTarget.includes("export interface PairedCheckpointCommandReceiver") ||
    !pairedTarget.includes("projectPairedCheckpointCommandReceiver(") ||
    !pairedTarget.includes("receiver: PairedCheckpointCommandReceiver,") ||
    count(deviceRemovalCleanup, '"recovery-checkpoint-incoming"') !== 1
  ) {
    failures.push("paired checkpoint incoming physical factory, required Host ports or cleanup exact-set drifted");
  }
  const publishedTargetConcreteImporters = records
    .filter(({ text }) =>
      text.includes("FileRecoveryCheckpointTarget") &&
      text.includes('from "@zhixing/mesh/checkpoint-target"'))
    .map(({ relative }) => relative)
    .sort();
  const publishedTargetFactoryConsumers = records
    .filter(({ text }) => text.includes("createPublishedCheckpointTargetInfrastructure("))
    .map(({ relative }) => relative)
    .sort();
  const expectedPublishedTargetFactoryConsumers = [
    "packages/cli/src/serve/backup-command.ts",
    "packages/cli/src/serve/command.ts",
    "packages/cli/src/serve/disaster-recovery-command.ts",
    "packages/cli/src/serve/mesh-pair-command.ts",
    "packages/cli/src/serve/paired-checkpoint-incoming-infrastructure.ts",
    "packages/cli/src/serve/published-checkpoint-target-infrastructure.ts",
  ].sort();
  if (
    JSON.stringify(publishedTargetConcreteImporters) !== JSON.stringify([
      "packages/cli/src/serve/published-checkpoint-target-infrastructure.ts",
    ]) ||
    JSON.stringify(publishedTargetFactoryConsumers) !==
      JSON.stringify(expectedPublishedTargetFactoryConsumers) ||
    count(publishedCheckpointTargetInfrastructure, "FileRecoveryCheckpointTarget.open({") !== 1 ||
    count(publishedCheckpointTargetInfrastructure, "FileRecoveryCheckpointTarget.openPaired({") !== 1 ||
    count(publishedCheckpointTargetInfrastructure, '"recovery-checkpoints"') !== 1 ||
    count(publishedCheckpointTargetInfrastructure, '"authority"') !== 1 ||
    publishedCheckpointTargetInfrastructure.includes("PairedRecoveryCheckpointTarget") ||
    !publishedCheckpointTarget.includes("export interface PublishedRecoveryCheckpointTargetSession") ||
    !publishedCheckpointTarget.includes("export interface PublishedCheckpointTargetInfrastructure") ||
    !publishedCheckpointTarget.includes("projectInventoryPublishedRecoveryCheckpointTarget(") ||
    !owner.includes("readonly publishedDirectoryTargets: ExistingPublishedCheckpointDirectorySessions") ||
    owner.includes("publishedDirectoryTargets?:") ||
    !backup.includes("readonly publishedDirectoryTargets: PublishedCheckpointDirectorySessions") ||
    !disasterCommand.includes(
      "readonly publishedDirectoryInventoryTargets: PublishedCheckpointDirectoryInventorySessions",
    ) ||
    !pairing.includes("readonly publishedPairedTargets: PublishedCheckpointPairedSessions") ||
    [owner, backup, disasterCommand, pairing, pairedIncomingInfrastructure].some((text) =>
      text.includes("FileRecoveryCheckpointTarget") ||
      text.includes("distributed-runtime/recovery-checkpoints")) ||
    !checkpointService.includes("export interface RecoveryCheckpointTargetSession") ||
    !checkpointService.includes(") => Promise<RecoveryCheckpointTargetSession>;") ||
    count(checkpointService, "await targetSession.close()") !== 2 ||
    count(checkpointService, "await targetSession?.close()") !== 1 ||
    checkpointService.includes("target.close?.()") ||
    checkpointTarget.includes("close?(): Promise<void>") ||
    count(deviceRemovalCleanup, '"recovery-checkpoints"') !== 0
  ) {
    failures.push(
      "published checkpoint filesystem target factory, bounded session or retention boundary drifted",
    );
  }
  return failures;
}

export function inspectDisasterRecoveryStagingBoundary(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const required = (relative) => {
    const text = byPath.get(relative);
    if (text === undefined) failures.push(`${relative}: disaster-recovery staging source is missing`);
    return text ?? "";
  };
  const boundary = required("packages/cli/src/serve/disaster-recovery-staging.ts");
  const infrastructure = required(
    "packages/cli/src/serve/disaster-recovery-staging-infrastructure.ts",
  );
  const target = required("packages/cli/src/serve/disaster-recovery-target.ts");
  const authority = required("packages/cli/src/serve/disaster-recovery-authority.ts");
  const candidate = required("packages/cli/src/serve/disaster-recovery-candidate.ts");
  const installation = required("packages/cli/src/serve/disaster-recovery-installation.ts");
  const command = required("packages/cli/src/serve/disaster-recovery-command.ts");
  const bootstrap = required("packages/cli/src/serve/mesh-runtime-bootstrap.ts");
  const assembly = required("packages/cli/src/serve/mesh-runtime-assembly.ts");
  const applicationHost = required("packages/cli/src/serve/application-host.ts");
  const accessRoot = required("packages/cli/src/serve/access-surfaces.ts");
  const executorRoot = required("packages/cli/src/serve/executor-role-runtime.ts");
  const cleanup = required("packages/cli/src/serve/device-removal-cleanup.ts");
  const count = (text, token) => text.split(token).length - 1;
  if (failures.length > 0) return failures;

  const factories = records.filter(({ text }) =>
    text.includes("export function createDisasterRecoveryStagingInfrastructure("));
  if (
    factories.length !== 1 ||
    factories[0]?.relative !==
      "packages/cli/src/serve/disaster-recovery-staging-infrastructure.ts" ||
    count(infrastructure, '"disaster-recovery-staging"') !== 1 ||
    count(infrastructure, "new FileArtifactStore(") !== 1 ||
    count(infrastructure, "new FileAuthorityCommitLog(") !== 2 ||
    count(infrastructure, "new FileResumableArtifactReceiver(") !== 2 ||
    count(
      infrastructure,
      "MAX_DISASTER_RECOVERY_ARTIFACT_BYTES = 512 * 1024 * 1024 * 1024",
    ) !== 1 ||
    count(infrastructure, "DISASTER_RECOVERY_CHUNK_BYTES = 1024 * 1024") !== 1 ||
    !infrastructure.includes('path.join(root, "candidate-claims")') ||
    !infrastructure.includes('transferPath(root, "journals", input.transferId)') ||
    !infrastructure.includes('transferPath(root, "transfers", input.transferId)') ||
    !infrastructure.includes('path.join(transferRoot, "artifacts")') ||
    !infrastructure.includes('path.join(transferRoot, "partials")') ||
    !infrastructure.includes('path.join(transferRoot, "promotion-partials")') ||
    !infrastructure.includes("await rm(transferRoot, { recursive: true, force: true })") ||
    !infrastructure.includes("const walker = new BoundedRemovalWalker(root)") ||
    /anchor-transfer-staging|conversation-transfer-staging/u.test(infrastructure)
  ) {
    failures.push("disaster-recovery staging unique physical ownership drifted");
  }

  const consumers = [target, authority, candidate, installation, bootstrap, assembly, cleanup];
  if (
    /from\s+["']node:(?:fs|fs\/promises|path)["']/u.test(
      [target, authority, candidate, installation].join("\n"),
    ) ||
    /FileArtifactStore|FileAuthorityCommitLog|FileResumableArtifactReceiver|stagingRoot|privatePartialsRoot/u.test(
      [target, authority, candidate, installation].join("\n"),
    ) ||
    consumers.some((text) => /readonly disasterRecoveryStaging\?/u.test(text)) ||
    count(boundary, "export interface DisasterRecoveryStagingArea {") !== 1 ||
    count(boundary, "cleanupPostInstall(transferId: string): Promise<void>;") !== 1 ||
    count(boundary, "cleanupCurrentDevice(signal?: AbortSignal): Promise<void>;") !== 1 ||
    count(target, "readonly staging: DisasterRecoveryStagingArea;") !== 3 ||
    count(target, "this.#staging = options.staging.openTarget({") !== 1 ||
    count(target, "privateReceiver: context.privateImport") !== 1 ||
    count(target, "await context.cleanupTransfer()") !== 1 ||
    count(target, "await input.staging.cleanupPostInstall(input.transferId)") !== 1
  ) {
    failures.push("disaster-recovery demand-side finite staging boundary drifted");
  }

  if (
    count(applicationHost, "createDisasterRecoveryStagingInfrastructure,") !== 2 ||
    count(applicationHost, "createDisasterRecoveryStaging({") !== 1 ||
    count(applicationHost, "disasterRecoveryStaging,") !== 4 ||
    count(bootstrap, "readonly disasterRecoveryStaging: DisasterRecoveryStagingArea;") !== 3 ||
    count(bootstrap, "disasterRecoveryStaging: input.disasterRecoveryStaging") !== 2 ||
    count(bootstrap, "staging: input.disasterRecoveryStaging") !== 1 ||
    count(assembly, "readonly disasterRecoveryStaging: DisasterRecoveryStagingArea;") !== 1 ||
    count(assembly, "staging: this.options.disasterRecoveryStaging") !== 2 ||
    count(accessRoot, "disasterRecoveryStaging: bootstrap.disasterRecoveryStaging") !== 1 ||
    count(executorRoot, "disasterRecoveryStaging: bootstrap.mesh.disasterRecoveryStaging") !== 2
  ) {
    failures.push("disaster-recovery Host/bootstrap required instance flow drifted");
  }
  const meshRelease = applicationHost.indexOf("() => this.#releaseCurrentMesh()");
  const disasterRelease = applicationHost.indexOf("const owner = this.#disasterRecoveryStaging");
  const workspaceRelease = applicationHost.indexOf("const owner = this.#localWorkspaceOwner");
  if (
    meshRelease < 0 || disasterRelease < meshRelease || workspaceRelease < disasterRelease ||
    count(applicationHost, "() => disasterRecoveryStaging.close()") !== 1 ||
    count(command, "createDisasterRecoveryStagingInfrastructure({") !== 1 ||
    count(command, "disasterRecoveryStaging: context.disasterRecoveryStaging") !== 2 ||
    count(command, "staging: context.disasterRecoveryStaging") !== 1 ||
    count(command, "await context.disasterRecoveryStaging.close()") !== 2
  ) {
    failures.push("disaster-recovery staging lifecycle or recovery-command identity drifted");
  }

  if (
    count(cleanup, "readonly disasterRecoveryStaging: DisasterRecoveryStagingArea;") !== 1 ||
    count(cleanup, "await input.disasterRecoveryStaging.cleanupCurrentDevice(input.signal)") !== 1 ||
    count(cleanup, '"distributed-runtime/disaster-recovery-staging"') !== 1 ||
    cleanup.includes('path.join(distributed, "disaster-recovery-staging")') ||
    count(infrastructure, "async cleanupPostInstall(transferId: string): Promise<void>") !== 1 ||
    count(infrastructure, "async cleanupCurrentDevice(signal?: AbortSignal): Promise<void>") !== 1 ||
    count(target, "await context.cleanupTransfer()") !== 1 ||
    count(target, "await input.staging.cleanupPostInstall(input.transferId)") !== 1
  ) {
    failures.push("disaster-recovery exact cleanup ownership drifted");
  }

  const retired = /FileDisasterRecoveryCandidateJournal|FileDisasterRecoveryTransferJournal/u;
  if (records.some(({ text }) => retired.test(text))) {
    failures.push("disaster-recovery retired physical owner returned");
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
  const applicationHost = byPath.get("packages/cli/src/serve/application-host.ts");
  const stagingInfrastructure = byPath.get(
    "packages/cli/src/serve/planned-anchor-transfer-staging-infrastructure.ts",
  );
  const accessRoot = byPath.get("packages/cli/src/serve/access-surfaces.ts");
  const executorRoot = byPath.get("packages/cli/src/serve/executor-role-runtime.ts");
  const setup = byPath.get("packages/cli/src/setup-delivery.ts");
  const channels = byPath.get("packages/cli/src/serve/channels.ts");
  const inboundRouter = byPath.get("packages/server/src/channels/inbound-router.ts");
  const conversationProtocol = byPath.get("packages/cli/src/serve/conversation-protocol-runtime.ts");
  const deliveryPipeline = byPath.get("packages/core/src/delivery/authority-pipeline.ts");
  const surfaceAssetAuthority = byPath.get("packages/cli/src/serve/surface-asset-authority.ts");
  const surfaceAssets = byPath.get("packages/core/src/authority/surface-assets.ts");
  const lifecycleContribution = byPath.get(
    "packages/cli/src/serve/planned-duty-migration-lifecycle-contribution.ts",
  );
  if (
    !assembly || !mesh || !transfer || !command || !server || !facade || !product ||
    !accessRoot || !executorRoot || !setup || !firstParty || !connectionLifetime || !localRouter ||
    !registry || !bootstrap || !applicationHost || !stagingInfrastructure ||
    !channels || !inboundRouter || !conversationProtocol ||
    !deliveryPipeline || !surfaceAssetAuthority || !surfaceAssets || !lifecycleContribution
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
  const physicalFactoryDefinitions = records.filter(({ text }) =>
    text.includes("export function createPlannedAnchorTransferStagingInfrastructure("));
  if (
    physicalFactoryDefinitions.length !== 1 ||
    physicalFactoryDefinitions[0]?.relative !==
      "packages/cli/src/serve/planned-anchor-transfer-staging-infrastructure.ts" ||
    count(stagingInfrastructure, '"anchor-transfer-staging"') !== 1 ||
    count(stagingInfrastructure, "new FileArtifactStore(") !== 1 ||
    count(stagingInfrastructure, "new FileAuthorityCommitLog(") !== 2 ||
    count(stagingInfrastructure, "new FileResumableArtifactReceiver(") !== 2 ||
    count(
      stagingInfrastructure,
      "MAX_PLANNED_ANCHOR_TRANSFER_ARTIFACT_BYTES = 512 * 1024 * 1024 * 1024",
    ) !== 1 ||
    count(
      stagingInfrastructure,
      "PLANNED_ANCHOR_TRANSFER_CHUNK_BYTES = 512 * 1024",
    ) !== 1 ||
    !stagingInfrastructure.includes('transferPath(root, "transfers", input.transferId)') ||
    !stagingInfrastructure.includes('transferPath(root, "journals", input.transferId)') ||
    !stagingInfrastructure.includes('path.join(root, "candidate-claims")') ||
    !stagingInfrastructure.includes('path.join(transferRoot, "artifacts")') ||
    !stagingInfrastructure.includes('path.join(transferRoot, "partials")') ||
    !stagingInfrastructure.includes('path.join(transferRoot, "promotion-partials")') ||
    !stagingInfrastructure.includes("cleanupTransferAndJournal: async () => {") ||
    !stagingInfrastructure.includes("cleanupPostInstall(transferId: string): Promise<void>") ||
    !transfer.includes("interface PlannedAnchorAuthorityReadPort {") ||
    !transfer.includes("interface PlannedAnchorInstallAuthorityPort extends PlannedAnchorAuthorityReadPort {") ||
    !transfer.includes("export interface PlannedAnchorJournalStorage {") ||
    !transfer.includes("interface PlannedAnchorSourceAuthorityPort") ||
    /conversation-transfer-staging|disaster-recovery-staging/u.test(stagingInfrastructure) ||
    /from\s+["']node:(?:fs|fs\/promises|path)["']/u.test(transfer) ||
    /\bAuthorityCommitLog\b|FileArtifactStore|FileAuthorityCommitLog|FileResumableArtifactReceiver|stagingRoot|privateRoot|Pick\s*</u.test(transfer) ||
    /anchor-transfer-staging|stagingRoot|privateRoot|FileResumableArtifactReceiver/u.test(assembly) ||
    /anchor-transfer-staging|stagingRoot|privateRoot|FileResumableArtifactReceiver/u.test(bootstrap)
  ) {
    failures.push("planned anchor staging physical ownership or finite boundary drifted");
  }
  if (
    count(applicationHost, "createPlannedAnchorTransferStagingInfrastructure,") !== 2 ||
    count(applicationHost, "createPlannedAnchorTransferStaging({") !== 1 ||
    [...applicationHost.matchAll(
      /await this\.#prepareMesh\(\s*deviceCapacity,\s*plannedAnchorTransferStaging,\s*disasterRecoveryStaging,\s*\)/gu,
    )].length !== 2 ||
    count(applicationHost, "plannedAnchorTransferStaging.close()") !== 1 ||
    count(
      bootstrap,
      "readonly plannedAnchorTransferStaging: PlannedAnchorTransferStagingArea;",
    ) !== 3 ||
    count(
      bootstrap,
      "plannedAnchorTransferStaging: input.plannedAnchorTransferStaging",
    ) !== 2 ||
    count(bootstrap, "staging: input.plannedAnchorTransferStaging") !== 1 ||
    count(
      accessRoot,
      "plannedAnchorTransferStaging: bootstrap.plannedAnchorTransferStaging",
    ) !== 1 ||
    count(
      executorRoot,
      "plannedAnchorTransferStaging: bootstrap.mesh.plannedAnchorTransferStaging",
    ) !== 1 ||
    count(
      assembly,
      "readonly plannedAnchorTransferStaging: PlannedAnchorTransferStagingArea;",
    ) !== 1 ||
    count(assembly, "staging: this.options.plannedAnchorTransferStaging") !== 3
  ) {
    failures.push("planned anchor staging Host/bootstrap required instance flow drifted");
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
    "for (const transferId of await this.#staging.recoverableTransferIds())",
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
  const staticContribution = command.indexOf(
    "definePlannedDutyMigrationLifecycleContribution({",
  );
  const preparedStart = command.indexOf("await preparedMesh.start({", staticContribution);
  const activePublication = command.indexOf("ctx.meshRuntime = activeMesh", preparedStart);
  const runtimeStart = assembly.indexOf("  async start(options: {");
  const runtimeStop = assembly.indexOf("  async stop(): Promise<void>", runtimeStart);
  const runtimeContribution = assembly.indexOf(
    "definePlannedDutyMigrationLifecycleContribution(",
    runtimeStart,
  );
  const initialRole = assembly.indexOf(
    "this.#installInitialPlannedAnchorRole(this.options.trust)",
    runtimeContribution,
  );
  const deviceRecovery = assembly.indexOf(
    "await this.#deviceRemovalTarget.resumeBeforeAdmission()",
    initialRole,
  );
  const plannedStartupRecovery = assembly.indexOf(
    "await this.#recoverStartupState(options.lifecycleAdmissionClosed === true)",
    deviceRecovery,
  );
  const postInstallRecovery = assembly.indexOf(
    "await this.#completePlannedAnchorPostInstall()",
    plannedStartupRecovery,
  );
  const controlStart = assembly.indexOf("await this.#startControl()", postInstallRecovery);
  if (
    completion < 0 || loadInstall < completion || activateKey < loadInstall || committed < activateKey ||
    bootstrapCompletion < 0 || activeGate < bootstrapCompletion ||
    count(assembly, "bindAuthorityCheckpointOwner(") !== 0 ||
    count(assembly, "bindPlannedAnchorLifecycle(") !== 0 ||
    count(assembly, "bindPlannedAnchorPostInstallConsumers(") !== 0 ||
    count(command, "bindAuthorityCheckpointOwner(") !== 0 ||
    count(command, "bindPlannedAnchorLifecycle(") !== 0 ||
    count(command, "bindPlannedAnchorPostInstallConsumers(") !== 0 ||
    !lifecycleContribution.includes('readonly kind: "anchor"') ||
    !lifecycleContribution.includes('readonly kind: "absent"') ||
    !lifecycleContribution.includes('readonly role: "executor-only"') ||
    !lifecycleContribution.includes('kind: "interaction" | "confirmation" | "final"') ||
    !lifecycleContribution.includes('kind: "assignment" | "intent"') ||
    !lifecycleContribution.includes('kind: "delivery"') ||
    count(lifecycleContribution, "definePlannedDutyMigrationLifecycleContribution(") !== 2 ||
    staticContribution < 0 || preparedStart < staticContribution ||
    activePublication < preparedStart || runtimeContribution < runtimeStart ||
    initialRole < runtimeContribution || deviceRecovery < initialRole ||
    plannedStartupRecovery < deviceRecovery || postInstallRecovery < plannedStartupRecovery ||
    controlStart < postInstallRecovery ||
    runtimeStop < runtimeStart ||
    count(assembly.slice(runtimeStart, runtimeStop), "await this.#startControl()") !== 1 ||
    count(command, "definePlannedDutyMigrationLifecycleContribution({") !== 1 ||
    count(command, "await preparedMesh.start({") !== 1 ||
    count(command, "plannedDutyMigrationLifecycle,") !== 1 ||
    count(executorRoot, "EXECUTOR_ONLY_PLANNED_DUTY_MIGRATION_LIFECYCLE") !== 3 ||
    count(assembly, "#plannedDutyMigrationLifecycle!: PlannedDutyMigrationLifecycleContribution") !== 1 ||
    count(assembly, "this.#plannedDutyMigrationLifecycle = plannedDutyMigrationLifecycle") !== 1 ||
    assembly.includes("#plannedAnchorCheckpointOwner") ||
    assembly.includes("#plannedAnchorLifecycle") ||
    assembly.includes("#plannedAnchorPostInstallConsumers") ||
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
    "const receipt = await authority.rebindInstalledAuthority(generation);",
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
  const plannedLifecycle = command.indexOf("definePlannedDutyMigrationLifecycleContribution({");
  const stopInbound = command.indexOf("plannedInbound.refuseNewMessages()", plannedLifecycle);
  const drainInbound = command.indexOf(
    "await plannedInbound.drainAcceptedMessages()",
    stopInbound,
  );
  const disconnectChannels = command.indexOf(
    "await plannedChannel.connections.disconnectConfigured()",
    drainInbound,
  );
  const quiesceDelivery = command.indexOf(
    "await plannedDelivery.stack.quiesceForAuthorityTransfer()",
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
    /ctx\.[A-Za-z]+\?\./u.test(command.slice(plannedLifecycle, preparedStart)) ||
    count(command, "await plannedDelivery.stack.resumeAfterAuthorityTransfer()") !== 1 ||
    count(command, "await ctx.deliveryStack?.lifecycle.resume()") !== 3 ||
    count(command, "await conversationProtocol.recoverInstalledAuthority()") !== 1 ||
    count(command, "return obligations;") !== 3 ||
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
    count(accessRoot, "connectImmediately: false") !== 1 ||
    !command.includes("await channel.connectConfigured()") ||
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
  if (
    count(transfer, "await context.cleanupTransferAndJournal()") !== 1 ||
    count(
      transfer,
      "await this.#context(candidate.identity.transferId).cleanupTransferAndJournal()",
    ) !== 1 ||
    count(transfer, "await context.cleanupTransfer()") !== 2 ||
    count(transfer, "await input.staging.cleanupPostInstall(input.transferId)") !== 1 ||
    count(transfer, "input.staging.openTransfer({") !== 1 ||
    count(transfer, "this.#staging = options.staging.openTarget({") !== 1 ||
    count(transfer, "await this.#staging.close()") !== 1 ||
    /readonly staging\?/u.test(transfer)
  ) {
    failures.push("planned anchor staging cleanup or lifecycle exact-set drifted");
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

/** A6 Conversation application owns dispatch policy/state; Host owns topology mechanisms only. */
export function inspectConversationExecutorDispatchBoundary(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const required = (relative) => {
    const text = byPath.get(relative);
    if (text === undefined) {
      failures.push(`${relative}: Conversation executor dispatch boundary source is missing`);
    }
    return text ?? "";
  };
  const dispatchPath = "packages/cli/src/serve/conversation-executor-dispatch.ts";
  const protocolPath = "packages/cli/src/serve/conversation-protocol-runtime.ts";
  const accessPath = "packages/cli/src/serve/access-surfaces.ts";
  const executorPath = "packages/cli/src/serve/executor-role-runtime.ts";
  const localOwnerPath = "packages/cli/src/serve/local-conversation-owner.ts";
  const meshPath = "packages/cli/src/serve/mesh-runtime-assembly.ts";
  const commandPath = "packages/cli/src/serve/command.ts";
  const schedulerPath = "packages/cli/src/serve/anchor-scheduler-runtime.ts";
  const dispatch = required(dispatchPath);
  const protocol = required(protocolPath);
  const access = required(accessPath);
  const executor = required(executorPath);
  const localOwner = required(localOwnerPath);
  const mesh = required(meshPath);
  const command = required(commandPath);
  const scheduler = required(schedulerPath);
  const count = (text, token) => text.split(token).length - 1;

  const requiredPort = (relative, text, interfaceName, propertyName, typeName) => {
    const source = sourceFile(relative, text);
    const declaration = source.statements.find((statement) =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === interfaceName
    );
    const property = declaration?.members.find((member) =>
      ts.isPropertySignature(member) &&
      ts.isIdentifier(member.name) && member.name.text === propertyName
    );
    if (
      !property || !ts.isPropertySignature(property) || property.questionToken ||
      property.type?.getText(source) !== typeName
    ) {
      failures.push(
        `${relative}: ${interfaceName}.${propertyName} must be the required ${typeName}`,
      );
    }
  };
  requiredPort(
    protocolPath,
    protocol,
    "ConversationProtocolRuntimeOptions",
    "executorDispatch",
    "ConversationExecutorDispatchApplication",
  );
  requiredPort(
    localOwnerPath,
    localOwner,
    "LocalConversationOwnerAssemblyOptions",
    "executorDispatch",
    "ConversationExecutorDispatchApplication",
  );
  requiredPort(
    localOwnerPath,
    localOwner,
    "LocalConversationOwnerAssemblyOptions",
    "assignmentStaging",
    "ConversationAssignmentStagingPort",
  );
  requiredPort(
    dispatchPath,
    dispatch,
    "ConversationExecutorHostBoundaryOptions",
    "directory",
    "ConversationExecutorTopologyDirectory",
  );

  const forbiddenProtocolTokens = [
    "RemoteConversationExecution",
    "bindRemoteExecution",
    "localExecutor?:",
    "executorLedger()",
    "ConversationAssignmentLedger",
    "InProcessAssignmentSubmission",
    "MeshRuntimeAssembly",
    "isRetryableMeshFailure",
    "#remoteExecution",
    "#localRuntimeFactory",
  ];
  for (const token of forbiddenProtocolTokens) {
    if (protocol.includes(token)) {
      failures.push(`${protocolPath}: topology/transport responsibility leaked through ${token}`);
    }
  }
  if (
    count(protocol, "this.#executorDispatch.plan({") !== 1 ||
    count(protocol, "executorPlan.run({") !== 1 ||
    count(protocol, "requirement: conversationExecutorRequirement(") !== 1 ||
    !protocol.includes("Conversation protocol requires the executor dispatch application")
  ) {
    failures.push(`${protocolPath}: one product-owned requirement/application result chain drifted`);
  }

  const hostBoundaryConstructions = records.filter(({ text }) =>
    text.includes("createConversationExecutorHostBoundary({")
  );
  if (
    hostBoundaryConstructions.length !== 2 ||
    count(access, "createConversationExecutorHostBoundary({") !== 2 ||
    count(executor, "createConversationExecutorHostBoundary({") !== 1 ||
    hostBoundaryConstructions.some(({ relative }) => ![accessPath, executorPath].includes(relative))
  ) {
    failures.push("Conversation executor Host boundary construction exact-set drifted");
  }
  if (
    count(access, "executorDispatch: executorBoundary.application") !== 1 ||
    count(access, "executorDispatch: localExecutorBoundary.application") !== 1 ||
    count(executor, "executorDispatch: conversationExecutorBoundary.application") !== 1 ||
    count(localOwner, "executorDispatch: options.executorDispatch") !== 1 ||
    localOwner.includes("createConversationExecutorHostBoundary({")
  ) {
    failures.push("Conversation executor application/staging Host injection drifted");
  }
  if (
    dispatch.includes("bindDirectory(") ||
    dispatch.includes("#directory: ConversationExecutorTopologyDirectory | undefined") ||
    access.includes("executorBoundary.topology") ||
    mesh.includes("bindDirectory(") ||
    mesh.includes("#remoteDirectory()") ||
    count(mesh, "this.options.executorTopologyDirectory.candidates()") !== 1 ||
    count(access, "directory: topologyDirectory") !== 1 ||
    count(access, "directory: NO_REMOTE_CONVERSATION_EXECUTORS") !== 1 ||
    count(executor, "directory: NO_REMOTE_CONVERSATION_EXECUTORS") !== 1 ||
    access.indexOf("new MeshConversationExecutorTopologyDirectory({") < 0 ||
    access.indexOf("new MeshConversationExecutorTopologyDirectory({") >
      access.indexOf("const executorBoundary = createConversationExecutorHostBoundary({") ||
    mesh.includes("bindRemoteExecution") ||
    count(dispatch, "this.#authority.prepareConversationAssignment({") !== 1 ||
    dispatch.includes("supportsOffDeviceExecution") ||
    dispatch.includes("readonly ingress: IngressContext") ||
    dispatch.includes("readonly invocation: ConversationInvocation")
  ) {
    failures.push("Conversation executor static topology/application ownership drifted");
  }
  const topology = dispatch.slice(
    dispatch.indexOf("export class ConversationExecutorTopologyAdapter"),
    dispatch.indexOf(
      "export interface ConversationExecutorHostBoundary",
      dispatch.indexOf("export class ConversationExecutorTopologyAdapter"),
    ),
  );
  if (
    topology.includes("prepareConversationAssignment") ||
    topology.includes("ConversationInvocation") ||
    topology.includes("IngressContext") ||
    topology.includes("localLedger()") ||
    topology.includes("runtimeFactory()") ||
    topology.includes("authority()") ||
    topology.includes("bindDirectory(") ||
    !topology.includes("readonly #directory: ConversationExecutorTopologyDirectory")
  ) {
    failures.push("Host topology adapter became a product-policy or service-locator owner");
  }
  const demand = dispatch.slice(
    dispatch.indexOf("export interface ConversationExecutorExecutionEffect"),
    dispatch.indexOf("export interface ConversationExecutorHostBoundaryOptions"),
  );
  if (
    demand.includes("ConversationAssignmentLedger") ||
    demand.includes("InProcessAssignmentSubmission") ||
    demand.includes("RuntimeFactory") ||
    demand.includes("localLedger")
  ) {
    failures.push("Conversation executor demand contract leaked concrete Executor implementation");
  }
  if (
    command.includes("conversationProtocol.executorLedger()") ||
    scheduler.includes("conversationProtocol.executorLedger()") ||
    access.includes("conversationProtocol.executorLedger()") ||
    dispatch.includes("localLedger()") ||
    command.includes("conversationExecutorDispatch.localLedger()") ||
    access.includes("conversationExecutorDispatch!.localLedger()")
  ) {
    failures.push("Conversation executor ledger escaped through a demand or dispatch accessor");
  }
  return failures;
}

/** A6 Workscene remote probing consumes one static topology port before publication. */
export function inspectWorksceneRemoteWorkspaceProbeTopologyBoundary(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const required = (relative) => {
    const text = byPath.get(relative);
    if (text === undefined) {
      failures.push(`${relative}: Workscene remote workspace probe topology source is missing`);
    }
    return text ?? "";
  };
  const directory = required("packages/cli/src/serve/workscene-directory.ts");
  const topology = required("packages/cli/src/serve/workscene-remote-workspace-probe.ts");
  const command = required("packages/cli/src/serve/command.ts");
  const access = required("packages/cli/src/serve/access-surfaces.ts");
  const mesh = required("packages/cli/src/serve/mesh-runtime-assembly.ts");
  const count = (text, token) => text.split(token).length - 1;

  if (
    !directory.includes("export interface WorksceneRemoteWorkspaceProbePort") ||
    !directory.includes("remoteWorkspaceProbe: WorksceneRemoteWorkspaceProbePort;") ||
    directory.includes("remoteWorkspaceProbe?:") ||
    directory.includes("probeRemote") ||
    count(directory, "deps.remoteWorkspaceProbe.probe(") !== 1 ||
    /MeshRuntimeAssembly|MeshConnectionRegistry|MeshExecutorTopologyTrustState|EnvironmentProbeMeshClient/u.test(
      directory,
    )
  ) {
    failures.push("Workscene remote workspace probe demand is not one required topology-neutral port");
  }

  if (
    !topology.includes("export const REJECT_REMOTE_WORKSPACE_PROBE") ||
    !topology.includes("export class MeshWorksceneRemoteWorkspaceProbe") ||
    !topology.includes("this.options.trust.current().members.find(") ||
    count(topology, "this.options.trust.current()") < 2 ||
    !topology.includes('target?.state !== "active"') ||
    !topology.includes('!target.roles.includes("executor")') ||
    !topology.includes("!this.options.connections.has(deviceId)") ||
    !topology.includes("this.options.connections.client(deviceId)") ||
    /MeshRuntimeAssembly|\b(?:bind|install|set)(?:Remote|Probe|Topology)|\b(?:ref|currentRef|runtimeRef)\b|\bget\s+\w+\s*\(/u.test(
      topology,
    )
  ) {
    failures.push("Workscene remote workspace probe adapter lost static wiring or live trust/connectivity");
  }

  const trustIndex = command.indexOf("const meshExecutorTopologyTrust =");
  const connectionsIndex = command.indexOf("const meshConnections =");
  const portIndex = command.indexOf("const remoteWorkspaceProbe =");
  const directoryIndex = command.indexOf("const worksceneDirectory = createWorksceneDirectory({");
  if (
    trustIndex < 0 || connectionsIndex < 0 || portIndex < 0 || directoryIndex < 0 ||
    trustIndex > portIndex || connectionsIndex > portIndex || portIndex > directoryIndex ||
    count(command, "new MeshConnectionRegistry({") !== 1 ||
    count(command, "new MeshExecutorTopologyTrustState(") !== 1 ||
    count(command, "new MeshWorksceneRemoteWorkspaceProbe({") !== 1 ||
    count(command, "remoteWorkspaceProbe,") !== 1 ||
    !command.includes("...(meshConnections ? { meshConnections } : {}),") ||
    !command.includes(
      "...(meshExecutorTopologyTrust ? { meshExecutorTopologyTrust } : {}),",
    ) ||
    /meshRuntimeRef|probeRemote|workspaceProbeForDevice|MeshRuntimeAssembly\s*\|\s*undefined/u.test(
      command,
    )
  ) {
    failures.push("Anchor Host does not publish one complete static Workscene probe topology");
  }

  if (
    access.includes("new MeshConnectionRegistry({") ||
    access.includes("new MeshExecutorTopologyTrustState(") ||
    !access.includes("trust: ctx.meshExecutorTopologyTrust") ||
    !access.includes("connections: ctx.meshConnections") ||
    access.includes("ctx.meshConnections =") ||
    access.includes("ctx.meshExecutorTopologyTrust =") ||
    mesh.includes("workspaceProbeForDevice(")
  ) {
    failures.push("Mesh/Conversation assembly regained a second or late Workscene topology owner");
  }
  return failures;
}

/** A6 assignment stream/ticket consumers depend on one topology-neutral finite port. */
export function inspectAssignmentDataPlaneBoundary(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const required = (relative) => {
    const text = byPath.get(relative);
    if (text === undefined) failures.push(`${relative}: assignment data-plane source is missing`);
    return text ?? "";
  };
  const executor = required("packages/cli/src/serve/executor-data-plane-runtime.ts");
  const topology = required("packages/cli/src/serve/assignment-data-plane-topology.ts");
  const lossless = required("packages/cli/src/serve/lossless-data-plane-runtime.ts");
  const composition = required("packages/cli/src/serve/lossless-data-plane-composition.ts");
  const coordinator = required("packages/cli/src/serve/channel-interaction-coordinator.ts");
  const protocol = required("packages/cli/src/serve/conversation-protocol-runtime.ts");
  const mesh = required("packages/cli/src/serve/mesh-runtime-assembly.ts");
  const access = required("packages/cli/src/serve/access-surfaces.ts");
  const executorRole = required("packages/cli/src/serve/executor-role-runtime.ts");
  const count = (text, token) => text.split(token).length - 1;

  if (
    !topology.includes("export interface AssignmentDataPlaneTarget") ||
    !topology.includes("export interface AssignmentDataPlaneTargetDirectory") ||
    !topology.includes("export class AssignmentDataPlaneTopologyAdapter") ||
    topology.includes("ExecutorDataPlaneRuntime") ||
    topology.includes("ConversationAssignmentLedger") ||
    topology.includes("AssignmentStreamSpool") ||
    topology.includes("DataPlaneTicketRegistry") ||
    topology.includes("MeshRuntimeAssembly")
  ) {
    failures.push("assignment data-plane topology contract leaked a concrete mechanism");
  }
  if (
    !lossless.includes("readonly #targets: AssignmentDataPlaneTargetDirectory") ||
    !lossless.includes("this.#targets.targetForExecutor(") ||
    [
      "AuthorityRuntimeStack",
      "ExecutorDataPlaneRuntime",
      "MeshRuntimeAssembly",
      "DurableConversationInteractionObserver",
      "dataPlaneForExecutor",
    ].some((token) => lossless.includes(token))
  ) {
    failures.push("lossless assignment data-plane consumer bypassed its finite target port");
  }
  if (
    !composition.includes("readonly targets: AssignmentDataPlaneTargetDirectory") ||
    !composition.includes("targets: options.targets") ||
    /readonly\s+(?:authority|local|mesh|interactions)\s*:/u.test(composition)
  ) {
    failures.push("lossless data-plane composition restored a concrete service-locator input");
  }
  if (
    !coordinator.includes("export interface ChannelInteractionDataPlanePort") ||
    coordinator.includes("LosslessDataPlaneRuntime") ||
    !protocol.includes("export interface ConversationLosslessDataPlanePort") ||
    protocol.includes("LosslessDataPlaneRuntime")
  ) {
    failures.push("assignment data-plane upper consumers depend on a concrete runtime");
  }
  if (
    !executor.includes("readonly #spool: AssignmentStreamSpool") ||
    !executor.includes("readonly #tickets: DataPlaneTicketRegistry") ||
    /readonly\s+(?:spool|tickets)\s*:/u.test(executor) ||
    executor.includes("bindLedger(") ||
    !executor.includes("readonly assignmentTickets: ExecutorDataPlaneTicketAuthorityPort") ||
    !executor.includes("readonly localTransport: AssignmentDataPlaneLocalTransportPort") ||
    !executor.includes("registerMeshServices(input: AssignmentDataPlaneMeshServiceInput)")
  ) {
    failures.push("executor data-plane concrete spool/ticket ownership escaped its finite ports");
  }
  if (
    !mesh.includes("readonly dataPlane: AssignmentDataPlaneMeshPort") ||
    count(mesh, "dataPlane.registerMeshServices({") !== 1 ||
    mesh.includes("dataPlane.spool") ||
    mesh.includes("dataPlane.tickets") ||
    mesh.includes("registerAssignmentStreamService(this.services") ||
    mesh.includes("registerDataPlaneTicketService(this.services") ||
    !mesh.includes("remoteDataPlaneTarget(executorId: string): AssignmentDataPlaneTarget")
  ) {
    failures.push("Mesh assignment data-plane binding owns concrete storage or business selection");
  }
  if (
    count(access, "new AssignmentDataPlaneTopologyAdapter({") !== 1 ||
    count(access, "new ExecutorDataPlaneRuntime({") !== 1 ||
    count(executorRole, "new ExecutorDataPlaneRuntime({") !== 1 ||
    count(access, ".assignmentTickets") !== 2 ||
    count(executorRole, ".assignmentTickets") !== 2 ||
    count(access, "bindAssignmentAuthority(") !== 1 ||
    count(executorRole, "bindAssignmentAuthority(") !== 1
  ) {
    failures.push("Host assignment data-plane construction and finite injection exact-set drifted");
  }
  return failures;
}

/** A6 Advancement evidence chooses local or Mesh only through one Host adapter. */
export function inspectAdvancementEvidenceTopologyBoundary(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const required = (relative) => {
    const text = byPath.get(relative);
    if (text === undefined) failures.push(`${relative}: Advancement evidence source is missing`);
    return text ?? "";
  };
  const topology = required("packages/cli/src/serve/advancement-evidence-topology.ts");
  const application = required("packages/cli/src/serve/advancement-controller.ts");
  const command = required("packages/cli/src/serve/command.ts");
  const context = required("packages/cli/src/serve/access-surface.ts");
  const access = required("packages/cli/src/serve/access-surfaces.ts");
  const localOwner = required("packages/cli/src/serve/local-conversation-owner.ts");
  const mesh = required("packages/cli/src/serve/mesh-runtime-assembly.ts");
  const evidenceMesh = required("packages/cli/src/serve/evidence-mesh.ts");
  const count = (text, token) => text.split(token).length - 1;

  if (
    !topology.includes("export interface AdvancementEvidenceTargetDirectory") ||
    !topology.includes("export interface AdvancementEvidenceRemoteDirectory") ||
    !topology.includes("export class AdvancementEvidenceTopologyAdapter") ||
    !topology.includes("export class AdvancementEvidenceHostBinding") ||
    [
      "ExecutorEvidenceHandler",
      "EvidenceMeshClient",
      "MeshRuntimeAssembly",
      "AssemblyContext",
      "MeshServiceRegistry",
      "ownerEpoch:",
      "workspace:",
      "descriptor:",
    ].some((token) => topology.includes(token))
  ) {
    failures.push("Advancement evidence demand contract leaked a concrete mechanism or target rule");
  }
  if (
    !application.includes("readonly evidenceRuntime?: AdvancementEvidenceRuntimePort") ||
    !application.includes("evidenceRuntime.targets.clientForExecutor(executorId)") ||
    [
      "AssemblyContext",
      "ExecutorEvidenceHandler",
      "EvidenceMeshClient",
      "MeshRuntimeAssembly",
      "evidenceForExecutor",
      "executorId ===",
    ].some((token) => application.includes(token))
  ) {
    failures.push("Advancement evidence application bypassed its finite target directory");
  }
  if (
    count(command, "new AdvancementEvidenceHostBinding()") !== 1 ||
    count(command, "evidenceRuntime: advancementEvidenceRuntime") !== 1 ||
    command.includes("evidenceRuntime: () =>") ||
    command.includes("evidenceForExecutor(")
  ) {
    failures.push("command restored an AssemblyContext or Mesh evidence service-locator path");
  }
  if (
    !context.includes("readonly advancementEvidenceRuntime: AdvancementEvidenceHostBindingPort") ||
    count(access, "ctx.advancementEvidenceRuntime.bind({") !== 1 ||
    count(access, "new AdvancementEvidenceTopologyAdapter({") !== 1 ||
    !/createMeshSurface\(\),\r?\n\s+advancementEvidenceTopologyUnit,\r?\n\s+losslessDataPlaneSurface/u.test(
      access,
    ) ||
    count(localOwner, "new AdvancementEvidenceTopologyAdapter({") !== 1
  ) {
    failures.push("Host Advancement evidence topology construction exact-set drifted");
  }
  if (
    !mesh.includes("AdvancementEvidenceRemoteDirectory") ||
    !mesh.includes("remoteEvidenceClient(executorId: string)") ||
    mesh.includes("evidenceForExecutor(") ||
    /remoteEvidenceClient\([\s\S]*?this\.options\.executor\?\.evidence/u.test(mesh)
  ) {
    failures.push("Mesh evidence mechanism regained local selection or a concrete lookup API");
  }
  const meshClientOwners = records
    .filter((record) => record.text.includes("new EvidenceMeshClient("))
    .map((record) => record.relative)
    .sort();
  const serviceRegistrationOwners = records
    .filter((record) =>
      record.relative !== "packages/cli/src/serve/evidence-mesh.ts" &&
      record.text.includes("registerEvidenceMeshService("),
    )
    .map((record) => record.relative)
    .sort();
  if (
    meshClientOwners.length !== 1 ||
    meshClientOwners[0] !== "packages/cli/src/serve/mesh-runtime-assembly.ts" ||
    serviceRegistrationOwners.length !== 1 ||
    serviceRegistrationOwners[0] !== "packages/cli/src/serve/mesh-runtime-assembly.ts" ||
    count(mesh, "new EvidenceMeshClient(") !== 1 ||
    count(mesh, "registerEvidenceMeshService(") !== 1 ||
    !evidenceMesh.includes("export class EvidenceMeshClient implements EvidenceHandlerPort")
  ) {
    failures.push("Advancement evidence Mesh client or service acquired a second production owner");
  }
  return failures;
}

/** A6 Assignment resource needs cross only finite Correctness ports. */
export function inspectAssignmentResourcePortBoundary(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const required = (relative) => {
    const source = byPath.get(relative);
    if (source === undefined) failures.push(`${relative}: Assignment resource source is missing`);
    return source ?? "";
  };
  const owner = required("packages/cli/src/serve/conversation-owner-runtime.ts");
  const protocol = required("packages/cli/src/serve/conversation-protocol-runtime.ts");
  const dispatch = required("packages/cli/src/serve/conversation-executor-dispatch.ts");
  const ledger = required("packages/cli/src/serve/conversation-executor-ledger.ts");
  const conversationWorker = required(
    "packages/cli/src/serve/conversation-assignment-worker.ts",
  );
  const jobWorker = required("packages/cli/src/serve/job-assignment-worker.ts");
  const access = required("packages/cli/src/serve/access-surfaces.ts");
  const executorRole = required("packages/cli/src/serve/executor-role-runtime.ts");
  const mesh = required("packages/cli/src/serve/mesh-runtime-assembly.ts");
  const setup = required("packages/cli/src/setup-delivery.ts");
  const ownerContract = owner.slice(
    owner.indexOf("export interface ConversationOwnerRuntimeStack"),
    owner.indexOf("export function anchorConversationOwnerRuntime"),
  );
  const demandSources = [protocol, dispatch, ledger, conversationWorker, jobWorker];

  if (
    demandSources.some((source) => source.includes("ExecutorResourceGovernor")) ||
    owner.includes("import type { ExecutorResourceGovernor") ||
    owner.includes(" as ExecutorResourceGovernor")
  ) {
    failures.push("Assignment resource demand boundary regained the concrete governor");
  }
  if (
    !ownerContract.includes("readonly resources: ConversationOwnerResourceAuthority") ||
    !ownerContract.includes("readonly executionResources?: ResourceReservationPort") ||
    !ownerContract.includes(
      "readonly assignmentResources?: ExecutorAssignmentResourceCoordinator",
    ) ||
    !ownerContract.includes("readonly resourceRecovery: ConversationResourceRecoveryPort") ||
    /readonly\s+(?:resourceGovernor|executorResources|executorResourceGovernor)\b/u.test(
      ownerContract,
    )
  ) {
    failures.push("Conversation owner resource role exact-set or legacy aliases drifted");
  }
  if (
    !protocol.includes("this.#authority.resources.enqueueRoot(") ||
    !protocol.includes("this.#authority.resourceRecovery.reclaimExpired()") ||
    !protocol.includes(
      "this.#authority.resourceRecovery.activeConversationReservations()",
    ) ||
    !protocol.includes("this.#authority.executionResources") ||
    [
      "this.#authority.resourceGovernor",
      "this.#authority.executorResources",
      "this.#authority.executorResourceGovernor",
    ].some((token) => protocol.includes(token))
  ) {
    failures.push("Conversation protocol bypassed its finite resource roles");
  }
  if (
    !ledger.includes("resources: options.authority.assignmentResources") ||
    !dispatch.includes("options.authority.assignmentResources") ||
    ledger.includes(" as ExecutorResourceGovernor") ||
    dispatch.includes("options.authority.executorResources")
  ) {
    failures.push("Assignment ledger or dispatch bypassed its coordinator port");
  }
  for (const [name, source] of [
    ["conversation", conversationWorker],
    ["job", jobWorker],
  ]) {
    if (
      !source.includes("readonly resources: ResourceReservationPort") ||
      !source.includes("port: this.options.resources") ||
      source.includes("resourceGovernor")
    ) {
      failures.push(`${name} worker bypassed its ResourceReservationPort`);
    }
  }
  if (
    !access.includes("createConversationResourceRecoveryPort({") ||
    !access.includes("resources: ctx.authorityRuntime.executorResourceGovernor") ||
    !executorRole.includes("createConversationResourceRecoveryPort({") ||
    !executorRole.includes("resources: authority.executorResourceGovernor") ||
    !mesh.includes("resources: options.authority.executorResourceGovernor")
  ) {
    failures.push("Host Assignment resource role projection exact-set drifted");
  }
  const concreteOwners = records
    .filter((record) => /new\s+executorRuntime!\.ExecutorResourceGovernor\(/u.test(record.text))
    .map((record) => record.relative);
  if (
    concreteOwners.length !== 1 ||
    concreteOwners[0] !== "packages/cli/src/setup-delivery.ts" ||
    !setup.includes("new executorRuntime!.ExecutorResourceGovernor({")
  ) {
    failures.push("Executor resource governor acquired a second production owner");
  }
  return failures;
}

/** A6 keeps P07 workspace-probe bytes at one finite Host infrastructure edge. */
export function inspectWorkspaceProbePersistenceBoundary(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const required = (relative) => {
    const source = byPath.get(relative);
    if (source === undefined) {
      failures.push(`${relative}: workspace probe persistence source is missing`);
    }
    return source ?? "";
  };
  const probe = required("packages/core/src/environment/workspace-probe.ts");
  const port = required(
    "packages/core/src/environment/workspace-probe-persistence.ts",
  );
  const environment = required("packages/core/src/environment/index.ts");
  const coreIndex = required("packages/core/src/index.ts");
  const adapterPath = "packages/cli/src/serve/workspace-probe-persistence.ts";
  const adapter = required(adapterPath);
  const setup = required("packages/cli/src/setup-delivery.ts");
  const options = probe.slice(
    probe.indexOf("export interface WorkspaceProbeHandlerOptions"),
    probe.indexOf("export interface WorkspaceProbePort"),
  );

  if (
    !port.includes("export interface WorkspaceProbePersistencePort") ||
    !port.includes("inspectEstablishment(): Promise<WorkspaceProbePersistenceObservation>") ||
    !port.includes("publishEstablishment(): Promise<void>") ||
    !options.includes("readonly persistence: WorkspaceProbePersistencePort") ||
    options.includes("readonly persistence?:") ||
    !probe.includes("this.#persistence.inspectEstablishment()") ||
    !probe.includes("this.#persistence.publishEstablishment()")
  ) {
    failures.push("Workspace probe demand persistence port exact-set drifted");
  }
  if (
    /WorkspaceProbePersistence|workspace-probe-persistence/u.test(environment) ||
    coreIndex.includes("workspace-probe-persistence") ||
    !probe.includes(
      'import type { WorkspaceProbePersistencePort } from "./workspace-probe-persistence.js"',
    )
  ) {
    failures.push("Workspace probe persistence port leaked through a Core barrel");
  }
  if (
    /node:(?:fs|fs\/promises|path)/u.test(probe) ||
    /\b(?:ensureDurableDirectory|syncDirectory)\b|#(?:rootDir|markerPath)|\blogPath\b|["']workspace-probes["']/u.test(
      probe,
    ) ||
    /as\s+(?:FileAuthorityCommitLog|WorkspaceProbePersistencePort)/u.test(probe)
  ) {
    failures.push("Core workspace probe regained a path, filesystem or concrete log mechanism");
  }
  if (
    !adapter.includes("implements WorkspaceProbePersistencePort") ||
    !adapter.includes('from "@zhixing/core/environment/workspace-probe-persistence"') ||
    !adapter.includes("readonly authorityLog: FileAuthorityCommitLog") ||
    !adapter.includes('"distributed-runtime",\n      "workspace-probes"') ||
    !adapter.includes('path.join(this.#rootDir, "probe-log-established")') ||
    !adapter.includes("this.#authorityLogPath = options.authorityLog.logPath") ||
    !adapter.includes("await ensureDurableDirectory(this.#rootDir)") ||
    !adapter.includes("await handle.sync()") ||
    !adapter.includes("await syncDirectory(this.#rootDir)") ||
    /WorkspaceProbe(?:Request|Result)|probe-(?:started|completed|retired)|ProtocolSign/u.test(
      adapter,
    )
  ) {
    failures.push("CLI workspace probe persistence adapter ownership or durability drifted");
  }
  if (
    !setup.includes("persistence: new FileWorkspaceProbePersistence({") ||
    !setup.includes("zhixingHome: options.zhixingHome") ||
    !setup.includes("authorityLog: executorLog!") ||
    setup.includes('path.join(authorityRoot, "workspace-probes")')
  ) {
    failures.push("setupAuthorityRuntime workspace probe persistence binding drifted");
  }

  const adapterDefinitions = records
    .filter((record) => record.text.includes("implements WorkspaceProbePersistencePort"))
    .map((record) => record.relative)
    .sort();
  const adapterConstructions = records
    .filter((record) => record.text.includes("new FileWorkspaceProbePersistence("))
    .map((record) => record.relative)
    .sort();
  if (
    adapterDefinitions.length !== 1 ||
    adapterDefinitions[0] !== adapterPath ||
    adapterConstructions.length !== 1 ||
    adapterConstructions[0] !== "packages/cli/src/setup-delivery.ts"
  ) {
    failures.push("Workspace probe persistence acquired a second adapter or constructor");
  }
  return failures;
}

/** A6 keeps each P07 workspace-binding generation marker/WAL pair at one Host edge. */
export function inspectWorkspaceBindingGenerationPersistenceBoundary(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const required = (relative) => {
    const source = byPath.get(relative);
    if (source === undefined) {
      failures.push(`${relative}: workspace binding generation persistence source is missing`);
    }
    return source ?? "";
  };
  const service = required("packages/core/src/environment/workspace-bindings.ts");
  const catalog = required("packages/core/src/environment/workspace-binding-catalog.ts");
  const port = required(
    "packages/core/src/environment/workspace-binding-generation-persistence.ts",
  );
  const environment = required("packages/core/src/environment/index.ts");
  const coreIndex = required("packages/core/src/index.ts");
  const coreBuild = required("packages/core/tsup.config.ts");
  const adapterPath =
    "packages/cli/src/serve/workspace-binding-generation-persistence.ts";
  const adapter = required(adapterPath);
  const setup = required("packages/cli/src/setup-delivery.ts");
  const options = service.slice(
    service.indexOf("export interface WorkspaceBindingServiceOptions"),
    service.indexOf("export interface WorkspaceCapabilityPublication"),
  );

  if (
    !port.includes("export interface WorkspaceBindingGenerationPersistencePort") ||
    !port.includes(
      "inspectEstablishment(): Promise<WorkspaceBindingGenerationPersistenceObservation>",
    ) ||
    !port.includes("publishEstablishment(): Promise<void>") ||
    !options.includes(
      "readonly persistence: WorkspaceBindingGenerationPersistencePort",
    ) ||
    options.includes("readonly persistence?:") ||
    !service.includes("this.#persistence.inspectEstablishment()") ||
    !service.includes("this.#persistence.publishEstablishment()")
  ) {
    failures.push("Workspace binding generation persistence port exact-set drifted");
  }
  if (
    /WorkspaceBindingGenerationPersistence|workspace-binding-generation-persistence/u.test(
      environment,
    ) ||
    coreIndex.includes("workspace-binding-generation-persistence") ||
    !service.includes(
      'import type { WorkspaceBindingGenerationPersistencePort } from "./workspace-binding-generation-persistence.js"',
    ) ||
    !coreBuild.includes('"src/environment/workspace-binding-generation-persistence.ts"')
  ) {
    failures.push("Workspace binding generation persistence port export boundary drifted");
  }
  if (
    /#markerPath|\blogPath\b|writeEstablishmentMarker|ensureDurableDirectory|syncDirectory/u.test(
      service,
    ) ||
    options.includes("readonly rootDir:") ||
    /as\s+(?:FileAuthorityCommitLog|WorkspaceBindingGenerationPersistencePort)/u.test(
      service,
    )
  ) {
    failures.push(
      "Core workspace binding service regained generation paths, marker I/O or concrete WAL access",
    );
  }
  if (
    !catalog.includes("readonly initialGeneration: WorkspaceBindingGenerationRuntime") ||
    !catalog.includes("readonly createGeneration:") ||
    !catalog.includes("readonly persistence: WorkspaceBindingGenerationPersistencePort") ||
    !catalog.includes("persistence: runtime.persistence") ||
    /initialLog|createGenerationLog|#generationLogs/u.test(catalog) ||
    catalog.includes('path.join(\n        this.#rootDir,\n        "generations"')
  ) {
    failures.push("Workspace binding Catalog generation/WAL pairing drifted");
  }
  if (
    !adapter.includes("class FileWorkspaceBindingGenerationPersistence") ||
    !adapter.includes("implements WorkspaceBindingGenerationPersistencePort") ||
    !adapter.includes(
      "export class FileWorkspaceBindingGenerationPersistenceFactory",
    ) ||
    !adapter.includes(
      'from "@zhixing/core/environment/workspace-binding-generation-persistence"',
    ) ||
    !adapter.includes('"workspace-bindings"') ||
    !adapter.includes('"generations"') ||
    !adapter.includes('path.join(this.#rootDir, "directory-established")') ||
    !adapter.includes("authorityLogPath: authorityLog.logPath") ||
    !adapter.includes('open(this.#markerPath, "wx", 0o600)') ||
    !adapter.includes("await handle.sync()") ||
    !adapter.includes("await syncDirectory(this.#rootDir)") ||
    /WorkspaceBindingRecord|directory-established.*deviceId/u.test(adapter)
  ) {
    failures.push(
      "CLI workspace binding generation persistence ownership or durability drifted",
    );
  }
  if (
    !setup.includes("new FileWorkspaceBindingGenerationPersistenceFactory({") ||
    !setup.includes("initialGeneration: {") ||
    !setup.includes("log: initialWorkspaceBindingLog") ||
    !setup.includes(
      'bindingGenerationPersistence.create(\n              "catalog-initial",\n              initialWorkspaceBindingLog',
    ) ||
    !setup.includes("createGeneration: (generation) => {") ||
    !setup.includes("bindingGenerationPersistence.create(\n                generation,\n                log")
  ) {
    failures.push("setupAuthorityRuntime workspace binding generation pairing drifted");
  }

  const adapterDefinitions = records
    .filter((record) =>
      record.text.includes("implements WorkspaceBindingGenerationPersistencePort")
    )
    .map((record) => record.relative)
    .sort();
  const factoryConstructions = records
    .filter((record) =>
      record.text.includes("new FileWorkspaceBindingGenerationPersistenceFactory(")
    )
    .map((record) => record.relative)
    .sort();
  if (
    adapterDefinitions.length !== 1 ||
    adapterDefinitions[0] !== adapterPath ||
    factoryConstructions.length !== 1 ||
    factoryConstructions[0] !== "packages/cli/src/setup-delivery.ts"
  ) {
    failures.push(
      "Workspace binding generation persistence acquired a second adapter or factory",
    );
  }
  return failures;
}

/** A6 keeps the P07 Workspace catalog root manifest at one finite Host CAS edge. */
export function inspectWorkspaceBindingCatalogPersistenceBoundary(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const required = (relative) => {
    const source = byPath.get(relative);
    if (source === undefined) {
      failures.push(`${relative}: workspace binding catalog persistence source is missing`);
    }
    return source ?? "";
  };
  const catalog = required("packages/core/src/environment/workspace-binding-catalog.ts");
  const port = required(
    "packages/core/src/environment/workspace-binding-catalog-persistence.ts",
  );
  const environment = required("packages/core/src/environment/index.ts");
  const coreIndex = required("packages/core/src/index.ts");
  const coreBuild = required("packages/core/tsup.config.ts");
  const adapterPath =
    "packages/cli/src/serve/workspace-binding-catalog-persistence.ts";
  const adapter = required(adapterPath);
  const setup = required("packages/cli/src/setup-delivery.ts");
  const options = catalog.slice(
    catalog.indexOf("export interface WorkspaceBindingCatalogOptions"),
    catalog.indexOf("interface WorkspaceBindingGenerationRuntime"),
  );

  if (
    !port.includes("export interface WorkspaceBindingCatalogPersistencePort") ||
    !port.includes("load(): Promise<WorkspaceBindingCatalogRootDocument | undefined>") ||
    !port.includes("readonly expectedSnapshotToken: string | undefined") ||
    !port.includes("readonly replacementBytes: string") ||
    !options.includes(
      "readonly rootPersistence: WorkspaceBindingCatalogPersistencePort",
    ) ||
    options.includes("readonly rootPersistence?:") ||
    !catalog.includes("this.#rootPersistence.load()") ||
    !catalog.includes("this.#rootPersistence.compareAndSwap({")
  ) {
    failures.push("Workspace binding catalog persistence port exact-set drifted");
  }
  if (
    /WorkspaceBindingCatalogPersistence|workspace-binding-catalog-persistence/u.test(
      environment,
    ) ||
    coreIndex.includes("workspace-binding-catalog-persistence") ||
    !catalog.includes(
      'import type { WorkspaceBindingCatalogPersistencePort } from "./workspace-binding-catalog-persistence.js"',
    ) ||
    !coreBuild.includes('"src/environment/workspace-binding-catalog-persistence.ts"')
  ) {
    failures.push("Workspace binding catalog persistence port export boundary drifted");
  }
  if (
    /node:(?:fs|fs\/promises|path)|acquireFileLock|ensureDurableDirectory|syncDirectory|#rootDir|#manifestPath|\.tmp-|\brename\(/u.test(
      catalog,
    ) ||
    options.includes("readonly rootDir:") ||
    /as\s+(?:FileWorkspaceBindingCatalogPersistence|WorkspaceBindingCatalogPersistencePort)/u.test(
      catalog,
    ) ||
    !catalog.includes("this.#maintenanceResourceKey()")
  ) {
    failures.push(
      "Core Workspace binding Catalog regained root paths, file CAS or physical maintenance identity",
    );
  }
  if (
    !adapter.includes(
      "export class FileWorkspaceBindingCatalogPersistence",
    ) ||
    !adapter.includes("implements WorkspaceBindingCatalogPersistencePort") ||
    !adapter.includes(
      'from "@zhixing/core/environment/workspace-binding-catalog-persistence"',
    ) ||
    !adapter.includes('"distributed-runtime"') ||
    !adapter.includes('"workspace-bindings"') ||
    !adapter.includes('path.join(this.#rootDir, "root-manifest.json")') ||
    !adapter.includes('acquireFileLock(`${this.#manifestPath}.lock`') ||
    !adapter.includes('open(temp, "w", 0o600)') ||
    !adapter.includes("await handle.sync()") ||
    !adapter.includes("await rename(temp, this.#manifestPath)") ||
    !adapter.includes("await syncDirectory(this.#rootDir)") ||
    /catalogGeneration|pendingReset|capabilityRevision/u.test(adapter)
  ) {
    failures.push(
      "CLI Workspace binding catalog persistence ownership or durability drifted",
    );
  }
  if (
    !setup.includes(
      "rootPersistence: new FileWorkspaceBindingCatalogPersistence({\n            zhixingHome: options.zhixingHome,",
    ) ||
    setup.includes("rootDir: bindingRoot")
  ) {
    failures.push("setupAuthorityRuntime Workspace binding root CAS binding drifted");
  }

  const adapterDefinitions = records
    .filter((record) =>
      record.text.includes("implements WorkspaceBindingCatalogPersistencePort")
    )
    .map((record) => record.relative)
    .sort();
  const adapterConstructions = records
    .filter((record) =>
      record.text.includes("new FileWorkspaceBindingCatalogPersistence(")
    )
    .map((record) => record.relative)
    .sort();
  if (
    adapterDefinitions.length !== 1 ||
    adapterDefinitions[0] !== adapterPath ||
    adapterConstructions.length !== 1 ||
    adapterConstructions[0] !== "packages/cli/src/setup-delivery.ts"
  ) {
    failures.push(
      "Workspace binding catalog persistence acquired a second adapter or constructor",
    );
  }
  return failures;
}

/** A6 keeps the P09 D03 projection behind three finite roles at Host edges. */
export function inspectMeshBootstrapProjectionBoundary(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const required = (relative) => {
    const source = byPath.get(relative);
    if (source === undefined) {
      failures.push(`${relative}: Mesh bootstrap projection source is missing`);
    }
    return source ?? "";
  };
  const projectionPath = "packages/cli/src/serve/mesh-bootstrap-projection.ts";
  const storePath = "packages/cli/src/serve/mesh-bootstrap-store.ts";
  const projection = required(projectionPath);
  const store = required(storePath);
  const control = required("packages/cli/src/serve/mesh-control-plane.ts");
  const bootstrap = required("packages/cli/src/serve/mesh-runtime-bootstrap.ts");
  const assembly = required("packages/cli/src/serve/mesh-runtime-assembly.ts");
  const access = required("packages/cli/src/serve/access-surfaces.ts");
  const executor = required("packages/cli/src/serve/executor-role-runtime.ts");
  const surface = required("packages/cli/src/runtime/surface-core-host-link.ts");
  const pairing = required("packages/cli/src/serve/mesh-pair-command.ts");

  for (const [role, methods] of [
    ["MeshEndpointDirectoryPersistencePort", ["loadEndpoints", "acceptEndpoint"]],
    ["MeshTransportPeerDirectoryPersistencePort", ["loadTransportPeers", "acceptTransportPeer"]],
    ["MeshBootstrapCompletionPersistencePort", ["markBootstrapComplete", "bootstrapCompleted"]],
  ]) {
    const start = projection.indexOf(`export interface ${role}`);
    const end = projection.indexOf("\n}", start);
    const declaration = start < 0 || end < 0 ? "" : projection.slice(start, end);
    if (
      start < 0 ||
      methods.some((method) => !declaration.includes(`readonly ${method}:`)) ||
      declaration.includes("?:") ||
      /FileMeshBootstrapStore|node:fs|node:path/u.test(declaration)
    ) {
      failures.push(`Mesh bootstrap ${role} exact-set or dependency boundary drifted`);
    }
  }
  if (
    !projection.includes("return Object.freeze({") ||
    !projection.includes("endpoints: Object.freeze({") ||
    !projection.includes("transportPeers: Object.freeze({") ||
    !projection.includes("completions: Object.freeze({") ||
    /\b(?:class|interface)\s+(?:MeshStorage|MeshPersistence|MeshBootstrapStorePort)\b/u.test(
      projection,
    )
  ) {
    failures.push("Mesh bootstrap finite projection construction drifted");
  }
  if (
    !store.includes("MeshEndpointDirectoryPersistencePort,") ||
    !store.includes("MeshTransportPeerDirectoryPersistencePort,") ||
    !store.includes("MeshBootstrapCompletionPersistencePort") ||
    !store.includes("implements\n    MeshEndpointDirectoryPersistencePort") ||
    !store.includes('"mesh-endpoints.json"') ||
    !store.includes('"mesh-peers.json"') ||
    !store.includes('"mesh-bootstrap-completions.json"')
  ) {
    failures.push("File Mesh bootstrap projection ownership drifted");
  }

  const controlOptions = control.slice(
    control.indexOf("export interface ProductionMeshControlPlaneOptions"),
    control.indexOf("/** Owns direct listeners"),
  );
  if (
    /FileMeshBootstrapStore|\bbootstrapStore\b|Pick\s*</u.test(control) ||
    !controlOptions.includes("readonly endpointDirectory: MeshEndpointDirectoryPersistencePort;") ||
    !controlOptions.includes(
      "readonly transportPeerDirectory: MeshTransportPeerDirectoryPersistencePort;",
    ) ||
    controlOptions.includes("readonly endpointDirectory?:") ||
    controlOptions.includes("readonly transportPeerDirectory?:") ||
    !control.includes("options.endpointDirectory.acceptEndpoint(descriptor)") ||
    !control.includes("this.options.transportPeerDirectory.loadTransportPeers()")
  ) {
    failures.push("Mesh control plane regained concrete or optional bootstrap persistence");
  }
  if (
    (bootstrap.match(/readonly bootstrapProjection: MeshBootstrapProjectionPorts;/gu)?.length ?? 0) !== 2 ||
    !bootstrap.includes("createMeshBootstrapProjectionPorts(bootstrapStore)") ||
    /bootstrapStore\.(?:loadEndpoints|acceptEndpoint|loadTransportPeers|acceptTransportPeer|markBootstrapComplete|bootstrapCompleted)\b/u.test(
      bootstrap,
    ) ||
    !assembly.includes("readonly bootstrapProjection: MeshBootstrapProjectionPorts;") ||
    assembly.includes("readonly bootstrapProjection?:") ||
    !assembly.includes("completions: this.options.bootstrapProjection.completions") ||
    !assembly.includes("await input.completions.markBootstrapComplete(") ||
    !access.includes("bootstrapProjection: bootstrap.bootstrapProjection") ||
    !executor.includes("bootstrapProjection: bootstrap.mesh.bootstrapProjection")
  ) {
    failures.push("Persistent Host Mesh bootstrap projection binding drifted");
  }
  if (
    !surface.includes("createMeshBootstrapProjectionPorts(bootstrapStore)") ||
    surface.includes("Pick<FileMeshBootstrapStore") ||
    /bootstrapStore\.(?:loadEndpoints|acceptEndpoint|loadTransportPeers|acceptTransportPeer|markBootstrapComplete|bootstrapCompleted)\b/u.test(
      surface,
    ) ||
    !pairing.includes("createMeshBootstrapProjectionPorts(store)") ||
    /(?:input\.)?(?:store|bootstrapStore)\.(?:loadEndpoints|acceptEndpoint|loadTransportPeers|acceptTransportPeer|markBootstrapComplete|bootstrapCompleted)\b/u.test(
      pairing,
    )
  ) {
    failures.push("Command Host Mesh bootstrap projection binding drifted");
  }

  const controlPlaneCallers = records.filter((record) =>
    record.text.includes("new ProductionMeshControlPlane({")
  );
  for (const record of controlPlaneCallers) {
    const calls = record.text.match(/new ProductionMeshControlPlane\(\{/gu)?.length ?? 0;
    const endpointBindings = record.text.match(/\bendpointDirectory:/gu)?.length ?? 0;
    const peerBindings = record.text.match(/\btransportPeerDirectory:/gu)?.length ?? 0;
    const trustBindings = record.text.match(/\btrustProjection:/gu)?.length ?? 0;
    if (
      endpointBindings < calls ||
      peerBindings < calls ||
      trustBindings < calls
    ) {
      failures.push(`${record.relative}: Mesh control plane finite binding is incomplete`);
    }
  }
  const projectionFactories = records
    .filter((record) =>
      record.relative !== projectionPath &&
      record.text.includes("createMeshBootstrapProjectionPorts(")
    )
    .map((record) => record.relative)
    .sort();
  const expectedFactories = [
    "packages/cli/src/runtime/surface-core-host-link.ts",
    "packages/cli/src/serve/mesh-pair-command.ts",
    "packages/cli/src/serve/mesh-runtime-bootstrap.ts",
  ];
  const storeOwners = records
    .filter((record) => record.text.includes("implements\n    MeshEndpointDirectoryPersistencePort"))
    .map((record) => record.relative);
  if (
    projectionFactories.length !== expectedFactories.length ||
    projectionFactories.some((relative, index) => relative !== expectedFactories[index]) ||
    storeOwners.length !== 1 ||
    storeOwners[0] !== storePath
  ) {
    failures.push("Mesh bootstrap projection acquired a second factory or physical owner");
  }
  return failures;
}

/** A6 keeps the P09 D04 continuation behind one finite repository at command/Host edges. */
export function inspectMeshPairingContinuationPersistenceBoundary(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const required = (relative) => {
    const source = byPath.get(relative);
    if (source === undefined) {
      failures.push(`${relative}: Mesh pairing continuation source is missing`);
    }
    return source ?? "";
  };
  const repositoryPath =
    "packages/cli/src/serve/mesh-pairing-continuation-repository.ts";
  const storePath = "packages/cli/src/serve/mesh-pairing-continuation.ts";
  const pairPath = "packages/cli/src/serve/mesh-pair-command.ts";
  const assemblyPath = "packages/cli/src/serve/mesh-runtime-assembly.ts";
  const accessPath = "packages/cli/src/serve/access-surfaces.ts";
  const executorPath = "packages/cli/src/serve/executor-role-runtime.ts";
  const cleanupPath = "packages/cli/src/serve/device-removal-cleanup.ts";
  const repository = required(repositoryPath);
  const store = required(storePath);
  const pair = required(pairPath);
  const assembly = required(assemblyPath);
  const access = required(accessPath);
  const executor = required(executorPath);
  const cleanup = required(cleanupPath);

  const contractStart = repository.indexOf(
    "export interface MeshPairingContinuationRepository",
  );
  const contractEnd = repository.indexOf("\n}", contractStart);
  const contract = contractStart < 0 || contractEnd < 0
    ? ""
    : repository.slice(contractStart, contractEnd);
  if (
    contractStart < 0 ||
    !contract.includes("readonly load:") ||
    !contract.includes("readonly save:") ||
    !contract.includes("readonly clear:") ||
    contract.includes("?:") ||
    /FileMeshPairingContinuationStore|node:fs|node:path|rootDir|filePath/u.test(contract) ||
    !repository.includes("return Object.freeze({") ||
    !repository.includes('readonly side: "issuer";') ||
    !repository.includes('readonly side: "joiner";') ||
    !repository.includes('readonly phase: "offer-secret-pending" | "offered";') ||
    !repository.includes('| { readonly phase: "secret-pending" }') ||
    !repository.includes('| { readonly phase: "commit-ready" }') ||
    !repository.includes('| { readonly phase: "proof-ready" }') ||
    !repository.includes('readonly phase: "bootstrap-ready";')
  ) {
    failures.push("Mesh pairing continuation finite repository or phase exact-set drifted");
  }

  if (
    !store.includes("implements MeshPairingContinuationRepository") ||
    store.includes("export class FileMeshPairingContinuationStore") ||
    !store.includes('"mesh-pairing-continuation.json"') ||
    !store.includes("`${this.#filePath}.lock`") ||
    (store.match(/acquireFileLock\(this\.#lockPath/gu)?.length ?? 0) !== 3 ||
    !store.includes("canonicalize(value) !== text") ||
    !store.includes("assertContinuationShape(value)") ||
    !store.includes('randomBytes(8).toString("hex")') ||
    !store.includes('flag: "wx"') ||
    !store.includes("await handle.sync()") ||
    !store.includes("await rename(temporary, filePath)") ||
    !store.includes("await syncDirectory(directory)") ||
    !store.includes("await rm(temporary, { force: true }).catch(() => undefined)") ||
    !store.includes("new FileMeshPairingContinuationStore(rootDir)") ||
    !store.includes("projectMeshPairingContinuationRepository(")
  ) {
    failures.push("File Mesh pairing continuation durability contract drifted");
  }

  const runtimeInputStart = pair.indexOf("interface PairingRuntimeInput");
  const runtimeInputEnd = pair.indexOf("\n}", runtimeInputStart);
  const runtimeInput = runtimeInputStart < 0 || runtimeInputEnd < 0
    ? ""
    : pair.slice(runtimeInputStart, runtimeInputEnd);
  if (
    !runtimeInput.includes(
      "readonly continuations: MeshPairingContinuationRepository;",
    ) ||
    runtimeInput.includes("FileMeshPairingContinuationStore") ||
    pair.includes("new FileMeshPairingContinuationStore(") ||
    !pair.includes("createFileMeshPairingContinuationRepository(zhixingHome)") ||
    !pair.includes("await continuations.load()") ||
    !pair.includes("await input.continuations.save(") ||
    !pair.includes("await input.continuations.clear(")
  ) {
    failures.push("Pair command bypasses its finite continuation repository");
  }

  if (
    !assembly.includes(
      "readonly pairingContinuations: MeshPairingContinuationRepository;",
    ) ||
    assembly.includes("readonly pairingContinuations?:") ||
    assembly.includes("FileMeshPairingContinuationStore") ||
    !assembly.includes("continuations: this.options.pairingContinuations") ||
    !assembly.includes("const continuation = await input.continuations.load()") ||
    !assembly.includes("await input.continuations.clear(offerId)") ||
    !access.includes(
      "pairingContinuations: createFileMeshPairingContinuationRepository(",
    ) ||
    !executor.includes(
      "pairingContinuations: createFileMeshPairingContinuationRepository(",
    )
  ) {
    failures.push("Persistent Mesh Host continuation binding is optional or bypassed");
  }

  const factoryConsumers = records
    .filter((record) =>
      record.relative !== storePath &&
      record.text.includes("createFileMeshPairingContinuationRepository(")
    )
    .map((record) => record.relative)
    .sort();
  const expectedFactoryConsumers = [accessPath, executorPath, pairPath].sort();
  const concreteOwners = records
    .filter((record) =>
      record.text.includes("new FileMeshPairingContinuationStore(")
    )
    .map((record) => record.relative);
  const repositoryOwners = records
    .filter((record) =>
      record.text.includes("implements MeshPairingContinuationRepository")
    )
    .map((record) => record.relative);
  if (
    factoryConsumers.length !== expectedFactoryConsumers.length ||
    factoryConsumers.some((relative, index) =>
      relative !== expectedFactoryConsumers[index]
    ) ||
    concreteOwners.length !== 1 ||
    concreteOwners[0] !== storePath ||
    repositoryOwners.length !== 1 ||
    repositoryOwners[0] !== storePath
  ) {
    failures.push("Mesh pairing continuation acquired a second factory or physical owner");
  }
  if (
    cleanup.includes("mesh-pairing-continuation.json") ||
    cleanup.includes("MeshPairingContinuationRepository") ||
    cleanup.includes("FileMeshPairingContinuationStore")
  ) {
    failures.push("Device removal cleanup took ownership of pairing continuation state");
  }
  return failures;
}

export function inspectSurfaceAssetStagingPersistenceBoundary(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const required = (relative) => {
    const text = byPath.get(relative);
    if (text === undefined) failures.push(`${relative}: Surface asset staging source is missing`);
    return text ?? "";
  };
  const portPath = "packages/core/src/authority/surface-asset-staging.ts";
  const coordinatorPath = "packages/core/src/authority/surface-assets.ts";
  const lifecyclePath = "packages/core/src/authority/artifact-lifecycle-index.ts";
  const infrastructurePath =
    "packages/cli/src/serve/surface-asset-staging-infrastructure.ts";
  const authorityPath = "packages/cli/src/serve/surface-asset-authority.ts";
  const bootstrapPath = "packages/cli/src/serve/mesh-bootstrap-store.ts";
  const cleanupPath = "packages/cli/src/serve/device-removal-cleanup.ts";
  const ports = required(portPath);
  const coordinator = required(coordinatorPath);
  const lifecycle = required(lifecyclePath);
  const infrastructure = required(infrastructurePath);
  const authority = required(authorityPath);
  const bootstrap = required(bootstrapPath);
  const cleanup = required(cleanupPath);
  const count = (text, token) => text.split(token).length - 1;

  const uploadStart = ports.indexOf("export interface SurfaceAssetUploadStagingPort");
  const uploadEnd = ports.indexOf("\n}", uploadStart);
  const upload = uploadStart < 0 || uploadEnd < 0
    ? ""
    : ports.slice(uploadStart, uploadEnd);
  const recoveryStart = ports.indexOf(
    "export interface SurfaceAssetTemporaryRecoveryPort",
  );
  const recoveryEnd = ports.indexOf("\n}", recoveryStart);
  const recovery = recoveryStart < 0 || recoveryEnd < 0
    ? ""
    : ports.slice(recoveryStart, recoveryEnd);
  const presenceStart = ports.indexOf(
    "export interface SurfaceAssetTemporaryPresencePort",
  );
  const presenceEnd = ports.indexOf("\n}", presenceStart);
  const presence = presenceStart < 0 || presenceEnd < 0
    ? ""
    : ports.slice(presenceStart, presenceEnd);
  if (
    !upload.includes("readonly progress:") ||
    !upload.includes("readonly append:") ||
    !upload.includes("readonly discard:") ||
    /openPartialReferenceCursor|visitPartialReferences|rootDir|path/u.test(upload) ||
    !recovery.includes("readonly progress:") ||
    !recovery.includes("readonly openPartialReferenceCursor:") ||
    /append|discard|visitPartialReferences|rootDir|path/u.test(recovery) ||
    !presence.includes("readonly mark:") ||
    !presence.includes("readonly has:") ||
    !presence.includes("readonly removeScopes:") ||
    !presence.includes("readonly remove:") ||
    !presence.includes("readonly openReconciliationCursor:") ||
    !presence.includes("readonly hasLegacyMigration:") ||
    !presence.includes("readonly beginLegacyMigration:") ||
    !presence.includes("readonly finishLegacyMigration:") ||
    /visitReferences|visitScopes|removeStagingFiles|rootDir|path/u.test(presence) ||
    !ports.includes("return Object.freeze({") ||
    count(ports, "Object.freeze({") !== 4
  ) {
    failures.push("Surface asset staging finite readonly port exact-set drifted");
  }

  if (
    coordinator.includes("FileResumableArtifactReceiver") ||
    coordinator.includes("Pick<File") ||
    !coordinator.includes("readonly receiver: SurfaceAssetUploadStagingPort;") ||
    lifecycle.includes("FileResumableArtifactReceiver") ||
    lifecycle.includes("ArtifactTemporaryPresenceStore") ||
    lifecycle.includes("Pick<File") ||
    !lifecycle.includes("readonly temporaryPresence: SurfaceAssetTemporaryPresencePort;") ||
    !lifecycle.includes("readonly receiver: SurfaceAssetTemporaryRecoveryPort;")
  ) {
    failures.push("Core Surface asset demand regained a concrete or broad physical mechanism");
  }

  if (
    count(infrastructure, "new FileArtifactStore(") !== 1 ||
    count(infrastructure, "new FileResumableArtifactReceiver(") !== 1 ||
    count(infrastructure, "new FileArtifactTemporaryPresenceStore(") !== 1 ||
    count(infrastructure, '"surface-asset-temporary"') !== 1 ||
    count(infrastructure, '"surface-asset-partials"') !== 1 ||
    count(infrastructure, '".presence"') !== 1 ||
    count(infrastructure, "projectSurfaceAssetStagingPorts(receiver, presence)") !== 1 ||
    !infrastructure.includes("return Object.freeze({")
  ) {
    failures.push("Surface asset staging physical composition or root exact-set drifted");
  }

  if (
    count(authority, "createSurfaceAssetStagingInfrastructure({") !== 1 ||
    !authority.includes("temporaryArtifacts: staging.temporaryArtifacts") ||
    !authority.includes("temporaryPresence: staging.presence") ||
    !authority.includes("receiver: staging.recovery") ||
    !authority.includes("receiver: staging.upload") ||
    /FileResumableArtifactReceiver|FileArtifactTemporaryPresenceStore|surface-asset-partials|surface-asset-temporary/u.test(authority) ||
    count(bootstrap, "createSurfaceAssetStagingInfrastructure({") !== 1 ||
    !bootstrap.includes("temporaryArtifacts: staging.temporaryArtifacts") ||
    !bootstrap.includes("temporaryPresence: staging.presence") ||
    !bootstrap.includes("receiver: staging.recovery") ||
    !bootstrap.includes("checkpointRetention(): ArtifactCheckpointRetentionPort") ||
    /FileResumableArtifactReceiver|FileArtifactTemporaryPresenceStore|surface-asset-partials|surface-asset-temporary/u.test(bootstrap)
  ) {
    failures.push("Surface asset full-Host or command-only composition bypassed finite staging roles");
  }

  const factoryConsumers = records
    .filter((record) =>
      record.relative !== infrastructurePath &&
      record.text.includes("createSurfaceAssetStagingInfrastructure({")
    )
    .map((record) => record.relative)
    .sort();
  const expectedConsumers = [authorityPath, bootstrapPath].sort();
  const physicalRootOwners = records
    .filter((record) =>
      record.text.includes('"surface-asset-temporary"') ||
      record.text.includes('"surface-asset-partials"')
    )
    .map((record) => record.relative)
    .sort();
  const expectedRootOwners = [cleanupPath, infrastructurePath].sort();
  if (
    factoryConsumers.length !== expectedConsumers.length ||
    factoryConsumers.some((relative, index) => relative !== expectedConsumers[index]) ||
    physicalRootOwners.length !== expectedRootOwners.length ||
    physicalRootOwners.some((relative, index) => relative !== expectedRootOwners[index])
  ) {
    failures.push("Surface asset staging acquired a second physical root or composition entry");
  }
  if (
    count(cleanup, 'path.join(distributed, "surface-asset-partials")') !== 1 ||
    count(cleanup, 'path.join(distributed, "surface-asset-temporary")') !== 1
  ) {
    failures.push("Surface asset current-device cleanup exact-set drifted");
  }
  return failures;
}

export function inspectAssignmentArtifactReceiverBoundary(records) {
  const failures = [];
  const byPath = new Map(records.map((record) => [record.relative, record.text]));
  const required = (relative) => {
    const text = byPath.get(relative);
    if (text === undefined) failures.push(`${relative}: assignment artifact receiver source is missing`);
    return text ?? "";
  };
  const portPath = "packages/cli/src/serve/assignment-artifact-receiver.ts";
  const infrastructurePath =
    "packages/cli/src/serve/assignment-artifact-receiver-infrastructure.ts";
  const adapterPath = "packages/cli/src/serve/assignment-mesh-adapter.ts";
  const compositionPath = "packages/cli/src/serve/assignment-mesh-composition.ts";
  const assemblyPath = "packages/cli/src/serve/mesh-runtime-assembly.ts";
  const anchorPath = "packages/cli/src/serve/access-surfaces.ts";
  const executorPath = "packages/cli/src/serve/executor-role-runtime.ts";
  const cleanupPath = "packages/cli/src/serve/device-removal-cleanup.ts";
  const port = required(portPath);
  const infrastructure = required(infrastructurePath);
  const adapter = required(adapterPath);
  const composition = required(compositionPath);
  const assembly = required(assemblyPath);
  const anchor = required(anchorPath);
  const executor = required(executorPath);
  const cleanup = required(cleanupPath);
  const count = (text, token) => text.split(token).length - 1;

  const interfaceStart = port.indexOf("export interface AssignmentArtifactReceiverPort");
  const interfaceEnd = port.indexOf("\n}", interfaceStart);
  const contract = interfaceStart < 0 || interfaceEnd < 0
    ? ""
    : port.slice(interfaceStart, interfaceEnd);
  if (
    !contract.includes("readonly progress:") ||
    !contract.includes("readonly append:") ||
    count(contract, "readonly ") !== 2 ||
    /discard|cursor|rootDir|path|FileResumableArtifactReceiver|ArtifactStore/u.test(contract) ||
    count(port, "Object.freeze({") !== 1
  ) {
    failures.push("Assignment artifact receiver finite readonly exact-set drifted");
  }

  if (
    count(infrastructure, "new FileResumableArtifactReceiver(") !== 1 ||
    count(infrastructure, '"mesh-artifact-partials"') !== 1 ||
    count(infrastructure, "projectAssignmentArtifactReceiver(") !== 1 ||
    !infrastructure.includes("artifacts: ArtifactStore;") ||
    !infrastructure.includes("maxArtifactBytes: MAX_ASSIGNMENT_ARTIFACT_BYTES")
  ) {
    failures.push("Assignment artifact receiver physical composition or limits drifted");
  }

  if (
    /FileResumableArtifactReceiver|Pick<File|mesh-artifact-partials/u.test(adapter) ||
    count(adapter, "readonly receiver: AssignmentArtifactReceiverPort;") !== 4 ||
    /FileResumableArtifactReceiver|Pick<File|mesh-artifact-partials/u.test(composition) ||
    count(composition, "readonly receiver: AssignmentArtifactReceiverPort;") !== 1 ||
    /FileResumableArtifactReceiver|Pick<File|mesh-artifact-partials/u.test(assembly) ||
    !assembly.includes(
      "readonly assignmentArtifactReceiver: AssignmentArtifactReceiverPort;",
    ) ||
    assembly.includes(
      "readonly assignmentArtifactReceiver?: AssignmentArtifactReceiverPort;",
    ) ||
    !assembly.includes("receiver: options.assignmentArtifactReceiver")
  ) {
    failures.push("Assignment Mesh demand regained a concrete, broad, or optional receiver");
  }

  if (
    count(anchor, "createAssignmentArtifactReceiverInfrastructure({") !== 1 ||
    count(anchor, "ctx.assignmentArtifactReceiver = receiver;") !== 1 ||
    count(anchor, "assignmentArtifactReceiver: ctx.assignmentArtifactReceiver") !== 1 ||
    anchor.includes("FileResumableArtifactReceiver") ||
    anchor.includes("mesh-artifact-partials")
  ) {
    failures.push("Anchor Host did not inject the unique finite assignment receiver");
  }
  if (
    count(executor, "createAssignmentArtifactReceiverInfrastructure({") !== 1 ||
    count(executor, "assignmentArtifactReceiver: createAssignmentArtifactReceiverInfrastructure({") !== 1 ||
    executor.includes("FileResumableArtifactReceiver") ||
    executor.includes("mesh-artifact-partials")
  ) {
    failures.push("Executor Host did not inject the unique finite assignment receiver");
  }

  const factoryConsumers = records
    .filter((record) =>
      record.relative !== infrastructurePath &&
      record.text.includes("createAssignmentArtifactReceiverInfrastructure({")
    )
    .map((record) => record.relative)
    .sort();
  const expectedConsumers = [anchorPath, executorPath].sort();
  const rootOwners = records
    .filter((record) => record.text.includes('"mesh-artifact-partials"'))
    .map((record) => record.relative)
    .sort();
  const expectedRootOwners = [cleanupPath, infrastructurePath].sort();
  if (
    factoryConsumers.length !== expectedConsumers.length ||
    factoryConsumers.some((relative, index) => relative !== expectedConsumers[index]) ||
    rootOwners.length !== expectedRootOwners.length ||
    rootOwners.some((relative, index) => relative !== expectedRootOwners[index])
  ) {
    failures.push("Assignment artifact receiver acquired a second Host entry or physical root");
  }
  if (count(cleanup, 'path.join(distributed, "mesh-artifact-partials")') !== 1) {
    failures.push("Assignment artifact current-device cleanup exact-set drifted");
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
      "agentTurnAdmission",
      "answerInteractionWithTicket",
      "cancelConversationRuns",
      "commitConversationClear",
      "commitConversationDelete",
      "createConversation",
      "createAgentTurnExecution",
      "deferSchedule",
      "discardDeferredIntent",
      "ensureSession",
      "finalHistory",
      "listConversations",
      "listConversationAuthorities",
      "listDeferredIntents",
      "mutateSession",
      "pendingInteractions",
      "resolveConversationUncertain",
      "resolveNoInteractiveSurface",
      "rubricCatalog",
      "sessionState",
      "statusHistory",
      "taskLists",
      "currentAuthority",
      "subscribeConversationFacts",
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
    "assignmentResources",
    "artifacts",
    "deviceId",
    "executionResources",
    "executorCapabilities",
    "executorId",
    "executorLog",
    "executionAssetCatalog",
    "finalizeUsage",
    "localControlAdmission",
    "localDomainId",
    "localGovernorEpoch",
    "localOwnerEpoch",
    "permissionSnapshotFor",
    "preflightLocalConversationEnvironment",
    "prepareLocalConversationAssignment",
    "releaseLocalConversationEnvironmentPreflight",
    "resourceRecovery",
    "resources",
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
      if (ts.isPropertySignature(node) && node.name) {
        const name = propertyNameText(node.name);
        if (name) contractKeys.add(name);
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
  const projectedResourceDependencies = new Set([
    "resources",
    "executionResources",
    "assignmentResources",
  ]);
  const allowedCreateProperties = new Set([
    "owner",
    "executorDispatch",
    "assignmentStaging",
    "runtimeFactory",
    "interactions",
    "advancementModelProvider",
    "evidence",
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
          if (projectedResourceDependencies.has(name)) {
            if (
              !ts.isIdentifier(property.initializer) ||
              property.initializer.text !== "executorResources"
            ) {
              failures.push(
                `${record.relative}: local runtime dependency ${name} must bind the finite executorResources projection`,
              );
            }
            continue;
          }
          if (name === "resourceRecovery") {
            if (
              !ts.isCallExpression(property.initializer) ||
              !ts.isIdentifier(property.initializer.expression) ||
              property.initializer.expression.text !== "createConversationResourceRecoveryPort"
            ) {
              failures.push(
                `${record.relative}: local runtime resourceRecovery must bind the finite recovery adapter`,
              );
            }
            continue;
          }
          if (name === "finalizeUsage") {
            if (!ts.isArrowFunction(property.initializer)) {
              failures.push(
                `${record.relative}: local runtime finalizeUsage must bind a finite Host adapter`,
              );
            }
            continue;
          }
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
        let hasResourceProjection = false;
        const findResourceProjection = (node) => {
          if (
            ts.isVariableDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === "executorResources" &&
            node.initializer?.getText(source) ===
              `${dependencyOwner}.executorResourceGovernor`
          ) {
            hasResourceProjection = true;
          }
          ts.forEachChild(node, findResourceProjection);
        };
        findResourceProjection(source);
        if (!hasResourceProjection) {
          failures.push(
            `${record.relative}: finite executorResources projection must originate at the Host governor boundary`,
          );
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
            "executorDispatch",
            "assignmentStaging",
            "runtimeFactory",
            "interactions",
            "advancementModelProvider",
            "evidence",
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
    ["packages/cli/src/serve/conversation-transfer-staging-infrastructure.ts", undefined],
    ["packages/cli/src/serve/access-surfaces.ts", undefined],
    ["packages/cli/src/serve/executor-role-runtime.ts", undefined],
    ["packages/cli/src/serve/planned-anchor-transfer.ts", undefined],
    ["packages/cli/src/serve/disaster-recovery-target.ts", undefined],
    ["packages/cli/src/serve/device-removal-cleanup.ts", undefined],
    ["packages/cli/src/serve/conversation-evidence-authority.ts", undefined],
    ["packages/cli/src/serve/conversation-transfer-mesh.ts", undefined],
    ["packages/cli/src/serve/first-party-conversation-mesh.ts", undefined],
    ["packages/cli/src/serve/local-conversation-rpc.ts", undefined],
    ["packages/cli/src/serve/local-conversation-directory-application.ts", undefined],
    ["packages/cli/src/serve/post-adoption-review.ts", undefined],
    ["packages/cli/src/serve/conversation-resume-binding.ts", undefined],
    ["packages/cli/src/serve/command.ts", undefined],
    ["packages/cli/src/runtime/rpc-confirmation-broker.ts", undefined],
    ["packages/cli/src/runtime/rpc-conversation-facade.ts", undefined],
    ["packages/cli/src/runtime/conversation-controller.ts", undefined],
    ["packages/cli/src/repl.ts", undefined],
    ["packages/core/src/conversation/application.ts", undefined],
    ["packages/rpc/src/session-wire.ts", undefined],
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
  const stagingInfrastructure = required.get(
    "packages/cli/src/serve/conversation-transfer-staging-infrastructure.ts",
  );
  requireCount(mesh, /new\s+ConversationTransferTarget\s*\(/gu, 1, "anchor transfer target construction");
  requireCount(mesh, /registerConversationTransferMeshService\s*\(/gu, 1, "conversation transfer mesh registration");
  requireCount(mesh, /options\.localConversationOwner\.transferSource\s*\(\s*\)/gu, 1, "local transfer source binding");
  requireCount(mesh, /afterCommit\s*:\s*async\s*\(base\)[\s\S]*?this\.#installCommittedTransfer\s*\(base\)/gu, 1, "post-commit authority installation");
  if (!/this\.#transferTarget\s*=\s*roles\.has\("anchor"\)\s*&&\s*options\.conversationTransferStaging\s*\?[\s\S]*?new\s+ConversationTransferTarget\s*\(/u.test(mesh.text)) {
    failures.push(`${mesh.relative}: transfer target must be owned only by the active anchor role`);
  }
  if (
    !/readonly\s+conversationTransferStaging:\s*ConversationTransferStagingArea\s*\|\s*null/u.test(mesh.text) ||
    /conversationTransferStaging\?/u.test(mesh.text) ||
    !/roles\.has\("anchor"\)\s*&&\s*!options\.conversationTransferStaging/u.test(mesh.text) ||
    !/staging:\s*options\.conversationTransferStaging,[\s\S]*?storageMaintenance:\s*options\.authority\.storageMaintenance,[\s\S]*?abortSignal:\s*\(\)\s*=>\s*this\.#transferAbort\.signal/u.test(mesh.text) ||
    /FileConversationTransferStagingArea|FileResumableArtifactReceiver|conversation-transfer-staging/u.test(mesh.text)
  ) {
    failures.push(`${mesh.relative}: anchor transfer target must use private staging and the authority governor/lifecycle abort`);
  }
  if (
    count(stagingInfrastructure.text, /new\s+FileArtifactStore\s*\(/gu) !== 1 ||
    count(stagingInfrastructure.text, /new\s+FileResumableArtifactReceiver\s*\(/gu) !== 1 ||
    count(stagingInfrastructure.text, /conversation-transfer-staging/gu) !== 1 ||
    !/MAX_CONVERSATION_TRANSFER_ARTIFACT_BYTES\s*=\s*512\s*\*\s*1024\s*\*\s*1024/u.test(stagingInfrastructure.text) ||
    !/CONVERSATION_TRANSFER_CHUNK_BYTES\s*=\s*256\s*\*\s*1024/u.test(stagingInfrastructure.text) ||
    count(stagingInfrastructure.text, /rm\(transferRoot,\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}\)/gu) !== 1 ||
    !/path\.resolve\([\s\S]*?options\.zhixingHome[\s\S]*?"distributed-runtime"[\s\S]*?"conversation-transfer-staging"/u.test(stagingInfrastructure.text) ||
    !/path\.dirname\(transferRoot\)\s*!==\s*root/u.test(stagingInfrastructure.text) ||
    !/return\s+Object\.freeze\(\{[\s\S]*?forTransfer/u.test(stagingInfrastructure.text) ||
    !/artifacts:\s*Object\.freeze\(\{[\s\S]*?get:[\s\S]*?readRange:[\s\S]*?has:/u.test(stagingInfrastructure.text) ||
    !/receiver:\s*Object\.freeze\(\{[\s\S]*?progress:[\s\S]*?append:/u.test(stagingInfrastructure.text)
  ) {
    failures.push(`${stagingInfrastructure.relative}: conversation transfer staging physical factory or finite frozen projection drifted`);
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
  if (
    !/#postAdoptionReviewLifecycle!:\s*PostAdoptionReviewLifecycleContribution/u.test(
      mesh.text,
    ) ||
    !/const postAdoptionReviewLifecycle\s*=\s*definePostAdoptionReviewLifecycleContribution\([\s\S]*?this\.#postAdoptionReviewLifecycle\s*=\s*postAdoptionReviewLifecycle;[\s\S]*?await this\.#recoverStartupState/u.test(
      mesh.text,
    ) ||
    /bindPostAdoptionReview|#postAdoptionReview\s*[?:]/u.test(mesh.text)
  ) {
    failures.push(`${mesh.relative}: post-adoption review lifecycle must be installed before replaying durable commits`);
  }
  if (!/await\s+protocol\.installCommittedConversationTransfer\s*\(base\);[\s\S]*?lifecycle\.kind\s*!==\s*"anchor"[\s\S]*?lifecycle\.review\.reviewAfterAdoption\s*\(/u.test(mesh.text)) {
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
  if (
    !/params\.acceptLimitedCapabilities\s*!==\s*true/u.test(router.text) ||
    count(router.text, /requireContinuationConsent\(params\);/gu) !== 9 ||
    !/assertLocalConversationIdForDevice\s*\(/u.test(router.text) ||
    /continueLocally|requireLocalConsent/u.test(router.text)
  ) {
    failures.push(`${router.relative}: all limited-capability mutations must require one topology-neutral user decision before local identity routing`);
  }
  const conversationDomain = required.get(
    "packages/core/src/conversation/application.ts",
  );
  if (
    !/type\s+ConversationAvailability\s*=\s*[\s\S]*?capabilitySet:\s*"complete";[\s\S]*?continuationConfirmation:\s*"not-required";[\s\S]*?capabilitySet:\s*"limited";[\s\S]*?continuationConfirmation:\s*"required";[\s\S]*?unavailableCapabilities:\s*readonly\s+string\[\]/u.test(
      conversationDomain.text,
    ) ||
    /mode:\s*"(?:anchor|local-only)"|continueLocally/u.test(
      conversationDomain.text,
    )
  ) {
    failures.push(`${conversationDomain.relative}: Conversation availability must expose only complete/limited capabilities and explicit confirmation semantics`);
  }
  const sessionWire = required.get("packages/rpc/src/session-wire.ts");
  if (
    !/availability\?:\s*ConversationAvailability;/u.test(sessionWire.text) ||
    !/interface\s+SessionContinuationConsent\s*\{[\s\S]*?readonly\s+acceptLimitedCapabilities:\s*true;/u.test(
      sessionWire.text,
    ) ||
    /mode:\s*"(?:anchor|local-only)"|continueLocally/u.test(sessionWire.text)
  ) {
    failures.push(`${sessionWire.relative}: session wire must reuse the domain availability and carry one explicit topology-neutral continuation decision`);
  }
  const localDirectory = required.get(
    "packages/cli/src/serve/local-conversation-directory-application.ts",
  );
  if (
    !/availability:\s*\{[\s\S]*?capabilitySet:\s*"limited",[\s\S]*?continuationConfirmation:\s*"required",[\s\S]*?unavailableCapabilities:\s*LIMITED_CONVERSATION_CAPABILITIES/u.test(
      localDirectory.text,
    ) ||
    /LOCAL_ONLY_CAPABILITIES|mode:\s*"local-only"/u.test(localDirectory.text)
  ) {
    failures.push(`${localDirectory.relative}: Host topology adapter must project finite capability limits without exposing deployment mode`);
  }
  const conversationFacade = required.get(
    "packages/cli/src/runtime/rpc-conversation-facade.ts",
  );
  if (
    count(
      conversationFacade.text,
      /\.\.\.this\.#continuationConsent\(\)/gu,
    ) !== 9 ||
    !/pendingContinuationConfirmation\(\):\s*readonly\s+string\[\]\s*\|\s*null/u.test(
      conversationFacade.text,
    ) ||
    !/confirmContinuation\(\):\s*void/u.test(conversationFacade.text) ||
    /continueLocally|#localOnly|#localContinuation|requiresLocalContinuation|enableLocalContinuation/u.test(
      conversationFacade.text,
    )
  ) {
    failures.push(`${conversationFacade.relative}: the Surface client must apply one capability confirmation fact to the nine mutation requests without topology state`);
  }
  const conversationController = required.get(
    "packages/cli/src/runtime/conversation-controller.ts",
  );
  if (
    !/pendingContinuationConfirmation\?\.\(\)[\s\S]*?confirmContinuation\?\.[\s\S]*?confirmContinuation\?\.\(\)/u.test(
      conversationController.text,
    ) ||
    /OfflineContinuationDeclined|requiresLocalContinuation|enableLocalContinuation|confirmLocalContinuation/u.test(
      conversationController.text,
    )
  ) {
    failures.push(`${conversationController.relative}: initial selection must confirm explicit capability consequences without interpreting deployment topology`);
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
  requireCount(command, /new\s+AnchorSchedulerHostLifecycle\s*\(\{/gu, 1, "anchor Schedule generation owner construction");
  requireCount(command, /definePostAdoptionReviewLifecycleContribution\s*\(\{/gu, 1, "anchor post-adoption review lifecycle contribution");
  requireCount(command, /schedulerGenerationOwner\.postAdoptionReview/gu, 2, "shared post-adoption review port consumption");
  const reviewOwner = command.text.indexOf("const schedulerGenerationOwner = new AnchorSchedulerHostLifecycle({");
  const reviewInstall = command.text.indexOf("await schedulerGenerationOwner.installInitial({", reviewOwner);
  const reviewContribution = command.text.indexOf("const postAdoptionReviewLifecycle =", reviewInstall);
  const meshStart = command.text.indexOf("const activeMesh = await preparedMesh.start({", reviewContribution);
  const publicServer = command.text.indexOf("runner = await runServer(");
  if (
    reviewOwner < 0 ||
    reviewInstall < reviewOwner ||
    reviewContribution < reviewInstall ||
    meshStart < reviewContribution ||
    publicServer < meshStart ||
    !command.text.slice(meshStart, publicServer).includes("postAdoptionReviewLifecycle,") ||
    /bindPostAdoptionReview|let adoptionReview|\.\.\.\(adoptionReview\s*\?/u.test(
      command.text,
    )
  ) {
    failures.push(`${command.relative}: the stable adoption review generation owner must precede Mesh recovery and public admission`);
  }
  const resumeBinding = required.get(
    "packages/cli/src/serve/conversation-resume-binding.ts",
  );
  if (
    !/resume:\s*createAnchorConversationResumePort\s*\(\s*\{[\s\S]*?adoptionReview/u.test(
      command.text,
    ) ||
    !/adoptionReview:\s*AnchorConversationAdoptionReview;[\s\S]*?reviewAdoption:[\s\S]*?input\.adoptionReview\.reviewForSurface/u.test(
      resumeBinding.text,
    ) ||
    /adoptionReview\?:|input\.adoptionReview!|\.\.\.\(input\.adoptionReview/u.test(
      resumeBinding.text,
    ) ||
    count(
      executorRoot.text,
      /postAdoptionReviewLifecycle:\s*EXECUTOR_ONLY_POST_ADOPTION_REVIEW_LIFECYCLE/gu,
    ) !== 2 ||
    /conversationAdoptionReview/u.test(command.text)
  ) {
    failures.push(`${command.relative}: public resume must reuse the authenticated anchor review coordinator`);
  }
  if (
    count(accessRoot.text, /conversationTransferStaging:\s*createConversationTransferStagingInfrastructure\s*\(/gu) !== 1 ||
    count(executorRoot.text, /conversationTransferStaging:\s*null/gu) !== 1 ||
    count(accessRoot.text, /createConversationTransferStagingInfrastructure\s*\(/gu) !== 1 ||
    /createConversationTransferStagingInfrastructure|conversation-transfer-staging/u.test(executorRoot.text)
  ) {
    failures.push("conversation transfer staging must be required at Mesh composition and physically created only by the Anchor Host");
  }
  for (const relative of [
    "packages/cli/src/serve/planned-anchor-transfer.ts",
    "packages/cli/src/serve/disaster-recovery-target.ts",
    "packages/cli/src/serve/device-removal-cleanup.ts",
  ]) {
    const record = required.get(relative);
    if (/createConversationTransferStagingInfrastructure|conversation-transfer-staging/u.test(record.text)) {
      failures.push(`${record.relative}: conversation transfer staging ownership escaped into another P12 lifecycle`);
    }
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
    /FileConversationTransferStagingArea|FileArtifactStore|FileResumableArtifactReceiver|node:path|node:fs\/promises|\brootDir\b|Pick<File/u.test(transferOwner.text) ||
    !/interface\s+ConversationTransferStagingArtifacts[\s\S]*?readonly\s+get:[\s\S]*?readonly\s+readRange:[\s\S]*?readonly\s+has:/u.test(transferOwner.text) ||
    !/interface\s+ConversationTransferStagingReceiver[\s\S]*?readonly\s+progress:[\s\S]*?readonly\s+append:/u.test(transferOwner.text) ||
    !/interface\s+ConversationTransferStaging[\s\S]*?readonly\s+artifacts:[\s\S]*?readonly\s+receiver:[\s\S]*?readonly\s+cleanup:/u.test(transferOwner.text) ||
    !/interface\s+ConversationTransferStagingArea[\s\S]*?readonly\s+forTransfer:/u.test(transferOwner.text) ||
    /ConversationTransferStagingArea\s*\|\s*undefined|staging\?\s*:/u.test(transferOwner.text) ||
    !/const\s+size\s*=\s*256\s*\*\s*1024/u.test(transferOwner.text) ||
    !/promoteTransferClosure\s*\([\s\S]*?putVerifiedStream/u.test(transferOwner.text) ||
    !/step:\s*"staging-cleanup"[\s\S]*?obligation:\s*"committed"[\s\S]*?forTransfer\(transferId\)\.cleanup\(\)/u.test(transferOwner.text)
  ) {
    failures.push(`${transferOwner.relative}: transfer staging demand ports, shared promotion and durable-abort cleanup must remain finite and distinct`);
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
  const addObserver = session.text.indexOf(
    "const observerAdded = manager.addObserver(",
  );
  const resumeCommand = session.text.indexOf(
    "productApi.command(CONVERSATION_RESUME_COMMAND",
  );
  if (
    addObserver < 0 ||
    resumeCommand < 0 ||
    addObserver > resumeCommand ||
    !/const alreadyObserved\s*=\s*manager\s*\.getObserverConnectionIds\(params\.conversationId\)\s*\.has\(connectionId\)/u.test(
      session.text,
    ) ||
    !/error\.code === "not-found"\s*&&\s*observerAdded\s*&&\s*!alreadyObserved[\s\S]*?manager\.removeObserver\(params\.conversationId, connectionId\)/u.test(
      session.text,
    ) ||
    /conversationAdoptionReview/u.test(session.text)
  ) {
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
  if (
    !/confirmContinuation:\s*async\s*\(unavailableCapabilities\)[\s\S]*?unavailableCapabilities\.join\("；"\)[\s\S]*?接受以上限制并继续/u.test(
      repl.text,
    ) ||
    /confirmLocalContinuation/u.test(repl.text)
  ) {
    failures.push(`${repl.relative}: the first-party Surface must present exact capability consequences instead of physical topology`);
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
  if (relative === "packages/runtime-host/package.json") {
    for (const dependency of ["@zhixing/mcp", "@zhixing/tools-builtin"]) {
      if (edges.includes(dependency)) {
        failures.push(`${relative}: runtime-host declares product dependency ${dependency}`);
      }
    }
    for (const subpath of [
      "./builtin-extra-tools",
      "./segment-deps",
      "./workmode-tools",
      "./workscene-port",
    ]) {
      if (subpath in (manifest.exports ?? {})) {
        failures.push(`${relative}: runtime-host exposes retired product subpath ${subpath}`);
      }
    }
  }
  if (
    relative === "packages/orchestrator/package.json" &&
    edges.includes("@zhixing/providers")
  ) {
    failures.push(
      `${relative}: orchestrator declares concrete Provider production dependency`,
    );
  }
  if (
    relative === "packages/orchestrator/package.json" &&
    edges.includes("@zhixing/tools-builtin")
  ) {
    failures.push(
      `${relative}: orchestrator declares concrete Tool production dependency`,
    );
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
