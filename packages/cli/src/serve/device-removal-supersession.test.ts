import { describe, expect, it } from "vitest";
import { pairingSupersedesRemoval } from "./device-removal.js";

const DIGEST = `sha256:${"a".repeat(64)}`;
const member = (deviceId: string, state: "active" | "revoked" | "pending-reenroll" = "active") => ({ state, device: { deviceId } });

// 显式重新配对是否取代旧移除：只看按键读出的当前成员、它最近一次配对的位置与旧接受点在本机链上的位置
describe("explicit pairing superseding an earlier device removal", () => {
  const identity = { targetDeviceId: "fp:target" };

  it("names the pairing of the same device after the acceptance point while it stays active", () => {
    expect(pairingSupersedesRemoval({ identity, acceptedSeq: 5, current: { member: member("fp:target"), pairing: { seq: 9, eventDigest: DIGEST } } }))
      .toBe(DIGEST);
  });

  it("does not supersede without a later pairing of exactly that device that is still active", () => {
    // 配对早于或就在接受点：这是旧移除针对的那次加入，配对之后新发起的移除不受影响
    expect(pairingSupersedesRemoval({ identity, acceptedSeq: 9, current: { member: member("fp:target"), pairing: { seq: 9, eventDigest: DIGEST } } })).toBeUndefined();
    expect(pairingSupersedesRemoval({ identity, acceptedSeq: 12, current: { member: member("fp:target"), pairing: { seq: 9, eventDigest: DIGEST } } })).toBeUndefined();
    // 配对之后又被撤销、仍待重新配对：旧移除照旧有效
    expect(pairingSupersedesRemoval({ identity, acceptedSeq: 5, current: { member: member("fp:target", "revoked"), pairing: { seq: 9, eventDigest: DIGEST } } })).toBeUndefined();
    expect(pairingSupersedesRemoval({ identity, acceptedSeq: 5, current: { member: member("fp:target", "pending-reenroll"), pairing: { seq: 9, eventDigest: DIGEST } } })).toBeUndefined();
    // 别的设备的配对、从未配对过（创始值班设备）、不是成员：都不取代
    expect(pairingSupersedesRemoval({ identity, acceptedSeq: 5, current: { member: member("fp:other"), pairing: { seq: 9, eventDigest: DIGEST } } })).toBeUndefined();
    expect(pairingSupersedesRemoval({ identity, acceptedSeq: 5, current: { member: member("fp:target") } })).toBeUndefined();
    expect(pairingSupersedesRemoval({ identity, acceptedSeq: 5, current: undefined })).toBeUndefined();
  });

  it("draws no derived conclusion when the acceptance point is not on the local chain", () => {
    expect(pairingSupersedesRemoval({ identity, acceptedSeq: undefined, current: { member: member("fp:target"), pairing: { seq: 9, eventDigest: DIGEST } } }))
      .toBeUndefined();
  });
});
