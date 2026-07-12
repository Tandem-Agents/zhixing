import { readFile, readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const inventoryPath = path.join(root, "packages/mesh/security-dependencies.json");
const meshManifestPath = path.join(root, "packages/mesh/package.json");
const rootManifestPath = path.join(root, "package.json");
const lockfilePath = path.join(root, "pnpm-lock.yaml");
const meshRoot = path.join(root, "packages/mesh");

const [inventory, meshManifest, rootManifest, lockfile, npmrc] = await Promise.all([
  readJson(inventoryPath),
  readJson(meshManifestPath),
  readJson(rootManifestPath),
  readFile(lockfilePath, "utf8"),
  readFile(path.join(root, ".npmrc"), "utf8"),
]);

const errors = [];
const workspaceProjects = listWorkspaceProjects();
const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const directByName = new Map(inventory.direct.map((entry) => [entry.name, entry]));
const declaredExternalDependencies = Object.keys(meshManifest.dependencies ?? {})
  .filter((name) => name !== "@zhixing/core")
  .sort();
const reviewedDirectDependencies = [...directByName.keys()].sort();
const reviewedProductionDependencies = inventory.direct
  .filter((entry) => entry.placement === "dependencies")
  .map((entry) => entry.name)
  .sort();

if (inventory.schemaVersion !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(inventory.reviewedAt)) {
  errors.push("security dependency inventory has an invalid schema version or review date");
}
if (!/^\s*frozen-lockfile\s*=\s*true\s*$/m.test(npmrc)) {
  errors.push(".npmrc must enforce frozen-lockfile=true");
}
if (JSON.stringify(declaredExternalDependencies) !== JSON.stringify(reviewedProductionDependencies)) {
  errors.push("mesh external runtime dependencies differ from the reviewed direct inventory");
}

for (const project of workspaceProjects) {
  if (path.resolve(project.path) === meshRoot) continue;
  const manifest = await readJson(path.join(project.path, "package.json"));
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const name of reviewedDirectDependencies) {
      if (manifest[section]?.[name]) {
        errors.push(`${name} may only be declared by @zhixing/mesh, not ${project.name ?? project.path}`);
      }
    }
  }
}

const expectedClosure = new Set(
  inventory.securityClosure.map((dependency) => `${dependency.name}@${dependency.version}`),
);
if (expectedClosure.size !== inventory.securityClosure.length) {
  errors.push("security closure inventory contains duplicate package versions");
}
const actualClosure = installedSecurityClosure(reviewedDirectDependencies);
for (const key of actualClosure) {
  if (!expectedClosure.has(key)) errors.push(`unreviewed security dependency entered mesh: ${key}`);
}
for (const key of expectedClosure) {
  if (!actualClosure.has(key)) errors.push(`reviewed security dependency is no longer in mesh: ${key}`);
}
const productionTree = installedMeshTree(true, "0");
for (const expected of inventory.direct) {
  const installedInProduction = Boolean(productionTree.dependencies?.[expected.name]);
  if (expected.placement === "dependencies" && !installedInProduction) {
    errors.push(`production dependency is missing from the installed mesh tree: ${expected.name}`);
  }
  if (expected.placement === "devDependencies" && installedInProduction) {
    errors.push(`development-only security dependency leaked into production: ${expected.name}`);
  }
}

for (const [name, expected] of directByName) {
  if (!["dependencies", "devDependencies"].includes(expected.placement)) {
    errors.push(`${name} has an invalid dependency placement`);
    continue;
  }
  const declared = meshManifest[expected.placement]?.[name];
  if (declared !== expected.version || !exactVersion.test(declared ?? "")) {
    errors.push(`${name} must be pinned exactly to ${expected.version}`);
  }
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    if (section !== expected.placement && meshManifest[section]?.[name]) {
      errors.push(`${name} must only appear in ${expected.placement}`);
    }
  }
  const importerPattern = new RegExp(
    `${escapeRegex(yamlName(name))}:\\r?\\n\\s+specifier: ${escapeRegex(expected.version)}\\r?\\n\\s+version: ${escapeRegex(expected.version)}(?:\\r?\\n|$)`,
  );
  if (!importerPattern.test(meshImporterBlock(lockfile))) {
    errors.push(`pnpm-lock.yaml importer does not pin ${name}@${expected.version}`);
  }
  const block = lockPackageBlock(lockfile, `${name}@${expected.version}`);
  if (!block || !block.includes(`integrity: ${expected.integrity}`)) {
    errors.push(`pnpm-lock.yaml integrity does not match reviewed ${name}@${expected.version}`);
  }
}

