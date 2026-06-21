import { describe, expect, it, vi } from "vitest";
import { prepareUserTurnInput } from "../user-turn-input.js";

describe("prepareUserTurnInput", () => {
  it("非空正文保留首尾空白", async () => {
    await expect(
      prepareUserTurnInput("  hello\n", { workspaceRoot: "E:/repo" }),
    ).resolves.toEqual({
      text: "  hello\n",
      resolvedFiles: [],
      errors: [],
    });
  });

  it("纯空白输入按空输入处理", async () => {
    await expect(
      prepareUserTurnInput(" \t\n ", { workspaceRoot: "E:/repo" }),
    ).resolves.toBeNull();
  });

  it("@file 引用只替换引用片段，保留周围空白", async () => {
    const resolveRefs = vi.fn(async (input: string) => ({
      text: input.replace("@file:a.txt", "<file>A</file>"),
      resolvedFiles: ["E:/repo/a.txt"],
      errors: ["warn"],
    }));

    const result = await prepareUserTurnInput("  @file:a.txt  ", {
      workspaceRoot: "E:/repo",
      resolveRefs,
    });

    expect(resolveRefs).toHaveBeenCalledWith("  @file:a.txt  ", {
      workspaceRoot: "E:/repo",
    });
    expect(result).toEqual({
      text: "  <file>A</file>  ",
      resolvedFiles: ["E:/repo/a.txt"],
      errors: ["warn"],
    });
  });
});
