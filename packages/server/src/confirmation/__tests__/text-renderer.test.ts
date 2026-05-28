/**
 * TextConfirmationRenderer 单元测试
 *
 * 覆盖：
 *   - 有 turnOrigin.target → adapter.send 被调用 + 埋点 sent
 *   - 无 target 但有 defaultTarget → 走 defaultTarget
 *   - 完全无 target → skip + 埋点 no-target
 *   - adapter 未注册 → 埋点 send-failed adapter-not-found
 *   - adapter.send 抛错 → 不上抛，记 send-failed 埋点
 *   - resolved 事件不触发 send
 *   - stop 后事件不再转发
 *   - formatConfirmationMessage 包含词集提示行（中英文、拒绝理由）
 */

import { describe, expect, it, vi } from "vitest";
import {
  ConfirmationBroker,
  type ChannelLogger,
  type ChannelRegistry,
  type ChannelAdapter,
  type DeliveryTarget,
  type DeliveryResult,
  type ConfirmationRequest,
} from "@zhixing/core";
import { ConfirmationHub } from "../hub.js";
import {
  TextConfirmationRenderer,
  formatConfirmationMessage,
} from "../text-renderer.js";

// ─── 测试辅助 ───

function makeLogger(): ChannelLogger & {
  calls: Array<{ level: string; msg: string; data?: unknown }>;
} {
  const calls: Array<{ level: string; msg: string; data?: unknown }> = [];
  return {
    debug: (msg, data) => calls.push({ level: "debug", msg, data }),
    info: (msg, data) => calls.push({ level: "info", msg, data }),
    warn: (msg, data) => calls.push({ level: "warn", msg, data }),
    error: (msg, data) => calls.push({ level: "error", msg, data }),
    calls,
  };
}

/** 一个 send 可被配置成成功或抛错的假 channel adapter */
function makeAdapter(
  id: string,
  sendBehavior: "ok" | "throw" = "ok",
): { adapter: ChannelAdapter; sentMessages: Array<{ target: DeliveryTarget; text: string }> } {
  const sentMessages: Array<{ target: DeliveryTarget; text: string }> = [];
  const adapter: ChannelAdapter = {
    id,
    capabilities: {
      kinds: ["text"],
      receive: false,
      send: true,
      typing: false,
      approval: false,
    } as never,
    async connect() {},
    async disconnect() {},
    async send(target, content): Promise<DeliveryResult> {
      if (sendBehavior === "throw") throw new Error("network fail");
      sentMessages.push({ target, text: content.text ?? "" });
      return { success: true, messageId: `msg-${sentMessages.length}` };
    },
  };
  return { adapter, sentMessages };
}

/** 一个最小 ChannelRegistry stub——只需要 get(id) 方法 */
function makeChannelRegistry(
  adapters: Map<string, ChannelAdapter>,
): ChannelRegistry {
  return {
    get: (id: string) => adapters.get(id),
  } as unknown as ChannelRegistry;
}

function makeRequest(
  id: string,
  target?: DeliveryTarget,
): ConfirmationRequest {
  const now = Date.now();
  return {
    id,
    tool: "bash",
    toolInput: { command: "ls" },
    workingDirectory: "/tmp",
    display: {
      title: "Bash 命令",
      body: { kind: "bash", command: "ls", commandPreview: "ls" },
      cwd: "/tmp",
    },
    options: [],
    sessionType: "interactive",
    contextId: { kind: "main" },
    createdAt: now,
    expiresAt: now + 30 * 60 * 1000,
    turnOrigin: target
      ? { channel: target.channelId, target, triggeredBy: "u_1" }
      : undefined,
  };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

// ─── 基础派发 ───

describe("TextConfirmationRenderer — 基础派发", () => {
  it("有 turnOrigin.target → adapter.send 被调用 + 埋点 confirmation.remote.sent", async () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    hub.attach("b1", broker, { conversationId: "conv1" });

    const { adapter, sentMessages } = makeAdapter("feishu");
    const channels = makeChannelRegistry(new Map([["feishu", adapter]]));
    const logger = makeLogger();
    const renderer = new TextConfirmationRenderer({ hub, channels, logger });
    renderer.start();

    const target: DeliveryTarget = { channelId: "feishu", to: "ou_abc" };
    const promise = broker.requestConfirmation(makeRequest("r1", target));
    await flushMicrotasks();

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]!.target).toEqual(target);
    expect(sentMessages[0]!.text).toContain("需要批准");

    const sentEvents = logger.calls.filter(
      (c) => c.msg === "confirmation.remote.sent",
    );
    expect(sentEvents).toHaveLength(1);

    // 清场
    broker.resolve("r1", { kind: "allow-once" });
    await promise;
    renderer.stop();
  });

  it("turnOrigin.target 为空但有 defaultTarget → 走 defaultTarget", async () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    hub.attach("b1", broker);

    const { adapter, sentMessages } = makeAdapter("admin-dm");
    const channels = makeChannelRegistry(new Map([["admin-dm", adapter]]));
    const logger = makeLogger();
    const defaultTarget: DeliveryTarget = {
      channelId: "admin-dm",
      to: "admin",
    };
    const renderer = new TextConfirmationRenderer({
      hub,
      channels,
      logger,
      defaultTarget,
    });
    renderer.start();

    const promise = broker.requestConfirmation(makeRequest("r1"));
    await flushMicrotasks();

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]!.target).toEqual(defaultTarget);

    broker.resolve("r1", { kind: "allow-once" });
    await promise;
    renderer.stop();
  });

  it("无 target 且无 defaultTarget → skip + 埋点 confirmation.remote.no-target", async () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    hub.attach("b1", broker);

    const { adapter, sentMessages } = makeAdapter("feishu");
    const channels = makeChannelRegistry(new Map([["feishu", adapter]]));
    const logger = makeLogger();
    const renderer = new TextConfirmationRenderer({ hub, channels, logger });
    renderer.start();

    const promise = broker.requestConfirmation(makeRequest("r1"));
    await flushMicrotasks();

    expect(sentMessages).toHaveLength(0);
    expect(
      logger.calls.filter((c) => c.msg === "confirmation.remote.no-target"),
    ).toHaveLength(1);

    broker.resolve("r1", { kind: "allow-once" });
    await promise;
    renderer.stop();
  });
});

