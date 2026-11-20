import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILTIN_CURATED_CATALOG,
  DEFAULT_OFFICIAL_CATALOG_REPOSITORY,
  ModelCatalogManager,
  TufSecurityPolicyError,
  checkTufRenewalDue,
  collectUpstreamCatalogCandidate,
  computeCatalogReviewBinding,
  diffCuratedCatalogs,
  formatCatalogDiffMarkdown,
  generateTufEd25519KeyPair,
  generateTufFourRoleKeySet,
  publishTufCatalogRepository,
  publishTufCatalogUpdate,
  refreshCatalogWithTuf,
  renewTufMetadata,
  resolveActiveCatalogPath,
  resolveCatalogRepositorySourcePath,
  resolveCatalogStoreDir,
  resolveTufMetadataDir,
  rotateTufRoot,
  signTufEnvelope,
  validateTufMetadataBytes,
  verifyCatalogCompatibilityForReader,
  verifyCatalogReviewBinding,
  type CuratedCatalogBundle,
} from "../index.js";

const servers: http.Server[] = [];
const tempDirs: string[] = [];

async function makeTempDir(prefix = "zhixing-unit3-tuf-"): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function serveStaticRepo(
  repoDir: string,
  options: { readonly onRequest?: (reqPath: string) => void; readonly offline?: () => boolean } = {},
): Promise<{ baseUrl: string; server: http.Server }> {
  const server = http.createServer(async (req, res) => {
    const reqPath = (req.url ?? "/").split("?")[0]!;
    options.onRequest?.(reqPath);
    if (options.offline?.()) {
      res.socket?.destroy();
      return;
    }
    const rel = reqPath.replace(/^\/+/u, "");
    const full = path.join(repoDir, rel);
    try {
      const data = await fs.readFile(full);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("Not Found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  servers.push(server);
  const addr = server.address() as { port: number };
  return { baseUrl: `http://127.0.0.1:${addr.port}`, server };
}

afterEach(async () => {
  while (servers.length > 0) {
    const srv = servers.pop()!;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("Unit 3 · Restricted 4-role TUF security wrapper, maintenance loop & crash/offline recovery", () => {
  it("runs complete publish -> diff -> old-client reader -> live client update across all lifecycle changes & root rotation", async () => {
    const repoDir = await makeTempDir("zhixing-tuf-repo-");
    const homeDir = await makeTempDir("zhixing-tuf-home-");
    const keysV1 = generateTufFourRoleKeySet();

    // Release 1: baseline + new model + spec update + deprecated/retired + future-capability model
    const rev1Catalog: CuratedCatalogBundle = {
      ...structuredClone(BUILTIN_CURATED_CATALOG),
      catalogRevision: "2026.11.20-r2",
      publishedAt: "2026-11-20T01:00:00Z",
      presets: [
        ...BUILTIN_CURATED_CATALOG.presets,
        {
          id: "groq-compat",
          name: "Groq",
          presetRevision: "2026.11.20-r2",
          baseUrl: "https://api.groq.com/openai/v1",
          protocol: "openai-compatible",
          defaultAuthMode: "api-key",
          defaultNetwork: { proxy: "inherit" },
          discovery: {
            mode: "native",
            kind: "openai-models",
            urlBase: "baseUrl",
            path: "/models",
            authoritativeNativeFacts: true,
          },
          ui: {
            label: "Groq",
            description: "高速推理 OpenAI 兼容服务商",
            apiKeyHint: "输入 Groq API Key。",
            apiKeyExample: "gsk_xxxxxxxx",
          },
        },
      ],
      models: [
        ...BUILTIN_CURATED_CATALOG.models.map((m) =>
          m.presetId === "deepseek" && m.id === "deepseek-v4-flash"
            ? {
                ...m,
                lifecycle: "retired" as const,
                replacementModelId: "deepseek-v4-flash-2",
                lifecycleReason: "已正式退役，请迁移至 deepseek-v4-flash-2",
              }
            : m,
        ),
        {
          presetId: "deepseek",
          id: "deepseek-v4-flash-2",
          name: "DeepSeek V4 Flash 2",
          purpose: "chat",
          lifecycle: "active",
          contextWindow: 1_000_000,
          maxOutputTokens: 384_000,
          supportsTools: true,
          verifiedAt: "2026-11-20T01:00:00Z",
          evidenceSource: "DeepSeek release changelog",
        },
        {
          presetId: "openai",
          id: "gpt-7-next",
          name: "GPT-7 Next",
          purpose: "chat",
          lifecycle: "active",
          requiredCapabilities: ["adapter:openai-future-v3"],
          verifiedAt: "2026-11-20T01:00:00Z",
          evidenceSource: "OpenAI preview spec",
        },
      ],
    };

    // Reviewable diff separates fact catalog updates from recommendations (0 recommendation changes!)
    const diff = diffCuratedCatalogs(BUILTIN_CURATED_CATALOG, rev1Catalog);
    expect(diff.presets.some((p) => p.presetId === "groq-compat" && p.change === "added")).toBe(true);
    expect(diff.models.some((m) => m.modelId === "deepseek-v4-flash-2" && m.change === "added")).toBe(true);
    expect(diff.recommendations).toEqual([]);
    const md = formatCatalogDiffMarkdown(diff);
    expect(md).toContain("事实修订未改动用途推荐");

    // Old-client compatibility check isolates future-capability entry without failing bundle
    const compat = verifyCatalogCompatibilityForReader(rev1Catalog);
    expect(compat.compatible).toBe(true);
    expect(compat.upgradeRequiredModels).toEqual(["openai/gpt-7-next"]);

    // Publish real Ed25519 TUF v1 repo with an ALREADY-EXPIRED v1 root to prove continuous expired-root -> v2 rotation!
    const pastDate = new Date(Date.now() - 10 * 86_400_000);
    const expiredBootstrap = await publishTufCatalogRepository({
      outputDir: repoDir,
      catalog: BUILTIN_CURATED_CATALOG,
      keys: keysV1,
      rootVersion: 1,
      now: pastDate,
      rootExpiresDays: 1, // expired 9 days ago!
    });

    // Now rotate root v1 -> v2 (dual-signed by old + new root keys) and publish rev1Catalog
    const newRootKey = generateTufEd25519KeyPair();
    const keysV2 = { ...keysV1, root: newRootKey };
    const pubV2 = await publishTufCatalogRepository({
      outputDir: repoDir,
      catalog: rev1Catalog,
      keys: keysV2,
      rootVersion: 2,
      targetsVersion: 2,
      snapshotVersion: 2,
      timestampVersion: 2,
      previousRootSigner: keysV1.root,
    });

    let simulateOffline = false;
    const { baseUrl } = await serveStaticRepo(repoDir, { offline: () => simulateOffline });

    const testRepo = {
      metadataBaseUrl: `${baseUrl}/metadata`,
      targetsBaseUrl: `${baseUrl}/targets`,
      targetPath: "catalog-v1.json",
      bootstrapRootBytes: expiredBootstrap.rootBytes,
      network: { proxy: "direct" as const, allowPrivateOrigin: true },
    };

    const manager = new ModelCatalogManager({
      homeDir,
      repository: testRepo,
    });
    await manager.initialize();
    expect(manager.status().source).toBe("bundled");

    // Refresh rotates expired root v1 -> valid root v2 and activates rev1Catalog atomically
    const r1 = await manager.refresh({ force: true });
    expect(r1.status).toBe("updated");
    expect(r1.activeRevision).toBe("2026.11.20-r2");
    expect(r1.rootVersion).toBe(2);
    expect(manager.port().getPreset("groq-compat")?.implemented).toBe(true);
    expect(manager.port().getCuratedModel("deepseek", "deepseek-v4-flash")?.lifecycle).toBe("retired");
    expect(manager.port().getCuratedModel("deepseek", "deepseek-v4-flash-2")?.lifecycle).toBe("active");

    // Periodic metadata renewal bumps TUF versions WITHOUT touching target bytes or model verifiedAt dates
    const renewed = await renewTufMetadata({ outputDir: repoDir, keys: keysV2 });
    expect(renewed.targetSha256Unchanged).toBe(pubV2.targetSha256);
    expect(renewed.timestampVersion).toBe(3);
    const rRenew = await manager.refresh({ force: true });
    expect(rRenew.status).toBe("up-to-date");
    expect(manager.port().getCuratedModel("deepseek", "deepseek-v4-flash-2")?.verifiedAt).toBe(
      "2026-11-20T01:00:00Z",
    );

    // Higher-revision error correction (fix bad content via revision r3)
    const rev3Catalog: CuratedCatalogBundle = {
      ...rev1Catalog,
      catalogRevision: "2026.11.20-r3-fix",
      publishedAt: "2026-11-20T02:00:00Z",
      models: rev1Catalog.models.map((m) =>
        m.id === "deepseek-v4-flash-2" ? { ...m, contextWindow: 512_000 } : m,
      ),
    };
    await publishTufCatalogRepository({
      outputDir: repoDir,
      catalog: rev3Catalog,
      keys: keysV2,
      rootVersion: 2,
      targetsVersion: 4,
      snapshotVersion: 4,
      timestampVersion: 4,
      previousRootSigner: keysV1.root,
    });
    const rFix = await manager.refresh({ force: true });
    expect(rFix.status).toBe("updated");
    expect(rFix.activeRevision).toBe("2026.11.20-r3-fix");
    expect(manager.port().getModelInfo("deepseek", "deepseek-v4-flash-2")?.contextWindow).toBe(512_000);

    // Offline fallback keeps previously accepted catalog intact
    simulateOffline = true;
    const rOffline = await manager.refresh({ force: true });
    expect(rOffline.status).toBe("offline");
    expect(manager.port().revision).toBe("2026.11.20-r3-fix");

    // Auto-check disabled skips network completely
    await manager.setAutoCheckEnabled(false);
    const rDisabled = await manager.refresh({ force: false });
    expect(rDisabled.status).toBe("disabled");

    // Default official source MUST enforce its bundled official bootstrap root and NEVER trust a foreign local repo's disk catalog!
    const defaultOfficialMgr = new ModelCatalogManager({ homeDir });
    await defaultOfficialMgr.initialize();
    expect(defaultOfficialMgr.status().source).toBe("bundled");
    expect(defaultOfficialMgr.status().activeRevision).toBe(BUILTIN_CURATED_CATALOG.catalogRevision);

    // Corrupted active-catalog.json under the SAME pinned repository recovers ONLY target content (previous-catalog.json) and NEVER rolls back TUF root v2!
    await fs.writeFile(resolveActiveCatalogPath(manager.storeDir), "{corrupted-json", "utf8");
    const manager2 = new ModelCatalogManager({ homeDir, repository: testRepo });
    await manager2.initialize();
    expect(manager2.status().source).toBe("recovered-previous");
    expect(manager2.status().activeRevision).toBe("2026.11.20-r2");
    expect(manager2.status().rootVersion).toBe(2);
    const persistedRoot = validateTufMetadataBytes(
      await fs.readFile(path.join(resolveTufMetadataDir(manager.storeDir), "root.json")),
      "root",
    );
    expect(persistedRoot.version).toBe(2);
  }, 15_000);

  it("blocks bad signatures, expired metadata, rollback attacks, non-RFC3339 dates, delegations, duplicate keys & write interruptions", async () => {
    const keys = generateTufFourRoleKeySet();

    // 1. External policy guard checks
    const invalidDateEnv = signTufEnvelope(
      {
        _type: "timestamp",
        spec_version: "1.0.31",
        version: 1,
        expires: "2026-02-30T00:00:00Z", // non-existent calendar date!
        meta: {},
      },
      [keys.timestamp],
    );
    expect(() => validateTufMetadataBytes(invalidDateEnv, "timestamp")).toThrow(TufSecurityPolicyError);

    const delegatedTargets = signTufEnvelope(
      {
        _type: "targets",
        spec_version: "1.0.31",
        version: 1,
        expires: "2027-01-01T00:00:00Z",
        targets: {},
        delegations: { keys: {}, roles: [] },
      },
      [keys.targets],
    );
    expect(() => validateTufMetadataBytes(delegatedTargets, "targets")).toThrow(TufSecurityPolicyError);

    const dupSigBytes = Buffer.from(
      JSON.stringify({
        signed: {
          _type: "timestamp",
          spec_version: "1.0.31",
          version: 1,
          expires: "2027-01-01T00:00:00Z",
          meta: {},
        },
        signatures: [
          { keyid: keys.timestamp.keyid, sig: "a".repeat(128) },
          { keyid: keys.timestamp.keyid, sig: "b".repeat(128) },
        ],
      }),
    );
    expect(() => validateTufMetadataBytes(dupSigBytes, "timestamp")).toThrow(TufSecurityPolicyError);

    const rsaRootBytes = signTufEnvelope(
      {
        _type: "root",
        spec_version: "1.0.31",
        version: 1,
        expires: "2027-01-01T00:00:00Z",
        consistent_snapshot: false,
        keys: {
          [keys.root.keyid]: { keytype: "rsa", scheme: "rsassa-pss-sha256", keyval: { public: "x" } },
        },
        roles: {
          root: { keyids: [keys.root.keyid], threshold: 1 },
          timestamp: { keyids: [keys.root.keyid], threshold: 1 },
          snapshot: { keyids: [keys.root.keyid], threshold: 1 },
          targets: { keyids: [keys.root.keyid], threshold: 1 },
        },
      },
      [keys.root],
    );
    expect(() => validateTufMetadataBytes(rsaRootBytes, "root")).toThrow(TufSecurityPolicyError);

    // 2. End-to-end attack simulations over real HTTP repo
    const repoDir = await makeTempDir("zhixing-tuf-sec-repo-");
    const storeDir = await makeTempDir("zhixing-tuf-sec-store-");
    const pub1 = await publishTufCatalogRepository({
      outputDir: repoDir,
      catalog: BUILTIN_CURATED_CATALOG,
      keys,
      rootVersion: 1,
      targetsVersion: 2,
      snapshotVersion: 2,
      timestampVersion: 2,
    });
    const fetchedPaths: string[] = [];
    const { baseUrl } = await serveStaticRepo(repoDir, { onRequest: (p) => fetchedPaths.push(p) });

    // 2a. Write interruption at timestamp MUST fail and MUST NOT fetch snapshot.json!
    await expect(
      refreshCatalogWithTuf({
        storeDir,
        repository: {
          metadataBaseUrl: `${baseUrl}/metadata`,
          targetsBaseUrl: `${baseUrl}/targets`,
          targetPath: "catalog-v1.json",
          bootstrapRootBytes: pub1.rootBytes,
          network: { proxy: "direct", allowPrivateOrigin: true },
        },
        writeInterceptor: (stage, name) => {
          if (stage === "metadata" && name === "timestamp") {
            throw new Error("synthetic crash on timestamp write");
          }
        },
      }),
    ).rejects.toThrow("synthetic crash on timestamp write");
    expect(fetchedPaths).not.toContain("/metadata/snapshot.json");

    // 2b. Clean refresh succeeds and establishes accepted v2 state
    const ok = await refreshCatalogWithTuf({
      storeDir,
      repository: {
        metadataBaseUrl: `${baseUrl}/metadata`,
        targetsBaseUrl: `${baseUrl}/targets`,
        targetPath: "catalog-v1.json",
        bootstrapRootBytes: pub1.rootBytes,
        network: { proxy: "direct", allowPrivateOrigin: true },
      },
    });
    expect(ok.timestampVersion).toBe(2);

    // 2c. Tampered signature on timestamp.json -> rejected!
    const tsPath = path.join(repoDir, "metadata", "timestamp.json");
    const goodTs = await fs.readFile(tsPath);
    const badSigTs = JSON.parse(goodTs.toString("utf8")) as {
      signed: Record<string, unknown>;
      signatures: Array<{ keyid: string; sig: string }>;
    };
    badSigTs.signatures[0]!.sig = crypto.randomBytes(64).toString("hex");
    await fs.writeFile(tsPath, JSON.stringify(badSigTs));
    await expect(
      refreshCatalogWithTuf({
        storeDir,
        repository: {
          metadataBaseUrl: `${baseUrl}/metadata`,
          targetsBaseUrl: `${baseUrl}/targets`,
          targetPath: "catalog-v1.json",
          bootstrapRootBytes: pub1.rootBytes,
          network: { proxy: "direct", allowPrivateOrigin: true },
        },
      }),
    ).rejects.toThrow();

    // 2d. Rollback attack (timestamp version 1 < accepted version 2) -> rejected!
    const rollbackTs = signTufEnvelope(
      {
        _type: "timestamp",
        spec_version: "1.0.31",
        version: 1,
        expires: new Date(Date.now() + 86_400_000).toISOString().replace(/\.\d{3}Z$/u, "Z"),
        meta: { "snapshot.json": { version: 1 } },
      },
      [keys.timestamp],
    );
    await fs.writeFile(tsPath, rollbackTs);
    await expect(
      refreshCatalogWithTuf({
        storeDir,
        repository: {
          metadataBaseUrl: `${baseUrl}/metadata`,
          targetsBaseUrl: `${baseUrl}/targets`,
          targetPath: "catalog-v1.json",
          bootstrapRootBytes: pub1.rootBytes,
          network: { proxy: "direct", allowPrivateOrigin: true },
        },
      }),
    ).rejects.toThrow();

    // 2e. Freeze attack (expired timestamp with higher version 3) -> rejected on fresh Updater clock!
    const expiredTs = signTufEnvelope(
      {
        _type: "timestamp",
        spec_version: "1.0.31",
        version: 3,
        expires: new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/u, "Z"),
        meta: { "snapshot.json": { version: 2 } },
      },
      [keys.timestamp],
    );
    await fs.writeFile(tsPath, expiredTs);
    await expect(
      refreshCatalogWithTuf({
        storeDir,
        repository: {
          metadataBaseUrl: `${baseUrl}/metadata`,
          targetsBaseUrl: `${baseUrl}/targets`,
          targetPath: "catalog-v1.json",
          bootstrapRootBytes: pub1.rootBytes,
          network: { proxy: "direct", allowPrivateOrigin: true },
        },
      }),
    ).rejects.toThrow();

    // Restore valid v2 timestamp and verify concurrent refreshes across two manager instances serialize cleanly via file lock
    await fs.writeFile(tsPath, goodTs);
    const homeConcurrent = await makeTempDir("zhixing-tuf-concurrent-");
    const repoCfg = {
      metadataBaseUrl: `${baseUrl}/metadata`,
      targetsBaseUrl: `${baseUrl}/targets`,
      targetPath: "catalog-v1.json",
      bootstrapRootBytes: pub1.rootBytes,
      network: { proxy: "direct" as const, allowPrivateOrigin: true },
    };
    const mA = new ModelCatalogManager({ homeDir: homeConcurrent, repository: repoCfg });
    const mB = new ModelCatalogManager({ homeDir: homeConcurrent, repository: repoCfg });
    const [resA, resB] = await Promise.all([mA.refresh({ force: true }), mB.refresh({ force: true })]);
    expect(["updated", "up-to-date"]).toContain(resA.status);
    expect(["updated", "up-to-date"]).toContain(resB.status);
    expect(mA.port().revision).toBe(BUILTIN_CURATED_CATALOG.catalogRevision);
    expect(mB.port().revision).toBe(BUILTIN_CURATED_CATALOG.catalogRevision);
  });

  it("R2 F3: rejects unsigned valid-schema active-catalog.json and rejects post-TUF valid-JSON tampering on cold restart", async () => {
    // 1. Unsigned valid-schema active-catalog.json in empty storeDir (no TUF root) MUST be rejected
    const unsignedHome = await makeTempDir("zhixing-tuf-unsigned-");
    const unsignedStore = resolveCatalogStoreDir(unsignedHome);
    await fs.mkdir(unsignedStore, { recursive: true });
    const fakeCatalog: CuratedCatalogBundle = {
      ...structuredClone(BUILTIN_CURATED_CATALOG),
      catalogRevision: "unsigned-fixture",
    };
    await fs.writeFile(
      resolveActiveCatalogPath(unsignedStore),
      JSON.stringify(fakeCatalog, null, 2),
      "utf8",
    );
    const unsignedMgr = new ModelCatalogManager({ homeDir: unsignedHome, repository: null });
    await unsignedMgr.initialize();
    expect(unsignedMgr.status().source).toBe("bundled");
    expect(unsignedMgr.status().activeRevision).toBe(BUILTIN_CURATED_CATALOG.catalogRevision);
    expect(unsignedMgr.status().activeRevision).not.toBe("unsigned-fixture");

    // 2. After real Ed25519 TUF acceptance, tampering active-catalog.json with another VALID-SCHEMA JSON MUST be rejected
    const repoDir = await makeTempDir("zhixing-tuf-tamper-repo-");
    const tamperHome = await makeTempDir("zhixing-tuf-tamper-home-");
    const keys = generateTufFourRoleKeySet();
    const signedR1: CuratedCatalogBundle = {
      ...structuredClone(BUILTIN_CURATED_CATALOG),
      catalogRevision: "signed-r1",
    };
    const pub1 = await publishTufCatalogRepository({
      outputDir: repoDir,
      catalog: signedR1,
      keys,
    });
    const { baseUrl } = await serveStaticRepo(repoDir);
    const repoCfg = {
      metadataBaseUrl: `${baseUrl}/metadata`,
      targetsBaseUrl: `${baseUrl}/targets`,
      targetPath: "catalog-v1.json",
      bootstrapRootBytes: pub1.rootBytes,
      network: { proxy: "direct" as const, allowPrivateOrigin: true },
    };
    const mgr1 = new ModelCatalogManager({ homeDir: tamperHome, repository: repoCfg });
    await mgr1.initialize();
    const res1 = await mgr1.refresh({ force: true });
    expect(res1.status).toBe("updated");
    expect(mgr1.status().activeRevision).toBe("signed-r1");

    // Tamper active-catalog.json with valid-schema JSON claiming a different revision & maxOutputTokens
    const tamperedValidJson: CuratedCatalogBundle = {
      ...structuredClone(signedR1),
      catalogRevision: "tampered-valid-json",
      models: signedR1.models.map((m, idx) => (idx === 0 ? { ...m, maxOutputTokens: 999_999 } : m)),
    };
    await fs.writeFile(
      resolveActiveCatalogPath(mgr1.storeDir),
      JSON.stringify(tamperedValidJson, null, 2),
      "utf8",
    );

    // Cold restart MUST reject tampered valid JSON and fall back cleanly while preserving TUF rootVersion=1
    const mgr2 = new ModelCatalogManager({ homeDir: tamperHome, repository: repoCfg });
    await mgr2.initialize();
    expect(mgr2.status().activeRevision).not.toBe("tampered-valid-json");
    expect(mgr2.status().source).toBe("bundled");
    expect(mgr2.status().rootVersion).toBe(1);
  });

  it("R2 F1: binds official repository by default, loads controlled repository-source.json, and runs upstream collection + renewal-due checks", async () => {
    // 1. Zero-arg ModelCatalogManager({ homeDir }) binds official repository by default
    const defaultHome = await makeTempDir("zhixing-tuf-default-repo-");
    const defaultMgr = new ModelCatalogManager({ homeDir: defaultHome });
    await defaultMgr.initialize();
    expect(defaultMgr.status().repositoryConfigured).toBe(true);
    expect(defaultMgr.isRefreshDue()).toBe(true);
    expect(DEFAULT_OFFICIAL_CATALOG_REPOSITORY.targetPath).toBe("catalog-v1.json");

    // 2. Controlled <storeDir>/repository-source.json binds zero-arg manager to a signed repo cleanly
    const repoDir = await makeTempDir("zhixing-tuf-cfg-repo-");
    const cfgHome = await makeTempDir("zhixing-tuf-cfg-home-");
    const keys = generateTufFourRoleKeySet();
    const r2Catalog: CuratedCatalogBundle = {
      ...structuredClone(BUILTIN_CURATED_CATALOG),
      catalogRevision: "2026.11.20-controlled-r2",
    };
    const pub = await publishTufCatalogRepository({
      outputDir: repoDir,
      catalog: r2Catalog,
      keys,
      timestampExpiresHours: 2, // near expiry for due check
    });
    const { baseUrl } = await serveStaticRepo(repoDir);
    const storeDir = resolveCatalogStoreDir(cfgHome);
    await fs.mkdir(storeDir, { recursive: true });
    await fs.writeFile(
      resolveCatalogRepositorySourcePath(storeDir),
      JSON.stringify({
        schemaVersion: 1,
        metadataBaseUrl: `${baseUrl}/metadata`,
        targetsBaseUrl: `${baseUrl}/targets`,
        targetPath: "catalog-v1.json",
        bootstrapRootJson: pub.rootBytes.toString("utf8"),
        network: { proxy: "direct", allowPrivateOrigin: true },
      }),
      "utf8",
    );

    const cfgMgr = new ModelCatalogManager({ homeDir: cfgHome });
    await cfgMgr.initialize();
    expect(cfgMgr.status().repositoryConfigured).toBe(true);
    expect(cfgMgr.isRefreshDue()).toBe(true);
    const dueRefresh = await cfgMgr.checkIfDue();
    expect(dueRefresh.status).toBe("updated");
    expect(cfgMgr.status().source).toBe("trusted-remote");
    expect(cfgMgr.status().activeRevision).toBe("2026.11.20-controlled-r2");
    expect(cfgMgr.isRefreshDue()).toBe(false);

    // 3. Maintenance checkTufRenewalDue accurately flags near-expiry timestamp (2h < 12h threshold)
    const dueReport = await checkTufRenewalDue({
      outputDir: repoDir,
      timestampThresholdHours: 12,
    });
    expect(dueReport.due).toBe(true);
    expect(dueReport.rolesDue).toContain("timestamp");

    // 4. Maintenance collectUpstreamCatalogCandidate fetches local HTTP official-shape API, filters non-chat, preserves recommendations
    const upstreamServer = http.createServer((req, res) => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            data: [
              { id: "deepseek-v5-preview", context_length: 256_000 },
              { id: "deepseek-embed-v1", architecture: { output_modalities: ["embedding"] } },
            ],
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, "127.0.0.1", () => resolve()));
    servers.push(upstreamServer);
    const upPort = (upstreamServer.address() as { port: number }).port;

    const collected = await collectUpstreamCatalogCandidate({
      baseCatalog: BUILTIN_CURATED_CATALOG,
      nextRevision: "2026.11.20-collected-r1",
      sources: [
        {
          presetId: "deepseek",
          adapter: "openai-compatible",
          endpoint: `http://127.0.0.1:${upPort}/v1`,
          auth: { mode: "none" },
          network: { proxy: "direct", allowPrivateOrigin: true },
          evidenceSource: "DeepSeek official API fixture",
        },
      ],
    });
    expect(collected.candidate.models.some((m) => m.id === "deepseek-v5-preview")).toBe(true);
    expect(collected.candidate.models.some((m) => m.id === "deepseek-embed-v1")).toBe(false);
    expect(collected.diff.recommendations).toEqual([]);
    expect(collected.reviewDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(collected.readerCompatibility.compatible).toBe(true);
    expect(collected.diffMarkdown).toContain("deepseek-v5-preview");
  });

  it("R3 R2-2 / R2-3 / R2-4: preserves accepted catalog across all metadata/root/active-swap interruptions, pins default official root, and supports online-only updates & dual-threshold rotation", async () => {
    const repoDir = await makeTempDir("zhixing-tuf-r3-repo-");
    const keysV1 = generateTufFourRoleKeySet();
    const cat = (rev: string): CuratedCatalogBundle => ({
      ...structuredClone(BUILTIN_CURATED_CATALOG),
      catalogRevision: rev,
    });

    // Publish initial v1 repository (revision A)
    const pubA = await publishTufCatalogRepository({
      outputDir: repoDir,
      catalog: cat("r3-catalog-A"),
      keys: keysV1,
    });
    const { baseUrl } = await serveStaticRepo(repoDir);
    const repoCfg = {
      metadataBaseUrl: `${baseUrl}/metadata`,
      targetsBaseUrl: `${baseUrl}/targets`,
      targetPath: pubA.targetPath,
      bootstrapRootBytes: pubA.rootBytes,
      network: { proxy: "direct" as const, allowPrivateOrigin: true },
    };

    // Prepare online-only keys (NO root private key!) and publish B via publishTufCatalogUpdate
    const onlineKeysV1 = {
      timestamp: keysV1.timestamp,
      snapshot: keysV1.snapshot,
      targets: keysV1.targets,
    };

    // Matrix of ALL mid-update interruption boundaries:
    // 1. Before snapshot v2 write (after timestamp v2 persisted)
    // 2. Before targets v2 write (after snapshot v2 persisted)
    // 3. Before active-catalog.json write (after active-catalog.tuf-targets.json persisted -> recovers via previous!)
    const boundaries = [
      { stage: "metadata" as const, name: "snapshot", expectSource: "trusted-remote" as const, expectTs: 2, expectSnap: 1 },
      { stage: "metadata" as const, name: "targets", expectSource: "trusted-remote" as const, expectTs: 2, expectSnap: 2 },
      { stage: "active" as const, name: "active-catalog.json", expectSource: "recovered-previous" as const, expectTs: 2, expectSnap: 2 },
    ];

    for (const boundary of boundaries) {
      const storeDir = await makeTempDir(`zhixing-tuf-r3-${boundary.name}-`);
      // Start fresh repo at A (v1)
      const caseRepoDir = await makeTempDir(`zhixing-tuf-r3-case-repo-`);
      const casePubA = await publishTufCatalogRepository({
        outputDir: caseRepoDir,
        catalog: cat("r3-catalog-A"),
        keys: keysV1,
      });
      const caseSrv = await serveStaticRepo(caseRepoDir);
      const caseRepo = {
        metadataBaseUrl: `${caseSrv.baseUrl}/metadata`,
        targetsBaseUrl: `${caseSrv.baseUrl}/targets`,
        targetPath: casePubA.targetPath,
        bootstrapRootBytes: casePubA.rootBytes,
        network: { proxy: "direct" as const, allowPrivateOrigin: true },
      };

      let injectFail = false;
      const mgr = new ModelCatalogManager({
        storeDir,
        repository: caseRepo,
        writeInterceptor(stage, name) {
          if (injectFail && stage === boundary.stage && name === boundary.name) {
            throw new Error(`injected failure at ${stage}:${name}`);
          }
        },
      });
      await mgr.initialize();
      const initRes = await mgr.refresh({ force: true });
      expect(initRes.activeRevision).toBe("r3-catalog-A");
      expect(mgr.status().source).toBe("trusted-remote");

      // R2-3: default official manager on the SAME storeDir MUST reject foreign repo A and fall back to bundled!
      const defaultMgr = new ModelCatalogManager({ storeDir });
      await defaultMgr.initialize();
      expect(defaultMgr.status().source).toBe("bundled");
      expect(defaultMgr.status().activeRevision).toBe(BUILTIN_CURATED_CATALOG.catalogRevision);

      // Publish B using ONLINE-ONLY keys (root stays offline!)
      const pubB = await publishTufCatalogUpdate({
        outputDir: caseRepoDir,
        catalog: cat("r3-catalog-B"),
        keys: onlineKeysV1,
      });
      expect(pubB.timestampVersion).toBe(2);
      expect(pubB.snapshotVersion).toBe(2);
      expect(pubB.targetsVersion).toBe(2);

      // Inject interruption at boundary during update A -> B
      injectFail = true;
      const failed = await mgr.refresh({ force: true });
      expect(failed.status).toBe("failed");
      // Live manager MUST retain intact accepted catalog A (NEVER drop to bundled!)
      expect(failed.activeRevision).toBe("r3-catalog-A");
      expect(mgr.status().source).toBe(boundary.expectSource);

      // Cold restart MUST also retain intact accepted catalog A!
      const coldMgr = new ModelCatalogManager({ storeDir, repository: caseRepo });
      await coldMgr.initialize();
      expect(coldMgr.status().activeRevision).toBe("r3-catalog-A");
      expect(coldMgr.status().source).toBe(boundary.expectSource);

      // Trust metadata MUST stay at high-water mark (NO rollback!)
      const tsVer = validateTufMetadataBytes(
        await fs.readFile(path.join(resolveTufMetadataDir(storeDir), "timestamp.json")),
        "timestamp",
      ).version;
      const snapVer = validateTufMetadataBytes(
        await fs.readFile(path.join(resolveTufMetadataDir(storeDir), "snapshot.json")),
        "snapshot",
      ).version;
      expect(tsVer).toBe(boundary.expectTs);
      expect(snapVer).toBe(boundary.expectSnap);

      // Later retry after interruption clears cleanly accepts B!
      injectFail = false;
      const retried = await mgr.refresh({ force: true });
      expect(retried.status).toBe("updated");
      expect(retried.activeRevision).toBe("r3-catalog-B");
      expect(mgr.status().source).toBe("trusted-remote");
    }

    // 4. Root rotation mid-flight interruption (root v1 -> v2 written with rotated online keys, interrupted before timestamp v2 write!)
    const rotStore = await makeTempDir("zhixing-tuf-r3-rot-");
    let injectRotInterrupt = false;
    const rotMgr = new ModelCatalogManager({
      storeDir: rotStore,
      repository: repoCfg,
      writeInterceptor(stage, name) {
        if (injectRotInterrupt && stage === "metadata" && name === "timestamp") {
          throw new Error("injected failure right after root v2 rotation");
        }
      },
    });
    await rotMgr.initialize();
    const rotInit = await rotMgr.refresh({ force: true });
    expect(rotInit.activeRevision).toBe("r3-catalog-A");

    const keysV2 = generateTufFourRoleKeySet();
    const rotated = await rotateTufRoot({
      outputDir: repoDir,
      previousRootKey: keysV1.root,
      nextKeys: keysV2,
    });
    expect(rotated.nextRootVersion).toBe(2);
    expect(rotated.targetSha256Unchanged).toBe(pubA.targetSha256);

    injectRotInterrupt = true;
    const rotFailed = await rotMgr.refresh({ force: true });
    expect(rotFailed.status).toBe("failed");
    // Root v2 was persisted, timestamp v2 failed -> A MUST STILL BE PRESERVED via verified continuous v1->v2 root chain!
    expect(rotFailed.activeRevision).toBe("r3-catalog-A");
    expect(rotMgr.status().rootVersion).toBe(2);

    const rotCold = new ModelCatalogManager({ storeDir: rotStore, repository: repoCfg });
    await rotCold.initialize();
    expect(rotCold.status().activeRevision).toBe("r3-catalog-A");
    expect(rotCold.status().source).toBe("trusted-remote");
    expect(rotCold.status().rootVersion).toBe(2);

    // Retry completes cleanly under v2 root and accepts subsequent online update C!
    injectRotInterrupt = false;
    await publishTufCatalogUpdate({
      outputDir: repoDir,
      catalog: cat("r3-catalog-C"),
      keys: { timestamp: keysV2.timestamp, snapshot: keysV2.snapshot, targets: keysV2.targets },
    });
    const rotRetry = await rotMgr.refresh({ force: true });
    expect(rotRetry.status).toBe("updated");
    expect(rotRetry.activeRevision).toBe("r3-catalog-C");
    expect(rotRetry.rootVersion).toBe(2);

    // 5. Checked-in single-source catalog/v1/curated-catalog.json sync verification
    const repoRoot = path.resolve(import.meta.dirname, "../../../..");
    const checkedInRaw = JSON.parse(
      await fs.readFile(path.join(repoRoot, "catalog/v1/curated-catalog.json"), "utf8"),
    );
    expect(checkedInRaw).toEqual(BUILTIN_CURATED_CATALOG);
    expect(verifyCatalogCompatibilityForReader(checkedInRaw).compatible).toBe(true);
  }, 20_000);

  it("R4 R3-2: surfaces preset discovery/auth/network/quirks semantic diffs and rejects stale/tampered approval digests across baseline or candidate changes", () => {
    const base = structuredClone(BUILTIN_CURATED_CATALOG);

    // 1. Toggling OpenRouter discovery.authoritativeNativeFacts (false -> true) MUST appear in diff + markdown + warning!
    const toggledOpenRouter: CuratedCatalogBundle = {
      ...structuredClone(base),
      presets: base.presets.map((p) =>
        p.id === "openrouter"
          ? {
              ...p,
              defaultHeaderName: "X-Custom-OR",
              defaultNetwork: { proxy: "direct" as const },
              discovery: { ...p.discovery, authoritativeNativeFacts: true },
            }
          : p,
      ),
    };
    const presetDiff = diffCuratedCatalogs(base, toggledOpenRouter);
    expect(presetDiff.presets.length).toBe(1);
    const orFields = presetDiff.presets[0]!.fields.map((f) => f.field);
    expect(orFields).toContain("discovery.authoritativeNativeFacts");
    expect(orFields).toContain("defaultHeaderName");
    expect(orFields).toContain("defaultNetwork.proxy");
    expect(presetDiff.warnings.some((w) => w.includes("authoritativeNativeFacts"))).toBe(true);
    const presetMd = formatCatalogDiffMarkdown(presetDiff);
    expect(presetMd).toContain("discovery.authoritativeNativeFacts");
    expect(presetMd).not.toBe(formatCatalogDiffMarkdown(diffCuratedCatalogs(base, base)));

    // 2. Cryptographic review binding binds BOTH actual baseline AND actual candidate + diff!
    const candidateA: CuratedCatalogBundle = {
      ...structuredClone(base),
      catalogRevision: "2026.11.20-r4-candA",
      models: base.models.map((m, i) => (i === 0 ? { ...m, maxOutputTokens: 384_000 } : m)),
    };
    const reviewA = computeCatalogReviewBinding(base, candidateA);
    expect(reviewA.binding.approvalDigest).toMatch(/^[0-9a-f]{64}$/u);

    // Exact match passes
    expect(
      verifyCatalogReviewBinding({
        baseCatalog: base,
        candidateCatalog: candidateA,
        expectedApprovalDigest: reviewA.binding.approvalDigest,
      }).binding.approvalDigest,
    ).toBe(reviewA.binding.approvalDigest);

    // Tampering candidate A -> B (384000 -> 384001) with A's approval MUST FAIL CLOSED!
    const candidateB: CuratedCatalogBundle = {
      ...structuredClone(candidateA),
      models: candidateA.models.map((m, i) => (i === 0 ? { ...m, maxOutputTokens: 384_001 } : m)),
    };
    expect(() =>
      verifyCatalogReviewBinding({
        baseCatalog: base,
        candidateCatalog: candidateB,
        expectedApprovalDigest: reviewA.binding.approvalDigest,
      }),
    ).toThrow(/不匹配|不一致/u);

    // Baseline drift (base -> driftedBase) with A's approval MUST ALSO FAIL CLOSED!
    const driftedBase: CuratedCatalogBundle = {
      ...structuredClone(base),
      catalogRevision: "2026.11.20-drifted-base",
    };
    expect(() =>
      verifyCatalogReviewBinding({
        baseCatalog: driftedBase,
        candidateCatalog: candidateA,
        expectedApprovalDigest: reviewA.binding.approvalDigest,
      }),
    ).toThrow(/不匹配|漂移/u);
  });

  it("R5: prevents --base from bypassing actual repo target on existing repos and fails closed on missing/corrupted target", async () => {
    const repoRoot = path.resolve(import.meta.dirname, "../../../..");
    const maintCli = path.join(repoRoot, "scripts/catalog-maintenance.mjs");
    const runMaint = (args: string[], env: Record<string, string> = {}) =>
      spawnSync(process.execPath, [maintCli, ...args], {
        cwd: repoRoot,
        env: { ...process.env, ...env },
        encoding: "utf8",
        timeout: 30_000,
      });

    const workDir = await makeTempDir("zhixing-tuf-r5-base-");
    const repoDir = path.join(workDir, "repo");
    const keysDir = path.join(workDir, "keys");
    const baseFile = path.join(workDir, "A.json");
    await fs.writeFile(baseFile, JSON.stringify(BUILTIN_CURATED_CATALOG, null, 2) + "\n", "utf8");

    const init = runMaint(["init-ceremony", repoDir, keysDir, "--catalog", baseFile]);
    expect(init.status).toBe(0);
    const initJson = JSON.parse(init.stdout) as { generatedFiles: { onlineKeysForCiSecret: string } };
    const onlineKeys = await fs.readFile(initJson.generatedFiles.onlineKeysForCiSecret, "utf8");

    // Candidate B (384000) reviewed against A, and Candidate C (384001) reviewed & published against A
    const candB = structuredClone(BUILTIN_CURATED_CATALOG);
    candB.catalogRevision = "2026.11.20-r5-B";
    candB.models[0] = { ...candB.models[0]!, maxOutputTokens: 384_000 };
    const candBFile = path.join(workDir, "B.json");
    await fs.writeFile(candBFile, JSON.stringify(candB, null, 2) + "\n", "utf8");
    const reviewBDir = path.join(workDir, "reviewB");
    expect(runMaint(["review", baseFile, candBFile, "--out-dir", reviewBDir]).status).toBe(0);

    const candC = structuredClone(BUILTIN_CURATED_CATALOG);
    candC.catalogRevision = "2026.11.20-r5-C";
    candC.models[0] = { ...candC.models[0]!, maxOutputTokens: 384_001 };
    const candCFile = path.join(workDir, "C.json");
    await fs.writeFile(candCFile, JSON.stringify(candC, null, 2) + "\n", "utf8");
    const reviewC = JSON.parse(runMaint(["review", baseFile, candCFile]).stdout) as {
      binding: { approvalDigest: string };
    };
    const pubC = runMaint(
      [
        "publish-local",
        candCFile,
        repoDir,
        "--keys-env",
        "CATALOG_TUF_ONLINE_KEYS_JSON",
        "--approved-review",
        reviewC.binding.approvalDigest,
      ],
      { CATALOG_TUF_ONLINE_KEYS_JSON: onlineKeys },
    );
    expect(pubC.status).toBe(0);
    const targetAfterC = await fs.readFile(path.join(repoDir, "targets/catalog-v1.json"), "utf8");

    // 1. Replaying old B approval with --base A.json MUST FAIL CLOSED and keep C untouched!
    const replayWithOldBase = runMaint(
      [
        "publish-local",
        candBFile,
        repoDir,
        "--base",
        baseFile,
        "--keys-env",
        "CATALOG_TUF_ONLINE_KEYS_JSON",
        "--approved-review",
        path.join(reviewBDir, "review-digest.txt"),
      ],
      { CATALOG_TUF_ONLINE_KEYS_JSON: onlineKeys },
    );
    expect(replayWithOldBase.status).not.toBe(0);
    expect(replayWithOldBase.stderr).toContain("--base");
    expect(await fs.readFile(path.join(repoDir, "targets/catalog-v1.json"), "utf8")).toBe(targetAfterC);

    // 2. Consistent --base C.json with freshly reviewed C -> D succeeds!
    const candD = structuredClone(candC);
    candD.catalogRevision = "2026.11.20-r5-D";
    const candDFile = path.join(workDir, "D.json");
    await fs.writeFile(candDFile, JSON.stringify(candD, null, 2) + "\n", "utf8");
    const reviewD = JSON.parse(runMaint(["review", candCFile, candDFile]).stdout) as {
      binding: { approvalDigest: string };
    };
    const pubD = runMaint(
      [
        "publish-local",
        candDFile,
        repoDir,
        "--base",
        candCFile,
        "--keys-env",
        "CATALOG_TUF_ONLINE_KEYS_JSON",
        "--approved-review",
        reviewD.binding.approvalDigest,
      ],
      { CATALOG_TUF_ONLINE_KEYS_JSON: onlineKeys },
    );
    expect(pubD.status).toBe(0);

    // 3. Corrupted or missing targets/catalog-v1.json in an ALREADY-INITIALIZED repo MUST FAIL CLOSED even with --base!
    await fs.writeFile(path.join(repoDir, "targets/catalog-v1.json"), "{corrupted", "utf8");
    const corruptAttempt = runMaint(
      [
        "publish-local",
        candBFile,
        repoDir,
        "--base",
        baseFile,
        "--keys-env",
        "CATALOG_TUF_ONLINE_KEYS_JSON",
        "--approved-review",
        path.join(reviewBDir, "review-digest.txt"),
      ],
      { CATALOG_TUF_ONLINE_KEYS_JSON: onlineKeys },
    );
    expect(corruptAttempt.status).not.toBe(0);

    await fs.unlink(path.join(repoDir, "targets/catalog-v1.json"));
    const missingAttempt = runMaint(
      [
        "publish-local",
        candBFile,
        repoDir,
        "--base",
        baseFile,
        "--keys-env",
        "CATALOG_TUF_ONLINE_KEYS_JSON",
        "--approved-review",
        path.join(reviewBDir, "review-digest.txt"),
      ],
      { CATALOG_TUF_ONLINE_KEYS_JSON: onlineKeys },
    );
    expect(missingAttempt.status).not.toBe(0);

    // 4. Fresh uninitialized directory still allows --base A.json for initial creation
    const freshRepoDir = path.join(workDir, "fresh-repo");
    const freshInit = runMaint([
      "publish-local",
      candBFile,
      freshRepoDir,
      "--base",
      baseFile,
      "--approved-review",
      path.join(reviewBDir, "review-digest.txt"),
    ]);
    expect(freshInit.status).toBe(0);
  }, 20_000);
});
