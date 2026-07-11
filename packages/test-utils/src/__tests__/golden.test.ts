import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { assertGolden, normalizeGolden } from "../golden.js";
import { createTempDir } from "../temp-dir.js";

describe("runtime golden infrastructure", () => {
  it("sorts keys and normalizes only unstable values", () => {
    expect(
      normalizeGolden(
        {
          z: "2026-07-11T12:00:00.000Z",
          a: {
            turnId: "turn_random-123",
            stableId: "job-7",
            eventType: "turn_complete",
            userContent: "5f4dcc3b-5aa7-4f42-8fd1-8d3f4d5ea921",
          },
          path: "C:\\tmp\\golden\\file.json",
        },
        {
          volatileKeys: ["turnId", "z"],
          replaceStrings: { "C:\\tmp\\golden": "<temp>" },
        },
      ),
    ).toEqual({
      a: {
        eventType: "turn_complete",
        stableId: "job-7",
        turnId: "<turnId:string>",
        userContent: "5f4dcc3b-5aa7-4f42-8fd1-8d3f4d5ea921",
      },
      path: "<temp>\\file.json",
      z: "<z:string>",
    });
  });

  it("preserves volatile scalar types and rejects hidden object shapes", () => {
    expect(normalizeGolden({ createdAt: 123 }, { volatileKeys: ["createdAt"] })).toEqual({
      createdAt: "<createdAt:number>",
    });
    expect(() =>
      normalizeGolden({ payload: { value: 1 } }, { volatileKeys: ["payload"] }),
    ).toThrow(/must be scalar/);
  });

  it("updates only under the explicit flag, then compares read-only", async () => {
    const dir = await createTempDir("golden");
    const fixture = pathToFileURL(join(dir, "sample.golden.json"));
    const previous = process.env.ZHIXING_UPDATE_GOLDENS;
    process.env.ZHIXING_UPDATE_GOLDENS = "1";
    try {
      await assertGolden(fixture, { b: 2, a: 1 });
    } finally {
      if (previous === undefined) delete process.env.ZHIXING_UPDATE_GOLDENS;
      else process.env.ZHIXING_UPDATE_GOLDENS = previous;
    }

    const file = join(dir, "sample.golden.json");
    const lf = await readFile(file, "utf8");
    await writeFile(file, lf.replace(/\n/g, "\r\n"), "utf8");
    await expect(assertGolden(fixture, { a: 1, b: 2 })).resolves.toBeUndefined();
    await expect(assertGolden(fixture, { a: 2, b: 2 })).rejects.toThrow(
      /Golden mismatch/,
    );
  });
});
