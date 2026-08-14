import { describe, expect, it, vi } from "vitest";
import { AdvancementController, SessionAdvancementStore } from "@zhixing/owner-services";
import { ProgramUpdateNotificationDomain, createServerContext } from "../context.js";
import { DEFAULT_SERVER_CONFIG } from "../types.js";

const TEST_VERSION = "0.1.0-test";
const TEST_TOKEN = "test-token-context";

async function makeStore() {
  return new SessionAdvancementStore({
    port: () => {
      throw new Error("context test does not reach the session state port");
    },
    requestIdFor: () => `req-${Math.random()}`,
  });
}

describe("createServerContext", () => {
  it("keeps only the exact live update-status connection generation", () => {
    const domain = new ProgramUpdateNotificationDomain();
    const alreadyClosed = connection(6);
    (alreadyClosed.value as unknown as { closed: boolean }).closed = true;
    domain.subscribe(alreadyClosed.value);
    const first = connection(7);
    const successor = connection(7);
    domain.subscribe(first.value);
    domain.subscribe(successor.value);
    first.close();

    domain.publishChanged();
    expect(alreadyClosed.notify).not.toHaveBeenCalled();
    expect(first.notify).not.toHaveBeenCalled();
    expect(successor.notify).toHaveBeenCalledWith("server.update.changed", {});

    successor.close();
    domain.publishChanged();
    expect(successor.notify).toHaveBeenCalledOnce();
  });

  it("llmComplete 不自动启用推进控制面", () => {
    const ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 0 },
      version: TEST_VERSION,
      token: TEST_TOKEN,
      llmComplete: async () => "{}",
    });

    expect(ctx.advancement).toBeUndefined();
  });

  it("显式传入的推进控制面优先于默认装配", async () => {
    const advancement = new AdvancementController({ store: await makeStore() });
    const ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 0 },
      version: TEST_VERSION,
      token: TEST_TOKEN,
      advancement,
      llmComplete: async () => "{}",
    });

    expect(ctx.advancement).toBe(advancement);
  });

  it("没有 llmComplete 时保持原有纯执行语义", () => {
    const ctx = createServerContext({
      config: { ...DEFAULT_SERVER_CONFIG, port: 0 },
      version: TEST_VERSION,
      token: TEST_TOKEN,
    });

    expect(ctx.advancement).toBeUndefined();
  });
});

function connection(id: number) {
  let closeHandler = () => undefined;
  const notify = vi.fn(() => true);
  return {
    notify,
    value: {
      id,
      authenticated: true,
      loopback: true,
      closed: false,
      tryNotify: vi.fn((method: string, params: unknown) => {
        notify(method, params);
        return true;
      }),
      onClose(handler: () => void) {
        closeHandler = handler;
        return vi.fn();
      },
    } as never,
    close: () => closeHandler(),
  };
}