// ─── 失败路径 ───

describe("TextConfirmationRenderer — 失败路径", () => {
  it("adapter 未注册 → 埋点 send-failed + error=adapter-not-found", async () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    hub.attach("b1", broker);

    const channels = makeChannelRegistry(new Map()); // 空 registry
    const logger = makeLogger();
    const renderer = new TextConfirmationRenderer({ hub, channels, logger });
    renderer.start();

    const target: DeliveryTarget = { channelId: "unknown", to: "x" };
    const promise = broker.requestConfirmation(makeRequest("r1", target));
    await flushMicrotasks();

    const failed = logger.calls.filter(
      (c) => c.msg === "confirmation.remote.send-failed",
    );
    expect(failed).toHaveLength(1);
    expect((failed[0]!.data as { error: string }).error).toBe(
      "adapter-not-found",
    );

    broker.resolve("r1", { kind: "allow-once" });
    await promise;
    renderer.stop();
  });

  it("adapter.send 抛错 → 不上抛，记 send-failed 埋点", async () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    hub.attach("b1", broker);

    const { adapter } = makeAdapter("feishu", "throw");
    const channels = makeChannelRegistry(new Map([["feishu", adapter]]));
    const logger = makeLogger();
    const renderer = new TextConfirmationRenderer({ hub, channels, logger });
    renderer.start();

    const target: DeliveryTarget = { channelId: "feishu", to: "ou_abc" };
    const promise = broker.requestConfirmation(makeRequest("r1", target));
    await flushMicrotasks();

    const failed = logger.calls.filter(
      (c) => c.msg === "confirmation.remote.send-failed",
    );
    expect(failed).toHaveLength(1);
    expect((failed[0]!.data as { error: string }).error).toContain(
      "network fail",
    );

    // broker 的 pending 应保留——超时由 broker expiresAt 兜底（INV-T2）
    expect(broker.listPending()).toHaveLength(1);

    broker.resolve("r1", { kind: "allow-once" });
    await promise;
    renderer.stop();
  });
});

// ─── resolved 事件不触发 send ───

describe("TextConfirmationRenderer — 事件路由", () => {
  it("resolved 事件不会二次触发 send（INV-T3）", async () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    hub.attach("b1", broker);

    const { adapter, sentMessages } = makeAdapter("feishu");
    const channels = makeChannelRegistry(new Map([["feishu", adapter]]));
    const logger = makeLogger();
    const renderer = new TextConfirmationRenderer({ hub, channels, logger });
    renderer.start();

    const target: DeliveryTarget = { channelId: "feishu", to: "ou_abc" };
    const promise = broker.requestConfirmation(makeRequest("r1", target));
    await flushMicrotasks();
    expect(sentMessages).toHaveLength(1);

    broker.resolve("r1", { kind: "allow-once" });
    await promise;
    await flushMicrotasks();

    // resolved 后不应二次 send
    expect(sentMessages).toHaveLength(1);
    renderer.stop();
  });

  it("stop 后事件不再转发", async () => {
    const hub = new ConfirmationHub();
    const broker = new ConfirmationBroker();
    broker.onRequest(() => {});
    hub.attach("b1", broker);

    const { adapter, sentMessages } = makeAdapter("feishu");
    const channels = makeChannelRegistry(new Map([["feishu", adapter]]));
    const logger = makeLogger();
    const renderer = new TextConfirmationRenderer({ hub, channels, logger });
    renderer.start();
    renderer.stop();

    const target: DeliveryTarget = { channelId: "feishu", to: "ou_abc" };
    const promise = broker.requestConfirmation(makeRequest("r1", target));
    await flushMicrotasks();

    expect(sentMessages).toHaveLength(0);

    broker.resolve("r1", { kind: "allow-once" });
    await promise;
  });
});

