import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
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

  it("keeps normal pairing help free of topology and security internals", () => {
    const pair = program.commands.find((command) => command.name() === "pair");
    const help = pair?.helpInformation() ?? "";

    expect(help).toContain("另一台设备显示的邀请内容");
    expect(help).not.toMatch(/高熵|listen|advertise|relay|executor|host:port/iu);
  });

  it("keeps the documented top-level command set exact with the real registry", async () => {
    const readme = await readFile(
      new URL("../../README.md", import.meta.url),
      "utf8",
    );
    const section = readme.match(
      /<!-- public-top-level-commands:start -->([\s\S]*?)<!-- public-top-level-commands:end -->/u,
    )?.[1];
    expect(section).toBeDefined();
    const documented = [...section!.matchAll(/^- `zz(?: ([a-z][a-z-]*))?`/gmu)]
      .map((match) => match[1] ? `zhixing ${match[1]}` : "zhixing")
      .sort((left, right) => left.localeCompare(right, "en-US"));
    const registered = captureCliCommandDescriptor()
      .filter(({ path, hidden }) =>
        !hidden && (path === "zhixing" || /^zhixing [^ ]+$/u.test(path))
      )
      .map(({ path }) => path)
      .sort((left, right) => left.localeCompare(right, "en-US"));

    expect(documented).toEqual(registered);
    expect(documented).not.toContain("zhixing serve");
  });
});
