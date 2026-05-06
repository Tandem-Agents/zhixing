import { describe, it, expect, beforeEach } from "vitest";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import {
  ServerStateFile,
  InvalidPhaseTransitionError,
  type ServerStateSnapshot,
} from "../server-state.js";

describe("ServerStateFile", () => {
  let tempDir: string;
  let statePath: string;
  let readyPath: string;

  beforeEach(async () => {
    tempDir = await createTempDir("server-state");
    statePath = join(tempDir, "server.state");
    readyPath = join(tempDir, "server.ready");
  });

  function newFile() {
    let tick = 0;
    return new ServerStateFile({
      statePath,
      readyMarkerPath: readyPath,
      clock: () => {
        tick += 1000;
        return new Date(1_700_000_000_000 + tick);
      },
    });
  }

  async function readState(): Promise<ServerStateSnapshot> {
    return JSON.parse(await readFile(statePath, "utf-8"));
  }

  describe("phase transitions", () => {
    it("happy path: starting → ready → running → stopping → stopped", async () => {
      const f = newFile();
      await f.markReady({ pid: 123, startedAt: "t", port: 18900, host: "127.0.0.1" });
      expect(f.currentPhase).toBe("ready");
      expect((await readState()).phase).toBe("ready");
      await stat(readyPath); // .ready marker 存在

      await f.markRunning();
      expect(f.currentPhase).toBe("running");
      expect((await readState()).phase).toBe("running");

      await f.markStopping("graceful");
      expect(f.currentPhase).toBe("stopping");
      const stoppingSnap = await readState();
      expect(stoppingSnap.phase).toBe("stopping");
      expect(stoppingSnap.exitReason).toBe("graceful");

      await f.markStopped();
      expect(f.currentPhase).toBe("stopped");
      expect((await readState()).phase).toBe("stopped");
    });

    it("rejects illegal transition stopped → running", async () => {
      const f = newFile();
      await f.markReady({ pid: 1, startedAt: "t" });
      await f.markRunning();
      await f.markStopping();
      await f.markStopped();

      // running handled via markRunning, which requires phase ready
      await expect(f.markRunning()).rejects.toBeInstanceOf(InvalidPhaseTransitionError);
    });

    it("rejects markRunning before markReady", async () => {
      const f = newFile();
      await expect(f.markRunning()).rejects.toBeInstanceOf(InvalidPhaseTransitionError);
    });

    it("markUnhealthy is valid from any phase and is idempotent", async () => {
      const f = newFile();
      await f.markReady({ pid: 1, startedAt: "t" });
      await f.markRunning();
      await f.markUnhealthy("boom");
      expect(f.currentPhase).toBe("unhealthy");
      const snap = await readState();
      expect(snap.phase).toBe("unhealthy");
      expect(snap.extensions?.unhealthyReason).toBe("boom");

      // 幂等
      await expect(f.markUnhealthy("second")).resolves.toBeUndefined();
    });

    it("markUnhealthy works even before markReady (no snapshot yet)", async () => {
      const f = newFile();
      await f.markUnhealthy("init-fail");
      expect(f.currentPhase).toBe("unhealthy");
      const snap = await readState();
      expect(snap.phase).toBe("unhealthy");
      expect(snap.extensions?.unhealthyReason).toBe("init-fail");
    });
  });

  describe(".ready marker lifecycle", () => {
    it("creates .ready only on markReady", async () => {
      const f = newFile();
      await expect(stat(readyPath)).rejects.toHaveProperty("code", "ENOENT");
      await f.markReady({ pid: 1, startedAt: "t" });
      await stat(readyPath); // 存在
    });

    it("cleanup removes .ready marker and state file", async () => {
      const f = newFile();
      await f.markReady({ pid: 1, startedAt: "t" });
      await f.markRunning();
      await f.markStopping();
      await f.markStopped();
      await f.cleanup();

      await expect(stat(readyPath)).rejects.toHaveProperty("code", "ENOENT");
      await expect(stat(statePath)).rejects.toHaveProperty("code", "ENOENT");
    });

    it("cleanup is idempotent (safe to call twice)", async () => {
      const f = newFile();
      await f.cleanup();
      await f.cleanup();
    });
  });

  describe("heartbeat", () => {
    it("refreshes lastHeartbeat but does NOT change phase", async () => {
      const f = newFile();
      await f.markReady({ pid: 1, startedAt: "2026-04-22T00:00:00Z" });
      await f.markRunning();
      const first = await readState();
      const firstHb = first.lastHeartbeat;
      expect(first.phase).toBe("running");

      await f.heartbeat();
      const second = await readState();
      expect(second.phase).toBe("running"); // 不变
      expect(second.lastHeartbeat).not.toBe(firstHb); // 刷新
    });

    it("is a no-op when called before markReady", async () => {
      const f = newFile();
      await expect(f.heartbeat()).resolves.toBeUndefined();
      // state 文件不应存在
      await expect(stat(statePath)).rejects.toHaveProperty("code", "ENOENT");
    });

    it("is a no-op when phase is stopping (Issue γ regression guard)", async () => {
      const f = newFile();
      await f.markReady({ pid: 1, startedAt: "t" });
      await f.markRunning();
      await f.markStopping("graceful");
      const before = (await readState()).lastHeartbeat;

      await f.heartbeat();
      const after = await readState();
      expect(after.lastHeartbeat).toBe(before); // 未被刷新
      expect(after.phase).toBe("stopping");
    });

    it("is a no-op when phase is stopped / unhealthy", async () => {
      const f = newFile();
      await f.markReady({ pid: 1, startedAt: "t" });
      await f.markUnhealthy("boom");
      const before = (await readState()).lastHeartbeat;

      await f.heartbeat();
      const after = await readState();
      expect(after.lastHeartbeat).toBe(before);
    });
  });

  describe("startup-failure path (Issue α regression guard)", () => {
    it("markStopping is no-op in starting phase (no noise in startup-guard cleanup)", async () => {
      const f = newFile();
      // 从未 markReady —— 模拟 startup 失败
      await expect(f.markStopping("error")).resolves.toBeUndefined();
      expect(f.currentPhase).toBe("starting"); // 未改变
      // state 文件仍不存在
      await expect(stat(statePath)).rejects.toHaveProperty("code", "ENOENT");
    });

    it("markStopped is no-op in starting phase", async () => {
      const f = newFile();
      await expect(f.markStopped()).resolves.toBeUndefined();
      expect(f.currentPhase).toBe("starting");
    });

    it("markStopped is no-op in unhealthy phase", async () => {
      const f = newFile();
      await f.markUnhealthy("init-fail");
      await expect(f.markStopped()).resolves.toBeUndefined();
      expect(f.currentPhase).toBe("unhealthy"); // 不变
    });

    it("markStopping is no-op in unhealthy phase (Issue δ regression guard)", async () => {
      const f = newFile();
      await f.markReady({ pid: 1, startedAt: "t" });
      await f.markUnhealthy("mid-flight");
      // unhealthy 是死胡同，但 markStopping 调用必须 no-op（不能抛 InvalidPhaseTransition）
      await expect(f.markStopping("error")).resolves.toBeUndefined();
      expect(f.currentPhase).toBe("unhealthy");
    });

    it("markStopped is no-op in running phase (whitelist: stopping only)", async () => {
      const f = newFile();
      await f.markReady({ pid: 1, startedAt: "t" });
      await f.markRunning();
      // 跳过 markStopping 直接 markStopped —— 白名单只允许 stopping，应 no-op
      await expect(f.markStopped()).resolves.toBeUndefined();
      expect(f.currentPhase).toBe("running");
    });

    it("markStopping is idempotent (stopping → stopping no-op)", async () => {
      const f = newFile();
      await f.markReady({ pid: 1, startedAt: "t" });
      await f.markRunning();
      await f.markStopping();
      await expect(f.markStopping()).resolves.toBeUndefined();
      expect(f.currentPhase).toBe("stopping");
    });

    it("full startup-failure path: registry.runAll produces no noise", async () => {
      // 模拟 shutdown-chain 的 registry.runAll 在 startup 失败场景下被调
      const f = newFile();
      // phase = starting（未 markReady）
      await expect(f.markStopping("error")).resolves.toBeUndefined(); // 从 registerCoreCleanup
      await expect(f.markStopped()).resolves.toBeUndefined(); // 从 registerTailCleanup
      await expect(f.cleanup()).resolves.toBeUndefined(); // 文件不存在，也 no-op
      // 全程不抛，不污染日志
    });

    // 端到端 startup-failure 场景 —— 真跑 CleanupRegistry + logger spy，
    // 断言 logger.error 零调用。这守护"整个清理链静默"契约，比单纯 "不抛" 更强。
    it("E2E: CleanupRegistry + mark* in startup-failure → logger.error zero calls", async () => {
      const { CleanupRegistry } = await import("../cleanup-registry.js");
      const logger = {
        info: () => {},
        debug: () => {},
        error: (msg: string, err?: unknown) => {
          errorCalls.push({ msg, err });
        },
      };
      const errorCalls: Array<{ msg: string; err?: unknown }> = [];
      const registry = new CleanupRegistry({ logger });
      const f = newFile();

      // 模拟 command.ts startup-failure 完整注册链（phase 仍是 starting）
      registry.register("stateFile.markStopped", () => f.markStopped());
      registry.register("stateFile.cleanup", () => f.cleanup());
      registry.register("stateFile.markStopping", () => f.markStopping("error"));
      await registry.runAll("startup-failure");

      expect(errorCalls).toEqual([]);
    });
  });

  describe("atomic writes", () => {
    it("never leaves .tmp file behind after successful write", async () => {
      const f = newFile();
      await f.markReady({ pid: 1, startedAt: "t" });
      await expect(stat(statePath + ".tmp")).rejects.toHaveProperty("code", "ENOENT");
    });

    it("concurrent writes are serialized (final state consistent)", async () => {
      const f = newFile();
      await f.markReady({ pid: 1, startedAt: "t" });
      // 并发发 10 次 heartbeat + 1 次 markRunning，等全部完成
      const ops = [f.markRunning(), ...Array.from({ length: 10 }, () => f.heartbeat())];
      await Promise.all(ops);
      const snap = await readState();
      expect(snap.phase).toBe("running");
    });
  });

  describe("read()", () => {
    it("returns null when state file missing", async () => {
      const f = newFile();
      expect(await f.read()).toBeNull();
    });

    it("returns snapshot when state file present", async () => {
      const f = newFile();
      await f.markReady({ pid: 42, startedAt: "t", port: 18900 });
      await f.markRunning();
      const snap = await f.read();
      expect(snap?.phase).toBe("running");
      expect(snap?.pid).toBe(42);
      expect(snap?.port).toBe(18900);
    });

    it("returns null on corrupted state file", async () => {
      const f = newFile();
      await writeFile(statePath, "{ not json", "utf-8");
      expect(await f.read()).toBeNull();
    });
  });
});
