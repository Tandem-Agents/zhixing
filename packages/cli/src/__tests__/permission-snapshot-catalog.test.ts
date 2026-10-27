import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { AuthorityCacheIntegrity } from "@zhixing/core/authority";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import type { PermissionRule } from "@zhixing/core/security";
import {
  createSignedTrustRuleSnapshot,
  normalizeTrustRulesForSnapshot,
  protocolDigest,
  type ProtocolSignatureVerifier,
  type ProtocolSigner,
} from "@zhixing/core/protocol";
import { captureFileIo, createTempDir } from "@zhixing/test-utils";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { FileTrustRuleSnapshotCatalog } from "../executor-snapshot-version-store.js";

const NOW = "2026-07-19T00:00:00.000Z";

const signer: ProtocolSigner = {
  sign(schemaId, version, payload) {
    return { alg: "test-digest", keyId: "device-a", sig: protocolDigest(schemaId, version, payload) };
  },
};

const verifier: ProtocolSignatureVerifier = {
  verify(schemaId, version, payload, signature) {
    const expected = signer.sign(schemaId, version, payload);
    if (signature.alg !== expected.alg || signature.keyId !== expected.keyId || signature.sig !== expected.sig) {
      throw new TypeError("Test signature is invalid");
    }
  },
};

function rules(index: number): PermissionRule[] {
  return [{
    id: `rule-${index}`,
    pattern: { tool: "bash", argument: `npm run task-${index}` },
    decision: "allow",
    scope: "global",
    createdAt: 1,
    lastMatchedAt: 0,
    matchCount: 0,
  }];
}

async function populated(count: number) {
  const root = await createTempDir(`permission-catalog-${count}`);
  const catalog = await FileTrustRuleSnapshotCatalog.open(root, verifier);
  const published = [];
  for (let index = 0; index < count; index++) {
    published.push((await catalog.publishRules({ rules: rules(index), signer, generatedAt: NOW })).snapshot);
  }
  return { root, published };
}

