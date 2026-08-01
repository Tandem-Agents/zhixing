import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = parseArgs(process.argv.slice(2));
const excludedPrefixes = ["research/design/workbench/"];
const baseRevision = git(["rev-parse", `${args.base}^{commit}`]);
const baseEntries = new Map(
  splitZero(gitRaw(["ls-tree", "-rz", baseRevision])).map((line) => {
    const separator = line.indexOf("\t");
    const metadata = line.slice(0, separator).split(" ");
    return [normalizePath(line.slice(separator + 1)), metadata[2]];
  }),
);
const paths = [
  ...splitZero(gitRaw([
    "diff",
    "--no-renames",
    "--name-only",
    "-z",
    baseRevision,
    "--",
  ])),
  ...splitZero(gitRaw(["ls-files", "--others", "--exclude-standard", "-z"])),
]
  .map(normalizePath)
  .filter((candidate) =>
    excludedPrefixes.every((prefix) => !candidate.startsWith(prefix)),
  )
  .filter((candidate, index, all) => all.indexOf(candidate) === index)
  .sort((left, right) => left.localeCompare(right, "en-US"));

const existence = await Promise.all(
  paths.map(async (repositoryPath) => ({
    repositoryPath,
    exists: await access(path.join(root, ...repositoryPath.split("/"))).then(
      () => true,
      () => false,
    ),
  })),
);
const existingPaths = existence
  .filter(({ exists }) => exists)
  .map(({ repositoryPath }) => repositoryPath);
const worktreeBlobs = new Map(
  existingPaths.map((repositoryPath) => [
    repositoryPath,
    git(["hash-object", `--path=${repositoryPath}`, "--", repositoryPath]),
  ]),
);
const entries = [];
for (const { repositoryPath, exists } of existence) {
  if (exists) {
    entries.push({
      status: baseEntries.has(repositoryPath) ? "M" : "A",
      path: repositoryPath,
      blob: worktreeBlobs.get(repositoryPath),
    });
  } else {
    entries.push({
      status: "D",
      path: repositoryPath,
      blob: baseEntries.get(repositoryPath),
    });
  }
}

const groups = Object.fromEntries(
  [...Map.groupBy(entries, ({ path: repositoryPath }) => groupOf(repositoryPath))]
    .sort(([left], [right]) => left.localeCompare(right, "en-US"))
    .map(([group, members]) => [group, members.length]),
);
const pathSetBytes = entries.map(({ path: repositoryPath }) => repositoryPath).join("\n");
const manifestBytes = entries
  .map(({ status, path: repositoryPath, blob }) =>
    `${status}\t${repositoryPath}\t${blob}`,
  )
  .join("\n");
const manifest = {
  schema: "git-delivery-manifest-v1",
  baseRevision,
  excludedPrefixes,
  pathCount: entries.length,
  deletedCount: entries.filter(({ status }) => status === "D").length,
  groups,
  pathSetSha256: sha256(pathSetBytes),
  fingerprint: `git-delivery-manifest-v1:${sha256(manifestBytes)}`,
  entries,
};
const serialized = `${JSON.stringify(manifest, null, 2)}\n`;

if (args.write) {
  const target = insideWorkspace(args.write);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, serialized, "utf8");
} else if (args.check) {
  const target = insideWorkspace(args.check);
  if ((await readFile(target, "utf8")) !== serialized) {
    throw new Error(`Delivery manifest is stale: ${path.relative(root, target)}`);
  }
} else {
  process.stdout.write(serialized);
}

function groupOf(repositoryPath) {
  const parts = repositoryPath.split("/");
  if (parts[0] === "packages") {
    if (parts[1] === "channels") return `channel-${parts[2] ?? "unknown"}`;
    return parts[1] === "cli" ? "CLI" : (parts[1] ?? "packages-other");
  }
  if (parts[0] === "scripts") return "scripts";
  if (parts[0] === "research" && parts[1] === "design") {
    return "architecture-and-specification";
  }
  return parts.length === 1 ? "root-config" : "other";
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function git(args) {
  return gitRaw(args).trim();
}

function gitRaw(args, input) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    input,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
}

function splitZero(value) {
  return value.split("\0").filter(Boolean);
}

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

function insideWorkspace(value) {
  const target = path.resolve(root, value);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Delivery manifest path must stay inside the workspace");
  }
  return target;
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error("Delivery manifest arguments are incomplete");
    }
    const name = key.slice(2);
    if (!["base", "write", "check"].includes(name) || name in result) {
      throw new Error(`Unknown or duplicate --${name}`);
    }
    result[name] = value;
  }
  if (!result.base || (result.write && result.check)) {
    throw new Error("Expected --base and at most one of --write/--check");
  }
  return result;
}
