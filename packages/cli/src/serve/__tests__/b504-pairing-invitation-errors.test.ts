import { canonicalize } from "@zhixing-ai/core/protocol";
import { DeviceKey, enrollDeviceIdentity } from "@zhixing-ai/mesh/device-identity";
import { describe, expect, it } from "vitest";
import {
  decodeInvitation,
  PairingInvitationError,
  pairingPublicError,
  runPairCommand,
} from "../mesh-pair-command.js";

function toBase64Url(value: unknown): string {
  return Buffer.from(canonicalize(value), "utf8").toString("base64url");
}

describe("B5-04 pairing invitation validation and public error classification", () => {
  it("classifies non-base64, non-JSON base64url, and structurally malformed invitations as invalid invitations without leaking raw input or cause", async () => {
    const secretMarker = "SUPER_SECRET_RAW_PAYLOAD_DO_NOT_LOG";
    const validBase64NonJson = Buffer.from(`not-json:${secretMarker}`, "utf8").toString("base64url");
    const samples = [
      "!!!",
      "abcd",
      "not-a-valid-invitation-token",
      validBase64NonJson,
      Buffer.from(Uint8Array.from([0xff, 0xfe, 0xfd])).toString("base64url"),
      toBase64Url({ v: 1 }),
      toBase64Url({
        v: 1,
        issuer: { deviceId: "dev-1" },
        offer: { issuer: { deviceId: "dev-1" }, offerId: "o1", homeId: "h1", expiresAt: "not-a-date", method: { kind: "qr-secret" } },
        qrSecret: "secret-1",
        rendezvousKey: "bad",
        transports: [{ kind: "direct-lan", host: "127.0.0.1", port: 99999 }],
      }),
    ];

    for (const sample of samples) {
      let caught: unknown;
      try {
        decodeInvitation(sample);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PairingInvitationError);
      const typed = caught as PairingInvitationError;
      expect(typed.reason).toBe("malformed");
      expect(typed.cause).toBeUndefined();
      expect(typed.message).not.toContain(sample);
      expect(typed.message).not.toContain(secretMarker);

      const publicErr = pairingPublicError(typed);
      expect(publicErr.message).toBe(
        "配对邀请内容无效或不完整。请核对复制的邀请内容是否完整，或回到出码设备重新运行 zz pair 获取新的邀请后再试。",
      );
      expect(publicErr.message).not.toContain("配对尚未完整结束");
      expect(publicErr.message).not.toContain("同一网络");
      expect(publicErr.message).not.toContain(secretMarker);
    }

    await expect(
      runPairCommand({
        zhixingHome: "/nonexistent-home-should-never-be-opened",
        invitation: "abcd",
      }),
    ).rejects.toBeInstanceOf(PairingInvitationError);
  });

  it("distinguishes expired structurally-valid invitations from malformed invitations while keeping allowExpired resume intact", async () => {
    const key = await DeviceKey.generate();
    const issuer = enrollDeviceIdentity(key, {
      displayName: "issuer-host",
      platform: "headless",
      enrolledAt: "2026-08-10T00:00:00.000Z",
    });
    const rendezvousKey = `rzv:${"a".repeat(64)}`;
    const qrSecret = Buffer.alloc(32, 5).toString("base64url");
    const expiredInvitation = toBase64Url({
      v: 1,
      issuer,
      offer: {
        v: 1,
        offerId: "offer-expired-1",
        homeId: "home-1",
        issuer,
        method: { kind: "qr-secret" },
        issuedAt: "2020-01-01T00:00:00.000Z",
        expiresAt: "2020-01-01T00:10:00.000Z",
      },
      qrSecret,
      rendezvousKey,
      transports: [{ kind: "direct", host: "127.0.0.1", port: 43210 }],
    });

    let caught: unknown;
    try {
      decodeInvitation(expiredInvitation);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PairingInvitationError);
    expect((caught as PairingInvitationError).reason).toBe("expired");
    expect((caught as PairingInvitationError).message).not.toContain(qrSecret);
    expect(pairingPublicError(caught).message).toBe(
      "这份配对邀请已经失效或不能再次使用。请回到出码设备重新运行 zz pair，再扫描或复制新的邀请内容。",
    );

    // Resumable joiner continuation still decodes expired invitations when allowExpired is true
    expect(decodeInvitation(expiredInvitation, { allowExpired: true }).offer.offerId).toBe("offer-expired-1");
  });

  it("does not misclassify post-decode SyntaxError, network failure, or genuine interrupted pairing progress as bad invitations", () => {
    expect(pairingPublicError(new SyntaxError("Unexpected token in local continuation file")).message).toBe(
      "配对尚未完整结束，已经完成的安全步骤会被保留。请在当前设备重新运行 zz pair 继续。",
    );
    expect(pairingPublicError(new Error("Pairing socket closed during rendezvous")).message).toBe(
      "两台设备暂时无法连接。请确认它们在同一网络后，回到出码设备重新运行 zz pair。",
    );
    expect(pairingPublicError(new Error("Recovery root activation interrupted")).message).toBe(
      "恢复码设置尚未完成。请保留刚才的恢复码，并在当前设备重新运行 zz pair 继续。",
    );
  });
});
