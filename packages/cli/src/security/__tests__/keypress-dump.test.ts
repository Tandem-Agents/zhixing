import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("keeps lazy keypress output on the entry root after environment changes", async () => {
  vi.useFakeTimers();
  vi.resetModules();
  const root = await createTempDir("keypress-owner");
  const other = await createTempDir("keypress-other");
  const dump = await import("../keypress-dump.js");
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  dump.configureKeypressDump(true, root);
  vi.stubEnv("ZHIXING_HOME", other);
  dump.recordKeypressEvent("isolation", { key: "x" });
  const logs = await fs.readdir(path.join(root, "logs"));
  expect(logs).toHaveLength(1);
  expect(await fs.readFile(path.join(root, "logs", logs[0]!), "utf8")).toContain("isolation");
  await expect(fs.stat(path.join(other, "logs"))).rejects.toMatchObject({ code: "ENOENT" });
});
