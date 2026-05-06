import { describe, it, expect, beforeEach } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { discoverServer, readToken, ServerNotRunningError } from "../discovery.js";

describe("discovery", () => {
  let tempDir: string;
  let pidPath: string;
  let portPath: string;
  let tokenPath: string;

  beforeEach(async () => {
    tempDir = await createTempDir("disc");
    pidPath = join(tempDir, "server.pid");
    portPath = join(tempDir, "server.port");
    tokenPath = join(tempDir, "server.token");
  });

  // ─── readToken ───

  it("readToken returns null when file missing", async () => {
    expect(await readToken(tokenPath)).toBeNull();
  });

  it("readToken returns trimmed content", async () => {
    await writeFile(tokenPath, "  abcdef\n", "utf-8");
    expect(await readToken(tokenPath)).toBe("abcdef");
  });

  it("readToken returns null on empty file", async () => {
    await writeFile(tokenPath, "  \n  ", "utf-8");
    expect(await readToken(tokenPath)).toBeNull();
  });

  // ─── discoverServer ───

  it("throws ServerNotRunningError when no PID file", async () => {
    await expect(
      discoverServer({ pidPath, portPath, tokenPath }),
    ).rejects.toBeInstanceOf(ServerNotRunningError);
  });

  it("throws when PID file points to dead process", async () => {
    await writeFile(
      pidPath,
      JSON.stringify({ pid: 999999999, port: 18900, startedAt: "2020-01-01T00:00:00Z" }),
      "utf-8",
    );
    await writeFile(tokenPath, "abc", "utf-8");
    await expect(
      discoverServer({ pidPath, portPath, tokenPath }),
    ).rejects.toMatchObject({ name: "ServerNotRunningError" });
  });

  it("throws when token file missing (but server alive)", async () => {
    await writeFile(
      pidPath,
      JSON.stringify({ pid: process.pid, port: 18900, startedAt: new Date().toISOString() }),
      "utf-8",
    );
    await expect(
      discoverServer({ pidPath, portPath, tokenPath }),
    ).rejects.toMatchObject({
      name: "ServerNotRunningError",
      message: expect.stringContaining("token"),
    });
  });

  it("returns endpoint when everything is in place", async () => {
    await writeFile(
      pidPath,
      JSON.stringify({ pid: process.pid, port: 18900, startedAt: new Date().toISOString() }),
      "utf-8",
    );
    await writeFile(tokenPath, "my-token-abc", "utf-8");

    const endpoint = await discoverServer({ pidPath, portPath, tokenPath });
    expect(endpoint.url).toBe("ws://127.0.0.1:18900/ws");
    expect(endpoint.httpBase).toBe("http://127.0.0.1:18900");
    expect(endpoint.token).toBe("my-token-abc");
    expect(endpoint.pid.pid).toBe(process.pid);
  });

  it("respects custom host and wsPath options", async () => {
    await writeFile(
      pidPath,
      JSON.stringify({ pid: process.pid, port: 9999, startedAt: new Date().toISOString() }),
      "utf-8",
    );
    await writeFile(tokenPath, "tok", "utf-8");

    const endpoint = await discoverServer({
      pidPath,
      portPath,
      tokenPath,
      host: "192.168.0.5",
      wsPath: "/v2/ws",
    });
    expect(endpoint.url).toBe("ws://192.168.0.5:9999/v2/ws");
    expect(endpoint.httpBase).toBe("http://192.168.0.5:9999");
  });

  it("hint is included on errors for friendly CLI output", async () => {
    try {
      await discoverServer({ pidPath, portPath, tokenPath });
    } catch (err) {
      expect(err).toBeInstanceOf(ServerNotRunningError);
      expect((err as ServerNotRunningError).hint).toBeTruthy();
    }
  });
});
