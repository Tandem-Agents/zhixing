import { describe, it, expect, beforeEach } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import {
  acquireLock,
  releaseLock,
  readLock,
  isProcessAlive,
  resolveProcessStartTime,
} from "../process-lock.js";

describe("ProcessLock", () => {
  let tempDir: string;
  let pidPath: string;
  let portPath: string;

  beforeEach(async () => {
    tempDir = await createTempDir("server-lock");
    pidPath = join(tempDir, "server.pid");
    portPath = join(tempDir, "server.port");
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

  it("overwrites a live-process pid file (port listen is the real lock, pid file is discovery-only)", async () => {
    // 残留 PID 文件指向一个活进程（崩溃残留 + PID 被复用的典型场景）。端口 listen 已是单例
    // 仲裁，acquireLock 只写发现辅助文件 → 直接覆盖、绝不因 PID 冲突自杀。
    await writeFile(
      pidPath,
      JSON.stringify({ pid: process.pid, port: 18900, startedAt: new Date().toISOString() }),
      "utf-8",
    );

    await acquireLock(18901, { pidPath, portPath });

    const lock = await readLock({ pidPath, portPath });
    expect(lock?.pid).toBe(process.pid);
    expect(lock?.port).toBe(18901); // 新 owner 覆盖
  });

  it("overwrites a stale pid file (dead process)", async () => {
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

  it("overwrites regardless of startTime — Windows(null) / 复用 / 残留一律覆盖、绝不自杀", async () => {
    // owner 由端口 listen 确立，PID 文件不再做 reuse 检测、不再有「活进程则拒绝」分支。
    // 这正是 owner 修复的核心回归：曾让宿主在 Windows（startTime=null、无 reuse 检测）下
    // 「listen 成功却因崩溃残留 + PID 复用而自杀 → 下次 ensure 撞同一残留再自杀 → 死循环卡死」
    // 的边角。现在一律覆盖：活进程 + null startTime（最毒的 Windows 场景）也照样接管。
    await writeFile(
      pidPath,
      JSON.stringify({
        pidFileVersion: 2,
        pid: process.pid, // 活进程
        port: 18900,
        startedAt: "2026-04-22T10:00:00Z",
        startTime: null, // Windows：平台不支持 reuse 检测
      }),
      "utf-8",
    );

    await acquireLock(18901, {
      pidPath,
      portPath,
      resolveStartTimeFn: async () => null,
    });

    const lock = await readLock({ pidPath });
    expect(lock!.pid).toBe(process.pid);
    expect(lock!.port).toBe(18901); // 覆盖成功、不自杀
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
