import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { assertGolden } from "@zhixing/test-utils";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const PACKAGES_ROOT = resolve(REPO_ROOT, "packages");
const RPC_ROOTS = [
  resolve(REPO_ROOT, "packages/rpc/src"),
  resolve(REPO_ROOT, "packages/server/src/rpc"),
];

const ZONES = [
  ["core/conversation", "packages/core/src/conversation"],
  ["core/transcript", "packages/core/src/transcript"],
  ["orchestrator/runtime", "packages/orchestrator/src/runtime"],
  ["executor", "packages/executor/src"],
  ["mesh", "packages/mesh/src"],
  ["owner-kernel", "packages/owner-kernel/src"],
  ["owner-services", "packages/owner-services/src"],
  ["rpc", "packages/rpc/src"],
  ["runtime-host", "packages/runtime-host/src"],
  ["secrets", "packages/secrets/src"],
  ["server/advancement", "packages/server/src/advancement"],
  ["server/confirmation", "packages/server/src/confirmation"],
  ["server/rpc", "packages/server/src/rpc"],
  ["server/runtime", "packages/server/src/runtime"],
  ["cli/runtime", "packages/cli/src/runtime"],
  ["cli/serve", "packages/cli/src/serve"],
] as const;

interface PackageManifest {
  name: string;
  directory: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
}

describe("distributed runtime structural gates", () => {
  it("keeps the package graph valid and topology inventory explicit", async () => {
    const manifests = await readPackageManifests();
    const packageNames = new Set(manifests.map((manifest) => manifest.name));
    const dependencyGraph = buildDependencyGraph(manifests, packageNames);
    const topology = await scanTopology(manifests, packageNames);
    const rpcContracts = await scanRpcContracts();

    expect(findDependencyCycles(dependencyGraph.production)).toEqual([]);
    expect(topology.undeclaredPackageImports).toEqual([]);
    expect(dependencyGraph.production["@zhixing/owner-services"]).toEqual([
      "@zhixing/core",
    ]);
    expect(dependencyGraph.production["@zhixing/runtime-host"]).toEqual([
      "@zhixing/core",
      "@zhixing/mcp",
      "@zhixing/orchestrator",
      "@zhixing/owner-kernel",
      "@zhixing/tools-builtin",
    ]);
    expect(dependencyGraph.production["@zhixing/executor"]).toEqual([
      "@zhixing/owner-kernel",
      "@zhixing/runtime-host",
    ]);
    expect(dependencyGraph.production["@zhixing/mesh"]).toEqual([
      "@zhixing/core",
    ]);
    expect(dependencyGraph.production["@zhixing/secrets"]).toEqual([
      "@zhixing/core",
    ]);
    expect(
      Object.entries(dependencyGraph.production)
        .filter(([name, dependencies]) =>
          name !== "@zhixing/mesh" && dependencies.includes("@zhixing/mesh"),
        )
        .map(([name]) => name),
    ).toEqual([]);
    expect(dependencyGraph.production["@zhixing/executor"]).not.toContain(
      "@zhixing/server",
    );
    expect(dependencyGraph.production["@zhixing/server"]).not.toContain(
      "@zhixing/executor",
    );
    const serveCommandRefs = await readModuleReferences(
      "packages/cli/src/serve/command.ts",
    );
    const topologyCommandRefs = await readModuleReferences(
      "packages/cli/src/serve/topology-command.ts",
    );
    const anchorRoleRefs = await readModuleReferences(
      "packages/cli/src/serve/anchor-role.ts",
    );
    expect(serveCommandRefs).not.toContainEqual({
      kind: "import",
      specifier: "@zhixing/executor",
    });
    expect(topologyCommandRefs).toContainEqual({
      kind: "dynamic-import",
      specifier: "@zhixing/executor",
    });
    expect(topologyCommandRefs).toContainEqual({
      kind: "dynamic-import",
      specifier: "./anchor-role.js",
    });
    expect(anchorRoleRefs).toContainEqual({
      kind: "dynamic-import",
      specifier: "./command.js",
    });
    expect(anchorRoleRefs).not.toContainEqual({
      kind: "import",
      specifier: "./command.js",
    });
    expect(rpcContracts.length).toBeGreaterThan(40);
    expect(findDuplicateContractNames(rpcContracts)).toEqual([]);

    await assertGolden(
      new URL("./__goldens__/distributed-runtime-structure.golden.json", import.meta.url),
      {
        dependencyGraph,
        rpcContracts,
        topologyEdges: topology.edges,
      },
    );
  }, 30_000);
});

