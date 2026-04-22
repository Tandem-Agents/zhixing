import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLock,
  releaseLock,
  readLock,
  isProcessAlive,
  resolveProcessStartTime,
  ProcessLockError,
} from "../process-lock.js";

describe("ProcessLock", () => {
  let tempDir: string;
  let pidPath: string;
  let portPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "zhixing-lock-"));
    pidPath = join(tempDir, "server.pid");
    portPath = join(tempDir, "server.port");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("acquires lock and writes pid + port files", async () => {
    await acquireLock(18900, { pidPath, portPath });

    const pid = await readLock({ pidPath, portPath });
    expect(pid?.pid).toBe(process.pid);
    expect(pid?.port).toBe(18900);
    expect(pid?.startedAt).toBeTruthy();

    const portContent = await readFile(portPath, "utf-8");
    expect(portContent).toBe("18900");
  });

  it("releaseLock removes files", async () => {
    await acquireLock(18900, { pidPath, portPath });
    await releaseLock({ pidPath, portPath });
    expect(await readLock({ pidPath, portPath })).toBeNull();
  });

  it("releaseLock is idempotent (no error when files missing)", async () => {
    await releaseLock({ pidPath, portPath });
    await releaseLock({ pidPath, portPath });
  });

  it("acquireLock fails when another live process holds the lock", async () => {
    // Write pid file pointing to current process (definitely alive)
    await writeFile(
      pidPath,
      JSON.stringify({ pid: process.pid, port: 18900, startedAt: new Date().toISOString() }),
      "utf-8",
    );

    await expect(acquireLock(18901, { pidPath, portPath })).rejects.toBeInstanceOf(
      ProcessLockError,
    );
  });

  it("acquireLock recovers from stale pid file (process not alive)", async () => {
    // Write pid file pointing to clearly invalid PID
    await writeFile(
      pidPath,
      JSON.stringify({ pid: 999999999, port: 18900, startedAt: "2020-01-01T00:00:00Z" }),
      "utf-8",
    );

    await acquireLock(18901, { pidPath, portPath });

    const pid = await readLock({ pidPath, portPath });
    expect(pid?.pid).toBe(process.pid);
    expect(pid?.port).toBe(18901);
  });

  it("readLock returns null when file missing", async () => {
    expect(await readLock({ pidPath, portPath })).toBeNull();
  });

  it("readLock returns null on corrupted file", async () => {
    await writeFile(pidPath, "{ not json", "utf-8");
    expect(await readLock({ pidPath, portPath })).toBeNull();
  });

  it("isProcessAlive returns true for current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("isProcessAlive returns false for impossibly large pid", () => {
    expect(isProcessAlive(999999999)).toBe(false);
  });

  // ─── schema v2 ───

  it("writes v2 schema with pidFileVersion=2 and startTime field", async () => {
    await acquireLock(18900, {
      pidPath,
      portPath,
      host: "127.0.0.1",
      version: "0.1.0",
      logPath: "/tmp/server.log",
      resolveStartTimeFn: async () => 12345,
    });

    const raw = JSON.parse(await readFile(pidPath, "utf-8"));
    expect(raw.pidFileVersion).toBe(2);
    expect(raw.startTime).toBe(12345);
    expect(raw.host).toBe("127.0.0.1");
    expect(raw.version).toBe("0.1.0");
    expect(raw.logPath).toBe("/tmp/server.log");
    expect(raw.kind).toBe("zhixing-server");
    expect(Array.isArray(raw.argv)).toBe(true);
  });

  it("silently migrates v1 file on read (no pidFileVersion field)", async () => {
    // v1 文件：只有 { pid, port, startedAt }，无 pidFileVersion
    await writeFile(
      pidPath,
      JSON.stringify({ pid: process.pid, port: 18900, startedAt: "2026-04-22T10:00:00Z" }),
      "utf-8",
    );

    const lock = await readLock({ pidPath });
    expect(lock).not.toBeNull();
    expect(lock!.pidFileVersion).toBe(1); // 补齐
    expect(lock!.startTime).toBeNull(); // 补齐
    expect(lock!.pid).toBe(process.pid);
    expect(lock!.port).toBe(18900);
  });

  it("v1 file does NOT trigger stale warning when process is alive", async () => {
    // 写 v1 文件指向本进程（肯定活着）——若 stale 检测错误报 stale，acquireLock 会成功（覆盖文件）
    // 期望：视为活进程，acquireLock 抛 ProcessLockError
    await writeFile(
      pidPath,
      JSON.stringify({ pid: process.pid, port: 18900, startedAt: "2026-04-22T10:00:00Z" }),
      "utf-8",
    );

    await expect(acquireLock(18901, { pidPath, portPath })).rejects.toBeInstanceOf(
      ProcessLockError,
    );
  });

  it("v2 file with matching startTime treats process as alive", async () => {
    // 伪造 v2 文件，startTime 能被 resolver 匹配上
    await writeFile(
      pidPath,
      JSON.stringify({
        pidFileVersion: 2,
        pid: process.pid,
        port: 18900,
        startedAt: "2026-04-22T10:00:00Z",
        startTime: 99999,
      }),
      "utf-8",
    );

    await expect(
      acquireLock(18901, {
        pidPath,
        portPath,
        resolveStartTimeFn: async () => 99999, // 相同 → 同一进程
      }),
    ).rejects.toBeInstanceOf(ProcessLockError);
  });

  it("v2 file with divergent startTime is treated as stale (PID reuse)", async () => {
    // pid 活，但 startTime 不一致 → PID 被复用
    await writeFile(
      pidPath,
      JSON.stringify({
        pidFileVersion: 2,
        pid: process.pid,
        port: 18900,
        startedAt: "2020-01-01T00:00:00Z",
        startTime: 11111,
      }),
      "utf-8",
    );

    // 能覆盖（视为 stale）
    await acquireLock(18901, {
      pidPath,
      portPath,
      resolveStartTimeFn: async () => 99999, // 不一致
    });

    const lock = await readLock({ pidPath });
    expect(lock!.port).toBe(18901); // 新锁生效
  });

  it("v2 file with null startTime falls back to isProcessAlive (platform unsupported)", async () => {
    // startTime 为 null（平台不支持）→ 跳过 PID reuse 检测，只看 isProcessAlive
    await writeFile(
      pidPath,
      JSON.stringify({
        pidFileVersion: 2,
        pid: process.pid,
        port: 18900,
        startedAt: "2026-04-22T10:00:00Z",
        startTime: null,
      }),
      "utf-8",
    );

    await expect(
      acquireLock(18901, {
        pidPath,
        portPath,
        resolveStartTimeFn: async () => null, // 平台不支持
      }),
    ).rejects.toBeInstanceOf(ProcessLockError);
  });

  it("resolveProcessStartTime returns a value or null — never throws", async () => {
    // 当前进程应该能读到（Linux/macOS），Windows 返回 null
    const res = await resolveProcessStartTime(process.pid);
    if (process.platform === "linux" || process.platform === "darwin") {
      // 理论上应能读到；若读取失败也不抛
      expect(res === null || typeof res === "number").toBe(true);
    } else {
      expect(res).toBeNull();
    }

    // 不存在的 pid 不抛
    const missing = await resolveProcessStartTime(999999999);
    expect(missing).toBeNull();
  });
});
