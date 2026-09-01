import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const CLI_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONSUMER_PATTERN =
  /\b(?:decodeRecoveryPackage|readDecodedRecoveryPackage|readRecoveryPackageFromTty)\s*\(/u;

const EXPECTED_CONSUMERS = [
  "runtime/anchor-uninstall-command.ts",
  "serve/backup-command.ts",
  "serve/command.ts",
  "serve/disaster-recovery-command.ts",
  "serve/mesh-pair-command.ts",
  "serve/recovery-package-input.ts",
] as const;

describe("recovery package consumer boundary", () => {
  it("allows legacy packages only at the two initial root-activation entries", () => {
    const consumers = listProductionSources(CLI_SRC)
      .filter((file) => CONSUMER_PATTERN.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(CLI_SRC, file).replaceAll("\\", "/"))
      .sort();
    expect(consumers).toEqual([...EXPECTED_CONSUMERS]);

    const backup = source("serve/backup-command.ts");
    expect(backup.match(/requireCurrentRecoveryPackage\s*\(/gu)).toHaveLength(4);
    expect(backup.match(/decoded\.version === 1/gu)).toHaveLength(1);

    const pairing = source("serve/mesh-pair-command.ts");
    expect(pairing.match(/decoded\.version === 1/gu)).toHaveLength(1);
    expect(pairing).not.toContain("requireCurrentRecoveryPackage(");

    expect(source("runtime/anchor-uninstall-command.ts").match(
      /requireCurrentRecoveryPackage\s*\(/gu,
    )).toHaveLength(1);
    expect(source("serve/command.ts").match(
      /requireCurrentRecoveryPackage\s*\(/gu,
    )).toHaveLength(1);
    expect(source("serve/disaster-recovery-command.ts").match(
      /requireCurrentRecoveryPackage\s*\(/gu,
    )).toHaveLength(1);
  });
});

function source(relative: string): string {
  return readFileSync(path.join(CLI_SRC, relative), "utf8");
}

function listProductionSources(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const absolute = path.join(directory, name);
      if (statSync(absolute).isDirectory()) {
        if (name !== "__tests__") walk(absolute);
      } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
        files.push(absolute);
      }
    }
  };
  walk(root);
  return files;
}
