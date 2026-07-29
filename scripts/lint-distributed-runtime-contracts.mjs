import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const coreRoot = fileURLToPath(
  new URL("../packages/core/", import.meta.url),
);
const sourceRoot = resolve(coreRoot, "src");
const contractsRoot = resolve(sourceRoot, "contracts");
const packagesRoot = fileURLToPath(new URL("../packages/", import.meta.url));
const require = createRequire(new URL("../packages/core/package.json", import.meta.url));
const ts = require("typescript");

const frozenSymbols = new Map([
  [
    "src/types/distributed.ts",
    [
      "Ulid",
      "IsoTime",
      "Digest",
      "KeyConfirmation",
      "JsonValue",
      "Signature",
      "ArtifactRef",
      "WireContractV1",
      "WireSchemaIdentity",
      "WireSchemaV1",
    ],
  ],
  ["src/conversation/types.ts", ["TaskListOp", "SegmentRecord"]],
  [
    "src/advancement/types.ts",
    ["EvidenceKind", "AdvancementControlEvent", "AdvancementSnapshot"],
  ],
  ["src/security/types.ts", ["TrustRule", "TrustRuleSnapshot"]],
  ["src/skills/types.ts", ["SkillModeDto", "SkillUsageRecord"]],
  ["src/scheduler/types.ts", ["TaskPriorityDto", "TaskScheduleDto"]],
  ["src/scheduler/facade.ts", ["ScheduleTaskSpec"]],
  ["src/channels/types.ts", ["DeliveryTargetDto", "OutboundContentDto"]],
  [
    "src/memory/contracts.ts",
    ["MemoryCategoryDto", "PersonMetaDto", "MemoryAppendPayload"],
  ],
  ["src/transcript/shard/types.ts", ["TranscriptRunRecord"]],
  ["src/context/window/types.ts", ["WindowCompactInstruction"]],
  [
    "src/types/agent-events.ts",
    ["ProjectedPassthroughEvent", "SessionEventProjection"],
  ],
]);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "__tests__") continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      files.push(path);
    }
  }
  return files;
}

async function parse(file) {
  const source = await readFile(file, "utf8");
  return {
    source,
    tree: ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    ),
  };
}

