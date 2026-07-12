import { p256 } from "@cipherman/pake-js/spake2plus";
import {
  PairingPakeSuiteRegistry,
  SHORT_PAKE_SUITE,
  type PairingPakeSuite,
} from "./pairing.js";

if (p256.SUITE_NAME !== SHORT_PAKE_SUITE) {
  throw new TypeError("SPAKE2+ dependency suite does not match the pairing protocol");
}

export const CIPHERMAN_P256_PAKE_SUITE: PairingPakeSuite = Object.freeze({
  name: p256.SUITE_NAME,
  mhfOutputBytes: 80,
  clientShareBytes: 65,
  serverShareBytes: 65,
  confirmationBytes: 32,
  deriveScalars: p256.deriveScalars,
  registerVerifier: p256.registerVerifier,
  clientStart: p256.clientStart,
  clientFinish: p256.clientFinish,
  serverRespond: p256.serverRespond,
  deriveKeys: p256.deriveKeys,
  verifyConfirmation: p256.verifyConfirmation,
});

export const CIPHERMAN_PAIRING_PAKE_SUITES = new PairingPakeSuiteRegistry([
  CIPHERMAN_P256_PAKE_SUITE,
]);
