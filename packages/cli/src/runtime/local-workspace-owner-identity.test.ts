import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { expect, it } from "vitest";
import { acquireFileLock, withFileLockProcessIdentity, type ProcessIdentityResolver } from "@zhixing/core/persistence";
import { acquireLocalWorkspaceOwner, callLocalWorkspaceHost, LocalWorkspaceTransportServer } from "./local-workspace-owner.js";

// 宿主组合根把平台身份端口装在自己的作用域里；本机工作区请求经 socket 读事件到达，
// 读事件拿不到接入时的异步上下文，处理请求时取文件锁必须仍用这个端口（否则回落默认解析）。
it("restores the composition root's platform identity port for every local workspace request", async () => {
  const home = await createTempDir("local-workspace-identity");
  const lease = await acquireLocalWorkspaceOwner(home);
  const reads: number[] = [];
  const platform: ProcessIdentityResolver = {
    read: async (pid) => { reads.push(pid); return { kind: "present", birth: "platform-port" }; },
  };
  const host = withFileLockProcessIdentity(platform, () => new LocalWorkspaceTransportServer(lease, async () => {
    const release = await acquireFileLock(path.join(home, "probe.lock"), { staleMs: 30_000, waitMs: 1_000 });
    await release();
    return { state: "ready" };
  }));
  await withFileLockProcessIdentity(platform, () => host.start());
  try {
    await expect(callLocalWorkspaceHost(home, { kind: "host-status" })).resolves.toEqual({ state: "ready" });
    expect(reads).toContain(process.pid);
  } finally {
    await host.close();
    await lease.release();
  }
});
