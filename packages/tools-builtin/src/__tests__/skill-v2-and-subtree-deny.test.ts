import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTempDir } from "@zhixing-ai/test-utils";
import {
  bindPermissionRuleExecutionSource,
  PermissionStore,
  SecurityPipeline,
  toPermissionContext,
  ToolFilePathExtractor,
} from "@zhixing-ai/core/security";
import {
  SkillCatalogLoadApplicationService,
  SkillCatalogSaveApplicationService,
  SkillPackageReadError,
  type SkillCatalogAdmissionApplication,
  type SkillCatalogAdmissionRequest,
  type SkillCatalogLoadCorrectnessPort,
  type SkillCatalogSaveCorrectnessPort,
  type SkillCatalogSaveOverlayRecord,
} from "@zhixing-ai/core/skills/catalog";
import { encodeSkillPackageArchive } from "@zhixing-ai/core/skills/archive";
import type { ArtifactRef, Digest } from "@zhixing-ai/core/contracts";
import { byteDigest } from "@zhixing-ai/core/protocol";
import { createGlobTool } from "../glob.js";
import { createGrepTool } from "../grep.js";
import { createGrepSearchPlan } from "../grep/plan.js";
import { nodeGrepSearchExecutor } from "../grep/node-executor.js";
import { isRipgrepAvailable, ripgrepSearchExecutor } from "../grep/ripgrep-executor.js";
import {
  createAdmitSkillTool,
  createSkillAdmitTool,
  createSkillMaterializeTool,
  createSkillReadTool,
  createSkillSaveTool,
  createSystemOnlySkillReadTool,
} from "../skill.js";

function makeRef(bytes: Uint8Array | string): ArtifactRef {
  const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
  const digest = byteDigest(buf) as Digest;
  return { digest, bytes: buf.byteLength };
}

