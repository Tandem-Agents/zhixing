import { describe, expect, it } from "vitest";
import {
  negotiateMeshProtocol,
  snapshotMeshProtocolRange,
} from "../protocol-version.js";

describe("mesh protocol compatibility", () => {
  it("uses the highest shared canonical string version", () => {
    const compatibility = negotiateMeshProtocol(
      { min: "2", max: "12" },
      { min: "1", max: "10" },
    );

    expect(compatibility).toEqual({
      mode: "read-write",
      protocolVersion: "10",
    });
    expect(Object.isFrozen(compatibility)).toBe(true);
  });

  it("returns an explicit read-only result when ranges do not overlap", () => {
    expect(
      negotiateMeshProtocol(
        { min: "1", max: "1" },
        { min: "2", max: "2" },
      ),
    ).toEqual({
      mode: "read-only",
      reason: "incompatible-version",
    });
  });

  it("rejects ambiguous, invalid and out-of-range version strings", () => {
    for (const version of [
      "",
      "0",
      "01",
      "1.0",
      "+1",
      "18446744073709551616",
    ]) {
      expect(() =>
        snapshotMeshProtocolRange({ min: version, max: version }),
      ).toThrow(TypeError);
    }
    expect(() =>
      snapshotMeshProtocolRange({
        min: 1 as unknown as string,
        max: 1 as unknown as string,
      }),
    ).toThrow(TypeError);
    expect(() =>
      snapshotMeshProtocolRange({ min: "2", max: "1" }),
    ).toThrow(TypeError);
  });
});