const approvedBuildDependencies = new Set(rootManifest.pnpm?.onlyBuiltDependencies ?? []);
for (const dependency of inventory.securityClosure) {
  const block = lockPackageBlock(lockfile, `${dependency.name}@${dependency.version}`);
  if (!block || !/resolution: \{integrity: sha(256|384|512)-/.test(block)) {
    errors.push(`runtime closure lacks lockfile integrity: ${dependency.name}@${dependency.version}`);
  }
  if (approvedBuildDependencies.has(dependency.name)) {
    errors.push(`security dependency may not execute install scripts: ${dependency.name}`);
  }
  try {
    const manifest = await readJson(installedManifestPath(dependency));
    const repository =
      typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
    if (
      manifest.version !== dependency.version ||
      manifest.license !== dependency.license ||
      repository !== dependency.repository
    ) {
      errors.push(`installed metadata drifted for ${dependency.name}@${dependency.version}`);
    }
    for (const script of ["preinstall", "install", "postinstall"]) {
      if (manifest.scripts?.[script]) {
        errors.push(`${dependency.name}@${dependency.version} declares ${script}`);
      }
    }
  } catch (error) {
    errors.push(`cannot inspect installed ${dependency.name}@${dependency.version}: ${error.message}`);
  }
}

for (const vector of inventory.standardsVectors) {
  for (const relative of [vector.fixture, vector.test]) {
    try {
      await readFile(path.join(root, "packages/mesh", relative));
    } catch {
      errors.push(`missing standards-vector artifact: packages/mesh/${relative}`);
    }
  }
}

await validatePakeBoundary(inventory.pakeProductionApproval, workspaceProjects, errors);

if (errors.length > 0) {
  console.error(`Mesh security supply-chain gate failed:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}

console.log(
  `Mesh security supply-chain gate passed (${inventory.direct.length} direct, ${inventory.securityClosure.length} reviewed packages).`,
);

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function meshImporterBlock(text) {
  const start = text.indexOf("  packages/mesh:\n");
  if (start < 0) return "";
  const next = text.indexOf("\n  packages/", start + 1);
  return text.slice(start, next < 0 ? undefined : next);
}

function lockPackageBlock(text, key) {
  const lines = text.split(/\r?\n/);
  const quoted = `  '${key}':`;
  const plain = `  ${key}:`;
  const start = lines.findIndex((line) => line === quoted || line === plain);
  if (start < 0) return "";
  let end = start + 1;
  while (end < lines.length && !/^  (?:'[^']+'|[^ ].*):$/.test(lines[end])) end += 1;
  return lines.slice(start, end).join("\n");
}

function installedManifestPath({ name, version }) {
  const directory = name.startsWith("@") ? `${name.replace("/", "+")}@${version}` : `${name}@${version}`;
  return path.join(root, "node_modules/.pnpm", directory, "node_modules", name, "package.json");
}

function installedSecurityClosure(rootNames) {
  const tree = installedMeshTree(false, "Infinity");
  const closure = new Set();
  const visit = (name, node) => {
    if (!node || name === "@zhixing/core") return;
    const key = `${name}@${node.version}`;
    if (closure.has(key)) return;
    closure.add(key);
    for (const [childName, child] of Object.entries(node.dependencies ?? {})) visit(childName, child);
  };
  const roots = { ...tree.dependencies, ...tree.devDependencies };
  for (const name of rootNames) visit(name, roots[name]);
  return closure;
}

function installedMeshTree(productionOnly, depth) {
  const args = ["--filter", "@zhixing/mesh", "list"];
  if (productionOnly) args.push("--prod");
  args.push("--depth", depth, "--json");
  const [tree] = JSON.parse(runPnpm(args));
  return tree;
}

function listWorkspaceProjects() {
  return JSON.parse(runPnpm(["-r", "list", "--depth", "-1", "--json"]));
}

function runPnpm(args) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return execFileSync(process.execPath, [npmExecPath, ...args], {
      cwd: root,
      encoding: "utf8",
    });
  }
  return execFileSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, {
    cwd: root,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
}

async function validatePakeBoundary(approval, projects, validationErrors) {
  const validStatuses = new Set(["blocked", "approved"]);
  if (!approval || !validStatuses.has(approval.status)) {
    validationErrors.push("PAKE production approval must have status blocked or approved");
    return;
  }
  const adapterSource = path.resolve(meshRoot, approval.adapterSource ?? "");
  const adapterWithinMesh = path.relative(meshRoot, adapterSource);
  const adapterRelative = path.relative(root, adapterSource).replaceAll("\\", "/");
  const exportTarget = meshManifest.exports?.[approval.exportSubpath];
  const buildConfig = await readFile(path.join(meshRoot, "tsup.config.ts"), "utf8");
  const adapterEntry = approval.adapterSource?.replace(/^src\//, "src/");
  const implementationName = approval.implementation?.name;
  const implementation = directByName.get(implementationName);

  if (
    !implementationName ||
    approval.implementation?.version !== implementation?.version ||
    !approval.adapterSource?.startsWith("src/") ||
    adapterWithinMesh.startsWith("..") ||
    path.isAbsolute(adapterWithinMesh) ||
    !approval.exportSubpath?.startsWith("./") ||
    !Array.isArray(approval.evidence)
  ) {
    validationErrors.push("PAKE approval does not identify its reviewed implementation boundary");
  }
  try {
    await readFile(adapterSource);
  } catch {
    validationErrors.push("PAKE adapter source is missing");
  }
  if (!meshManifest.exports?.["./pairing"]) {
    validationErrors.push("generic pairing must use its explicit package subpath");
  }
  if (Object.keys(meshManifest.exports ?? {}).some((key) => key.includes("*"))) {
    validationErrors.push("mesh wildcard exports can bypass the PAKE adapter boundary");
  }

  if (approval.status === "blocked") {
    if (implementation?.placement !== "devDependencies") {
      validationErrors.push("blocked PAKE implementation must stay out of production dependencies");
    }
    if (exportTarget) validationErrors.push("blocked PAKE adapter must not have a package export");
    if (adapterEntry && buildConfig.includes(adapterEntry)) {
      validationErrors.push("blocked PAKE adapter must not be included in package build entries");
    }
    if (approval.evidence?.length) {
      validationErrors.push("blocked PAKE adapter cannot claim approval evidence");
    }
  } else {
    if (implementation?.placement !== "dependencies") {
      validationErrors.push("approved PAKE implementation must be an explicit production dependency");
    }
    if (!exportTarget) validationErrors.push("approved PAKE adapter must use an explicit package subpath");
    if (!adapterEntry || !buildConfig.includes(adapterEntry)) {
      validationErrors.push("approved PAKE adapter must use an explicit build entry");
    }
    if (!Array.isArray(approval.evidence) || approval.evidence.length === 0) {
      validationErrors.push("approved PAKE adapter requires immutable audit or replacement evidence");
    }
    for (const evidence of approval.evidence ?? []) {
      if (
        !["independent-audit", "replacement-review"].includes(evidence.kind) ||
        typeof evidence.reference !== "string" ||
        evidence.reference.length === 0 ||
        !/^sha256:[0-9a-f]{64}$/.test(evidence.digest ?? "") ||
        !/^\d{4}-\d{2}-\d{2}$/.test(evidence.completedAt ?? "")
      ) {
        validationErrors.push("PAKE approval evidence is incomplete or mutable");
      }
    }
  }

  const indexSource = await readFile(path.join(meshRoot, "src/index.ts"), "utf8");
  if (indexSource.includes("pairing-public")) {
    validationErrors.push("pairing must remain reachable only through its explicit package subpath");
  }

  for (const project of projects) {
    await walk(path.join(project.path, "src"), async (file) => {
      const relative = path.relative(root, file).replaceAll("\\", "/");
      if (/(?:^|\/)(__tests__|dist)(?:\/|$)/.test(relative)) return;
      if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(relative) || !/\.[cm]?[jt]sx?$/.test(relative)) return;
      const source = await readFile(file, "utf8");
      if (implementationName && relative !== adapterRelative && source.includes(implementationName)) {
        validationErrors.push(`PAKE dependency escaped its adapter: ${relative}`);
      }
      if (
        approval.status === "blocked" &&
        relative !== adapterRelative &&
        (source.includes("pairing-pake-cipherman") ||
          source.includes(`@zhixing/mesh/${approval.exportSubpath?.replace(/^\.\//, "")}`))
      ) {
        validationErrors.push(`blocked PAKE adapter is mounted by: ${relative}`);
      }
    });
  }
}

async function walk(directory, visit) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.isSymbolicLink()) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(absolute, visit);
    else await visit(absolute);
  }
}

function yamlName(name) {
  return name.startsWith("@") ? `'${name}'` : name;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
