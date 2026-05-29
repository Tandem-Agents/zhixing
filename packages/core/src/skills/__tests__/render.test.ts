import { describe, it, expect } from "vitest";
import { renderSkillIndex } from "../render.js";
import type { SkillRecord } from "../types.js";

function rec(partial: Partial<SkillRecord>): SkillRecord {
  return {
    id: "x",
    name: "X",
    description: "d",
    source: "own",
    dir: "/x",
    mode: "main",
    pinned: false,
    disabled: false,
    createdAt: "2024-01-01T00:00:00.000Z",
    ...partial,
  };
}

const HEAD =
  "## Available Skills\n" +
  "To use a skill, call the `load_skill` tool with the id shown below. Descriptions are brief — load one for full instructions.";

describe("renderSkillIndex", () => {
  it("无技能返 null(段跳过)", () => {
    expect(renderSkillIndex([])).toBeNull();
  });

  it("单条:头 + 指引 + 一行 bullet", () => {
    expect(renderSkillIndex([rec({ id: "a", description: "do A" })])).toBe(
      `${HEAD}\n- **a**: do A`,
    );
  });

  it("pinned 前缀 ★", () => {
    expect(
      renderSkillIndex([rec({ id: "a", description: "x", pinned: true })]),
    ).toBe(`${HEAD}\n- ★ **a**: x`);
  });

  it("多条保持传入顺序", () => {
    expect(
      renderSkillIndex([
        rec({ id: "a", description: "da" }),
        rec({ id: "b", description: "db" }),
      ]),
    ).toBe(`${HEAD}\n- **a**: da\n- **b**: db`);
  });

  it("超长 description 截断并以省略号收尾", () => {
    const out = renderSkillIndex(
      [rec({ id: "a", description: "x".repeat(300) })],
      { maxDescriptionChars: 10 },
    );
    expect(out).toBe(`${HEAD}\n- **a**: ${"x".repeat(9)}…`);
  });

  it("不超上限不截断", () => {
    expect(
      renderSkillIndex([rec({ id: "a", description: "short" })], {
        maxDescriptionChars: 10,
      }),
    ).toBe(`${HEAD}\n- **a**: short`);
  });
});
