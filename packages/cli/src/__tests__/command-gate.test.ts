import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { findUnknownCommandPath } from "../command-gate.js";

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
      findUnknownCommandPath(["node", "zz", "rpc", "health"], program),
    ).toBe("rpc");
    expect(
      findUnknownCommandPath(
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
      expect(findUnknownCommandPath(argv, program), argv.join(" ")).toBeNull();
    }
  });

  it("rejects removed serve control aliases before serve can start", () => {
    const program = createProgram();

    expect(findUnknownCommandPath(["node", "zz", "serve", "status"], program)).toBe(
      "serve status",
    );
    expect(findUnknownCommandPath(["node", "zz", "serve", "stop"], program)).toBe(
      "serve stop",
    );
    expect(
      findUnknownCommandPath(["node", "zz", "serve", "status", "--help"], program),
    ).toBe("serve status");
  });

  it("uses the Commander registry as the single source of truth", () => {
    const program = createProgram();
    program.command("diagnose").alias("diag");

    expect(
      findUnknownCommandPath(["node", "zz", "diagnose"], program),
    ).toBeNull();
    expect(findUnknownCommandPath(["node", "zz", "diag"], program)).toBeNull();

    const serve = program.commands.find((cmd) => cmd.name() === "serve")!;
    serve.command("status");

    expect(findUnknownCommandPath(["node", "zz", "serve", "status"], program)).toBeNull();
  });
});
