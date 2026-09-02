import type { EvidenceClientPort, Signature } from "@zhixing/core/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  AdvancementEvidenceHostBinding,
  AdvancementEvidenceTopologyAdapter,
  type AdvancementEvidenceRuntimePort,
} from "./advancement-evidence-topology.js";

describe("Advancement evidence topology", () => {
  it("selects the local client by executor identity and delegates only remote targets", () => {
    const local = client();
    const remoteClient = client();
    const remoteEvidenceClient = vi.fn((executorId: string) =>
      executorId === "executor-remote" ? remoteClient : undefined,
    );
    const targets = new AdvancementEvidenceTopologyAdapter({
      local: { executorId: "executor-local", client: local },
      remote: { remoteEvidenceClient },
    });

    expect(targets.clientForExecutor("executor-local")).toBe(local);
    expect(remoteEvidenceClient).not.toHaveBeenCalled();
    expect(targets.clientForExecutor("executor-remote")).toBe(remoteClient);
    expect(remoteEvidenceClient).toHaveBeenCalledExactlyOnceWith("executor-remote");
    expect(targets.clientForExecutor("executor-missing")).toBeUndefined();
  });

  it("fails closed before Host binding and rejects duplicate runtime ownership", async () => {
    const binding = new AdvancementEvidenceHostBinding();
    expect(() => binding.targets.clientForExecutor("executor-local")).toThrow(
      "Advancement evidence runtime is unavailable",
    );
    expect(() => binding.signer.sign("Evidence", 1, {})).toThrow(
      "Advancement evidence runtime is unavailable",
    );
    expect(() => binding.resolveTarget("conversation-1", "run-1")).toThrow(
      "Advancement evidence runtime is unavailable",
    );

    const local = client();
    const signature: Signature = {
      alg: "test",
      keyId: "device-1",
      sig: "signature",
    };
    const runtime: AdvancementEvidenceRuntimePort = {
      signer: { sign: () => signature },
      verifier: { verify: vi.fn() },
      resolveTarget: vi.fn(async () => undefined),
      targets: new AdvancementEvidenceTopologyAdapter({
        local: { executorId: "executor-local", client: local },
      }),
    };
    binding.bind(runtime);

    expect(binding.targets.clientForExecutor("executor-local")).toBe(local);
    expect(binding.signer.sign("Evidence", 1, {})).toBe(signature);
    await expect(binding.resolveTarget("conversation-1", "run-1")).resolves.toBeUndefined();
    expect(() => binding.bind(runtime)).toThrow(
      "Advancement evidence runtime is already bound",
    );
  });
});

function client(): EvidenceClientPort {
  return { collect: vi.fn() };
}
