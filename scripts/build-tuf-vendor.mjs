/**
 * Reproducible, auditable builder/verifier for the locked, narrow-patched
 * `tuf-js@5.0.1` vendor bundle inlined into `@zhixing-ai/providers/dist`.
 *
 * Security & supply-chain guarantees (Design §4.2 + 实施期注意项 #5):
 * 1. Installs ONLY from the checked-in `tuf-lock.json` (`npm ci --ignore-scripts`).
 * 2. Verifies `node_modules/tuf-js/dist/updater.js` SHA-256 matches the exact
 *    audited upstream digest `f5c5629525cc20c27b0ca22ff8e5dfd5ab97eb0423b347817d8a87fd6c070929`.
 * 3. Applies ONLY the 4-site narrow async `metadataStore` persistence patch
 *    (root / timestamp / snapshot / targets all awaited with raw bytes).
 * 4. Bundles into an ESM module with explicit `createRequire(import.meta.url)`
 *    so it runs identically from `src/`, `dist/`, and isolated out-of-repo npm installs.
 * 5. Asserts zero non-builtin runtime externals (except optional `supports-color`
 *    caught by `debug`) and writes `THIRD-PARTY-NOTICES.txt` + `manifest.json`.
 *
 * Usage:
 *   node scripts/build-tuf-vendor.mjs [--offline] [--check]
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { isBuiltin } from "node:module";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = path.join(root, "packages/providers/src/catalog/tuf/vendor");
const vendorInputsDir = path.join(root, "scripts/tuf-vendor");
const lockPath = path.join(vendorInputsDir, "tuf-lock.json");
const pkgPath = path.join(vendorInputsDir, "tuf-package.json");
const bundleOutPath = path.join(vendorDir, "tuf-js-5.0.1-patched.mjs");
const noticesOutPath = path.join(vendorDir, "THIRD-PARTY-NOTICES.txt");
const manifestOutPath = path.join(vendorDir, "manifest.json");

const EXPECTED_TUF_VERSION = "5.0.1";
const EXPECTED_UPDATER_ORIGINAL_SHA256 =
  "f5c5629525cc20c27b0ca22ff8e5dfd5ab97eb0423b347817d8a87fd6c070929";

const offline = process.argv.includes("--offline");
const checkOnly = process.argv.includes("--check");
const cacheFlagIndex = process.argv.indexOf("--cache");
const explicitCacheDir =
  cacheFlagIndex >= 0 && process.argv[cacheFlagIndex + 1]
    ? path.resolve(process.argv[cacheFlagIndex + 1])
    : undefined;

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function resolveEsbuild() {
  const pnpmDir = path.join(root, "node_modules/.pnpm");
  const entries = await fs.readdir(pnpmDir);
  const match = entries.find((e) => e.startsWith("esbuild@"));
  assert(match, "esbuild package not found in workspace node_modules/.pnpm");
  const modPath = path.join(pnpmDir, match, "node_modules/esbuild/lib/main.js");
  return import(pathToFileURL(modPath).href);
}

const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "zhixing-tuf-vendor-"));
try {
  await fs.copyFile(pkgPath, path.join(tmpDir, "package.json"));
  await fs.copyFile(lockPath, path.join(tmpDir, "package-lock.json"));

  const npmArgs = ["ci", "--ignore-scripts", "--no-audit", "--no-fund"];
  if (offline) npmArgs.push("--offline");
  if (explicitCacheDir) npmArgs.push("--cache", explicitCacheDir);
  const install =
    process.platform === "win32"
      ? spawnSync(
          process.env.ComSpec ?? "cmd.exe",
          ["/d", "/s", "/c", "npm.cmd", ...npmArgs],
          {
            cwd: tmpDir,
            encoding: "utf8",
            windowsHide: true,
          },
        )
      : spawnSync("npm", npmArgs, {
          cwd: tmpDir,
          encoding: "utf8",
        });
  assert.equal(
    install.status,
    0,
    `npm ci failed (${install.status}): ${install.stderr || install.stdout}`,
  );

  // Verify exact upstream package version & updater.js raw byte SHA-256
  const tufPkg = JSON.parse(
    await fs.readFile(path.join(tmpDir, "node_modules/tuf-js/package.json"), "utf8"),
  );
  assert.equal(tufPkg.version, EXPECTED_TUF_VERSION, "tuf-js version mismatch");

  const updaterPath = path.join(tmpDir, "node_modules/tuf-js/dist/updater.js");
  const originalCode = await fs.readFile(updaterPath, "utf8");
  const originalSha = sha256(Buffer.from(originalCode, "utf8"));
  assert.equal(
    originalSha,
    EXPECTED_UPDATER_ORIGINAL_SHA256,
    `tuf-js/dist/updater.js SHA-256 mismatch: expected ${EXPECTED_UPDATER_ORIGINAL_SHA256}, got ${originalSha}`,
  );

  // Apply the exact narrow 4-site async metadataStore persistence patch
  const persistCallCount = (originalCode.match(/this\.persistMetadata\(/g) ?? []).length;
  assert.equal(persistCallCount, 4, `expected exactly 4 persistMetadata call sites, found ${persistCallCount}`);
  assert(!originalCode.includes("this.metadataStore"), "unexpected metadataStore in upstream updater.js");

  let patchedCode = originalCode;
  patchedCode = patchedCode.replace(
    "this.dir = metadataDir;",
    "this.dir = metadataDir;\n        this.metadataStore = options.metadataStore;",
  );
  patchedCode = patchedCode.replace(
    "loadLocalMetadata(fileName) {",
    "loadLocalMetadata(fileName) {\n        if (this.metadataStore) return this.metadataStore.read(fileName);",
  );
  patchedCode = patchedCode.replaceAll(
    "this.persistMetadata(",
    "await this.persistMetadata(",
  );
  patchedCode = patchedCode.replace(
    "persistMetadata(metaDataName, bytesData) {",
    "async persistMetadata(metaDataName, bytesData) {\n        if (this.metadataStore) { await this.metadataStore.write(metaDataName, bytesData); return; }",
  );
  assert.notEqual(patchedCode, originalCode, "patch did not apply");
  await fs.writeFile(updaterPath, patchedCode, "utf8");
  const patchedSha = sha256(Buffer.from(patchedCode, "utf8"));

  // Entry exporting only the controlled TUF primitives needed by Zhixing
  const entryPath = path.join(tmpDir, "entry.mjs");
  await fs.writeFile(
    entryPath,
    [
      'export { Updater } from "tuf-js";',
      'export { DownloadHTTPError, ValueError, RuntimeError, BadVersionNumberError, ExpiredMetadataError, EqualVersionNumberError, BadHashError, DownloadLengthMismatchError } from "tuf-js/dist/error.js";',
      'export { canonicalize } from "@tufjs/canonical-json";',
      "",
    ].join("\n"),
    "utf8",
  );

  const esbuild = await resolveEsbuild();
  const outFile = path.join(tmpDir, "tuf-js-5.0.1-patched.mjs");
  const result = await esbuild.build({
    entryPoints: [entryPath],
    absWorkingDir: tmpDir,
    outfile: outFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    metafile: true,
    logLevel: "silent",
    plugins: [
      {
        name: "stub-optional-supports-color",
        setup(build) {
          // debug/src/node.js only probes optional peer `supports-color` inside try/catch;
          // stubbing it away keeps the inlined TUF bundle 100% node-builtin-only so CLI
          // single-bundle closure checks pass without relaxing any closure guard.
          build.onResolve({ filter: /^supports-color$/ }, () => ({
            path: "supports-color",
            namespace: "optional-stub",
          }));
          build.onLoad({ filter: /.*/, namespace: "optional-stub" }, () => ({
            contents: "module.exports = false;",
            loader: "js",
          }));
        },
      },
    ],
    banner: {
      js: [
        "// GENERATED BY scripts/build-tuf-vendor.mjs — DO NOT HAND-EDIT.",
        "// Locked upstream: tuf-js@5.0.1 + narrow 4-site async metadataStore persistence patch.",
        'import { createRequire as __zhixingTufCreateRequire } from "node:module";',
        "const require = __zhixingTufCreateRequire(import.meta.url);",
      ].join("\n"),
    },
  });

  const externalImports = Object.values(result.metafile.outputs)
    .flatMap((o) => o.imports)
    .filter((i) => i.external)
    .map((i) => i.path);
  assert(
    externalImports.every((imp) => isBuiltin(imp)),
    `Unexpected non-builtin runtime imports in TUF vendor bundle: ${JSON.stringify(externalImports)}`,
  );

  // Verify the generated bundle imports cleanly in an isolated Node process with empty NODE_PATH
  const isolatedCheck = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const m = await import(${JSON.stringify(pathToFileURL(outFile).href)}); if (typeof m.Updater !== "function" || typeof m.canonicalize !== "function" || typeof m.DownloadHTTPError !== "function") process.exit(1);`,
    ],
    {
      cwd: tmpDir,
      encoding: "utf8",
      env: { ...process.env, NODE_PATH: "" },
    },
  );
  assert.equal(isolatedCheck.status, 0, `Isolated import failed: ${isolatedCheck.stderr}`);

  const bundleBytes = await fs.readFile(outFile);
  const bundleSha = sha256(bundleBytes);

  // Collect exact third-party notices for all installed packages
  const lockJson = JSON.parse(await fs.readFile(lockPath, "utf8"));
  const noticeSections = [
    "THIRD-PARTY SOFTWARE NOTICES AND INFORMATION",
    "============================================",
    "",
    "@zhixing-ai/providers inlines the locked, narrow-patched tuf-js@5.0.1",
    "TUF client and its transitive dependencies into dist/. Below are the",
    "upstream versions, licenses, and full license texts.",
    "",
  ];
  const auditedPackages = [];

  for (const [pkgKey, meta] of Object.entries(lockJson.packages)) {
    if (!pkgKey.startsWith("node_modules/")) continue;
    const pkgName = pkgKey.slice("node_modules/".length);
    const pkgDir = path.join(tmpDir, pkgKey);
    const files = await fs.readdir(pkgDir);
    const licenseFile = files.find((f) => /^license/iu.test(f));
    assert(licenseFile, `Missing LICENSE file for ${pkgName}@${meta.version}`);
    const licenseText = (await fs.readFile(path.join(pkgDir, licenseFile), "utf8")).trim();

    auditedPackages.push({
      name: pkgName,
      version: meta.version,
      license: meta.license,
      integrity: meta.integrity,
      licenseFile,
    });

    noticeSections.push(
      `--------------------------------------------------------------------------------`,
      `Package: ${pkgName}@${meta.version}`,
      `License: ${meta.license}`,
      `Integrity: ${meta.integrity}`,
      `--------------------------------------------------------------------------------`,
      licenseText,
      "",
    );
  }
  const noticesContent = noticeSections.join("\n");
  const noticesSha = sha256(Buffer.from(noticesContent, "utf8"));

  const manifest = {
    schemaVersion: 1,
    upstream: "tuf-js",
    version: EXPECTED_TUF_VERSION,
    updaterOriginalSha256: originalSha,
    updaterPatchedSha256: patchedSha,
    bundleSha256: bundleSha,
    noticesSha256: noticesSha,
    externalImports: [...new Set(externalImports)].sort(),
    patchDescription:
      "Inject optional async options.metadataStore { read(fileName), write(metaDataName, bytesData) } into tuf-js@5.0.1 dist/updater.js and await all 4 persistMetadata calls (root/timestamp/snapshot/targets) so raw bytes persist atomically via writeBytesAtomic.",
    packages: auditedPackages.sort((a, b) => a.name.localeCompare(b.name, "en-US")),
  };
  const manifestContent = JSON.stringify(manifest, null, 2) + "\n";

  if (checkOnly) {
    const existingBundle = await fs.readFile(bundleOutPath);
    const existingNotices = await fs.readFile(noticesOutPath, "utf8");
    const existingManifest = JSON.parse(await fs.readFile(manifestOutPath, "utf8"));
    assert.equal(sha256(existingBundle), bundleSha, "Checked-in TUF vendor bundle SHA-256 drifted");
    assert.equal(
      sha256(Buffer.from(existingNotices, "utf8")),
      noticesSha,
      "Checked-in THIRD-PARTY-NOTICES.txt drifted",
    );
    assert.equal(existingManifest.bundleSha256, bundleSha, "Checked-in manifest bundleSha256 drifted");
    console.log(`TUF vendor verification PASSED (bundle sha256=${bundleSha})`);
  } else {
    await fs.writeFile(bundleOutPath, bundleBytes);
    await fs.writeFile(noticesOutPath, noticesContent, "utf8");
    await fs.writeFile(manifestOutPath, manifestContent, "utf8");
    console.log(
      JSON.stringify(
        {
          status: "BUILT",
          bundleBytes: bundleBytes.length,
          bundleSha256: bundleSha,
          updaterOriginalSha256: originalSha,
          updaterPatchedSha256: patchedSha,
          packages: auditedPackages.length,
        },
        null,
        2,
      ),
    );
  }
} finally {
  await fs.rm(tmpDir, { recursive: true, force: true });
}
