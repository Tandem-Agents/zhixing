import { afterEach, expect, it, vi } from "vitest";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import type { DeviceIdentity } from "../../contracts/index.js";
import { FileArtifactStore } from "../../authority/artifact-store.js";
import { FileAuthorityCommitLog } from "../../authority/commit-log.js";
import { AuthorityCacheIntegrity } from "../../authority/startup-proofs.js";
import type { ProtocolSignatureVerifier } from "../signature.js";
import { ProtocolIdentityNotLoaded, ProtocolVerificationIdentityCache, verifyProtocolStep } from "../verification-identities.js";

const identity = (key: string, publicKey = "ed25519:" + key): DeviceIdentity => ({
  deviceId: key, publicKey, displayName: key, platform: "linux", enrolledAt: "2026-10-16T00:00:00.000Z",
});
/** 同步验签器：只回答签名身份，按 keyId 查缓存；签名内容即公钥本身，便于断言。 */
function verifierFor(cache: ProtocolVerificationIdentityCache): ProtocolSignatureVerifier {
  return {
    verify(_schema, _version, _payload, signature) {
      if (cache.identityFor(signature.keyId).publicKey !== signature.sig) throw new TypeError("Protocol signature is invalid");
    },
  };
}

const logs: FileAuthorityCommitLog[] = [];
afterEach(async () => { await Promise.all(logs.splice(0).map(log => log.stopStorageMaintenance())); });

it("keeps current identities resident, hydrates historical ones exactly and never caches an untrusted result", async () => {
  const cache = new ProtocolVerificationIdentityCache(1);
  cache.bindSource("trust-log");
  const directory = new Map([["revoked-a", identity("revoked-a")], ["revoked-b", identity("revoked-b")]]);
  const resolve = vi.fn(async (key: string) => directory.get(key));
  cache.setResolver(resolve);
  cache.remember(identity("active"), true);

  expect(cache.identityFor("active").deviceId).toBe("active");
  expect(() => cache.identityFor("revoked-a")).toThrow(ProtocolIdentityNotLoaded);
  const signal = (() => { try { cache.identityFor("revoked-a"); } catch (error) { return error as ProtocolIdentityNotLoaded; } })()!;
  // 补齐信号对未包边界的调用方就是不受信拒绝，不能被当作验签通过。
  expect(signal).toBeInstanceOf(TypeError);
  expect(signal.message).toContain("untrusted device");
  expect(await cache.hydrate(signal)).toBe(true);
  expect(cache.identityFor("revoked-a").deviceId).toBe("revoked-a");

  // 历史身份有限保留：容量 1 时补齐另一个就淘汰前一个，常驻身份不受影响。
  await cache.verifying(() => cache.identityFor("revoked-b"));
  expect(() => cache.identityFor("revoked-a")).toThrow(ProtocolIdentityNotLoaded);
  expect(cache.identityFor("active").deviceId).toBe("active");

  // 找不到的身份不缓存：每次都重新精确查询，且按不受信失败。
  await expect(cache.verifying(() => cache.identityFor("stranger"))).rejects.toThrow("untrusted device");
  await expect(cache.verifying(() => cache.identityFor("stranger"))).rejects.toThrow("untrusted device");
  expect(resolve.mock.calls.filter(call => call[0] === "stranger")).toHaveLength(2);
});

it("rejects a replaced public key and drops every identity when the trust source changes", async () => {
  const cache = new ProtocolVerificationIdentityCache();
  cache.bindSource("trust-log");
  cache.remember(identity("device"), true);
  expect(() => cache.remember(identity("device", "ed25519:other"))).toThrow("cannot be replaced");
  cache.bindSource("trust-log");
  expect(cache.identityFor("device").publicKey).toBe("ed25519:device");
  cache.bindSource("replacement-log");
  expect(() => cache.identityFor("device")).toThrow(ProtocolIdentityNotLoaded);
});

it("demotes former live members while retaining only the protected local identity and current live set", () => {
  const cache = new ProtocolVerificationIdentityCache(1);
  cache.bindSource("trust-log");
  cache.rememberProtected(identity("local"));
  for (let n = 0; n < 20; n++) cache.replaceResidents([identity("member-" + n)]);
  expect(cache.identityFor("local").deviceId).toBe("local");
  expect(cache.identityFor("member-19").deviceId).toBe("member-19");
  expect(() => cache.identityFor("member-0")).toThrow(ProtocolIdentityNotLoaded);
  cache.bindSource("replacement");
  expect(() => cache.identityFor("local")).toThrow(ProtocolIdentityNotLoaded);
});

it("observes source replacement during exact hydration and never accepts the old result", async () => {
  const cache = new ProtocolVerificationIdentityCache();
  let source = "original";
  cache.bindSource(source);
  cache.setSourceReader(() => source);
  cache.setResolver(async key => { source = "replacement"; return identity(key); });
  await expect(cache.verifying(() => cache.identityFor("old"))).rejects.toThrow("trust source changed");
  expect(() => cache.identityFor("old")).toThrow(ProtocolIdentityNotLoaded);
});

it("pins all signers of one pure step without growing the retained historical cache", async () => {
  const cache = new ProtocolVerificationIdentityCache(1);
  cache.bindSource("trust-log");
  const resolve = vi.fn(async (key: string) => identity(key));
  cache.setResolver(resolve);
  const value = await cache.verifying(async () => {
    const first = cache.identityFor("old-a");
    await Promise.resolve(); // A nested signature encountered after decoding CAS.
    const second = cache.identityFor("old-b");
    const third = cache.identityFor("old-c");
    return [first.deviceId, second.deviceId, third.deviceId, cache.identityFor("old-a").deviceId];
  });
  expect(value).toEqual(["old-a", "old-b", "old-c", "old-a"]);
  expect(resolve.mock.calls.map(call => call[0])).toEqual(["old-a", "old-b", "old-c"]);
  expect(() => cache.identityFor("old-a")).toThrow(ProtocolIdentityNotLoaded);
});

