import { describe, expect, it, vi } from "vitest";
import {
  pairingPublicError,
  renderPairingInvitation,
  resolveExecutorAutoStartSelection,
  resolveJoinerAnchorReachability,
} from "./mesh-pair-command.js";

describe("executor automatic-online selection", () => {
  it.each([true, false])("uses an explicit non-interactive choice: %s", async (explicit) => {
    const prompt = vi.fn(async () => !explicit);
    await expect(resolveExecutorAutoStartSelection({
      explicit,
      isolated: false,
      interactive: false,
      prompt,
    })).resolves.toBe(explicit);
    expect(prompt).not.toHaveBeenCalled();
  });

  it.each([true, false])("preserves a durable choice on pairing replay: %s", async (persisted) => {
    const prompt = vi.fn(async () => !persisted);
    await expect(resolveExecutorAutoStartSelection({
      persisted,
      isolated: false,
      interactive: true,
      prompt,
    })).resolves.toBe(persisted);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("prompts once for an interactive fresh joiner", async () => {
    const prompt = vi.fn(async () => true);
    await expect(resolveExecutorAutoStartSelection({
      isolated: false,
      interactive: true,
      prompt,
    })).resolves.toBe(true);
    expect(prompt).toHaveBeenCalledOnce();
  });

  it("keeps the non-interactive failure in product language", async () => {
    const prompt = vi.fn(async () => false);
    await expect(resolveExecutorAutoStartSelection({
      isolated: false,
      interactive: false,
      prompt,
    })).rejects.toThrow("请在交互终端重新运行同一个配对命令");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("keeps embedded pairing deterministic without creating a product preference", async () => {
    const prompt = vi.fn(async () => true);
    await expect(resolveExecutorAutoStartSelection({
      isolated: true,
      interactive: false,
      prompt,
    })).resolves.toBe(false);
    expect(prompt).not.toHaveBeenCalled();
  });
});

describe("pairing product presentation", () => {
  it("renders and copies the exact same invitation payload", async () => {
    const lines: string[] = [];
    const rendered: string[] = [];
    await renderPairingInvitation("same-one-time-invitation", (line) => lines.push(line), async (value) => {
      rendered.push(value);
      return "terminal-qr";
    });

    expect(rendered).toEqual(["same-one-time-invitation"]);
    expect(lines).toEqual([
      "用另一台设备扫描下面的二维码，或复制二维码下方的邀请内容。",
      "terminal-qr",
      "邀请内容：same-one-time-invitation",
    ]);
  });

  it("reuses a blind relay as automatic duty-candidate reachability", async () => {
    await expect(resolveJoinerAnchorReachability({
      roles: ["anchor", "executor"],
      invitation: {
        transports: [{
          kind: "blind-relay",
          relay: { host: "relay.example", port: 443 },
        }],
      },
    })).resolves.toEqual({
      relayRegistration: { host: "relay.example", port: 443 },
    });
  });

  it("never exposes internal route or identity failures", () => {
    const route = pairingPublicError(new Error("No pairing rendezvous endpoint was reachable"));
    const identity = pairingPublicError(new Error("Joined home: home:secret-internal-id"));

    expect(route.message).toContain("请确认它们在同一网络");
    expect(route.message).not.toMatch(/rendezvous|endpoint|host|port/iu);
    expect(identity.message).not.toContain("home:secret-internal-id");
  });
});
