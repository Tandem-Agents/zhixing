import { describe, expect, it } from "vitest";
import {
  SLASH_ALIASES,
  normalizeLeadingSlashAlias,
  normalizeLeadingSlashAliasInExpanded,
} from "../leading-slash-alias.js";

describe("normalizeLeadingSlashAlias", () => {
  it("空串原样返回", () => {
    expect(normalizeLeadingSlashAlias("")).toBe("");
  });

  it("首位 `/` 保持不变", () => {
    expect(normalizeLeadingSlashAlias("/help")).toBe("/help");
  });

  it("首位 `、` 替换为 `/`", () => {
    expect(normalizeLeadingSlashAlias("、help")).toBe("/help");
  });

  it("首位其他字符保持不变", () => {
    expect(normalizeLeadingSlashAlias("hello world")).toBe("hello world");
  });

  it("`、、` 仅替换首位", () => {
    expect(normalizeLeadingSlashAlias("、、")).toBe("/、");
  });

  it("`、 ` 后跟空格首位替换", () => {
    expect(normalizeLeadingSlashAlias("、 help")).toBe("/ help");
  });

  it("非首位 `、` 不替换(命令参数中保留原义)", () => {
    expect(normalizeLeadingSlashAlias("text、")).toBe("text、");
  });
});

describe("SLASH_ALIASES", () => {
  it("包含中文顿号", () => {
    expect(SLASH_ALIASES).toContain("、");
  });
});

describe("normalizeLeadingSlashAliasInExpanded", () => {
  it("guard 与 target 都以 alias 开头 → 替换 target 首位为 /", () => {
    expect(normalizeLeadingSlashAliasInExpanded("、help", "、help")).toBe(
      "/help",
    );
  });

  it("guard 与 target 都非 alias 开头 → 原样返回 target", () => {
    expect(normalizeLeadingSlashAliasInExpanded("hello", "hello")).toBe(
      "hello",
    );
  });

  it("paste 边界:guard 首位非 alias(token `<`)+ target 首位 alias(paste 内容) → 不替换", () => {
    expect(
      normalizeLeadingSlashAliasInExpanded("、我之前说", "<PASTE_id_xxx>"),
    ).toBe("、我之前说");
  });

  it("用户首位手输 alias + 后接 paste 内容 → target 首位替换", () => {
    expect(
      normalizeLeadingSlashAliasInExpanded(
        "、foo paste-content-here",
        "、<PASTE_id_xxx>",
      ),
    ).toBe("/foo paste-content-here");
  });

  it("guard 空串 → 不替换", () => {
    expect(normalizeLeadingSlashAliasInExpanded("、xxx", "")).toBe("、xxx");
  });

  it("target 空串 + guard alias → 返回 `/`", () => {
    expect(normalizeLeadingSlashAliasInExpanded("", "、")).toBe("/");
  });
});