async function readPackageManifests(): Promise<PackageManifest[]> {
  const files = (await walk(PACKAGES_ROOT)).filter((file) => file.endsWith("package.json"));
  const manifests = await Promise.all(
    files.map(async (file) => {
      const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<PackageManifest>;
      if (!parsed.name) throw new Error(`Workspace package has no name: ${file}`);
      return {
        name: parsed.name,
        directory: toRepoPath(dirname(file)),
        dependencies: parsed.dependencies ?? {},
        devDependencies: parsed.devDependencies ?? {},
        peerDependencies: parsed.peerDependencies ?? {},
        optionalDependencies: parsed.optionalDependencies ?? {},
      };
    }),
  );
  return manifests.sort((left, right) => left.name.localeCompare(right.name));
}

async function scanRpcContracts() {
  const files = (await Promise.all(RPC_ROOTS.map((root) => walk(root)))).flat().filter(
    (file) =>
      file.endsWith(".ts") &&
      !file.endsWith(".test.ts") &&
      !file.includes(`${sep}__tests__${sep}`),
  );
  const contracts: Array<{
    name: string;
    kind: "interface" | "type";
    definition: string | string[];
  }> = [];
  const contractName =
    /(Params|Result|Payload|Envelope|Request|Response|Notification|Error)$/;

  for (const file of files) {
    const sourceText = await readFile(file, "utf8");
    const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
    const methodContracts = file.includes(`${sep}rpc${sep}methods${sep}`);
    for (const node of sourceFile.statements) {
      const namedType = ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node);
      if (!namedType) continue;
      const exported = node.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      );
      if (!(methodContracts || exported || contractName.test(node.name.text))) continue;

      if (ts.isInterfaceDeclaration(node)) {
        contracts.push({
          name: node.name.text,
          kind: "interface",
          definition: node.members.map((member) => canonicalTypeText(member.getText(sourceFile))),
        });
      } else {
        contracts.push({
          name: node.name.text,
          kind: "type",
          definition: canonicalTypeText(node.type.getText(sourceFile)),
        });
      }
    }
  }

  return contracts.sort((left, right) => left.name.localeCompare(right.name));
}

