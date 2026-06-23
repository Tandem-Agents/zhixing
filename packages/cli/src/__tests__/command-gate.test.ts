import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { findUnknownTopLevelCommand } from "../command-gate.js";

function createProgram(): Command {
  const program = new Command();
  program.command("status");
  program.command("stop");
  const serve = program.command("serve");
  serve.command("logs");
  return program;
}

describe("CLI command gate", () => {
  it("rejects the removed rpc command before default interactive mode can run", () => {
    const program = createProgram();

    expect(
      findUnknownTopLevelCommand(["node", "zz", "rpc", "health"], program),
    ).toBe("rpc");
    expect(
      findUnknownTopLevelCommand(
        ["node", "zhixing", "rpc", "session.send", "{}"],
        program,
      ),
    ).toBe("rpc");
  });

  it("allows registered top-level commands and global exit options", () => {
    const program = createProgram();

    for (const argv of [
      ["node", "zz"],
      ["node", "zz", "--help"],
      ["node", "zz", "--version"],
      ["node", "zz", "--log"],
      ["node", "zz", "status"],
      ["node", "zz", "stop"],
      ["node", "zz", "serve", "logs"],
    ]) {
      expect(findUnknownTopLevelCommand(argv, program), argv.join(" ")).toBeNull();
    }
  });

  it("uses the Commander registry as the single source of truth", () => {
    const program = createProgram();
    program.command("diagnose").alias("diag");

    expect(
      findUnknownTopLevelCommand(["node", "zz", "diagnose"], program),
    ).toBeNull();
    expect(findUnknownTopLevelCommand(["node", "zz", "diag"], program)).toBeNull();
  });
});