function containsUnknown(node) {
  let found = false;
  function visit(current) {
    if (current.kind === ts.SyntaxKind.UnknownKeyword) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return found;
}

function collectNamedDeclarations(tree, names) {
  const declarations = new Map([...names].map((name) => [name, []]));
  function visit(node) {
    if (
      (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
      declarations.has(node.name.text)
    ) {
      declarations.get(node.name.text).push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return declarations;
}

const violations = [];
const sourceFiles = await walk(sourceRoot);
const parsedFiles = new Map();
for (const file of sourceFiles) parsedFiles.set(file, await parse(file));

const protocolByteDigestImplementation = resolve(
  sourceRoot,
  "protocol/canonical.ts",
);
for (const file of await walk(packagesRoot)) {
  if (file === protocolByteDigestImplementation) continue;
  const source = await readFile(file, "utf8");
  if (!source.includes("sha256:") || !source.includes("createHash")) continue;
  const tree = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const createHashNames = new Set();
  let constructsProtocolByteDigest = false;
  function containsSha256Hash(current) {
    let found = false;
    function visit(candidate) {
      if (
        ts.isCallExpression(candidate) &&
        ts.isIdentifier(candidate.expression) &&
        createHashNames.has(candidate.expression.text) &&
        candidate.arguments.length > 0 &&
        ts.isStringLiteral(candidate.arguments[0]) &&
        candidate.arguments[0].text === "sha256"
      ) {
        found = true;
        return;
      }
      ts.forEachChild(candidate, visit);
    }
    visit(current);
    return found;
  }
  function inspect(node) {
    if (
      ts.isImportDeclaration(node) &&
      node.moduleSpecifier.text === "node:crypto" &&
      node.importClause?.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      for (const element of node.importClause.namedBindings.elements) {
        if ((element.propertyName ?? element.name).text === "createHash") {
          createHashNames.add(element.name.text);
        }
      }
    }
    if (
      ts.isTemplateExpression(node) &&
      node.head.text === "sha256:" &&
      node.templateSpans.some((span) => containsSha256Hash(span.expression))
    ) {
      constructsProtocolByteDigest = true;
    }
    ts.forEachChild(node, inspect);
  }
  inspect(tree);
  if (constructsProtocolByteDigest) {
    violations.push(
      `${relative(packagesRoot, file)}: protocol B(bytes) digests must use @zhixing/core/protocol byteDigest`,
    );
  }
}

const wireCompositionTypes = new Set([
  "WireSchemaV1",
  "DataPlaneTicketBase",
  "ChannelChallengeTokenBase",
  "DispatchEnvelopeFor",
  "StatusNoticeBase",
  "CancelProofCommon",
]);

for (const [file, { tree }] of parsedFiles) {
  function visit(node) {
    const directWireBase =
      (ts.isTypeReferenceNode(node) &&
        node.typeName.getText(tree) === "WireContractV1") ||
      (ts.isExpressionWithTypeArguments(node) &&
        node.expression.getText(tree) === "WireContractV1");
    if (directWireBase) {
      let declaration = node.parent;
      while (
        declaration &&
        !ts.isTypeAliasDeclaration(declaration) &&
        !ts.isInterfaceDeclaration(declaration)
      ) {
        declaration = declaration.parent;
      }
      const name = declaration?.name?.text;
      if (!name || !wireCompositionTypes.has(name)) {
        violations.push(
          `${relative(coreRoot, file)}: ${name ?? "anonymous type"} must use WireSchemaV1 and register its schema`,
        );
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
}

for (const file of sourceFiles.filter((file) => file.startsWith(contractsRoot))) {
  const { source, tree } = parsedFiles.get(file);
  if (containsUnknown(tree)) {
    violations.push(`${relative(coreRoot, file)}: frozen contracts cannot use unknown`);
  }
  if (/\b(?:Phase|INV|ADR)(?:-|\s+|\s*§)/.test(source)) {
    violations.push(
      `${relative(coreRoot, file)}: comments cannot depend on mutable plan identifiers`,
    );
  }
}

for (const [relativeFile, symbols] of frozenSymbols) {
  const file = resolve(coreRoot, relativeFile);
  const parsed = parsedFiles.get(file) ?? (await parse(file));
  const declarations = collectNamedDeclarations(parsed.tree, symbols);
  for (const [symbol, matches] of declarations) {
    if (matches.length !== 1) {
      violations.push(
        `${relativeFile}: frozen symbol ${symbol} must have exactly one declaration`,
      );
    } else if (containsUnknown(matches[0])) {
      violations.push(`${relativeFile}: frozen symbol ${symbol} cannot use unknown`);
    }
  }
}

const schemaMarkers = new Map();
for (const [file, { tree }] of parsedFiles) {
  function visit(node) {
    const schemaReference =
      (ts.isTypeReferenceNode(node) &&
        (node.typeName.getText(tree) === "WireSchemaV1" ||
          node.typeName.getText(tree) === "WireSchemaIdentity")) ||
      (ts.isExpressionWithTypeArguments(node) &&
        (node.expression.getText(tree) === "WireSchemaV1" ||
          node.expression.getText(tree) === "WireSchemaIdentity"));
    if (schemaReference && node.typeArguments?.length === 1) {
      const [argument] = node.typeArguments;
      if (
        ts.isLiteralTypeNode(argument) &&
        ts.isStringLiteral(argument.literal)
      ) {
        const schemaId = argument.literal.text;
        const locations = schemaMarkers.get(schemaId) ?? [];
        locations.push(`${relative(coreRoot, file)}:${tree.getLineAndCharacterOfPosition(node.pos).line + 1}`);
        schemaMarkers.set(schemaId, locations);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
}

const schemaFile = resolve(contractsRoot, "schema.ts");
const schemaTree = parsedFiles.get(schemaFile).tree;
const schemaMap = schemaTree.statements.find(
  (node) => ts.isInterfaceDeclaration(node) && node.name.text === "WireSchemaMap",
);
if (!schemaMap) {
  violations.push("src/contracts/schema.ts: WireSchemaMap is missing");
} else {
  const registered = new Map();
  for (const member of schemaMap.members) {
    if (!ts.isPropertySignature(member) || !member.type) continue;
    const schemaId = member.name.getText(schemaTree).replace(/^['"]|['"]$/g, "");
    const target = ts.isTypeReferenceNode(member.type)
      ? member.type.typeName.getText(schemaTree)
      : member.type.getText(schemaTree);
    registered.set(schemaId, target);
    if (schemaId !== target) {
      violations.push(
        `src/contracts/schema.ts: ${schemaId} must register the same-named schema, not ${target}`,
      );
    }
  }

  for (const [schemaId, locations] of schemaMarkers) {
    if (locations.length !== 1) {
      violations.push(
        `${schemaId}: schema marker must have exactly one declaration (${locations.join(", ")})`,
      );
    }
    if (!registered.has(schemaId)) {
      violations.push(`${schemaId}: marked schema is missing from WireSchemaMap`);
    }
  }
  for (const schemaId of registered.keys()) {
    if (!schemaMarkers.has(schemaId)) {
      violations.push(`${schemaId}: registered schema is missing its wire schema marker`);
    }
  }
}

if (violations.length > 0) {
  throw new Error(violations.join("\n"));
}
