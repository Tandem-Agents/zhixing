/**
 * setup-delivery 回归测试
 *
 * 专注于 TD#1 修复：channel-not-found 返回 retryable:true 而非 false。
 * Daemon 长时运行期间，channel adapter 重连过渡窗口里查不到，必须重试，
 * 否则投递会被 Outbox 静默丢弃。
 *
 * 直接验证源码的最小方式：读文件查 retryable:true 字面量 + 确保 setupDelivery
 * 能正常组装栈。深度 Outbox 重试行为由 core 包自己的测试覆盖。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ChannelRegistry } from "@zhixing/core";
import { setupDelivery, type DeliveryStack } from "../setup-delivery.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const quietLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe("setupDelivery — TD#1 channel-not-found retryable", () => {
  let home: string;
  let stack: DeliveryStack | null = null;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "zhixing-delivery-"));
  });

  afterEach(async () => {
    if (stack) {
      await stack.stop().catch(() => {});
      stack = null;
    }
    await rm(home, { recursive: true, force: true });
  });

  it("source code: channel-not-found path uses retryable:true (TD#1 regression guard)", async () => {
    // 直接读源码断言——防止未来误改回 retryable:false
    const srcPath = resolve(__dirname, "..", "setup-delivery.ts");
    const src = await readFile(srcPath, "utf-8");

    // 查找 "Channel not found" 周围的 retryable 字段
    const idx = src.indexOf("Channel not found");
    expect(idx).toBeGreaterThan(0);
    const chunk = src.slice(idx, idx + 300);
    expect(chunk).toMatch(/retryable:\s*true/);
    expect(chunk).not.toMatch(/retryable:\s*false/);
  });

  it("assembles a valid DeliveryStack with an empty channel registry", async () => {
    const channels = new ChannelRegistry();
    stack = await setupDelivery({ channels, zhixingHome: home, logger: quietLogger });
    expect(stack).toBeDefined();
    expect(stack.delivery).toBeDefined();
    expect(stack.outboxRegistry).toBeDefined();
    expect(typeof stack.stop).toBe("function");
  });
});
