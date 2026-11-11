import { afterEach, describe, expect, it, vi } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import * as acorn from "acorn";
import { ExtensionCandidates } from "./candidate.js";
import type { ExtensionCandidate } from "./contracts.js";
import { createTempDir } from "@zhixing/test-utils";

vi.mock("acorn", async (original) => {
  const actual = await original<typeof import("acorn")>();
  return { ...actual, parse: vi.fn(actual.parse) };
});
afterEach(async () => {
  vi.mocked(acorn.parse).mockClear();
});

function candidateFor(code: string, build = "Node 24; no dependencies"): ExtensionCandidate {
  return { manifest: { id: "fixture", version: "1.0.0", digest: createHash("sha256").update(code).digest("hex"),
    runtime: "node24", entry: "extension.mjs", protocol: 1, type: "fixture", contract: 1, declaration: {} }, code,
    provenance: { url: "https://example.com/adapter", revision: "v1.0.0", kind: "existing" }, sources: { "extension.mjs": code }, build };
}

async function fixture() {
  const root = await createTempDir("extension-candidate");
  const expected = candidateFor("export const fixture = true;");
  const store = new ExtensionCandidates(join(root, "candidates"));
  const archive = join(root, "candidates", expected.manifest.digest, "candidate.json");
  return { store, expected, archive, directory: join(root, "candidates", expected.manifest.digest) };
}

describe("candidate archive matches its distribution seed", () => {
  it("recognizes the exact archive saved from the seed without parsing the bundled code", async () => {
    const f = await fixture();
    await f.store.save(f.expected);
    vi.mocked(acorn.parse).mockClear();
    expect(await f.store.holdsExactly(f.expected)).toBe(true);
    expect(acorn.parse).not.toHaveBeenCalled();
  });

  it("does not accept an invalid archive even when a forged conclusion file sits beside it", async () => {
    const f = await fixture();
    await f.store.save(f.expected);
    await writeFile(f.archive, "{}");
    await writeFile(join(f.directory, "verified.json"), JSON.stringify({ v: 1, archive: createHash("sha256").update("{}").digest("hex") }));
    expect(await f.store.holdsExactly(f.expected)).toBe(false);
    await expect(f.store.read(f.expected.manifest.digest)).rejects.toThrow();
  });

  it("does not accept a valid archive that belongs to a different candidate", async () => {
    const f = await fixture();
    const other = { ...f.expected, build: "另一份构建说明" };
    await f.store.save(other);
    expect(await f.store.holdsExactly(f.expected)).toBe(false);
    // 内容有效时完整读取仍然成功，调用方据此保留它
    await expect(f.store.read(f.expected.manifest.digest)).resolves.toMatchObject({ build: "另一份构建说明" });
  });

  it("does not vouch for an expected candidate whose code does not match its manifest digest", async () => {
    const f = await fixture();
    await f.store.save(f.expected);
    const wrong = { ...f.expected, code: "export const other = 1;", sources: { "extension.mjs": "export const other = 1;" } };
    await writeFile(f.archive, JSON.stringify(wrong));
    expect(await f.store.holdsExactly(wrong)).toBe(false);
    await expect(f.store.read(f.expected.manifest.digest)).rejects.toThrow();
  });

  it("refuses another valid candidate placed under the requested digest", async () => {
    const f = await fixture();
    const b = candidateFor("export const b = true;");
    const other = new ExtensionCandidates(join(f.directory, "..", "..", "other"));
    await other.save(b);
    const { readFile } = await import("node:fs/promises");
    const bBytes = await readFile(join(f.directory, "..", "..", "other", b.manifest.digest, "candidate.json"), "utf8");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(f.directory, { recursive: true });
    await writeFile(f.archive, bBytes);
    expect(await f.store.holdsExactly(f.expected)).toBe(false);
    await expect(f.store.read(f.expected.manifest.digest)).rejects.toThrow("不一致");
  });

  it("reports a missing archive so the caller rebuilds it", async () => {
    const f = await fixture();
    expect(await f.store.holdsExactly(f.expected)).toBe(false);
  });
});