/** 让下一次写入路径匹配的持久写失败一次，模拟进程在那一步之前崩溃。 */
function failNextWrite(match: (file: string) => boolean): void {
  const original = fs.open;
  let armed = true;
  const spy = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    if (armed && args[1] === "wx" && match(String(args[0]).replaceAll("\\", "/"))) {
      armed = false;
      throw new Error("injected crash before durable write");
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  onTestFinished(() => {
    spy.mockRestore();
    syncBuiltinESMExports();
  });
}

vi.setConfig({ testTimeout: 60_000 });

describe("FileTrustRuleSnapshotCatalog keyed layout", () => {
  it("keeps every catalog operation's reads independent of the retained snapshot count", async () => {
    const reads: Record<string, { readonly reads: number; readonly readBytes: number }>[] = [];
    for (const count of [1, 16, 64]) {
      const { root, published } = await populated(count);
      const io = await captureFileIo(root, () => "catalog");
      // 每项操作都在刚打开、没有缓存的新实例上计量，各档比较的是同一种冷状态
      const measure = async (label: string, work: (catalog: FileTrustRuleSnapshotCatalog) => Promise<unknown>) => {
        io.reset();
        const catalog = await FileTrustRuleSnapshotCatalog.open(root, verifier);
        if (label !== "open") io.reset();
        await work(catalog);
        const totals = io.snapshot();
        return [label, { reads: totals.reads, readBytes: totals.readBytes }] as const;
      };
      const entries = [
        await measure("open", async () => undefined),
        await measure("existing-content", (catalog) => catalog.publishRules({ rules: rules(0), signer, generatedAt: NOW })),
        await measure("latest", (catalog) => catalog.latest()),
        await measure("highWater", (catalog) => catalog.highWater()),
        await measure("oldest-by-digest", (catalog) => catalog.snapshot(published[0]!.digest)),
        await measure("new-content", (catalog) => catalog.publishRules({ rules: rules(count), signer, generatedAt: NOW })),
      ];
      reads.push(Object.fromEntries(entries));
      expect(await (await FileTrustRuleSnapshotCatalog.open(root, verifier)).highWater()).toBe(count + 1);
    }
    const [small, , large] = reads;
    for (const label of Object.keys(small!)) {
      expect(large![label]!.reads, label).toBe(small![label]!.reads);
      // 版本号位数随规模变长（head 与指针里的数字），允许每次读取几个字节的差
      expect(large![label]!.readBytes - small![label]!.readBytes, label).toBeLessThanOrEqual(8 * small![label]!.reads);
    }
  });

  it("rolls a crashed write forward from its durable intent without rewriting versions or regressing head", async () => {
    for (const [label, match] of [
      ["snapshot-file", (file: string) => /\/[a-f0-9]{64}\.json\.tmp$/u.test(file)],
      ["version-pointer", (file: string) => file.includes("/versions/")],
      ["content-pointer", (file: string) => file.includes("/contents/")],
      ["position-pointer", (file: string) => file.includes("/positions/")],
      ["head", (file: string) => file.endsWith("/head.json.tmp")],
    ] as const) {
      const { root, published } = await populated(2);
      const writer = await FileTrustRuleSnapshotCatalog.open(root, verifier);
      failNextWrite(match);
      await expect(writer.publishRules({ rules: rules(9), signer, generatedAt: NOW }), label).rejects.toThrow("injected crash");
      // 重启后的新实例：遗留意图在第一个加锁操作里前滚或丢弃
      const restarted = await FileTrustRuleSnapshotCatalog.open(root, verifier);
      const escapedBeforeCrash = label !== "snapshot-file";
      expect(await restarted.highWater(), label).toBe(escapedBeforeCrash ? 3 : 2);
      const latest = await restarted.latest();
      if (!escapedBeforeCrash) expect(latest?.digest, label).toBe(published[1]!.digest);
      const replay = await restarted.publishRules({ rules: rules(9), signer, generatedAt: "2026-07-19T00:00:09.000Z" });
      expect(replay.snapshot.snapshotVersion, label).toBe(3);
      expect(replay.highWater, label).toBe(3);
      if (escapedBeforeCrash) expect(replay.snapshot.digest, label).toBe(latest?.digest);
      await expect(fs.stat(path.join(root, "intent.json")), label).rejects.toMatchObject({ code: "ENOENT" });
      // 原有快照照常可按 digest 取到
      await expect(restarted.snapshot(published[0]!.digest), label).resolves.toEqual(published[0]);
    }
  });

  it("converts an old full-scan directory once and then fails closed instead of rescanning", async () => {
    const root = await createTempDir("permission-catalog-legacy");
    const legacy = [1, 2, 3].map((version) => createSignedTrustRuleSnapshot({
      snapshotVersion: version,
      rules: normalizeTrustRulesForSnapshot(rules(version)),
      generatedAt: NOW,
    }, signer));
    for (const snapshot of legacy) {
      await fs.writeFile(path.join(root, `${snapshot.digest.slice("sha256:".length)}.json`), `${JSON.stringify(snapshot)}\n`);
    }
    const converted = await FileTrustRuleSnapshotCatalog.open(root, verifier);
    expect(await converted.highWater()).toBe(3);
    expect((await converted.latest())?.digest).toBe(legacy[2]!.digest);
    expect((await converted.publishRules({ rules: rules(2), signer, generatedAt: NOW })).snapshot.digest).toBe(legacy[1]!.digest);

    const io = await captureFileIo(root, (file) => (/^[a-f0-9]{64}\.json$/u.test(file) ? "snapshot" : "pointer"));
    const reopened = await FileTrustRuleSnapshotCatalog.open(root, verifier);
    expect(io.snapshot().byCategory.snapshot).toBeUndefined();
    expect(await reopened.highWater()).toBe(3);

    // 已建立布局的目录缺 head：失败关闭，不退回整目录扫描，也不从零重新分配版本
    await fs.rm(path.join(root, "head.json"));
    const damaged = await FileTrustRuleSnapshotCatalog.open(root, verifier);
    await expect(damaged.highWater()).rejects.toThrow("head is missing");
    await expect(damaged.publishRules({ rules: rules(7), signer, generatedAt: NOW })).rejects.toThrow("head is missing");
  });

  it("fails closed when its head or version pointers are rewritten, replayed or removed", async () => {
    const integrity = new AuthorityCacheIntegrity(randomBytes(32));
    const root = await createTempDir("permission-catalog-tamper");
    const open = () => FileTrustRuleSnapshotCatalog.open(root, verifier, { integrity });
    const catalog = await open();
    const first = await catalog.publishRules({ rules: rules(1), signer, generatedAt: NOW });
    const headAtFirst = await fs.readFile(path.join(root, "head.json"), "utf8");
    const second = await catalog.publishRules({ rules: rules(2), signer, generatedAt: NOW });
    const headAtSecond = await fs.readFile(path.join(root, "head.json"), "utf8");
    expect((await (await open()).latest())?.digest).toBe(second.snapshot.digest);

    // 只把 head 改成指向 v1（快照与签名都没动）：MAC 不符，冷重开失败关闭而不是返回 v1
    await fs.writeFile(path.join(root, "head.json"), `${JSON.stringify({ v: 1, highWater: 1, digest: first.snapshot.digest })}\n`);
    await expect((await open()).latest()).rejects.toThrow("integrity check");
    // 回放更早的合法 head（v1 时的文件，MAC 有效）：版本 2 的指针还在，判为落后
    await fs.writeFile(path.join(root, "head.json"), headAtFirst);
    await expect((await open()).latest()).rejects.toThrow("behind its published versions");
    // 没有完整性密钥的读者对同一回放也失败关闭
    await expect((await FileTrustRuleSnapshotCatalog.open(root, verifier)).latest()).rejects.toThrow("behind its published versions");
    // head 正常，但它的版本指针被删
    await fs.writeFile(path.join(root, "head.json"), headAtSecond);
    await fs.rm(path.join(root, "versions", "2.json"));
    await expect((await open()).latest()).rejects.toThrow("does not match its version pointer");
  });

  it("detects a replayed head across a legal version gap through its dense publication position", async () => {
    // 总控反例：发布 v1 后按既有合同装签名 v9（版本合法跳号），只回放 v1 时那份带合法 MAC 的 head
    const integrity = new AuthorityCacheIntegrity(randomBytes(32));
    const root = await createTempDir("permission-catalog-sparse");
    const catalog = await FileTrustRuleSnapshotCatalog.open(root, verifier, { integrity });
    await catalog.publishRules({ rules: rules(1), signer, generatedAt: NOW });
    const headAtV1 = await fs.readFile(path.join(root, "head.json"));
    await catalog.publish(createSignedTrustRuleSnapshot({
      snapshotVersion: 9,
      rules: normalizeTrustRulesForSnapshot(rules(9)),
      generatedAt: NOW,
    }, signer));
    expect((await catalog.latest())?.snapshotVersion).toBe(9);
    await fs.writeFile(path.join(root, "head.json"), headAtV1);
    for (const options of [{ integrity }, {}]) {
      await expect((await FileTrustRuleSnapshotCatalog.open(root, verifier, options)).latest()).rejects.toThrow("behind its published versions");
    }
    // 合法路径不受影响：跳号之后本机照常接着分配，有钥与无钥读者冷重开都读到最新发布
    const healthy = await createTempDir("permission-catalog-sparse-healthy");
    const writer = await FileTrustRuleSnapshotCatalog.open(healthy, verifier, { integrity });
    await writer.publishRules({ rules: rules(1), signer, generatedAt: NOW });
    await writer.publish(createSignedTrustRuleSnapshot({ snapshotVersion: 9, rules: normalizeTrustRulesForSnapshot(rules(9)), generatedAt: NOW }, signer));
    expect((await writer.publishRules({ rules: rules(10), signer, generatedAt: NOW })).snapshot.snapshotVersion).toBe(10);
    expect((await (await FileTrustRuleSnapshotCatalog.open(healthy, verifier)).latest())?.snapshotVersion).toBe(10);
  });

  it("returns isolated copies from its bounded cache and rejects rewritten identities", async () => {
    const { root, published } = await populated(2);
    const catalog = await FileTrustRuleSnapshotCatalog.open(root, verifier);
    const first = (await catalog.snapshot(published[0]!.digest))!;
    (first.rules as PermissionRule[]).length = 0;
    await expect(catalog.snapshot(published[0]!.digest)).resolves.toEqual(published[0]);
    await expect(catalog.snapshot("sha256:not-a-digest")).resolves.toBeUndefined();
    await expect(catalog.snapshot(`sha256:${"0".repeat(64)}`)).resolves.toBeUndefined();

    // 另一个签名内容占用同一版本：按版本指针拒绝改写
    const conflicting = createSignedTrustRuleSnapshot({
      snapshotVersion: 2,
      rules: normalizeTrustRulesForSnapshot(rules(5)),
      generatedAt: NOW,
    }, signer);
    await expect(catalog.publish(conflicting)).rejects.toThrow("rewritten");
    // 远端按版本跳号安装：head 取最高版本，之后本机新分配的版本接着它
    const remote = createSignedTrustRuleSnapshot({
      snapshotVersion: 9,
      rules: normalizeTrustRulesForSnapshot(rules(6)),
      generatedAt: NOW,
    }, signer);
    await catalog.publish(remote);
    await catalog.publish(remote);
    expect(await catalog.highWater()).toBe(9);
    expect((await catalog.publishRules({ rules: rules(8), signer, generatedAt: NOW })).snapshot.snapshotVersion).toBe(10);
  });
});