// ─── 消息格式 ───

describe("formatConfirmationMessage", () => {
  it("包含标题 + 风险等级 + 词集提示行 + 自由理由提示", () => {
    const now = Date.now();
    const req: ConfirmationRequest = {
      id: "r1",
      tool: "bash",
      toolInput: { command: "rm -rf /tmp/x" },
      workingDirectory: "/tmp",
      decision: {
        action: "confirm",
        matchedRules: [],
        reason: "external op",
        riskLevel: "high",
      },
      display: {
        title: "Bash 命令",
        body: {
          kind: "bash",
          command: "rm -rf /tmp/x",
          commandPreview: "rm -rf /tmp/x",
        },
        cwd: "/tmp",
      },
      options: [],
      sessionType: "interactive",
      contextId: { kind: "main" },
      createdAt: now,
      expiresAt: now + 30 * 60 * 1000,
    };

    const text = formatConfirmationMessage(req);
    expect(text).toContain("需要批准：Bash 命令");
    expect(text).toContain("rm -rf /tmp/x");
    expect(text).toContain("风险等级：high");
    expect(text).toContain("允许本次");
    expect(text).toContain("好 / y / yes");
    expect(text).toContain("拒绝");
    expect(text).toContain("说明拒绝理由");
  });

  it("file-write 体显示文件路径 + 预览", () => {
    const now = Date.now();
    const req: ConfirmationRequest = {
      id: "r1",
      tool: "write",
      toolInput: { path: "/tmp/a.ts", content: "hi" },
      workingDirectory: "/tmp",
      display: {
        title: "写入文件",
        body: { kind: "file-write", path: "/tmp/a.ts", preview: "hi" },
        cwd: "/tmp",
      },
      options: [],
      sessionType: "interactive",
      contextId: { kind: "main" },
      createdAt: now,
      expiresAt: now + 60_000,
    };
    const text = formatConfirmationMessage(req);
    expect(text).toContain("文件：/tmp/a.ts");
    expect(text).toContain("内容预览：hi");
  });

  it("无 decision.riskLevel 时兜底为 medium", () => {
    const now = Date.now();
    const req: ConfirmationRequest = {
      id: "r1",
      tool: "bash",
      toolInput: {},
      workingDirectory: "/tmp",
      display: {
        title: "Bash",
        body: { kind: "bash", command: "ls", commandPreview: "ls" },
        cwd: "/tmp",
      },
      options: [],
      sessionType: "interactive",
      contextId: { kind: "main" },
      createdAt: now,
      expiresAt: now + 60_000,
    };
    const text = formatConfirmationMessage(req);
    expect(text).toContain("风险等级：medium");
  });

  it("display.stewardReason 存在时渲染安全助理察觉风险（远程通道也可见、与 TTY 同步术语）", () => {
    const now = Date.now();
    const req: ConfirmationRequest = {
      id: "r1",
      tool: "bash",
      toolInput: { command: "curl https://x.com" },
      workingDirectory: "/tmp",
      display: {
        title: "Bash 命令",
        body: {
          kind: "bash",
          command: "curl https://x.com",
          commandPreview: "curl https://x.com",
        },
        cwd: "/tmp",
        stewardReason: "向外部地址上传数据，与当前任务意图不完全匹配",
      },
      options: [],
      sessionType: "interactive",
      contextId: { kind: "main" },
      createdAt: now,
      expiresAt: now + 60_000,
    };
    const text = formatConfirmationMessage(req);
    expect(text).toContain("安全助理察觉风险");
    expect(text).toContain("与当前任务意图不完全匹配");
    expect(text).toContain("请你决定是否继续");
  });

  it("无 stewardReason 时不渲染助理风险行", () => {
    const now = Date.now();
    const req: ConfirmationRequest = {
      id: "r1",
      tool: "bash",
      toolInput: { command: "ls" },
      workingDirectory: "/tmp",
      display: {
        title: "Bash 命令",
        body: { kind: "bash", command: "ls", commandPreview: "ls" },
        cwd: "/tmp",
      },
      options: [],
      sessionType: "interactive",
      contextId: { kind: "main" },
      createdAt: now,
      expiresAt: now + 60_000,
    };
    const text = formatConfirmationMessage(req);
    expect(text).not.toContain("安全助理");
  });
});