it("awaits streamed replay validation without replaying previous records or repeating their mutations", async () => {
  const root = await createTempDir("b2-streamed-verification");
  const log = new FileAuthorityCommitLog(path.join(root, "authority"), new FileArtifactStore(path.join(root, "artifacts")));
  logs.push(log);
  const cache = new ProtocolVerificationIdentityCache(1);
  cache.bindSource("trust-log");
  const resolve = vi.fn(async (key: string) => identity(key));
  cache.setResolver(resolve);
  for (const signer of ["old-a", "old-b", "old-a"]) await log.append([{ stream: "control", body: { signer } }]);
  const callbacks: number[] = [];
  const state = await log.rebuildProjection<string[], { signer: string }>([], async (current, record, envelope) => {
    callbacks.push(envelope.lsn);
    const verified = await verifyProtocolStep(() => cache.identityFor(JSON.parse(JSON.stringify(record.body)).signer));
    current.push(verified.deviceId); // Effect after the pure step, exactly once.
    return current;
  });
  expect(state).toEqual(["old-a", "old-b", "old-a"]);
  expect(callbacks).toEqual([1, 2, 3]);
  expect(resolve.mock.calls.map(call => call[0])).toEqual(["old-a", "old-b", "old-a"]);
});

it("reruns an uncommitted step once per missing key and fails closed when the second miss repeats", async () => {
  const cache = new ProtocolVerificationIdentityCache();
  cache.bindSource("trust-log");
  let resolved = 0;
  cache.setResolver(async (key) => { resolved++; return identity(key); });
  let attempts = 0;
  const value = await cache.verifying(() => {
    attempts++;
    // 私有草稿：每次尝试都从头建立，失败的尝试不留痕。
    const draft = [cache.identityFor("outer").deviceId, cache.identityFor("nested").deviceId];
    return draft;
  });
  expect(value).toEqual(["outer", "nested"]);
  expect(attempts).toBe(3);
  expect(resolved).toBe(2);

  // 解析器声称找到但缓存仍拿不到（例如来源在解析期间切换）：同一缺键不会无限重跑。
  const flaky = new ProtocolVerificationIdentityCache();
  flaky.bindSource("trust-log");
  flaky.setResolver(async (key) => { flaky.bindSource("other-" + key); return identity(key); });
  await expect(flaky.verifying(() => flaky.identityFor("moving"))).rejects.toThrow("untrusted device");
});

it("lets the owning log hydrate a historical signer at its operation boundary and rerun the uncommitted step", async () => {
  const root = await createTempDir("b2-verification-hydration");
  const cache = new ProtocolVerificationIdentityCache();
  cache.bindSource("trust-log");
  const historical = new Map([["revoked", identity("revoked")]]);
  const resolve = vi.fn(async (key: string) => historical.get(key));
  cache.setResolver(resolve);
  cache.remember(identity("active"), true);
  const verifier = verifierFor(cache);
  const open = (reducerVersion = 1) => {
    const log = new FileAuthorityCommitLog(path.join(root, "authority"), new FileArtifactStore(path.join(root, "artifacts")),
      { integrity: new AuthorityCacheIntegrity(Buffer.alloc(32, 41)) });
    logs.push(log);
    const reduce = vi.fn((envelope: { entries: readonly { stream: string; body: unknown }[] }) => envelope.entries
      .filter(entry => entry.stream === "control")
      .map(entry => {
        const body = entry.body as { key: string; signer: string; publicKey: string };
        verifier.verify("Signed", 1, body, { alg: "test", keyId: body.signer, sig: body.publicKey });
        return { kind: "put" as const, key: body.key, value: body.signer };
      }));
    const index = log.durableProjection({ projectionId: "signed-records", reducerVersion, authenticated: true,
      inputs: { streams: ["control"] }, reduce });
    return { log, index, reduce };
  };
  const writer = open();
  await writer.log.append([{ stream: "control", body: { key: "a", signer: "active", publicKey: "ed25519:active" } }]);
  // 当前不在常驻集合里的历史签名者：提交时补齐一次再整体重跑，提交只发生一次。
  await writer.log.append([{ stream: "control", body: { key: "b", signer: "revoked", publicKey: "ed25519:revoked" } }]);
  expect(resolve).toHaveBeenCalledTimes(1);
  expect((await writer.log.checkpoint()).lsn).toBe(2);
  expect(await writer.index.get("b")).toBe("revoked");
  // 不在信任来源里的签名者：原有不受信失败，没有写入，投影也没有被标成永久故障。
  await expect(writer.log.append([{ stream: "control", body: { key: "c", signer: "stranger", publicKey: "ed25519:stranger" } }]))
    .rejects.toThrow("untrusted device");
  expect((await writer.log.checkpoint()).lsn).toBe(2);
  await writer.log.append([{ stream: "control", body: { key: "d", signer: "active", publicKey: "ed25519:active" } }]);
  await writer.log.stopStorageMaintenance();

  // 新进程从头分页构建新版本投影（历史回放）：缓存已清空，同样在页边界补齐后重跑该页。
  const before = resolve.mock.calls.length;
  cache.bindSource("other-trust-source");
  cache.bindSource("trust-log");
  cache.remember(identity("active"), true);
  const reader = open(2);
  await expect(reader.index.get("b")).resolves.toBe("revoked");
  expect(resolve.mock.calls.length).toBe(before + 1);
});
