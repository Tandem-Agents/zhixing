import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  getDefaultLogPath,
  getDefaultServerActiveLogPath,
  getDefaultServerLogDirPath,
  getLegacyServerLogPath,
} from "../paths.js";
import {
  DEFAULT_SERVER_LOG_POLICY,
  decideServerLogPathTransition,
  formatServerLogRotationFileName,
  getDefaultServerLogPaths,
  isServerLogRotationFileName,
} from "../server-log.js";

const ORIGINAL_ZHIXING_HOME = process.env.ZHIXING_HOME;

afterEach(() => {
  if (ORIGINAL_ZHIXING_HOME === undefined) delete process.env.ZHIXING_HOME;
  else process.env.ZHIXING_HOME = ORIGINAL_ZHIXING_HOME;
});

describe("server log path model", () => {
  it("derives governed server log paths from ZHIXING_HOME", () => {
    process.env.ZHIXING_HOME = join("tmp", "zhixing-home");

    expect(getDefaultServerLogDirPath()).toBe(join("tmp", "zhixing-home", "logs", "server"));
    expect(getDefaultServerActiveLogPath()).toBe(
      join("tmp", "zhixing-home", "logs", "server", "server.log"),
    );
    expect(getLegacyServerLogPath()).toBe(join("tmp", "zhixing-home", "server.log"));
    expect(getDefaultServerLogPaths()).toEqual({
      dirPath: join("tmp", "zhixing-home", "logs", "server"),
      activeLogPath: join("tmp", "zhixing-home", "logs", "server", "server.log"),
      legacyLogPath: join("tmp", "zhixing-home", "server.log"),
    });
  });

  it("keeps the current daemon log path separate from the governed active path", () => {
    process.env.ZHIXING_HOME = join("tmp", "zhixing-home");

    expect(getDefaultLogPath()).toBe(getLegacyServerLogPath());
    expect(getLegacyServerLogPath()).not.toBe(getDefaultServerActiveLogPath());
  });
});

describe("server log policy", () => {
  it("defines byte-based default lifecycle limits", () => {
    expect(DEFAULT_SERVER_LOG_POLICY).toEqual({
      activeMaxBytes: 8 * 1024 * 1024,
      maxRotatedFiles: 5,
      maxRotatedFileAgeMs: 14 * 24 * 60 * 60 * 1000,
      totalMaxBytes: 64 * 1024 * 1024,
    });
  });
});

describe("server log rotation file names", () => {
  it("formats UTC timestamp plus padded sequence for stable chronological names", () => {
    const date = new Date(Date.UTC(2026, 5, 23, 4, 5, 6, 7));

    expect(formatServerLogRotationFileName(date, 2)).toBe(
      "server-20260623-040506-007-0002.log",
    );
  });

  it("uses sequence to avoid collisions for the same millisecond", () => {
    const date = new Date(Date.UTC(2026, 5, 23, 4, 5, 6, 7));

    expect(formatServerLogRotationFileName(date, 0)).not.toBe(
      formatServerLogRotationFileName(date, 1),
    );
  });

  it("recognizes only governed server rotation files", () => {
    expect(isServerLogRotationFileName("server-20260623-040506-007-0002.log")).toBe(true);
    expect(isServerLogRotationFileName("server.log")).toBe(false);
    expect(isServerLogRotationFileName("llm-error-20260623.log")).toBe(false);
  });

  it("rejects invalid timestamps and sequences", () => {
    expect(() => formatServerLogRotationFileName(new Date(Number.NaN), 0)).toThrow(RangeError);
    expect(() => formatServerLogRotationFileName(new Date(), -1)).toThrow(RangeError);
    expect(() => formatServerLogRotationFileName(new Date(), 1.5)).toThrow(RangeError);
  });
});

describe("server log path transition", () => {
  const paths = {
    dirPath: "/home/zx/logs/server",
    activeLogPath: "/home/zx/logs/server/server.log",
    legacyLogPath: "/home/zx/server.log",
  };

  it("initializes the governed active path when no log exists", () => {
    expect(
      decideServerLogPathTransition({ activeExists: false, legacyExists: false, paths }),
    ).toEqual({
      kind: "initialize-active",
      paths,
      readPath: paths.activeLogPath,
      writePath: paths.activeLogPath,
    });
  });

  it("migrates the legacy log only when the governed active log is absent", () => {
    expect(
      decideServerLogPathTransition({ activeExists: false, legacyExists: true, paths }),
    ).toEqual({
      kind: "migrate-legacy",
      paths,
      readPath: paths.activeLogPath,
      writePath: paths.activeLogPath,
      migrateFrom: paths.legacyLogPath,
      migrateTo: paths.activeLogPath,
    });
  });

  it("uses the governed active log when both active and legacy logs exist", () => {
    expect(decideServerLogPathTransition({ activeExists: true, legacyExists: true, paths })).toEqual({
      kind: "use-active",
      paths,
      readPath: paths.activeLogPath,
      writePath: paths.activeLogPath,
    });
  });
});