function findDuplicateContractNames(contracts: readonly { name: string }[]): string[] {
  const counts = new Map<string, number>();
  for (const contract of contracts) {
    counts.set(contract.name, (counts.get(contract.name) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort();
}

function canonicalTypeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function buildDependencyGraph(
  manifests: readonly PackageManifest[],
  packageNames: ReadonlySet<string>,
) {
  const collect = (manifest: PackageManifest, field: keyof PackageManifest) =>
    Object.keys(manifest[field] as Record<string, string>)
      .filter((dependency) => packageNames.has(dependency))
      .sort();

  return {
    production: Object.fromEntries(
      manifests.map((manifest) => [
        manifest.name,
        [...new Set([
          ...collect(manifest, "dependencies"),
          ...collect(manifest, "optionalDependencies"),
        ])].sort(),
      ]),
    ),
    development: Object.fromEntries(
      manifests.map((manifest) => [manifest.name, collect(manifest, "devDependencies")]),
    ),
    peer: Object.fromEntries(
      manifests.map((manifest) => [manifest.name, collect(manifest, "peerDependencies")]),
    ),
  };
}

function findDependencyCycles(graph: Record<string, string[]>): string[][] {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  const visit = (node: string) => {
    if (visited.has(node)) return;
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      cycles.push([...stack.slice(start), node]);
      return;
    }
    visiting.add(node);
    stack.push(node);
    for (const dependency of graph[node] ?? []) visit(dependency);
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  };

  for (const node of Object.keys(graph).sort()) visit(node);
  return cycles;
}

async function scanTopology(
  manifests: readonly PackageManifest[],
  packageNames: ReadonlySet<string>,
) {
  const zoneRoots = ZONES.map(([name, directory]) => ({
    name,
    root: resolve(REPO_ROOT, directory),
  }));
  const edgeCounts = new Map<string, {
    sourceZone: string;
    kind: string;
    target: string;
    references: number;
  }>();
  const undeclaredPackageImports: Array<{ source: string; dependency: string }> = [];

  for (const zone of zoneRoots) {
    const sourceFiles = (await walk(zone.root)).filter(
      (file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.includes(`${sep}__tests__${sep}`),
    );
    for (const file of sourceFiles) {
      const sourceText = await readFile(file, "utf8");
      const sourceFile = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
      const owner = owningPackage(file, manifests);
      for (const moduleRef of collectModuleReferences(sourceFile)) {
        const packageName = internalPackageName(moduleRef.specifier, packageNames);
        if (packageName && owner && packageName !== owner.name) {
          if (!(packageName in owner.dependencies) && !(packageName in owner.optionalDependencies)) {
            undeclaredPackageImports.push({ source: toRepoPath(file), dependency: packageName });
          }
        }
        const target = resolveTopologyTarget(file, moduleRef.specifier, zoneRoots, packageName);
        if (!target || target === zone.name) continue;
        const edge = {
          sourceZone: zone.name,
          kind: moduleRef.kind,
          target,
          references: 1,
        };
        const edgeKey = JSON.stringify({
          sourceZone: edge.sourceZone,
          kind: edge.kind,
          target: edge.target,
        });
        const existing = edgeCounts.get(edgeKey);
        if (existing) existing.references += 1;
        else edgeCounts.set(edgeKey, edge);
      }
    }
  }

  const uniqueEdges = [...edgeCounts.values()].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
  undeclaredPackageImports.sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
  return { edges: uniqueEdges, undeclaredPackageImports };
}

function collectModuleReferences(sourceFile: ts.SourceFile) {
  const references: Array<{ kind: string; specifier: string }> = [];
  const add = (kind: string, node: ts.Expression | undefined) => {
    if (node && ts.isStringLiteralLike(node)) references.push({ kind, specifier: node.text });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      add(node.importClause?.isTypeOnly ? "type-import" : "import", node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node)) {
      add(node.isTypeOnly ? "type-export" : "export", node.moduleSpecifier);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      add("dynamic-import", node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return references;
}

async function readModuleReferences(repoPath: string) {
  const file = resolve(REPO_ROOT, repoPath);
  const sourceText = await readFile(file, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  return collectModuleReferences(sourceFile);
}

function internalPackageName(specifier: string, packageNames: ReadonlySet<string>) {
  if (!specifier.startsWith("@")) return undefined;
  const [scope, name] = specifier.split("/");
  const candidate = `${scope}/${name}`;
  return packageNames.has(candidate) ? candidate : undefined;
}

function resolveTopologyTarget(
  source: string,
  specifier: string,
  zones: readonly { name: string; root: string }[],
  packageName?: string,
): string | undefined {
  if (packageName) return `package:${packageName}`;
  if (!specifier.startsWith(".")) {
    const topologyDependencies = new Set([
      "node:dgram",
      "node:http",
      "node:https",
      "node:net",
      "node:tls",
      "ws",
    ]);
    return topologyDependencies.has(specifier) ? `external:${specifier}` : undefined;
  }
  const withoutExtension = specifier.replace(/\.js$/, "");
  const target = resolve(dirname(source), withoutExtension);
  const targetZone = zones.find((zone) => isWithin(target, zone.root));
  return targetZone?.name;
}

function owningPackage(file: string, manifests: readonly PackageManifest[]) {
  return manifests.find((manifest) => isWithin(file, resolve(REPO_ROOT, manifest.directory)));
}

async function walk(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else files.push(path);
  }
  return files;
}

function isWithin(file: string, directory: string): boolean {
  const path = relative(directory, file);
  return path === "" || (!path.startsWith("..") && !path.startsWith(sep));
}

function toRepoPath(file: string): string {
  return relative(REPO_ROOT, file).split(sep).join("/");
}
