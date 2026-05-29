import { describe, it, expect } from "vitest";
import { parseAddArgs, admissionOutcome } from "../admission-command.js";

describe("parseAddArgs", () => {
  it("纯路径", () => {
    expect(parseAddArgs("/some/skill")).toEqual({
      path: "/some/skill",
      force: false,
    });
  });

  it("路径 + --force", () => {
    expect(parseAddArgs("/some/skill --force")).toEqual({
      path: "/some/skill",
      force: true,
    });
  });

  it("--force 在前", () => {
    expect(parseAddArgs("--force /some/skill")).toEqual({
      path: "/some/skill",
      force: true,
    });
  });

  it("含空格的路径按单空格重组", () => {
    expect(parseAddArgs("/my path --force")).toEqual({
      path: "/my path",
      force: true,
    });
  });

  it("空 / 纯空白 → 空路径", () => {
    expect(parseAddArgs("")).toEqual({ path: "", force: false });
    expect(parseAddArgs("   ")).toEqual({ path: "", force: false });
  });
});

describe("admissionOutcome — 接入裁决安全护栏", () => {
  it("safe → admit", () => {
    expect(admissionOutcome("safe", false)).toBe("admit");
    expect(admissionOutcome("safe", true)).toBe("admit");
  });

  it("escalate → reject(--force 也不越)", () => {
    expect(admissionOutcome("escalate", false)).toBe("reject");
    expect(admissionOutcome("escalate", true)).toBe("reject");
  });

  it("needs-confirm → confirm;带 --force → admit", () => {
    expect(admissionOutcome("needs-confirm", false)).toBe("confirm");
    expect(admissionOutcome("needs-confirm", true)).toBe("admit");
  });
});
