import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const productionFiles = (await walk(path.join(root, "packages"))).filter(
  (file) =>
    file.endsWith(".ts") &&
    !file.endsWith(".test.ts") &&
    !file.includes(`${path.sep}__tests__${path.sep}`) &&
    !file.includes(`${path.sep}dist${path.sep}`),
);
const errors = [];
const legacyMentionsAllowed = new Set([
  "packages/core/src/security/builtin-rules.ts",
  "packages/cli/src/security/secret-boundary.ts",
]);
const legacyPlaintextMigrationOwner =
  "packages/providers/src/credentials-loader.ts";
const legacyPlaintextConsumers = [];
const fullCredentialProjectionAllowed = new Set([
  "packages/providers/src/credentials-loader.ts",
  "packages/providers/src/index.ts",
  "packages/providers/src/types.ts",
  "packages/cli/src/startup.ts",
  "packages/cli/src/serve/command.ts",
]);

for (const file of productionFiles) {
  const relative = repoPath(file);
  const source = await readFile(file, "utf8");
  if (source.includes("credentials.json") && !legacyMentionsAllowed.has(relative)) {
    if (relative === legacyPlaintextMigrationOwner) {
      legacyPlaintextConsumers.push(relative);
    } else {
      errors.push(`${relative} references the retired plaintext credential file`);
    }
  }
  if (source.includes("@zhixing/secrets") && !relative.startsWith("packages/cli/src/")) {
    errors.push(`${relative} bypasses the CLI composition root for SecretStore implementation`);
  }
  if (
    source.includes("ZhixingCredentials") &&
    !relative.startsWith("packages/cli/src/config-editor/") &&
    !fullCredentialProjectionAllowed.has(relative)
  ) {
    errors.push(`${relative} retains the full cross-domain credential projection`);
  }
  if (/createProviderRoles\s*\(\s*\)/u.test(source)) {
    errors.push(`${relative} creates providers without an explicit SecretStore projection`);
  }
}

const credentialRepository = await readFile(
  path.join(root, "packages/providers/src/credentials-loader.ts"),
  "utf8",
);
if (
  legacyPlaintextConsumers.length !== 1 ||
  legacyPlaintextConsumers[0] !== legacyPlaintextMigrationOwner ||
  (credentialRepository.match(/"credentials\.json"/gu)?.length ?? 0) !== 1 ||
  !credentialRepository.includes(
    "await migrateLegacyCredentialFile(options.store, options.legacyHomeDir)",
  ) ||
  !credentialRepository.includes("async function migrateLegacyCredentialFile(") ||
  /export\s+(?:async\s+)?function\s+migrateLegacyCredentialFile/u.test(
    credentialRepository,
  )
) {
  errors.push(
    "retired plaintext credentials must have exactly one private startup migration owner",
  );
}
if (/readFileSync|writeFileSync/u.test(credentialRepository)) {
  errors.push("credential repository contains a synchronous plaintext file path");
}

const isolationContract = await readFile(
  path.join(root, "research/design/specifications/credentials-and-onboarding.md"),
  "utf8",
);
for (const requiredBoundary of [
  "AI 文件工具及可解析 shell 路径",
  "不是 OS 进程沙箱",
]) {
  if (!isolationContract.includes(requiredBoundary)) {
    errors.push(`Secret isolation contract overstates or omits its L2 boundary: ${requiredBoundary}`);
  }
}
if (isolationContract.includes("任何 AI 文件访问")) {
  errors.push("Secret isolation contract incorrectly describes the L2 guard as hard isolation");
}
for (const required of [
  "runExclusive",
  "cleanupUncommittedGeneration",
  'state: "aborted"',
]) {
  if (!credentialRepository.includes(required)) {
    errors.push(`SecretStore credential repository is missing required boundary: ${required}`);
  }
}

const secretsManifest = JSON.parse(
  await readFile(path.join(root, "packages/secrets/package.json"), "utf8"),
);
const platformSecretStore = await readFile(
  path.join(root, "packages/secrets/src/platform-secret-store.ts"),
  "utf8",
);
for (const trustedCommandBoundary of [
  '"/usr/bin/security"',
  '"/usr/bin/secret-tool"',
  "windowsPowerShellCommand()",
  "sanitizedCredentialCommandEnvironment()",
  "cleanupPrivateFileTemps",
  "SECRET_STORE_FILE_PREFIX",
]) {
  if (!platformSecretStore.includes(trustedCommandBoundary)) {
    errors.push(`Platform SecretStore lost trusted command boundary: ${trustedCommandBoundary}`);
  }
}
const builtinSecurityRules = await readFile(
  path.join(root, "packages/core/src/security/builtin-rules.ts"),
  "utf8",
);
if (!builtinSecurityRules.includes('".zhixing/secret-vault"')) {
  errors.push("SecretStore files are not covered by the bypass-immune path boundary");
}
if (!builtinSecurityRules.includes('id: "bi-os-credential-store"')) {
  errors.push("Platform credential commands are not covered by a bypass-immune boundary");
}
const dynamicBoundaryFiles = new Map([
  [
    "packages/secrets/src/platform-secret-store.ts",
    ["getPlatformSecretStoreProtectedPaths", '"secret-vault"'],
  ],
  [
    "packages/cli/src/security/secret-boundary.ts",
    ['"credentials.json"', "getPlatformSecretStoreProtectedPaths"],
  ],
  [
    "packages/cli/src/serve/command.ts",
    ["resolveSystemProtectedSecretPaths", "systemProtectedPaths"],
  ],
  ["packages/runtime-host/src/runtime-host.ts", ["systemProtectedPaths"]],
  ["packages/orchestrator/src/runtime/create-agent-runtime.ts", ["systemProtectedPaths"]],
  [
    "packages/core/src/security/security-pipeline.ts",
    ["systemProtectedPaths", "new PolicyEngine"],
  ],
  [
    "packages/core/src/security/policy-engine.ts",
    ["bi-system-protected-paths", "bypassImmune: true", 'access: "any"'],
  ],
]);
for (const [relative, requiredBoundaries] of dynamicBoundaryFiles) {
  const source = await readFile(path.join(root, relative), "utf8");
  for (const requiredBoundary of requiredBoundaries) {
    if (!source.includes(requiredBoundary)) {
      errors.push(
        `${relative} lost the dynamic SecretStore boundary: ${requiredBoundary}`,
      );
    }
  }
}
const externalRuntimeDependencies = Object.keys(secretsManifest.dependencies ?? {}).filter(
  (name) => !name.startsWith("@zhixing/"),
);
if (externalRuntimeDependencies.length > 0) {
  errors.push(
    `SecretStore added unreviewed runtime dependencies: ${externalRuntimeDependencies.join(", ")}`,
  );
}

if (errors.length > 0) {
  throw new Error(`Secret boundary checks failed:\n- ${errors.join("\n- ")}`);
}
console.log("Secret boundaries verified: one private plaintext migration owner, explicit composition, zero external crypto dependencies.");

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(resolved)));
    else files.push(resolved);
  }
  return files;
}

function repoPath(file) {
  return path.relative(root, file).split(path.sep).join("/");
}