describe("Wave 5.2 · glob & grep 子树 /trust deny 过滤（免配额）", () => {
  it("glob 与 grep (node + ripgrep) 省略 path 时自动过滤 secret-sub/** 命中且零泄漏", async () => {
    const dir = await createTempDir("subtree-deny");
    const allowedFile = path.join(dir, "public", "notes.txt");
    const deniedFile = path.join(dir, "secret-sub", "nested", "secret.txt");
    await fs.mkdir(path.dirname(allowedFile), { recursive: true });
    await fs.mkdir(path.dirname(deniedFile), { recursive: true });
    await fs.writeFile(allowedFile, "NEEDLE_TOKEN public ok\n", "utf8");
    await fs.writeFile(deniedFile, "NEEDLE_TOKEN top secret content\n", "utf8");

    const filePathExtractor = ToolFilePathExtractor.fromTools([createGlobTool(), createGrepTool()]);
    const contextId = toPermissionContext({ kind: "workspace", hash: "ws-subtree" });
    const store = new PermissionStore({ rootDir: null });
    await store.create(
      contextId,
      PermissionStore.createRule({
        pattern: { tool: "glob", argument: "secret-sub/**" },
        decision: "deny",
        scope: "context",
        contextId,
      }),
    );
    await store.create(
      contextId,
      PermissionStore.createRule({
        pattern: { tool: "grep", argument: "secret-sub/**" },
        decision: "deny",
        scope: "context",
        contextId,
      }),
    );
    const pipeline = new SecurityPipeline({
      trustContext: { kind: "workspace", dir },
      sessionType: "interactive",
      permissionRuleSource: bindPermissionRuleExecutionSource(store, contextId),
      filePathExtractor,
    });

    const authorizeFor =
      (toolName: string) =>
      async ({ path: targetPath, access }: { readonly path: string; readonly access: "read" | "write" }) => {
        const res = await pipeline.evaluateNormalizedFileAccess({
          toolName,
          path: targetPath,
          access,
          workingDirectory: dir,
        });
        if (!res.allowed) {
          const err = new Error(`blocked: ${res.reason}`);
          err.name = "SecurityBlockError";
          throw err;
        }
      };

    // glob 省略 path：只返回 public/notes.txt
    const globRes = await createGlobTool().call(
      { pattern: "**/*.txt" },
      { workingDirectory: dir, authorizeFileAccess: authorizeFor("glob") },
    );
    expect(globRes.isError).toBeUndefined();
    expect(globRes.content).toContain("public/notes.txt");
    expect(globRes.content).not.toContain("secret-sub");
    expect(globRes.content).not.toContain("secret.txt");

    // grep 工具入口省略 path
    const grepRes = await createGrepTool().call(
      { pattern: "NEEDLE_TOKEN" },
      { workingDirectory: dir, authorizeFileAccess: authorizeFor("grep") },
    );
    expect(grepRes.isError).toBeUndefined();
    expect(grepRes.content).toContain("public");
    expect(grepRes.content).not.toContain("secret-sub");
    expect(grepRes.content).not.toContain("top secret");

    // node 执行器直接检查 + 单文件直查
    const dirPlan = await createGrepSearchPlan({
      workingDirectory: dir,
      pattern: "NEEDLE_TOKEN",
      searchPath: dir,
      outputMode: "content",
      regexDialect: "line-regexp",
      caseSensitivity: "sensitive",
      contextLines: 0,
      maxResultChars: 10_000,
      maxLineChars: 500,
    });
    expect(dirPlan.ok).toBe(true);
    if (dirPlan.ok) {
      const nodeRes = await nodeGrepSearchExecutor.search(dirPlan.plan, {
        authorizeFileAccess: authorizeFor("grep"),
      });
      expect(nodeRes.ok).toBe(true);
      if (nodeRes.ok) {
        expect(nodeRes.result.files.map((f) => f.displayPath)).toEqual(["public/notes.txt"]);
      }

      if (await isRipgrepAvailable()) {
        const rgRes = await ripgrepSearchExecutor.search(dirPlan.plan, {
          authorizeFileAccess: authorizeFor("grep"),
        });
        expect(rgRes.ok).toBe(true);
        if (rgRes.ok) {
          expect(rgRes.result.files.map((f) => f.displayPath)).toEqual(["public/notes.txt"]);
        }
      }
    }

    const singleFilePlan = await createGrepSearchPlan({
      workingDirectory: dir,
      pattern: "NEEDLE_TOKEN",
      searchPath: deniedFile,
      outputMode: "content",
      regexDialect: "line-regexp",
      caseSensitivity: "sensitive",
      contextLines: 0,
      maxResultChars: 10_000,
      maxLineChars: 500,
    });
    expect(singleFilePlan.ok).toBe(true);
    if (singleFilePlan.ok) {
      const singleNode = await nodeGrepSearchExecutor.search(singleFilePlan.plan, {
        authorizeFileAccess: authorizeFor("grep"),
      });
      expect(singleNode.ok && singleNode.result.files).toEqual([]);
    }
  });
});

