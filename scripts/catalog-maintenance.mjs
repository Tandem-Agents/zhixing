/**
 * 模型目录正式维护与可信发布 CLI（设计 §4.1、§4.2）。
 *
 * 完整覆盖本机与 CI 生产链（零隐式远程推送，密钥由离线文件或受控环境变量注入，绝不回显私钥）：
 *   node scripts/catalog-maintenance.mjs export-builtin <outJsonPath>
 *   node scripts/catalog-maintenance.mjs check-sync [catalog/v1/curated-catalog.json]
 *   node scripts/catalog-maintenance.mjs collect <base.json|builtin> <sources.json> <reviewOutDir> [--revision <rev>]
 *   node scripts/catalog-maintenance.mjs review <base.json|builtin> <candidate.json> [--out-dir <reviewOutDir>]
 *   node scripts/catalog-maintenance.mjs validate <candidate.json|builtin>
 *   node scripts/catalog-maintenance.mjs diff <previous.json|builtin> <candidate.json> [--digest-only]
 *   node scripts/catalog-maintenance.mjs init-ceremony <outRepoDir> <offlineKeysDir> [--catalog <file|builtin>] [--root-days <N>]
 *   node scripts/catalog-maintenance.mjs publish-local <candidate.json|builtin> <outDir> [--keys <file> | --keys-env <ENV>] [--approved-review <digestFile|bindingJson|hex>] [--base <base.json|builtin>]
 *   node scripts/catalog-maintenance.mjs renew-local <outDir> [--keys <file> | --keys-env <ENV>] [--if-due] [--threshold-hours <N>]
 *   node scripts/catalog-maintenance.mjs rotate-root-local <outDir> --old-root-key <file> --out-keys <newKeysDir> [--keep-online-keys <file>] [--root-days <N>]
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const providersEntry = path.join(root, "packages/providers/dist/index.js");

const {
  BUILTIN_CURATED_CATALOG,
  checkTufRenewalDue,
  collectUpstreamCatalogCandidate,
  computeCatalogReviewBinding,
  diffCuratedCatalogs,
  formatCatalogDiffMarkdown,
  generateTufEd25519KeyPair,
  generateTufFourRoleKeySet,
  parseCuratedCatalogBundle,
  publishTufCatalogRepository,
  publishTufCatalogUpdate,
  renewTufMetadata,
  rotateTufRoot,
  validateTufMetadataBytes,
  verifyCatalogCompatibilityForReader,
  verifyCatalogReviewBinding,
  verifyTufEnvelopeSignatureAgainstRoot,
} = await import(`file:///${providersEntry.replaceAll("\\", "/")}`);

const [cmd, ...rest] = process.argv.slice(2);

function option(flag) {
  const idx = rest.indexOf(flag);
  if (idx < 0) return undefined;
  return rest[idx + 1];
}

function hasFlag(flag) {
  return rest.includes(flag);
}

if (!cmd || cmd === "--help" || cmd === "-h") {
  console.log(
    [
      "Zhixing Model Catalog Maintenance CLI (local / CI, zero implicit remote push):",
      "  export-builtin <outJsonPath>",
      "  check-sync [catalog/v1/curated-catalog.json]",
      "  collect <base.json|builtin> <sources.json> <reviewOutDir> [--revision <rev>]",
      "  review <base.json|builtin> <candidate.json> [--out-dir <reviewOutDir>]",
      "  validate <candidate.json|builtin>",
      "  diff <previous.json|builtin> <candidate.json> [--digest-only]",
      "  init-ceremony <outRepoDir> <offlineKeysDir> [--catalog <file|builtin>] [--root-days <N>]",
      "  publish-local <candidate.json|builtin> <outDir> [--keys <file> | --keys-env <ENV>] [--approved-review <digestFile|bindingJson|hex>] [--base <base.json|builtin>]",
      "  renew-local <outDir> [--keys <file> | --keys-env <ENV>] [--if-due] [--threshold-hours <N>]",
      "  rotate-root-local <outDir> --old-root-key <file> --out-keys <newKeysDir> [--keep-online-keys <file>] [--root-days <N>]",
    ].join("\n"),
  );
  process.exit(0);
}

async function readBundleArg(arg) {
  if (arg === "builtin") return BUILTIN_CURATED_CATALOG;
  const raw = await fs.readFile(path.resolve(arg), "utf8");
  return JSON.parse(raw);
}

async function loadKeysFromArgs() {
  const keysPath = option("--keys");
  const keysEnv = option("--keys-env");
  if (keysPath && keysEnv) {
    throw new Error("Specify either --keys or --keys-env, not both");
  }
  if (keysPath) {
    return JSON.parse(await fs.readFile(path.resolve(keysPath), "utf8"));
  }
  if (keysEnv) {
    const raw = process.env[keysEnv];
    if (!raw || !raw.trim()) {
      throw new Error(`Environment variable ${keysEnv} is missing or empty`);
    }
    return JSON.parse(raw);
  }
  return undefined;
}

async function hasExistingVersionedRoot(outDir) {
  try {
    const entries = await fs.readdir(path.join(outDir, "metadata"));
    return entries.some((name) => /^\d+\.root\.json$/u.test(name));
  } catch {
    return false;
  }
}

async function hasExistingMetadataFiles(outDir) {
  try {
    const entries = await fs.readdir(path.join(outDir, "metadata"));
    return entries.some((name) => name.endsWith(".json"));
  } catch {
    return false;
  }
}

async function resolveActualPublishBaseline(outDir, explicitBaseArg, existingRepo) {
  const existingTargetPath = path.join(outDir, "targets", "catalog-v1.json");
  let targetRaw;
  try {
    targetRaw = await fs.readFile(existingTargetPath, "utf8");
  } catch (err) {
    if (!err || err.code !== "ENOENT") {
      throw err;
    }
    const repoInitialized = existingRepo || (await hasExistingMetadataFiles(outDir));
    if (repoInitialized) {
      throw new Error(
        `已初始化的 TUF 仓库缺少当前生效目标文件（${existingTargetPath}），拒绝以 --base 或随包基线替代缺失目标`,
      );
    }
    // 仅允许首次初始化空白仓库时由 --base（缺省随包基线）指定初始对照基线
    return explicitBaseArg
      ? parseCuratedCatalogBundle(await readBundleArg(explicitBaseArg))
      : parseCuratedCatalogBundle(BUILTIN_CURATED_CATALOG);
  }

  let actualTarget;
  try {
    actualTarget = parseCuratedCatalogBundle(JSON.parse(targetRaw));
  } catch (err) {
    throw new Error(
      `已有仓库的当前目标文件（${existingTargetPath}）损坏或未通过 Schema 校验，拒绝以 --base 绕过：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (explicitBaseArg) {
    const assertedBase = parseCuratedCatalogBundle(await readBundleArg(explicitBaseArg));
    const actualSha = computeCatalogReviewBinding(actualTarget, actualTarget).binding.baseCanonicalSha256;
    const assertedSha = computeCatalogReviewBinding(assertedBase, assertedBase).binding.baseCanonicalSha256;
    if (actualSha !== assertedSha) {
      throw new Error(
        `--base 与仓库当前实际生效目标（${existingTargetPath}，revision=${actualTarget.catalogRevision}，sha256=${actualSha}）不一致（--base revision=${assertedBase.catalogRevision}，sha256=${assertedSha}）；已有仓库严禁通过 --base 绕过当前真实基线`,
      );
    }
  }
  return actualTarget;
}

async function parseApprovalInput(approvedArg) {
  const trimmed = approvedArg.trim();
  if (/^[0-9a-f]{64}$/iu.test(trimmed)) {
    return { expectedApprovalDigest: trimmed.toLowerCase() };
  }
  const resolved = path.resolve(trimmed);
  const raw = (await fs.readFile(resolved, "utf8")).trim();
  if (raw.startsWith("{")) {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.approvalDigest !== "string") {
      throw new Error(`Invalid review-binding JSON (missing approvalDigest): ${resolved}`);
    }
    return {
      expectedApprovalDigest: parsed.approvalDigest,
      ...(typeof parsed.baseCanonicalSha256 === "string"
        ? { expectedBaseCanonicalSha256: parsed.baseCanonicalSha256 }
        : {}),
      ...(typeof parsed.candidateCanonicalSha256 === "string"
        ? { expectedCandidateCanonicalSha256: parsed.candidateCanonicalSha256 }
        : {}),
    };
  }
  // 纯文本 review-digest.txt：若同目录存在配套 review-binding.json 则一并核对基线/候选摘要以提供精确诊断
  const siblingBindingPath = path.join(path.dirname(resolved), "review-binding.json");
  try {
    const binding = JSON.parse(await fs.readFile(siblingBindingPath, "utf8"));
    return {
      expectedApprovalDigest: raw,
      ...(typeof binding?.baseCanonicalSha256 === "string"
        ? { expectedBaseCanonicalSha256: binding.baseCanonicalSha256 }
        : {}),
      ...(typeof binding?.candidateCanonicalSha256 === "string"
        ? { expectedCandidateCanonicalSha256: binding.candidateCanonicalSha256 }
        : {}),
    };
  } catch {
    return { expectedApprovalDigest: raw };
  }
}

if (cmd === "export-builtin") {
  const outArg = rest[0] ?? path.join(root, "catalog/v1/curated-catalog.json");
  const outPath = path.resolve(outArg);
  const validated = parseCuratedCatalogBundle(BUILTIN_CURATED_CATALOG);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const content = JSON.stringify(validated, null, 2) + "\n";
  await fs.writeFile(outPath, content, "utf8");
  const sha256 = crypto.createHash("sha256").update(content, "utf8").digest("hex");
  console.log(
    JSON.stringify(
      {
        exported: true,
        path: outPath,
        revision: validated.catalogRevision,
        presets: validated.presets.length,
        models: validated.models.length,
        sha256,
      },
      null,
      2,
    ),
  );
} else if (cmd === "check-sync") {
  const targetArg = rest[0] ?? path.join(root, "catalog/v1/curated-catalog.json");
  const targetPath = path.resolve(targetArg);
  const rawDisk = JSON.parse(await fs.readFile(targetPath, "utf8"));
  const diskBundle = parseCuratedCatalogBundle(rawDisk);
  const builtinBundle = parseCuratedCatalogBundle(BUILTIN_CURATED_CATALOG);
  const canonicalDisk = JSON.stringify(diskBundle);
  const canonicalBuiltin = JSON.stringify(builtinBundle);
  if (canonicalDisk !== canonicalBuiltin) {
    const diff = diffCuratedCatalogs(builtinBundle, diskBundle);
    throw new Error(
      `curated-catalog.json is out of sync with BUILTIN_CURATED_CATALOG:\n${formatCatalogDiffMarkdown(diff)}`,
    );
  }
  const currentCompat = verifyCatalogCompatibilityForReader(rawDisk);
  const legacyCompat = verifyCatalogCompatibilityForReader(rawDisk, [
    "adapter:openai-compatible",
    "adapter:anthropic-messages",
  ]);
  if (!currentCompat.compatible || !legacyCompat.compatible) {
    throw new Error(
      `Compatibility check failed: current=${currentCompat.error ?? "ok"}, legacy=${legacyCompat.error ?? "ok"}`,
    );
  }
  console.log(
    JSON.stringify(
      {
        synced: true,
        path: targetPath,
        revision: diskBundle.catalogRevision,
        presets: diskBundle.presets.length,
        models: diskBundle.models.length,
        currentReader: currentCompat,
        legacyReader: legacyCompat,
      },
      null,
      2,
    ),
  );
} else if (cmd === "collect") {
  const [baseArg, sourcesArg, reviewDirArg] = rest;
  if (!baseArg || !sourcesArg || !reviewDirArg) {
    throw new Error("Usage: collect <base.json|builtin> <sources.json> <reviewOutDir> [--revision <rev>]");
  }
  const baseCatalog = parseCuratedCatalogBundle(await readBundleArg(baseArg));
  const rawSourcesPayload = JSON.parse(await fs.readFile(path.resolve(sourcesArg), "utf8"));
  const rawSources = Array.isArray(rawSourcesPayload)
    ? rawSourcesPayload
    : Array.isArray(rawSourcesPayload?.sources)
      ? rawSourcesPayload.sources
      : [];

  const activeSources = [];
  const skippedSources = [];
  for (const src of rawSources) {
    if (!src || typeof src !== "object") continue;
    if (src.collectionMode === "manual-only" || src.collectionMode === "local-only") {
      skippedSources.push({
        presetId: src.presetId,
        reason: `skipped (${src.collectionMode})`,
      });
      continue;
    }
    let secretValue = src.secretValue;
    if (!secretValue && typeof src.authEnvVar === "string" && src.authEnvVar.trim()) {
      secretValue = process.env[src.authEnvVar.trim()];
    }
    if (src.auth?.mode !== "none" && (!secretValue || !secretValue.trim())) {
      skippedSources.push({
        presetId: src.presetId,
        reason: src.authEnvVar
          ? `missing env ${src.authEnvVar} (set read-only token to collect)`
          : "missing credentials",
      });
      continue;
    }
    activeSources.push({
      presetId: src.presetId,
      endpoint: src.endpoint,
      adapter: src.adapter,
      auth: src.auth,
      ...(secretValue ? { secretValue } : {}),
      ...(src.network ? { network: src.network } : {}),
      ...(src.allowOptionalCompatProbe !== undefined
        ? { allowOptionalCompatProbe: src.allowOptionalCompatProbe }
        : {}),
      ...(src.evidenceSource ? { evidenceSource: src.evidenceSource } : {}),
    });
  }

  const nextRevision = option("--revision");
  const collected = await collectUpstreamCatalogCandidate({
    baseCatalog,
    sources: activeSources,
    ...(nextRevision ? { nextRevision } : {}),
  });
  const reviewDir = path.resolve(reviewDirArg);
  await fs.mkdir(reviewDir, { recursive: true });
  await fs.writeFile(
    path.join(reviewDir, "candidate-catalog.json"),
    JSON.stringify(collected.candidate, null, 2) + "\n",
    "utf8",
  );
  await fs.writeFile(path.join(reviewDir, "review-diff.md"), collected.diffMarkdown, "utf8");
  await fs.writeFile(
    path.join(reviewDir, "compat-report.json"),
    JSON.stringify(collected.readerCompatibility, null, 2) + "\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(reviewDir, "review-binding.json"),
    JSON.stringify(collected.reviewBinding, null, 2) + "\n",
    "utf8",
  );
  await fs.writeFile(path.join(reviewDir, "review-digest.txt"), `${collected.reviewDigest}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        collected: true,
        reviewDir,
        revision: collected.candidate.catalogRevision,
        reviewDigest: collected.reviewDigest,
        reviewBinding: collected.reviewBinding,
        readerCompatible: collected.readerCompatibility.compatible,
        presetsChanged: collected.diff.presets.length,
        modelsChanged: collected.diff.models.length,
        recommendationsChanged: collected.diff.recommendations.length,
        sourceReports: collected.sourceReports,
        skippedSources,
      },
      null,
      2,
    ),
  );
} else if (cmd === "review") {
  const [baseArg, candidateArg] = rest;
  if (!baseArg || !candidateArg) {
    throw new Error("Usage: review <base.json|builtin> <candidate.json> [--out-dir <reviewOutDir>]");
  }
  const base = parseCuratedCatalogBundle(await readBundleArg(baseArg));
  const candidate = parseCuratedCatalogBundle(await readBundleArg(candidateArg));
  const reviewed = computeCatalogReviewBinding(base, candidate);
  const outDirArg = option("--out-dir");
  if (outDirArg) {
    const outDir = path.resolve(outDirArg);
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, "review-diff.md"), reviewed.diffMarkdown, "utf8");
    await fs.writeFile(
      path.join(outDir, "review-binding.json"),
      JSON.stringify(reviewed.binding, null, 2) + "\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(outDir, "review-digest.txt"),
      `${reviewed.binding.approvalDigest}\n`,
      "utf8",
    );
  }
  console.log(
    JSON.stringify(
      {
        reviewed: true,
        binding: reviewed.binding,
        summary: {
          bundleFieldsChanged: reviewed.diff.bundleFieldsChanged.length,
          presetsChanged: reviewed.diff.presets.length,
          modelsChanged: reviewed.diff.models.length,
          recommendationsChanged: reviewed.diff.recommendations.length,
          warnings: reviewed.diff.warnings,
        },
        ...(outDirArg ? { outDir: path.resolve(outDirArg) } : {}),
      },
      null,
      2,
    ),
  );
} else if (cmd === "validate") {
  const file = rest[0];
  if (!file) throw new Error("Missing <candidate.json|builtin>");
  const raw = await readBundleArg(file);
  const parsed = parseCuratedCatalogBundle(raw);
  const compat = verifyCatalogCompatibilityForReader(raw);
  const legacyCompat = verifyCatalogCompatibilityForReader(raw, [
    "adapter:openai-compatible",
    "adapter:anthropic-messages",
  ]);
  if (!compat.compatible || !legacyCompat.compatible) {
    throw new Error(
      `Compatibility check failed: current=${compat.error ?? "ok"}, legacy=${legacyCompat.error ?? "ok"}`,
    );
  }
  console.log(
    JSON.stringify(
      { ok: true, revision: parsed.catalogRevision, compat, legacyCompat },
      null,
      2,
    ),
  );
} else if (cmd === "diff") {
  const [prevArg, nextArg] = rest;
  if (!prevArg || !nextArg) {
    throw new Error("Usage: diff <previous.json|builtin> <candidate.json> [--digest-only]");
  }
  const prev = parseCuratedCatalogBundle(await readBundleArg(prevArg));
  const next = parseCuratedCatalogBundle(await readBundleArg(nextArg));
  const reviewed = computeCatalogReviewBinding(prev, next);
  if (hasFlag("--digest-only")) {
    console.log(reviewed.binding.approvalDigest);
  } else {
    console.log(reviewed.diffMarkdown);
  }
} else if (cmd === "init-ceremony") {
  const [outRepoArg, offlineKeysArg] = rest;
  if (!outRepoArg || !offlineKeysArg) {
    throw new Error(
      "Usage: init-ceremony <outRepoDir> <offlineKeysDir> [--catalog <file|builtin>] [--root-days <N>]",
    );
  }
  const catalogArg = option("--catalog") ?? "builtin";
  const rootDaysRaw = option("--root-days");
  const rootExpiresDays = rootDaysRaw ? Number.parseInt(rootDaysRaw, 10) : 365;
  const candidate = parseCuratedCatalogBundle(await readBundleArg(catalogArg));
  const compat = verifyCatalogCompatibilityForReader(candidate);
  if (!compat.compatible) {
    throw new Error(`Catalog failed reader compatibility gate: ${compat.error ?? "unknown"}`);
  }

  const outRepoDir = path.resolve(outRepoArg);
  const offlineKeysDir = path.resolve(offlineKeysArg);
  const keys = generateTufFourRoleKeySet();

  const published = await publishTufCatalogRepository({
    outputDir: outRepoDir,
    catalog: candidate,
    keys,
    rootExpiresDays,
  });

  // 离线仪式关键安全边界：分离离线根私钥与在线三角色 CI 密钥（绝不把 root 私钥放入在线密钥文件）
  await fs.mkdir(offlineKeysDir, { recursive: true, mode: 0o700 });
  const rootKeyPath = path.join(offlineKeysDir, "root-key.offline.json");
  const onlineKeysPath = path.join(offlineKeysDir, "online-keys.ci-secret.json");
  const publicKeyIdsPath = path.join(offlineKeysDir, "public-keyids.json");
  await fs.writeFile(
    rootKeyPath,
    JSON.stringify({ schemaVersion: 1, role: "root", key: keys.root }, null, 2) + "\n",
    { mode: 0o600 },
  );
  await fs.writeFile(
    onlineKeysPath,
    JSON.stringify(
      { timestamp: keys.timestamp, snapshot: keys.snapshot, targets: keys.targets },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  const keyFingerprints = {
    root: keys.root.keyid,
    timestamp: keys.timestamp.keyid,
    snapshot: keys.snapshot.keyid,
    targets: keys.targets.keyid,
  };
  await fs.writeFile(publicKeyIdsPath, JSON.stringify(keyFingerprints, null, 2) + "\n", "utf8");

  const bootstrapRootJson = published.rootBytes.toString("utf8");
  validateTufMetadataBytes(published.rootBytes, "root");
  verifyTufEnvelopeSignatureAgainstRoot(published.rootBytes, published.rootBytes, "root");
  const snippetPath = path.join(offlineKeysDir, "bootstrap-root.snippet.txt");
  await fs.writeFile(snippetPath, bootstrapRootJson, "utf8");

  console.log(
    JSON.stringify(
      {
        ceremonyCompleted: true,
        outputRepoDir: outRepoDir,
        offlineKeysDir,
        catalogRevision: published.catalogRevision,
        targetSha256: published.targetSha256,
        rootSha256: crypto.createHash("sha256").update(published.rootBytes).digest("hex"),
        publicKeyIds: keyFingerprints,
        generatedFiles: {
          rootKeyOffline: rootKeyPath,
          onlineKeysForCiSecret: onlineKeysPath,
          bootstrapRootSnippet: snippetPath,
          publicKeyIds: publicKeyIdsPath,
        },
      },
      null,
      2,
    ),
  );
} else if (cmd === "publish-local") {
  const [candidateArg, outDirArg] = rest;
  if (!candidateArg || !outDirArg) {
    throw new Error(
      "Usage: publish-local <candidate.json|builtin> <outDir> [--keys <file> | --keys-env <ENV>] [--approved-review <digestFile|bindingJson|hex>] [--base <base.json|builtin>]",
    );
  }
  const rawCandidate = await readBundleArg(candidateArg);
  const candidate = parseCuratedCatalogBundle(rawCandidate);
  const compat = verifyCatalogCompatibilityForReader(rawCandidate);
  if (!compat.compatible) {
    throw new Error(`Reader compatibility gate failed: ${compat.error ?? "unknown"}`);
  }
  const outDir = path.resolve(outDirArg);
  const existingRepo = await hasExistingVersionedRoot(outDir);
  const approvedReviewArg = option("--approved-review");
  let verifiedReviewBinding;
  if (approvedReviewArg) {
    const actualBase = await resolveActualPublishBaseline(outDir, option("--base"), existingRepo);
    const approval = await parseApprovalInput(approvedReviewArg);
    const verified = verifyCatalogReviewBinding({
      baseCatalog: actualBase,
      candidateCatalog: candidate,
      ...approval,
    });
    verifiedReviewBinding = verified.binding;
  }

  let keys = await loadKeysFromArgs();

  let published;
  if (existingRepo && keys && !keys.root) {
    // 已有仓库 + 在线三角色密钥：走无离线根更新路径（生产日常发布标准路径）
    published = await publishTufCatalogUpdate({
      outputDir: outDir,
      catalog: candidate,
      keys,
    });
  } else if (existingRepo && keys && hasFlag("--online-update")) {
    published = await publishTufCatalogUpdate({
      outputDir: outDir,
      catalog: candidate,
      keys,
    });
  } else {
    if (!keys) {
      keys = generateTufFourRoleKeySet();
      await fs.mkdir(outDir, { recursive: true });
      await fs.writeFile(
        path.join(outDir, "dev-tuf-keys.local.json"),
        JSON.stringify(keys, null, 2) + "\n",
        { mode: 0o600 },
      );
    }
    published = await publishTufCatalogRepository({
      outputDir: outDir,
      catalog: candidate,
      keys,
    });
  }

  console.log(
    JSON.stringify(
      {
        published: true,
        mode: existingRepo && (!keys.root || hasFlag("--online-update")) ? "online-update" : "initial-repo",
        outputDir: outDir,
        catalogRevision: published.catalogRevision,
        targetSha256: published.targetSha256,
        readerCompatible: compat.compatible,
        ...(verifiedReviewBinding ? { verifiedReviewBinding } : {}),
        versions: {
          root: published.rootVersion,
          targets: published.targetsVersion,
          snapshot: published.snapshotVersion,
          timestamp: published.timestampVersion,
        },
      },
      null,
      2,
    ),
  );
} else if (cmd === "renew-local") {
  const outDirArg = rest[0];
  const keys = await loadKeysFromArgs();
  if (!outDirArg || !keys) {
    throw new Error(
      "Usage: renew-local <outDir> [--keys <file> | --keys-env <ENV>] [--if-due] [--threshold-hours <N>]",
    );
  }
  const outDir = path.resolve(outDirArg);
  const ifDue = hasFlag("--if-due");
  const thresholdHoursRaw = option("--threshold-hours");
  const thresholdHours = thresholdHoursRaw ? Number.parseFloat(thresholdHoursRaw) : undefined;
  const dueCheck = await checkTufRenewalDue({
    outputDir: outDir,
    ...(thresholdHours !== undefined && Number.isFinite(thresholdHours)
      ? { timestampThresholdHours: thresholdHours }
      : {}),
  });
  if (ifDue && !dueCheck.due) {
    console.log(JSON.stringify({ renewed: false, skipped: true, dueCheck }, null, 2));
    process.exit(0);
  }
  const renewed = await renewTufMetadata({
    outputDir: outDir,
    keys,
  });
  console.log(JSON.stringify({ renewed: true, dueCheck, ...renewed }, null, 2));
} else if (cmd === "rotate-root-local") {
  const outDirArg = rest[0];
  const oldRootKeyPath = option("--old-root-key");
  const outKeysDirArg = option("--out-keys");
  if (!outDirArg || !oldRootKeyPath || !outKeysDirArg) {
    throw new Error(
      "Usage: rotate-root-local <outDir> --old-root-key <file> --out-keys <newKeysDir> [--keep-online-keys <file>] [--root-days <N>]",
    );
  }
  const outDir = path.resolve(outDirArg);
  const outKeysDir = path.resolve(outKeysDirArg);
  const oldRootRaw = JSON.parse(await fs.readFile(path.resolve(oldRootKeyPath), "utf8"));
  const previousRootKey = oldRootRaw.key ?? oldRootRaw.root ?? oldRootRaw;
  const keepOnlinePath = option("--keep-online-keys");
  const rootDaysRaw = option("--root-days");
  const rootExpiresDays = rootDaysRaw ? Number.parseInt(rootDaysRaw, 10) : 365;

  let nextKeys;
  if (keepOnlinePath) {
    const online = JSON.parse(await fs.readFile(path.resolve(keepOnlinePath), "utf8"));
    nextKeys = {
      root: generateTufEd25519KeyPair(),
      timestamp: online.timestamp,
      snapshot: online.snapshot,
      targets: online.targets,
    };
  } else {
    nextKeys = generateTufFourRoleKeySet();
  }

  const rotated = await rotateTufRoot({
    outputDir: outDir,
    previousRootKey,
    nextKeys,
    rootExpiresDays,
  });

  await fs.mkdir(outKeysDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(outKeysDir, `root-v${rotated.nextRootVersion}.offline.json`),
    JSON.stringify({ schemaVersion: 1, role: "root", version: rotated.nextRootVersion, key: nextKeys.root }, null, 2) + "\n",
    { mode: 0o600 },
  );
  await fs.writeFile(
    path.join(outKeysDir, `online-keys-v${rotated.nextRootVersion}.ci-secret.json`),
    JSON.stringify(
      { timestamp: nextKeys.timestamp, snapshot: nextKeys.snapshot, targets: nextKeys.targets },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );

  console.log(
    JSON.stringify(
      {
        rotated: true,
        outputDir: outDir,
        previousRootVersion: rotated.previousRootVersion,
        nextRootVersion: rotated.nextRootVersion,
        targetSha256Unchanged: rotated.targetSha256Unchanged,
        versions: {
          targets: rotated.targetsVersion,
          snapshot: rotated.snapshotVersion,
          timestamp: rotated.timestampVersion,
        },
        publicKeyIds: {
          root: nextKeys.root.keyid,
          timestamp: nextKeys.timestamp.keyid,
          snapshot: nextKeys.snapshot.keyid,
          targets: nextKeys.targets.keyid,
        },
      },
      null,
      2,
    ),
  );
} else {
  throw new Error(`Unknown command: ${cmd}`);
}
