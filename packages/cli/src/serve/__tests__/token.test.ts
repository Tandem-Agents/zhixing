import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateToken } from "../token.js";

describe("loadOrCreateToken", () => {
  let tempDir: string;
  let tokenPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zhixing-token-"));
    tokenPath = join(tempDir, "server.token");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("generates a new token when file does not exist", async () => {
    const result = await loadOrCreateToken(tokenPath);
    expect(result.generated).toBe(true);
    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    expect(result.path).toBe(tokenPath);

    const onDisk = (await readFile(tokenPath, "utf-8")).trim();
    expect(onDisk).toBe(result.token);
  });

  it("loads existing token when file exists", async () => {
    const existingToken = "a".repeat(64);
    await writeFile(tokenPath, existingToken + "\n", "utf-8");

    const result = await loadOrCreateToken(tokenPath);
    expect(result.generated).toBe(false);
    expect(result.token).toBe(existingToken);
  });

  it("regenerates if existing token is too short", async () => {
    await writeFile(tokenPath, "short", "utf-8");
    const result = await loadOrCreateToken(tokenPath);
    expect(result.generated).toBe(true);
    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("creates parent directory if missing", async () => {
    const nestedPath = join(tempDir, "subdir", "server.token");
    const result = await loadOrCreateToken(nestedPath);
    expect(result.generated).toBe(true);
    const onDisk = (await readFile(nestedPath, "utf-8")).trim();
    expect(onDisk).toBe(result.token);
  });
});
