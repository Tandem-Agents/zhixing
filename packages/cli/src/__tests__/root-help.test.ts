import { describe, expect, it } from "vitest";
import { captureCliCommandDescriptor, program } from "../index.js";

describe("root CLI help", () => {
  it("uses one Chinese Commander projection and keeps explicit help in the real registry", () => {
    const help = program.helpInformation();

    expect(help).toContain("用法： zhixing");
    expect(help).toContain("选项：");
    expect(help).toContain("命令：");
    expect(help).toContain("-h, --help");
    expect(help).toContain("显示帮助");
    expect(help).toContain("-V, --version");
    expect(help).toContain("显示版本");
    expect(help).not.toMatch(/\b(?:Usage|Arguments|Options|Global Options|Commands):/u);
    expect(help).not.toContain("display help");
    expect(help).not.toContain("output the version");

    expect(captureCliCommandDescriptor()).toContainEqual({
      path: "zhixing help",
      hidden: false,
      hasAction: true,
    });
  });

  it("preserves the no-argument root action", () => {
    expect(captureCliCommandDescriptor()).toContainEqual({
      path: "zhixing",
      hidden: false,
      hasAction: true,
    });
  });

  it("preserves the full root-to-subcommand usage path", () => {
    const status = program.commands.find((command) => command.name() === "status");
    expect(status?.helpInformation()).toContain("用法： zhixing status [选项]");
  });
});
