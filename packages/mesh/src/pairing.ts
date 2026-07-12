import {
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomInt,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { p256 } from "@cipherman/pake-js/spake2plus";
import type {
  DeviceIdentity,
  KeyConfirmation,
  PairingAcceptance,
  PairingFinished,
  PairingJoin,
  PairingOffer,
  PakeRound,
  Signature,
} from "@zhixing/core/contracts";
import { protocolBytes, protocolDigest } from "./canonical.js";
import { verifyDeviceSignature } from "./device-identity.js";
import { createUlid } from "./identifiers.js";
import { decodeCanonicalBase64Url } from "./recovery-root.js";

const OFFER_LIFETIME_MS = 120_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const QR_SECRET_BYTES = 32;
const PAKE_CONTEXT = "zhixing-device-pairing-v1";

export const SHORT_PAKE_SUITE = p256.SUITE_NAME;

export interface PairingPakeSuite {
  readonly name: string;
  readonly mhfOutputBytes: number;
  readonly clientShareBytes: number;
  readonly serverShareBytes: number;
  readonly confirmationBytes: number;
  deriveScalars(mhfOutput: Uint8Array): { w0: Uint8Array; w1: Uint8Array };
  registerVerifier(w1: Uint8Array): Uint8Array;
  clientStart(w0: Uint8Array): { x: Uint8Array; shareP: Uint8Array };
  clientFinish(input: {
    w0: Uint8Array;
    w1: Uint8Array;
    x: Uint8Array;
    shareV: Uint8Array;
  }): { Z: Uint8Array; V: Uint8Array };
  serverRespond(input: {
    w0: Uint8Array;
    L: Uint8Array;
    shareP: Uint8Array;
  }): { shareV: Uint8Array; Z: Uint8Array; V: Uint8Array };
  deriveKeys(input: {
    context: Uint8Array;
    idProver: Uint8Array;
    idVerifier: Uint8Array;
    w0: Uint8Array;
    shareP: Uint8Array;
    shareV: Uint8Array;
    Z: Uint8Array;
    V: Uint8Array;
  }): {
    K_shared: Uint8Array;
    confirmP: Uint8Array;
    confirmV: Uint8Array;
  };
  verifyConfirmation(expected: Uint8Array, received: Uint8Array): boolean;
}

export class PairingPakeSuiteRegistry {
  private readonly suites: ReadonlyMap<string, PairingPakeSuite>;

  constructor(suites: readonly PairingPakeSuite[]) {
    const byName = new Map<string, PairingPakeSuite>();
    for (const suite of suites) {
      if (!suite.name || byName.has(suite.name)) throw new TypeError("PAKE suite names must be unique");
      for (const size of [
        suite.mhfOutputBytes,
        suite.clientShareBytes,
        suite.serverShareBytes,
        suite.confirmationBytes,
      ]) {
        if (!Number.isSafeInteger(size) || size <= 0) throw new TypeError("PAKE suite sizes must be positive");
      }
      byName.set(
        suite.name,
        Object.freeze({
          name: suite.name,
          mhfOutputBytes: suite.mhfOutputBytes,
          clientShareBytes: suite.clientShareBytes,
          serverShareBytes: suite.serverShareBytes,
          confirmationBytes: suite.confirmationBytes,
          deriveScalars: suite.deriveScalars.bind(suite),
          registerVerifier: suite.registerVerifier.bind(suite),
          clientStart: suite.clientStart.bind(suite),
          clientFinish: suite.clientFinish.bind(suite),
          serverRespond: suite.serverRespond.bind(suite),
          deriveKeys: suite.deriveKeys.bind(suite),
          verifyConfirmation: suite.verifyConfirmation.bind(suite),
        }),
      );
    }
    this.suites = byName;
  }

  require(name: string): PairingPakeSuite {
    const suite = this.suites.get(name);
    if (!suite) throw new TypeError(`Unsupported PAKE suite: ${name}`);
    return suite;
  }
}

export const DEFAULT_PAIRING_PAKE_SUITES = new PairingPakeSuiteRegistry([
  {
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
  },
]);

export interface PairingSigner {
  readonly deviceId: string;
  sign(schemaId: string, version: number, payload: unknown): Signature;
}

export interface PairingOfferMaterial {
  readonly offer: PairingOffer;
  readonly secret: string;
}

export interface PairingOfferRepository {
  get(offerId: string): PairingOfferMaterial | undefined;
  remove(offerId: string): void;
}

export class InMemoryPairingOfferRepository implements PairingOfferRepository {
  private readonly offers = new Map<string, PairingOfferMaterial>();

  issueQr(input: Parameters<typeof createQrPairingOffer>[0]): PairingOfferMaterial {
    return this.add(createQrPairingOffer(input));
  }

  issueShortCode(input: Parameters<typeof createShortCodePairingOffer>[0]): PairingOfferMaterial {
    return this.add(createShortCodePairingOffer(input));
  }

  get(offerId: string): PairingOfferMaterial | undefined {
    return this.offers.get(offerId);
  }

  remove(offerId: string): void {
    this.offers.delete(offerId);
  }

  private add(material: PairingOfferMaterial): PairingOfferMaterial {
    if (this.offers.has(material.offer.offerId)) throw new TypeError("Pairing offer id collision");
    this.offers.set(material.offer.offerId, material);
    return material;
  }
}

export function createQrPairingOffer(input: {
  homeId: string;
  issuer: DeviceIdentity;
  protocolVersion: string;
  now?: number;
  maxAttempts?: number;
}): PairingOfferMaterial {
  return createOffer(input, { kind: "qr-secret" }, randomBytes(QR_SECRET_BYTES).toString("base64url"));
}

export function createShortCodePairingOffer(input: {
  homeId: string;
  issuer: DeviceIdentity;
  protocolVersion: string;
  now?: number;
  maxAttempts?: number;
}): PairingOfferMaterial {
  const code = randomInt(0, 100_000_000).toString().padStart(8, "0");
  return createOffer(input, { kind: "short-pake", suite: SHORT_PAKE_SUITE }, code);
}

export function createQrPairingJoin(
  offer: PairingOffer,
  device: DeviceIdentity,
  secret: string,
): PairingJoin {
  assertOfferMethod(offer, "qr-secret");
  const joinWithoutConfirmation = {
    v: 1 as const,
    method: "qr-secret" as const,
    offerId: offer.offerId,
    device,
    joinerNonce: randomBytes(32).toString("base64url"),
  };
  return {
    ...joinWithoutConfirmation,
    confirmation: pairingMac(
      secret,
      "PairingJoinConfirmation",
      { offer, join: joinWithoutConfirmation },
    ),
  };
}

export function verifyQrPairingJoin(
  offer: PairingOffer,
  join: PairingJoin,
  secret: string,
  now = Date.now(),
): void {
  assertOfferUsable(offer, join, now);
  if (join.method !== "qr-secret" || offer.method.kind !== "qr-secret") {
    throw new TypeError("QR join does not match the pairing offer");
  }
  const expected = pairingMac(secret, "PairingJoinConfirmation", {
    offer,
    join: {
      v: join.v,
      method: join.method,
      offerId: join.offerId,
      device: join.device,
      joinerNonce: join.joinerNonce,
    },
  });
  if (!constantTimeStringEqual(expected, join.confirmation)) {
    throw new TypeError("QR pairing confirmation is invalid");
  }
}

export function assertPairingOfferJoin(
  offer: PairingOffer,
  join: PairingJoin,
  issuer: DeviceIdentity,
  now = Date.now(),
): void {
  assertOfferUsable(offer, join, now);
  assertOfferMethod(offer, offer.method.kind);
  assertOfferIssuer(offer, issuer);
  if (offer.method.kind !== join.method) {
    throw new TypeError("Pairing join method does not match its offer");
  }
}

export function pairingTranscriptDigest(
  offer: PairingOffer,
  join: PairingJoin,
  pakeRounds: readonly PakeRound[],
): string {
  assertPakeRounds(offer, pakeRounds);
  return protocolDigest("PairingTranscript", 1, {
    offer,
    join,
    pakeRounds: [...pakeRounds],
  });
}

export function pairingOfferDigest(offer: PairingOffer): string {
  return protocolDigest("PairingOffer", 1, offer);
}

export class PakeJoinerSession {
  readonly firstRound: PakeRound;
  private state: "waiting-issuer" | "complete" | "failed" = "waiting-issuer";
  private sessionKeyValue?: Buffer;

  private constructor(
    private readonly offer: PairingOffer,
    private readonly join: Extract<PairingJoin, { method: "short-pake" }>,
    private readonly w0: Uint8Array,
    private readonly w1: Uint8Array,
    private readonly x: Uint8Array,
    private readonly suite: PairingPakeSuite,
    shareP: Uint8Array,
  ) {
    this.firstRound = round(offer.offerId, 1, "joiner", shareP);
  }

  static async start(
    offer: PairingOffer,
    device: DeviceIdentity,
    shortCode: string,
    now = Date.now(),
    suites = DEFAULT_PAIRING_PAKE_SUITES,
  ): Promise<{ join: Extract<PairingJoin, { method: "short-pake" }>; session: PakeJoinerSession }> {
    assertOfferMethod(offer, "short-pake");
    if (offer.method.kind !== "short-pake") throw new TypeError("Expected short-pake pairing offer");
    assertOfferFresh(offer, now);
    const join: Extract<PairingJoin, { method: "short-pake" }> = {
      v: 1,
      method: "short-pake",
      offerId: offer.offerId,
      device,
      joinerNonce: randomBytes(32).toString("base64url"),
    };
    const suite = suites.require(offer.method.suite);
    const { w0, w1 } = await derivePakeScalars(shortCode, offer, join, suite);
    const started = suite.clientStart(w0);
    return {
      join,
      session: new PakeJoinerSession(offer, join, w0, w1, started.x, suite, started.shareP),
    };
  }

  finish(issuerRound: PakeRound): PakeRound {
    if (this.state !== "waiting-issuer") {
      throw new TypeError("PAKE joiner session is already complete or failed");
    }
    let sharedKey: Uint8Array | undefined;
    let sharedPointZ: Uint8Array | undefined;
    let sharedPointV: Uint8Array | undefined;
    let proverConfirmation: Uint8Array | undefined;
    let verifierConfirmation: Uint8Array | undefined;
    try {
      assertRound(issuerRound, this.offer.offerId, 2, "issuer");
      const payload = decodeRoundPayload(
        issuerRound.payload,
        this.suite.serverShareBytes + this.suite.confirmationBytes,
      );
      const shareV = payload.subarray(0, this.suite.serverShareBytes);
      const confirmV = payload.subarray(this.suite.serverShareBytes);
      const values = this.suite.clientFinish({
        w0: this.w0,
        w1: this.w1,
        x: this.x,
        shareV,
      });
      sharedPointZ = values.Z;
      sharedPointV = values.V;
      const keys = this.suite.deriveKeys({
        ...pakeTranscriptFields(this.offer, this.join),
        w0: this.w0,
        shareP: decodeRoundPayload(this.firstRound.payload, this.suite.clientShareBytes),
        shareV,
        Z: values.Z,
        V: values.V,
      });
      sharedKey = keys.K_shared;
      proverConfirmation = keys.confirmP;
      verifierConfirmation = keys.confirmV;
      if (!this.suite.verifyConfirmation(keys.confirmV, confirmV)) {
        throw new TypeError("PAKE issuer key confirmation failed");
      }
      this.sessionKeyValue = Buffer.from(keys.K_shared);
      this.state = "complete";
      return round(this.offer.offerId, 3, "joiner", keys.confirmP);
    } catch (error) {
      this.state = "failed";
      this.sessionKeyValue?.fill(0);
      this.sessionKeyValue = undefined;
      throw error;
    } finally {
      this.w0.fill(0);
      this.w1.fill(0);
      this.x.fill(0);
      sharedKey?.fill(0);
      sharedPointZ?.fill(0);
      sharedPointV?.fill(0);
      proverConfirmation?.fill(0);
      verifierConfirmation?.fill(0);
    }
  }

  sessionKey(): Buffer {
    if (!this.sessionKeyValue) throw new TypeError("PAKE joiner session is incomplete");
    return Buffer.from(this.sessionKeyValue);
  }
}

export class PakeIssuerSession {
  readonly responseRound: PakeRound;
  private state: "waiting-joiner" | "complete" | "failed" = "waiting-joiner";
  private readonly expectedConfirmation: Uint8Array;
  private readonly sessionKeyValue: Buffer;

  private constructor(
    private readonly offer: PairingOffer,
    private readonly suite: PairingPakeSuite,
    expectedConfirmation: Uint8Array,
    sessionKey: Uint8Array,
    responseRound: PakeRound,
  ) {
    this.expectedConfirmation = Buffer.from(expectedConfirmation);
    this.sessionKeyValue = Buffer.from(sessionKey);
    this.responseRound = responseRound;
  }

  static async respond(
    offer: PairingOffer,
    join: PairingJoin,
    joinerRound: PakeRound,
    shortCode: string,
    now = Date.now(),
    suites = DEFAULT_PAIRING_PAKE_SUITES,
  ): Promise<PakeIssuerSession> {
    assertOfferUsable(offer, join, now);
    if (offer.method.kind !== "short-pake" || join.method !== "short-pake") {
      throw new TypeError("PAKE join does not match the pairing offer");
    }
    assertRound(joinerRound, offer.offerId, 1, "joiner");
    const suite = suites.require(offer.method.suite);
    const { w0, w1 } = await derivePakeScalars(shortCode, offer, join, suite);
    let sharedPointZ: Uint8Array | undefined;
    let sharedPointV: Uint8Array | undefined;
    let sharedKey: Uint8Array | undefined;
    let proverConfirmation: Uint8Array | undefined;
    let verifierConfirmation: Uint8Array | undefined;
    try {
      const shareP = decodeRoundPayload(joinerRound.payload, suite.clientShareBytes);
      const verifier = suite.registerVerifier(w1);
      const values = suite.serverRespond({ w0, L: verifier, shareP });
      sharedPointZ = values.Z;
      sharedPointV = values.V;
      const keys = suite.deriveKeys({
        ...pakeTranscriptFields(offer, join),
        w0,
        shareP,
        shareV: values.shareV,
        Z: values.Z,
        V: values.V,
      });
      sharedKey = keys.K_shared;
      proverConfirmation = keys.confirmP;
      verifierConfirmation = keys.confirmV;
      return new PakeIssuerSession(
        offer,
        suite,
        keys.confirmP,
        keys.K_shared,
        round(offer.offerId, 2, "issuer", Buffer.concat([values.shareV, keys.confirmV])),
      );
    } finally {
      w0.fill(0);
      w1.fill(0);
      sharedPointZ?.fill(0);
      sharedPointV?.fill(0);
      sharedKey?.fill(0);
      proverConfirmation?.fill(0);
      verifierConfirmation?.fill(0);
    }
  }

  finish(joinerRound: PakeRound): Buffer {
    if (this.state !== "waiting-joiner") {
      throw new TypeError("PAKE issuer session is already complete or failed");
    }
    try {
      assertRound(joinerRound, this.offer.offerId, 3, "joiner");
      if (
        !this.suite.verifyConfirmation(
          this.expectedConfirmation,
          decodeRoundPayload(joinerRound.payload, this.suite.confirmationBytes),
        )
      ) {
        throw new TypeError("PAKE joiner key confirmation failed");
      }
      this.state = "complete";
      return Buffer.from(this.sessionKeyValue);
    } catch (error) {
      this.state = "failed";
      throw error;
    } finally {
      this.expectedConfirmation.fill(0);
      this.sessionKeyValue.fill(0);
    }
  }
}

export function createPairingAcceptanceProof(input: {
  acceptance: Omit<PairingAcceptance, "finished">;
  role: "issuer" | "joiner";
  signer: PairingSigner;
  method: "qr-secret" | "short-pake";
  sessionKey?: Uint8Array;
}): { sig: Signature; keyConfirm?: KeyConfirmation } {
  const sig = input.signer.sign("PairingAcceptance", 1, input.acceptance);
  if (input.method === "qr-secret") return { sig };
  if (!input.sessionKey) throw new TypeError("PAKE finished proof requires the session key");
  return {
    sig,
    keyConfirm: pairingFinishedMac(input.sessionKey, input.role, input.acceptance),
  };
}

export function assemblePairingFinished(input: {
  method: "qr-secret" | "short-pake";
  issuer: { sig: Signature; keyConfirm?: KeyConfirmation };
  joiner: { sig: Signature; keyConfirm?: KeyConfirmation };
}): PairingFinished {
  if (input.method === "qr-secret") {
    return { method: "qr-secret", issuer: { sig: input.issuer.sig }, joiner: { sig: input.joiner.sig } };
  }
  if (!input.issuer.keyConfirm || !input.joiner.keyConfirm) {
    throw new TypeError("PAKE finished proof requires both key confirmations");
  }
  return {
    method: "short-pake",
    issuer: { sig: input.issuer.sig, keyConfirm: input.issuer.keyConfirm },
    joiner: { sig: input.joiner.sig, keyConfirm: input.joiner.keyConfirm },
  };
}

export function verifyPairingAcceptance(input: {
  acceptance: PairingAcceptance;
  offer: PairingOffer;
  issuer: DeviceIdentity;
  joiner: DeviceIdentity;
  sessionKey?: Uint8Array;
}): void {
  if (
    input.acceptance.v !== 1 ||
    !Number.isSafeInteger(input.acceptance.chainHead.seq) ||
    input.acceptance.chainHead.seq < 0
  ) {
    throw new TypeError("Pairing acceptance contract is invalid");
  }
  if (input.acceptance.offerId !== input.offer.offerId) {
    throw new TypeError("Pairing acceptance belongs to another offer");
  }
  const expectedMethod = input.offer.method.kind;
  if (input.acceptance.finished.method !== expectedMethod) {
    throw new TypeError("Pairing acceptance method does not match its offer");
  }
  const body = acceptanceBody(input.acceptance);
  const acceptedAt = assertCanonicalTime(input.acceptance.acceptedAt, "Pairing acceptance time");
  assertOfferFresh(input.offer, acceptedAt);
  assertOfferIssuer(input.offer, input.issuer);
  verifyDeviceSignature(input.issuer, "PairingAcceptance", 1, body, input.acceptance.finished.issuer.sig);
  verifyDeviceSignature(input.joiner, "PairingAcceptance", 1, body, input.acceptance.finished.joiner.sig);
  if (input.acceptance.finished.method === "short-pake") {
    if (!input.sessionKey) throw new TypeError("PAKE acceptance verification requires the session key");
    const issuerExpected = pairingFinishedMac(input.sessionKey, "issuer", body);
    const joinerExpected = pairingFinishedMac(input.sessionKey, "joiner", body);
    if (
      !constantTimeStringEqual(issuerExpected, input.acceptance.finished.issuer.keyConfirm) ||
      !constantTimeStringEqual(joinerExpected, input.acceptance.finished.joiner.keyConfirm)
    ) {
      throw new TypeError("Pairing finished key confirmation is invalid");
    }
  }
}

function createOffer(
  input: {
    homeId: string;
    issuer: DeviceIdentity;
    protocolVersion: string;
    now?: number;
    maxAttempts?: number;
  },
  method: PairingOffer["method"],
  secret: string,
): PairingOfferMaterial {
  const now = input.now ?? Date.now();
  const max = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (!Number.isSafeInteger(max) || max <= 0) throw new TypeError("Pairing attempts must be positive");
  const publicKeyBytes = decodeDevicePublicKey(input.issuer.publicKey);
  const offer: PairingOffer = Object.freeze({
    v: 1,
    offerId: createUlid(now),
    homeId: input.homeId,
    protocolVersion: input.protocolVersion,
    issuer: {
      deviceId: input.issuer.deviceId,
      keyFingerprint: `sha256:${createHash("sha256").update(publicKeyBytes).digest("hex")}`,
    },
    issuerNonce: randomBytes(32).toString("base64url"),
    method,
    expiresAt: new Date(now + OFFER_LIFETIME_MS).toISOString(),
    singleUse: true,
    attempts: { max, onExhaust: "expire" as const },
  });
  return Object.freeze({ offer, secret });
}

async function derivePakeScalars(
  shortCode: string,
  offer: PairingOffer,
  join: Extract<PairingJoin, { method: "short-pake" }>,
  suite: PairingPakeSuite,
): Promise<{ w0: Uint8Array; w1: Uint8Array }> {
  if (!/^\d{8}$/.test(shortCode)) throw new TypeError("Pairing code must contain eight digits");
  const password = protocolBytes("PairingShortCode", 1, {
    shortCode,
    offerId: offer.offerId,
    issuerDeviceId: offer.issuer.deviceId,
    joinerDeviceId: join.device.deviceId,
  });
  const salt = createHash("sha256")
    .update(
      protocolBytes("PairingPakeSalt", 1, {
        homeId: offer.homeId,
        offerId: offer.offerId,
        issuerNonce: offer.issuerNonce,
        joinerNonce: join.joinerNonce,
      }),
    )
    .digest();
  let output: Buffer | undefined;
  try {
    output = await runScrypt(password, salt, suite.mhfOutputBytes, {
      N: 1 << 15,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
    return suite.deriveScalars(output);
  } finally {
    password.fill(0);
    output?.fill(0);
  }
}

function runScrypt(
  password: Uint8Array,
  salt: Uint8Array,
  outputBytes: number,
  options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, outputBytes, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

function pakeTranscriptFields(
  offer: PairingOffer,
  join: Extract<PairingJoin, { method: "short-pake" }>,
): { context: Uint8Array; idProver: Uint8Array; idVerifier: Uint8Array } {
  return {
    context: protocolBytes("PairingPakeContext", 1, { application: PAKE_CONTEXT, offer, join }),
    idProver: Buffer.from(join.device.deviceId, "utf8"),
    idVerifier: Buffer.from(offer.issuer.deviceId, "utf8"),
  };
}

function pairingMac(secret: string, schemaId: string, payload: unknown): KeyConfirmation {
  const key = decodeCanonicalBase64Url(secret, "QR pairing secret");
  if (key.byteLength !== QR_SECRET_BYTES) throw new TypeError("QR pairing secret must be 256 bits");
  try {
    return `hmac-sha256:${createHmac("sha256", key)
      .update(protocolBytes(schemaId, 1, payload))
      .digest("base64url")}`;
  } finally {
    key.fill(0);
  }
}

function pairingFinishedMac(
  sessionKey: Uint8Array,
  role: "issuer" | "joiner",
  payload: unknown,
): KeyConfirmation {
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      sessionKey,
      Buffer.from("zhixing-pairing-finished-v1", "utf8"),
      Buffer.from(role, "utf8"),
      32,
    ),
  );
  try {
    return `hmac-sha256:${createHmac("sha256", key)
      .update(protocolBytes("PairingFinished", 1, payload))
      .digest("base64url")}`;
  } finally {
    key.fill(0);
  }
}

function acceptanceBody(acceptance: PairingAcceptance): Omit<PairingAcceptance, "finished"> {
  return {
    v: acceptance.v,
    offerId: acceptance.offerId,
    transcriptDigest: acceptance.transcriptDigest,
    chainHead: acceptance.chainHead,
    acceptedAt: acceptance.acceptedAt,
  };
}

function round(
  offerId: string,
  number: number,
  from: "issuer" | "joiner",
  payload: Uint8Array,
): PakeRound {
  return { v: 1, offerId, round: number, from, payload: Buffer.from(payload).toString("base64url") };
}

function assertPakeRounds(offer: PairingOffer, rounds: readonly PakeRound[]): void {
  if (offer.method.kind === "qr-secret") {
    if (rounds.length !== 0) throw new TypeError("QR pairing cannot contain PAKE rounds");
    return;
  }
  if (rounds.length !== 3) throw new TypeError("PAKE pairing requires exactly three rounds");
  assertRound(rounds[0]!, offer.offerId, 1, "joiner");
  assertRound(rounds[1]!, offer.offerId, 2, "issuer");
  assertRound(rounds[2]!, offer.offerId, 3, "joiner");
}

function assertRound(
  value: PakeRound,
  offerId: string,
  number: number,
  from: "issuer" | "joiner",
): void {
  if (value.v !== 1 || value.offerId !== offerId || value.round !== number || value.from !== from) {
    throw new TypeError(`Invalid PAKE round ${number}`);
  }
}

function decodeRoundPayload(value: string, bytes: number): Buffer {
  const decoded = decodeCanonicalBase64Url(value, "PAKE round payload");
  if (decoded.byteLength !== bytes) throw new TypeError("PAKE round payload has an invalid length");
  return decoded;
}

function assertOfferUsable(offer: PairingOffer, join: PairingJoin, now: number): void {
  assertOfferFresh(offer, now);
  const joinerNonce = decodeCanonicalBase64Url(join.joinerNonce, "Pairing joiner nonce");
  if (
    join.v !== 1 ||
    (join.method !== "qr-secret" && join.method !== "short-pake") ||
    joinerNonce.byteLength !== 32 ||
    join.offerId !== offer.offerId ||
    join.device.deviceId === offer.issuer.deviceId
  ) {
    throw new TypeError("Pairing join does not match the offer");
  }
}

function assertOfferFresh(offer: PairingOffer, now: number): void {
  const issuerNonce = decodeCanonicalBase64Url(offer.issuerNonce, "Pairing issuer nonce");
  if (
    offer.v !== 1 ||
    offer.offerId.length === 0 ||
    offer.homeId.length === 0 ||
    offer.protocolVersion.length === 0 ||
    offer.issuer.deviceId.length === 0 ||
    issuerNonce.byteLength !== 32 ||
    (offer.method.kind !== "qr-secret" && offer.method.kind !== "short-pake") ||
    (offer.method.kind === "short-pake" &&
      (typeof offer.method.suite !== "string" || offer.method.suite.length === 0)) ||
    offer.singleUse !== true ||
    !Number.isSafeInteger(offer.attempts.max) ||
    offer.attempts.max <= 0 ||
    offer.attempts.onExhaust !== "expire" ||
    !Number.isFinite(now)
  ) {
    throw new TypeError("Pairing offer contract is invalid");
  }
  const expiresAt = Date.parse(offer.expiresAt);
  if (
    !Number.isFinite(expiresAt) ||
    new Date(expiresAt).toISOString() !== offer.expiresAt ||
    now >= expiresAt
  ) {
    throw new TypeError("Pairing offer has expired or has a non-canonical expiry");
  }
}

function assertCanonicalTime(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new TypeError(`${label} must be canonical ISO`);
  }
  return parsed;
}

function assertOfferMethod(offer: PairingOffer, method: PairingOffer["method"]["kind"]): void {
  if (offer.method.kind !== method) throw new TypeError(`Expected ${method} pairing offer`);
  if (method === "short-pake" && offer.method.kind === "short-pake" && !offer.method.suite) {
    throw new TypeError("PAKE suite name is required");
  }
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

function decodeDevicePublicKey(value: string): Buffer {
  if (!value.startsWith("ed25519:")) throw new TypeError("Pairing issuer must use Ed25519");
  return decodeCanonicalBase64Url(value.slice("ed25519:".length), "Device public key");
}

function assertOfferIssuer(offer: PairingOffer, issuer: DeviceIdentity): void {
  if (offer.issuer.deviceId !== issuer.deviceId) {
    throw new TypeError("Pairing offer issuer does not match the accepting device");
  }
  const fingerprint = `sha256:${createHash("sha256")
    .update(decodeDevicePublicKey(issuer.publicKey))
    .digest("hex")}`;
  if (offer.issuer.keyFingerprint !== fingerprint) {
    throw new TypeError("Pairing offer issuer fingerprint is invalid");
  }
}
