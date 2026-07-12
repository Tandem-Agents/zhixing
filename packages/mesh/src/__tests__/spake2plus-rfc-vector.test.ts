import { readFile } from "node:fs/promises";
import { p256 } from "@cipherman/pake-js/spake2plus";
import { describe, expect, it } from "vitest";

interface RfcVector {
  suite: string;
  contextUtf8: string;
  idProverUtf8: string;
  idVerifierUtf8: string;
  w0: string;
  w1: string;
  L: string;
  x: string;
  shareP: string;
  y: string;
  shareV: string;
  Z: string;
  V: string;
  K_main: string;
  K_confirmP: string;
  K_confirmV: string;
  confirmP: string;
  confirmV: string;
  K_shared: string;
}

const vector = JSON.parse(
  await readFile(
    new URL("./fixtures/rfc9383-spake2plus-p256-sha256.json", import.meta.url),
    "utf8",
  ),
) as RfcVector;

describe("SPAKE2+ RFC 9383 conformance", () => {
  it("matches the published P-256/SHA-256 vector byte for byte", () => {
    expect(p256.SUITE_NAME).toBe(vector.suite);
    const w0 = fromHex(vector.w0);
    const w1 = fromHex(vector.w1);
    const verifier = p256.registerVerifier(w1);
    expectHex(verifier, vector.L);

    const prover = p256.__clientStartWithScalar(w0, BigInt(`0x${vector.x}`));
    expectHex(prover.shareP, vector.shareP);
    const responder = p256.__serverRespondWithScalar(
      { w0, L: verifier, shareP: prover.shareP },
      BigInt(`0x${vector.y}`),
    );
    expectHex(responder.shareV, vector.shareV);
    expectHex(responder.Z, vector.Z);
    expectHex(responder.V, vector.V);

    const finished = p256.clientFinish({
      w0,
      w1,
      x: prover.x,
      shareV: responder.shareV,
    });
    expectHex(finished.Z, vector.Z);
    expectHex(finished.V, vector.V);

    const keys = p256.deriveKeys({
      context: Buffer.from(vector.contextUtf8, "utf8"),
      idProver: Buffer.from(vector.idProverUtf8, "utf8"),
      idVerifier: Buffer.from(vector.idVerifierUtf8, "utf8"),
      w0,
      shareP: prover.shareP,
      shareV: responder.shareV,
      Z: finished.Z,
      V: finished.V,
    });
    for (const field of [
      "K_main",
      "K_confirmP",
      "K_confirmV",
      "confirmP",
      "confirmV",
      "K_shared",
    ] as const) {
      expectHex(keys[field], vector[field]);
    }
    expect(p256.verifyConfirmation(keys.confirmP, fromHex(vector.confirmP))).toBe(true);
    expect(p256.verifyConfirmation(keys.confirmV, fromHex(vector.confirmV))).toBe(true);
  });
});

function fromHex(value: string): Buffer {
  return Buffer.from(value, "hex");
}

function expectHex(actual: Uint8Array, expected: string): void {
  expect(Buffer.from(actual).toString("hex")).toBe(expected);
}
