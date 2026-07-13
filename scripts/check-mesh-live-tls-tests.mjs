import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const testRoot = path.join(projectRoot, "packages", "mesh", "src", "__tests__");
const harnessPath = path.join(testRoot, "live-tls-test-harness.ts");
const require = createRequire(new URL("../packages/mesh/package.json", import.meta.url));
const ts = require("typescript");

const tlsModules = new Set(["node:tls", "tls"]);
const meshTlsFactories = new Set([
  "connectAuthenticatedMesh",
  "createAuthenticatedMeshServer",
]);
const sourceFilePattern = /\.[cm]?[jt]sx?$/u;
const violations = [];
const files = (await walk(testRoot)).filter(
  (file) => sourceFilePattern.test(file) && !file.endsWith(".d.ts"),
);

verifyAnalyzer();

for (const file of files) {
  const source = await readFile(file, "utf8");
  violations.push(...analyzeTestModule(file, source));
}

const harnessSource = await readFile(harnessPath, "utf8");
verifyHarnessImports(harnessSource);

if (violations.length > 0) {
  throw new Error(`Mesh live TLS test boundary failed:\n- ${violations.join("\n- ")}`);
}

console.log(
  `Mesh live TLS test boundary verified: ${files.length} test source files route native TLS through one harness.`,
);

function analyzeTestModule(file, source) {
  if (path.resolve(file) === path.resolve(harnessPath)) return [];
  const tree = createTree(file, source);
  const found = [];

  function report(node, message) {
    found.push(`${relativePath(file)}:${lineOf(tree, node)} ${message}`);
  }

  function visit(node) {
    if (ts.isImportDeclaration(node) && node.importClause) {
      const moduleName = literalModuleName(node.moduleSpecifier);
      if (tlsModules.has(moduleName) && importHasRuntimeBinding(node.importClause)) {
        report(node, "imports native TLS values outside the shared test harness");
      }
      if (ts.isNamedImports(node.importClause.namedBindings)) {
        for (const element of node.importClause.namedBindings.elements) {
          if (!element.isTypeOnly && meshTlsFactories.has(importedName(element))) {
            report(element, `imports ${importedName(element)} outside the shared test harness`);
          }
        }
      }
    }

    if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      tlsModules.has(literalModuleName(node.moduleReference.expression))
    ) {
      report(node, "imports native TLS values outside the shared test harness");
    }

    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const moduleName = literalModuleName(node.moduleSpecifier);
      if (tlsModules.has(moduleName) && exportHasRuntimeBinding(node)) {
        report(node, "re-exports native TLS values outside the shared test harness");
      }
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          if (!element.isTypeOnly && meshTlsFactories.has(importedName(element))) {
            report(element, `re-exports ${importedName(element)} outside the shared test harness`);
          }
        }
      }
    }

    if (isDynamicModuleLoad(node)) {
      const moduleName = literalModuleName(node.arguments[0]);
      if (tlsModules.has(moduleName) || exposesMeshTlsFactories(moduleName)) {
        report(node, `loads ${moduleName} dynamically outside the shared test harness`);
      }
    }

    if (
      ts.isPropertyAccessExpression(node) &&
      meshTlsFactories.has(node.name.text)
    ) {
      report(node, `accesses ${node.name.text} outside the shared test harness`);
    }
    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      ts.isStringLiteral(node.argumentExpression) &&
      meshTlsFactories.has(node.argumentExpression.text)
    ) {
      report(node, `accesses ${node.argumentExpression.text} outside the shared test harness`);
    }
    if (
      ts.isBindingElement(node) &&
      (ts.isIdentifier(node.propertyName ?? node.name) ||
        ts.isStringLiteral(node.propertyName ?? node.name)) &&
      meshTlsFactories.has((node.propertyName ?? node.name).text)
    ) {
      report(
        node,
        `destructures ${(node.propertyName ?? node.name).text} outside the shared test harness`,
      );
    }

    ts.forEachChild(node, visit);
  }

  visit(tree);
  return found;
}

function verifyHarnessImports(source) {
  const tree = createTree(harnessPath, source);
  let importsNativeTls = false;
  const importedFactories = new Set();

  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const moduleName = literalModuleName(statement.moduleSpecifier);
    if (tlsModules.has(moduleName) && importHasRuntimeBinding(statement.importClause)) {
      importsNativeTls = true;
    }
    if (ts.isNamedImports(statement.importClause.namedBindings)) {
      for (const element of statement.importClause.namedBindings.elements) {
        if (!element.isTypeOnly && meshTlsFactories.has(importedName(element))) {
          importedFactories.add(importedName(element));
        }
      }
    }
  }

  if (!importsNativeTls || importedFactories.size !== meshTlsFactories.size) {
    violations.push(
      `${relativePath(harnessPath)} must remain the sole owner of native TLS and authenticated mesh factories`,
    );
  }
}

function verifyAnalyzer() {
  const helper = path.join(testRoot, "support", "tls-helper.ts");
  const cases = [
    {
      source: 'import { createServer } from "node:tls"; export const open = createServer;',
      expected: true,
    },
    {
      source:
        'import { connectAuthenticatedMesh as open } from "../../handshake.js"; export { open };',
      expected: true,
    },
    {
      source:
        'import * as mesh from "../../index.js"; export const open = mesh.createAuthenticatedMeshServer;',
      expected: true,
    },
    {
      source:
        'import * as mesh from "../../index.js"; const { connectAuthenticatedMesh: open } = mesh; export { open };',
      expected: true,
    },
    {
      source: 'import type { TLSSocket } from "node:tls"; export type Socket = TLSSocket;',
      expected: false,
    },
  ];

  for (const [index, example] of cases.entries()) {
    const failed = analyzeTestModule(helper, example.source).length > 0;
    if (failed !== example.expected) {
      violations.push(`mesh live TLS boundary analyzer self-check ${index + 1} failed`);
    }
  }
}

function importHasRuntimeBinding(clause) {
  if (clause.isTypeOnly) return false;
  if (clause.name || ts.isNamespaceImport(clause.namedBindings)) return true;
  return (
    ts.isNamedImports(clause.namedBindings) &&
    clause.namedBindings.elements.some((element) => !element.isTypeOnly)
  );
}

function exportHasRuntimeBinding(declaration) {
  if (declaration.isTypeOnly) return false;
  if (!declaration.exportClause) return true;
  return (
    ts.isNamedExports(declaration.exportClause) &&
    declaration.exportClause.elements.some((element) => !element.isTypeOnly)
  );
}

function isDynamicModuleLoad(node) {
  if (!ts.isCallExpression(node) || node.arguments.length !== 1) return false;
  return (
    node.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(node.expression) && node.expression.text === "require")
  );
}

function exposesMeshTlsFactories(moduleName) {
  return (
    /(?:^|\/)handshake(?:\.js)?$/u.test(moduleName) ||
    /(?:^|\/)index(?:\.js)?$/u.test(moduleName) ||
    moduleName === "@zhixing/mesh"
  );
}

function importedName(element) {
  return element.propertyName?.text ?? element.name.text;
}

function literalModuleName(node) {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : "";
}

function createTree(file, source) {
  const scriptKind = /\.[cm]?tsx$/u.test(file)
    ? ts.ScriptKind.TSX
    : /\.[cm]?jsx$/u.test(file)
      ? ts.ScriptKind.JSX
      : /\.[cm]?js$/u.test(file)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  return ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
}

function lineOf(tree, node) {
  return tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
}

function relativePath(file) {
  return path.relative(projectRoot, file).split(path.sep).join("/");
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(resolved)));
    else files.push(resolved);
  }
  return files;
}
