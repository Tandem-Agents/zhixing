import { describe, expect, it } from "vitest";
import type { ConfirmationOption, SuggestedPattern } from "@zhixing/core/confirmation";
import { translate } from "../confirmation-decision.js";
const PATTERN_NPM_INSTALL: SuggestedPattern = {
  pattern: { tool: "bash", argument: "npm install *" }, label: "npm install *",
};

describe("translate", () => {
  it("selected allow-once → { kind: 'allow-once' }", () => {
    const opt: ConfirmationOption = { kind: "allow-once", label: "x" };
    const map = new Map([["opt-0", opt]]);
    const result = translate({ kind: "selected", value: "opt-0" }, map);
    expect(result).toEqual({ kind: "allow-once" });
  });

  it("selected allow-with-note 带 note → { kind: 'allow-once', note }", () => {
    const opt: ConfirmationOption = {
      kind: "allow-with-note",
      label: "x",
      placeholder: "y",
    };
    const map = new Map([["opt-0", opt]]);
    const result = translate(
      { kind: "selected", value: "opt-0", note: "先检查依赖" },
      map,
    );
    expect(result).toEqual({ kind: "allow-once", note: "先检查依赖" });
  });

  it("selected deny-with-reason 带 note → { kind: 'deny', reason }", () => {
    const opt: ConfirmationOption = {
      kind: "deny-with-reason",
      label: "x",
      placeholder: "y",
    };
    const map = new Map([["opt-0", opt]]);
    const result = translate(
      { kind: "selected", value: "opt-0", note: "别用 rm -rf" },
      map,
    );
    expect(result).toEqual({ kind: "deny", reason: "别用 rm -rf" });
  });

  it("selected allow-context 携带 pattern", () => {
    const opt: ConfirmationOption = {
      kind: "allow-context",
      label: "x",
      pattern: PATTERN_NPM_INSTALL,
    };
    const map = new Map([["opt-0", opt]]);
    const result = translate({ kind: "selected", value: "opt-0" }, map);
    expect(result).toEqual({
      kind: "allow-context",
      pattern: PATTERN_NPM_INSTALL,
      note: undefined,
    });
  });

  it("selected allow-session / allow-global 携带 pattern", () => {
    const sessionOpt: ConfirmationOption = {
      kind: "allow-session",
      label: "x",
      pattern: PATTERN_NPM_INSTALL,
    };
    const globalOpt: ConfirmationOption = {
      kind: "allow-global",
      label: "x",
      pattern: PATTERN_NPM_INSTALL,
    };
    const map = new Map<string, ConfirmationOption>([
      ["opt-0", sessionOpt],
      ["opt-1", globalOpt],
    ]);
    expect(
      translate({ kind: "selected", value: "opt-0" }, map).kind,
    ).toBe("allow-session");
    expect(
      translate({ kind: "selected", value: "opt-1" }, map).kind,
    ).toBe("allow-global");
  });

  it("cancelled ctrl-c → { kind: 'cancelled', cause: 'user-ctrl-c' }", () => {
    const result = translate(
      { kind: "cancelled", cause: "ctrl-c" },
      new Map(),
    );
    expect(result).toEqual({ kind: "cancelled", cause: "user-ctrl-c" });
  });

  it("cancelled ctrl-d → { kind: 'cancelled', cause: 'user-ctrl-d' }", () => {
    const result = translate(
      { kind: "cancelled", cause: "ctrl-d" },
      new Map(),
    );
    expect(result).toEqual({ kind: "cancelled", cause: "user-ctrl-d" });
  });

  it("cancelled aborted → { kind: 'cancelled', cause: 'aborted' }", () => {
    const result = translate(
      { kind: "cancelled", cause: "aborted" },
      new Map(),
    );
    expect(result).toEqual({ kind: "cancelled", cause: "aborted" });
  });

  it("cancelled escape → { kind: 'deny' } (Esc 等价于拒绝)", () => {
    const result = translate(
      { kind: "cancelled", cause: "escape" },
      new Map(),
    );
    expect(result).toEqual({ kind: "deny" });
  });

  it("未知 value → deny with reason (防御性)", () => {
    const result = translate(
      { kind: "selected", value: "nonexistent" },
      new Map(),
    );
    expect(result.kind).toBe("deny");
    if (result.kind === "deny") {
      expect(result.reason).toContain("未知选项");
    }
  });
});
