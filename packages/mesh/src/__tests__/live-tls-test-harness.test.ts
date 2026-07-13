import { describe, expect, it } from "vitest";
import { DeviceKey } from "../device-identity.js";
import {
  createLiveTlsTestHarness,
  type CurrentLiveTlsCredential,
} from "./live-tls-test-harness.js";

describe("live TLS test harness", () => {
  it("accepts current credentials and rejects credentials from a detached clock", async () => {
    const harness = createLiveTlsTestHarness();
    const currentKey = await DeviceKey.generate({ now: harness.now });

    const current = await harness.issueCredential(currentKey);
    expect(current).toMatchObject({
      deviceId: currentKey.deviceId,
    });
    expect(() =>
      harness.createRawServer(current, {
        pfx: Buffer.from("bypassed credential"),
      } as never),
    ).toThrow("Raw TLS credential material must be supplied by the test harness");

    const staleIssuedAt = harness.timestamp - 2 * 24 * 60 * 60_000;
    const staleKey = await DeviceKey.generate({ now: () => staleIssuedAt });
    await expect(
      harness.identity(staleKey).issueTlsCredential({
        now: () => staleIssuedAt,
        validityMs: 60 * 60_000,
      }),
    ).rejects.toThrow(
      "Live TLS test credentials must cover the captured system clock with a safety margin",
    );
  });

  it("brands expired credentials explicitly and rejects credentials that bypass the harness", async () => {
    const harness = createLiveTlsTestHarness();
    const staleIssuedAt = harness.timestamp - 2 * 24 * 60 * 60_000;
    const staleKey = await DeviceKey.generate({ now: () => staleIssuedAt });
    const expired = await staleKey.issueTlsCredential({
      now: () => staleIssuedAt,
      validityMs: 60 * 60_000,
    });

    expect(harness.acceptExpiredCredential(expired)).toBe(expired);

    const currentKey = await DeviceKey.generate({ now: harness.now });
    const bypassed = (await currentKey.issueTlsCredential({
      now: harness.now,
    })) as CurrentLiveTlsCredential;
    await expect(
      harness.openRawConnection(bypassed, {
        host: "127.0.0.1",
        port: 1,
        rejectUnauthorized: false,
      }),
    ).rejects.toThrow("Raw TLS clients require a harness-validated credential");
  });
});
