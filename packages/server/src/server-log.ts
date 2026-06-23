import {
  getDefaultServerActiveLogPath,
  getDefaultServerLogDirPath,
  getLegacyServerLogPath,
} from "./paths.js";

export const SERVER_LOG_ACTIVE_FILE_NAME = "server.log";
export const SERVER_LOG_ROTATED_FILE_PATTERN =
  /^server-(\d{8})-(\d{6})-(\d{3})-(\d{4,})\.log$/;

const MIB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ServerLogPolicy {
  activeMaxBytes: number;
  maxRotatedFiles: number;
  maxRotatedFileAgeMs: number;
  totalMaxBytes: number;
}

export const DEFAULT_SERVER_LOG_POLICY: Readonly<ServerLogPolicy> = Object.freeze({
  activeMaxBytes: 8 * MIB,
  maxRotatedFiles: 5,
  maxRotatedFileAgeMs: 14 * DAY_MS,
  totalMaxBytes: 64 * MIB,
});

export interface ServerLogPaths {
  dirPath: string;
  activeLogPath: string;
  legacyLogPath: string;
}

export function getDefaultServerLogPaths(): ServerLogPaths {
  return {
    dirPath: getDefaultServerLogDirPath(),
    activeLogPath: getDefaultServerActiveLogPath(),
    legacyLogPath: getLegacyServerLogPath(),
  };
}

export function formatServerLogRotationFileName(
  date: Date = new Date(),
  sequence = 0,
): string {
  const time = date.getTime();
  if (!Number.isFinite(time)) {
    throw new RangeError("rotation timestamp must be a valid Date");
  }
  if (!Number.isInteger(sequence) || sequence < 0) {
    throw new RangeError("rotation sequence must be a non-negative integer");
  }

  const yyyy = String(date.getUTCFullYear()).padStart(4, "0");
  const mm = pad2(date.getUTCMonth() + 1);
  const dd = pad2(date.getUTCDate());
  const hh = pad2(date.getUTCHours());
  const mi = pad2(date.getUTCMinutes());
  const ss = pad2(date.getUTCSeconds());
  const ms = String(date.getUTCMilliseconds()).padStart(3, "0");
  const seq = String(sequence).padStart(4, "0");

  return `server-${yyyy}${mm}${dd}-${hh}${mi}${ss}-${ms}-${seq}.log`;
}

export function isServerLogRotationFileName(fileName: string): boolean {
  return SERVER_LOG_ROTATED_FILE_PATTERN.test(fileName);
}

export type ServerLogPathTransitionKind =
  | "initialize-active"
  | "migrate-legacy"
  | "use-active";

export interface ServerLogPathTransitionInput {
  activeExists: boolean;
  legacyExists: boolean;
  paths?: ServerLogPaths;
}

export interface ServerLogPathTransition {
  kind: ServerLogPathTransitionKind;
  paths: ServerLogPaths;
  readPath: string;
  writePath: string;
  migrateFrom?: string;
  migrateTo?: string;
}

export function decideServerLogPathTransition(
  input: ServerLogPathTransitionInput,
): ServerLogPathTransition {
  const paths = input.paths ?? getDefaultServerLogPaths();
  if (input.activeExists) {
    return {
      kind: "use-active",
      paths,
      readPath: paths.activeLogPath,
      writePath: paths.activeLogPath,
    };
  }
  if (input.legacyExists) {
    return {
      kind: "migrate-legacy",
      paths,
      readPath: paths.activeLogPath,
      writePath: paths.activeLogPath,
      migrateFrom: paths.legacyLogPath,
      migrateTo: paths.activeLogPath,
    };
  }
  return {
    kind: "initialize-active",
    paths,
    readPath: paths.activeLogPath,
    writePath: paths.activeLogPath,
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
