import { canonicalize } from "@zhixing/core/protocol";
import { createTempDir } from "@zhixing/test-utils";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  projectMeshPairingContinuationRepository,
  type PairingContinuation,
} from "./mesh-pairing-continuation-repository.js";
import {
  createFileMeshPairingContinuationRepository,
} from "./mesh-pairing-continuation.js";

const issuerPhases = [
  "offer-secret-pending",
  "offered",
  "secret-pending",
  "commit-ready",
] as const;
const joinerPhases = ["secret-pending", "proof-ready", "bootstrap-ready"] as const;

describe("Mesh pairing continuation repository", () => {
  it("exposes only the frozen finite continuation demand", async () => {
    const load = vi.fn(async () => undefined);
    const save = vi.fn(async (_state: PairingContinuation) => undefined);
    const clear = vi.fn(async (_offerId: string) => undefined);
    const repository = projectMeshPairingContinuationRepository({ load, save, clear });
    const state = issuerState("offered", "offer-finite");

    expect(Object.keys(repository).sort()).toEqual(["clear", "load", "save"]);
    expect(Object.isFrozen(repository)).toBe(true);
    await repository.load();
    await repository.save(state);
    await repository.clear("offer-finite");

    expect(load).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledWith(state);
    expect(clear).toHaveBeenCalledWith("offer-finite");
  });

  it("round-trips every current shallow v1 side and phase without inventing a second schema", async () => {
    const home = await createTempDir("mesh-pairing-continuation-phases");
    const store = createFileMeshPairingContinuationRepository(home);
    await expect(store.load()).resolves.toBeUndefined();

    const states = [
      ...issuerPhases.map((phase) => issuerState(phase, `issuer-${phase}`)),
      ...joinerPhases.map((phase) => joinerState(phase, `joiner-${phase}`)),
    ];
    for (const state of states) {
      await store.save(state);
      await expect(store.load()).resolves.toEqual(state);
      expect(await readFile(continuationPath(home), "utf8")).toBe(canonicalize(state));
    }
  });

  it("fails closed for non-canonical or unknown continuation records", async () => {
    const home = await createTempDir("mesh-pairing-continuation-invalid");
    const filePath = continuationPath(home);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, '{"side":"issuer","v":1,"phase":"offered","invitation":{"offer":{"offerId":"x"}}}', "utf8");
    await expect(createFileMeshPairingContinuationRepository(home).load()).rejects.toThrow(
      "Pairing continuation is not canonical",
    );

    const invalid = {
      v: 1,
      side: "issuer",
      phase: "future-phase",
      invitation: { offer: { offerId: "x" } },
    };
    await writeFile(filePath, canonicalize(invalid), "utf8");
    await expect(createFileMeshPairingContinuationRepository(home).load()).rejects.toThrow(
      "Pairing continuation is invalid",
    );
  });

  it("clears only the expected offer and leaves no temporary publication", async () => {
    const home = await createTempDir("mesh-pairing-continuation-clear");
    const store = createFileMeshPairingContinuationRepository(home);
    const state = issuerState("commit-ready", "offer-owned");
    await store.save(state);

    await expect(store.clear("offer-foreign")).rejects.toThrow(
      "Pairing continuation belongs to another offer",
    );
    await expect(store.load()).resolves.toEqual(state);
    await store.clear("offer-owned");
    await expect(store.load()).resolves.toBeUndefined();
    expect((await readdir(path.dirname(continuationPath(home)))).some((name) =>
      name.endsWith(".tmp")
    )).toBe(false);
  });

  it("serializes concurrent publications and accepts exact replay after response loss", async () => {
    const home = await createTempDir("mesh-pairing-continuation-replay");
    const first = issuerState("offered", "offer-concurrent");
    const second = issuerState("secret-pending", "offer-concurrent");
    await Promise.all([
      createFileMeshPairingContinuationRepository(home).save(first),
      createFileMeshPairingContinuationRepository(home).save(second),
    ]);
    const published = await createFileMeshPairingContinuationRepository(home).load();
    expect([first, second]).toContainEqual(published);

    const restarted = createFileMeshPairingContinuationRepository(home);
    await restarted.save(published!);
    await expect(restarted.load()).resolves.toEqual(published);
  });
});

function continuationPath(home: string): string {
  return path.join(home, "distributed-runtime", "mesh-pairing-continuation.json");
}

function issuerState(
  phase: typeof issuerPhases[number],
  offerId: string,
): PairingContinuation {
  return {
    v: 1,
    side: "issuer",
    phase,
    invitation: { offer: { offerId } },
  } as unknown as PairingContinuation;
}

function joinerState(
  phase: typeof joinerPhases[number],
  offerId: string,
): PairingContinuation {
  return {
    v: 1,
    side: "joiner",
    phase,
    invitation: { offer: { offerId }, issuer: {} },
    localDeviceId: "joiner-device",
  } as unknown as PairingContinuation;
}
