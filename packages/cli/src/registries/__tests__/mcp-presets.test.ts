/**
 * MCP 预设库测试。
 *
 * 关键不变量：
 *   - 预设 id 合法（可直接当 server id）
 *   - applyMcpPreset 产出可写入的 config 条目 + 凭证（直接字段原样、template 字段包裹）
 *   - 返回的 entry 是深拷贝，不污染预设常量
 */

import { describe, expect, it } from "vitest";
import { isValidServerId } from "@zhixing/mcp";
import { MCP_PRESETS, applyMcpPreset, findMcpPreset } from "../mcp-presets.js";

describe("MCP 预设库", () => {
  it("每个预设 id 都是合法 server id（无 __ 等）", () => {
    for (const preset of MCP_PRESETS) {
      expect(isValidServerId(preset.id)).toBe(true);
    }
  });

  it("每个预设至少一个密钥字段，key / label 非空", () => {
    for (const preset of MCP_PRESETS) {
      expect(preset.secretFields.length).toBeGreaterThan(0);
      for (const field of preset.secretFields) {
        expect(field.key).not.toBe("");
        expect(field.label).not.toBe("");
      }
    }
  });

  it("findMcpPreset 命中 / 未命中", () => {
    expect(findMcpPreset("github")?.label).toBe("GitHub");
    expect(findMcpPreset("does-not-exist")).toBeUndefined();
  });

  it("applyMcpPreset：直接字段产出 config 条目 + 原样凭证", () => {
    const notion = findMcpPreset("notion")!;
    const { entry, secrets } = applyMcpPreset(notion, {
      NOTION_TOKEN: "ntn_abc",
    });
    expect(entry).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@notionhq/notion-mcp-server"],
    });
    expect(secrets).toEqual({ NOTION_TOKEN: "ntn_abc" });
  });

  it("applyMcpPreset：template 字段把用户输入包进模板（Bearer 头）", () => {
    const github = findMcpPreset("github")!;
    const { entry, secrets } = applyMcpPreset(github, {
      Authorization: "ghp_xyz",
    });
    expect(entry).toEqual({
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
    });
    expect(secrets.Authorization).toBe("Bearer ghp_xyz");
  });

  it("applyMcpPreset：template 包裹按字面写入——token 含 $ 不被特殊模式改写", () => {
    const github = findMcpPreset("github")!;
    // token 里的 $& / $$ 若走字符串 replaceAll 会被当替换模式解释而污染
    const { secrets } = applyMcpPreset(github, { Authorization: "gh$&p_$$x" });
    expect(secrets.Authorization).toBe("Bearer gh$&p_$$x");
  });

  it("applyMcpPreset：空 / 缺失输入跳过，不写空凭证", () => {
    const github = findMcpPreset("github")!;
    expect(applyMcpPreset(github, { Authorization: "" }).secrets).toEqual({});
    expect(applyMcpPreset(github, {}).secrets).toEqual({});
  });

  it("applyMcpPreset：entry 是深拷贝，改返回值不污染预设常量", () => {
    const notion = findMcpPreset("notion")!;
    const { entry } = applyMcpPreset(notion, { NOTION_TOKEN: "x" });
    entry.command = "mutated";
    expect(findMcpPreset("notion")!.entry.command).toBe("npx");
  });
});