describe("Wave 5.2 · skill_read / skill_save / skill_admit / skill_materialize", () => {
  it("skill_read systemOnly 拒 user:* 并写 0 usage；正常版严格 <= 12288 B", async () => {
    const rootDoc = "---\nname: sys-check\ndescription: sys check\n---\nCheck body";
    const archive = encodeSkillPackageArchive([
      { path: "SKILL.md", content: "---\nname: user-one\ndescription: u1\n---\nRoot", kind: "root" },
      { path: "refs/big.txt", content: "A".repeat(15_000), kind: "resource" },
    ]);
    const contentRef = makeRef(rootDoc);
    const pkgRef = makeRef(archive.bytes);
    const usages: unknown[] = [];

    const loadPort: SkillCatalogLoadCorrectnessPort = {
      async readScope(skillId) {
        if (skillId === "user-one") {
          return {
            kind: "assignment",
            issuedAt: "2026-11-26T00:00:00.000Z",
            overlay: [],
            entry: {
              id: "user-one",
              name: "user-one",
              description: "u1",
              source: "own",
              mode: "main",
              pinned: false,
              disabled: false,
              createdAt: "2026-11-26T00:00:00.000Z",
              usage: null,
              contentRef,
              revision: 2,
              digest: contentRef.digest,
              visibility: { modelAutoIndex: true, userSlashCommand: true },
              packageRef: pkgRef,
            },
          };
        }
        return { kind: "builtin-only" };
      },
      async readContent() {
        return rootDoc;
      },
      async readBytes() {
        return archive.bytes;
      },
      async stageUsage(_opId, mutation) {
        usages.push(mutation);
      },
    };
    const app = new SkillCatalogLoadApplicationService(loadPort);

    const sysTool = createSystemOnlySkillReadTool(app);
    expect(sysTool.isReadOnly).toBe(true);
    expect(sysTool.boundaries).toEqual([{ boundaryType: "app-state", access: "read", dynamic: false }]);
    const denied = await sysTool.call({ id: "user:user-one" }, { workingDirectory: ".", toolCallId: "t1" });
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain("forbidden");
    expect(usages).toHaveLength(0);

    const sysOk = await sysTool.call({ id: "system:提炼技能" }, { workingDirectory: ".", toolCallId: "t2" });
    expect(sysOk.isError).toBe(false);
    expect(usages).toHaveLength(0);

    const fullTool = createSkillReadTool(app);
    const page1 = await fullTool.call({ id: "user:user-one" }, { workingDirectory: ".", toolCallId: "t3" });
    expect(page1.isError).toBe(false);
    expect(Buffer.byteLength(page1.content, "utf8")).toBeLessThanOrEqual(12_288);
    expect(usages).toHaveLength(1);
  });

  it("skill_save confirm 前预检与提交前双拦截并发 A->B，且仅改根保留附件", async () => {
    const blobs = new Map<string, Uint8Array>();
    const texts = new Map<string, string>();
    const initArchive = encodeSkillPackageArchive([
      { path: "SKILL.md", content: "---\nname: deploy\ndescription: v1\n---\nOld body", kind: "root" },
      { path: "refs/checklist.md", content: "- verify backup\n", kind: "resource" },
    ]);
    const pkgRef = makeRef(initArchive.bytes);
    blobs.set(pkgRef.digest, initArchive.bytes);
    const rootRef = makeRef("old");
    texts.set(rootRef.digest, "old");

    let currentRev = 3;
    const staged: unknown[] = [];

    const savePort: SkillCatalogSaveCorrectnessPort = {
      async readCatalogEntry() {
        return null;
      },
      async readCatalogEntryV2() {
        return {
          id: "deploy",
          name: "deploy",
          description: "v1",
          source: "own",
          mode: "main",
          pinned: false,
          disabled: false,
          createdAt: "2026-11-26T00:00:00.000Z",
          usage: null,
          contentRef: rootRef,
          revision: currentRev,
          digest: rootRef.digest,
          visibility: { modelAutoIndex: true, userSlashCommand: true },
          packageRef: pkgRef,
        };
      },
      async readOverlay(): Promise<readonly SkillCatalogSaveOverlayRecord[]> {
        return [];
      },
      requestIdentityFor(opId) {
        return opId;
      },
      async putContent(doc) {
        const ref = makeRef(doc);
        texts.set(ref.digest, doc);
        return ref;
      },
      async putBytes(bytes) {
        const ref = makeRef(bytes);
        blobs.set(ref.digest, bytes);
        return ref;
      },
      async readContent(ref) {
        return texts.get(ref.digest) ?? "";
      },
      async readBytes(ref) {
        return blobs.get(ref.digest)!;
      },
      async stage() {},
      async stageV2(_opId, mutation) {
        staged.push(mutation);
      },
      assignmentIssuedAt() {
        return "2026-11-26T00:00:00.000Z";
      },
    };

    const app = new SkillCatalogSaveApplicationService(savePort);
    const saveTool = createSkillSaveTool(app, "main");
    expect(saveTool.requiresExplicitConfirmation).toBe(true);

    // 1. 读后确认前已变更 A(3) -> B(4)：prepareConfirmation 返回 earlyReturn，不弹确认卡
    currentRev = 4;
    const stalePre = await saveTool.prepareConfirmation!(
      { name: "deploy", description: "v2", body: "New body", expectedRevision: 3 },
      { workingDirectory: ".", toolCallId: "op-1" },
    );
    expect(stalePre.earlyReturn?.isError).toBe(true);
    expect(stalePre.earlyReturn?.content).toContain("revision-conflict");

    // 2. 预检基于 revision 4 通过，displayInput 完整携带保留的 refs/checklist.md
    const okPre = await saveTool.prepareConfirmation!(
      { name: "deploy", description: "v2", body: "New body", expectedRevision: 4 },
      { workingDirectory: ".", toolCallId: "op-2" },
    );
    expect(okPre.earlyReturn).toBeUndefined();
    expect(okPre.displayInput).toMatchObject({
      name: "deploy",
      baselineVersion: initArchive.packageVersion,
      baselineRevision: 4,
      resources: [expect.objectContaining({ path: "refs/checklist.md", content: "- verify backup\n" })],
    });

    // 3. 确认等待期间发生并发变更 4 -> 5：call() 二次拦截 revision-conflict，0 落盘
    currentRev = 5;
    const conflictCall = await saveTool.call(
      { name: "deploy", description: "v2", body: "New body", expectedRevision: 4 },
      { workingDirectory: ".", toolCallId: "op-2" },
    );
    expect(conflictCall.isError).toBe(true);
    expect(conflictCall.content).toContain("revision-conflict");
    expect(staged).toHaveLength(0);

    // 4. 用最新 expectedRevision 5 保存，省略 resources -> 保留既有附件
    const savedCall = await saveTool.call(
      { name: "deploy", description: "v2", body: "New body", expectedRevision: 5 },
      { workingDirectory: ".", toolCallId: "op-3" },
    );
    expect(savedCall.isError).toBe(false);
    expect(staged).toHaveLength(1);
  });

  it("skill_admit / admit_skill 透传 authorizeMemberRead 且脱敏回执零候选泄漏", async () => {
    const requests: SkillCatalogAdmissionRequest[] = [];
    const seenPaths: string[] = [];
    const admissionApp: SkillCatalogAdmissionApplication = {
      async admit(req) {
        requests.push(req);
        if (req.authorizeMemberRead) {
          await req.authorizeMemberRead("/cand/refs/secret.md");
        }
        return {
          kind: "needs-confirm",
          admissionToken: "tok-safe-123",
          reason: "需要本人在宿主确认表面审阅完整审查报告",
          threats: [],
        };
      },
    };

    for (const tool of [createSkillAdmitTool(admissionApp, "main"), createAdmitSkillTool(admissionApp, "main")]) {
      expect(tool.filePathArgumentKeys).toEqual(["path"]);
      const res = await tool.call(
        { path: "/cand" },
        {
          workingDirectory: ".",
          toolCallId: `op-${tool.name}`,
          authorizeFileAccess: async ({ path: p }) => {
            seenPaths.push(p);
          },
        },
      );
      expect(res.isError).toBe(false);
      expect(res.content).toContain("tok-safe-123");
      expect(res.content).not.toContain("secret.md");
    }
    expect(seenPaths).toEqual(["/cand/refs/secret.md", "/cand/refs/secret.md"]);
  });

  it("skill_materialize 先校版本再建目录写入，支持 wx 拒覆盖与 overwrite 原子替换", async () => {
    const dir = await createTempDir("materialize");
    const archive = encodeSkillPackageArchive([
      { path: "SKILL.md", content: "---\nname: m\ndescription: d\n---\nBody", kind: "root" },
      { path: "scripts/run.sh", content: "#!/bin/sh\necho hi\n", kind: "resource" },
    ]);
    let disabled = true;
    const loadApp = new SkillCatalogLoadApplicationService({
      async readScope() {
        return {
          kind: "assignment",
          issuedAt: "2026-11-26T00:00:00.000Z",
          overlay: [],
          entry: {
            id: "m",
            name: "m",
            description: "d",
            source: "own",
            mode: "main",
            pinned: false,
            disabled,
            createdAt: "2026-11-26T00:00:00.000Z",
            usage: null,
            contentRef: makeRef("x"),
            revision: 1,
            digest: makeRef("x").digest,
            visibility: { modelAutoIndex: true, userSlashCommand: true },
            packageRef: makeRef(archive.bytes),
          },
        };
      },
      async readContent() {
        return "";
      },
      async readBytes() {
        return archive.bytes;
      },
      async stageUsage() {},
    });

    const tool = createSkillMaterializeTool(loadApp);
    const outFile = path.join(dir, "never-created", "run.sh");

    // 1. disabled -> skill-disabled，不建目录
    const disabledRes = await tool.call(
      { id: "user:m", resource: "scripts/run.sh", path: outFile, expectedVersion: archive.packageVersion },
      { workingDirectory: dir },
    );
    expect(disabledRes.isError).toBe(true);
    await expect(fs.access(path.dirname(outFile))).rejects.toThrow();

    // 2. latest / version-mismatch -> 0 字节落盘
    disabled = false;
    const latestRes = await tool.call(
      { id: "user:m", resource: "scripts/run.sh", path: outFile, expectedVersion: "latest" },
      { workingDirectory: dir },
    );
    expect(latestRes.isError).toBe(true);

    const mismatchRes = await tool.call(
      { id: "user:m", resource: "scripts/run.sh", path: outFile, expectedVersion: "sha256:bad" },
      { workingDirectory: dir },
    );
    expect(mismatchRes.isError).toBe(true);
    expect(JSON.parse(mismatchRes.content)).toMatchObject({ error: "version-mismatch" });
    await expect(fs.access(path.dirname(outFile))).rejects.toThrow();

    // 3. 精确版本 -> 成功写入，再次默认 wx 拒覆盖，overwrite: true 原子替换
    const okRes = await tool.call(
      { id: "user:m", resource: "scripts/run.sh", path: outFile, expectedVersion: archive.packageVersion },
      { workingDirectory: dir },
    );
    expect(okRes.isError).toBe(false);
    expect(await fs.readFile(outFile, "utf8")).toBe("#!/bin/sh\necho hi\n");

    const dupRes = await tool.call(
      { id: "user:m", resource: "scripts/run.sh", path: outFile, expectedVersion: archive.packageVersion },
      { workingDirectory: dir },
    );
    expect(dupRes.isError).toBe(true);

    const overwriteRes = await tool.call(
      { id: "user:m", resource: "scripts/run.sh", path: outFile, expectedVersion: archive.packageVersion, overwrite: true },
      { workingDirectory: dir },
    );
    expect(overwriteRes.isError).toBe(false);
    expect(await fs.readFile(outFile, "utf8")).toBe("#!/bin/sh\necho hi\n");

    // 4. workspace-required & workspace-escape（相对越界、绝对外部路径、符号链接/junction 目录逃逸）均 0 落盘拒绝
    const outsideDir = await createTempDir("materialize-outside");
    const outsideAbs = path.join(outsideDir, "escaped.sh");
    const relEscapeRes = await tool.call(
      { id: "user:m", resource: "scripts/run.sh", path: "../rel-escape.sh", expectedVersion: archive.packageVersion },
      { workingDirectory: dir },
    );
    expect(relEscapeRes.isError).toBe(true);
    expect(relEscapeRes.content).toContain("workspace-escape");

    const absEscapeRes = await tool.call(
      { id: "user:m", resource: "scripts/run.sh", path: outsideAbs, expectedVersion: archive.packageVersion },
      { workingDirectory: dir },
    );
    expect(absEscapeRes.isError).toBe(true);
    expect(absEscapeRes.content).toContain("workspace-escape");
    await expect(fs.access(outsideAbs)).rejects.toThrow();

    const junctionDir = path.join(dir, "linked-out");
    await fs.symlink(outsideDir, junctionDir, "junction");
    const symEscapeRes = await tool.call(
      { id: "user:m", resource: "scripts/run.sh", path: "linked-out/via-link.sh", expectedVersion: archive.packageVersion },
      { workingDirectory: dir },
    );
    expect(symEscapeRes.isError).toBe(true);
    expect(symEscapeRes.content).toContain("workspace-escape");
    await expect(fs.access(path.join(outsideDir, "via-link.sh"))).rejects.toThrow();

    const wsRequiredApp = new SkillCatalogLoadApplicationService({
      hasAuthorizedWorkspace: () => false,
      async readScope() {
        return { kind: "builtin-only" };
      },
      async readContent() {
        return "";
      },
      async stageUsage() {},
    });
    const wsRequiredTool = createSkillMaterializeTool(wsRequiredApp);
    const wsRequiredRes = await wsRequiredTool.call(
      { id: "system:外部能力接入", resource: "inbound.md", path: "inbound.md", expectedVersion: "v-any" },
      { workingDirectory: dir },
    );
    expect(wsRequiredRes.isError).toBe(true);
    expect(wsRequiredRes.content).toContain("workspace-required");
  });
});
