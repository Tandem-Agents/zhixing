/**
 * RuntimeSession.computeDiff 纯函数单测。
 *
 * 覆盖：
 * - 域识别（channels-only / agent-only / both / no-change）
 * - 各字段独立变更触发对应 domain
 * - stable equality（key 顺序无关、undefined / null / missing 等价）
 */

import { describe, it, expect } from "vitest";
import type { ZhixingConfig, ZhixingCredentials } from "@zhixing/providers";
import { computeDiff } from "../diff.js";

const baseConfig: ZhixingConfig = {
  llm: {
    main: { provider: "siliconflow", model: "Qwen/Qwen3-32B" },
  },
};

const baseCredentials: ZhixingCredentials = {
  providers: {
    siliconflow: { apiKey: "sk-old" },
  },
};

describe("computeDiff", () => {
  describe("no-change", () => {
    it("identical config + credentials → no-change", () => {
      const result = computeDiff(
        baseConfig,
        baseCredentials,
        baseConfig,
        baseCredentials,
      );
      expect(result.kind).toBe("no-change");
      expect(result.channelsChanged).toBe(false);
      expect(result.agentChanged).toBe(false);
      expect(result.changedDomains).toEqual([]);
    });

    it("clone with different key insertion order → no-change（stable equality）", () => {
      const reorderedConfig: ZhixingConfig = {
        llm: { main: { model: "Qwen/Qwen3-32B", provider: "siliconflow" } },
      };
      const result = computeDiff(
        baseConfig,
        baseCredentials,
        reorderedConfig,
        baseCredentials,
      );
      expect(result.kind).toBe("no-change");
    });

    it("undefined vs missing key → 等价（no-change）", () => {
      const a: ZhixingConfig = {
        llm: { main: { provider: "siliconflow", model: "X" } },
        agent: undefined,
      };
      const b: ZhixingConfig = {
        llm: { main: { provider: "siliconflow", model: "X" } },
      };
      expect(computeDiff(a, baseCredentials, b, baseCredentials).kind).toBe(
        "no-change",
      );
    });
  });

  describe("agent domain", () => {
    it("model 变化 → agent-only changed", () => {
      const newConfig: ZhixingConfig = {
        llm: { main: { provider: "siliconflow", model: "DeepSeek-V3" } },
      };
      const result = computeDiff(
        baseConfig,
        baseCredentials,
        newConfig,
        baseCredentials,
      );
      expect(result.kind).toBe("changed");
      expect(result.channelsChanged).toBe(false);
      expect(result.agentChanged).toBe(true);
      expect(result.changedDomains).toEqual(["agent"]);
    });

    it("provider 变化 → agent-only changed", () => {
      const newConfig: ZhixingConfig = {
        llm: { main: { provider: "openai", model: "Qwen/Qwen3-32B" } },
      };
      const result = computeDiff(
        baseConfig,
        baseCredentials,
        newConfig,
        baseCredentials,
      );
      expect(result.changedDomains).toEqual(["agent"]);
    });

    it("config.mcp 变化 → agent-only changed", () => {
      const newConfig: ZhixingConfig = {
        llm: { main: { provider: "siliconflow", model: "Qwen/Qwen3-32B" } },
        mcp: { servers: { github: { command: "uvx" } } },
      };
      const result = computeDiff(
        baseConfig,
        baseCredentials,
        newConfig,
        baseCredentials,
      );
      expect(result.agentChanged).toBe(true);
      expect(result.changedDomains).toEqual(["agent"]);
    });

    it("credentials.mcp 变化 → agent-only changed", () => {
      const newCredentials: ZhixingCredentials = {
        providers: { siliconflow: { apiKey: "sk-old" } },
        mcp: { github: { token: "ghp_x" } },
      };
      const result = computeDiff(
        baseConfig,
        baseCredentials,
        baseConfig,
        newCredentials,
      );
      expect(result.agentChanged).toBe(true);
      expect(result.changedDomains).toEqual(["agent"]);
    });

    it("apiKey（credentials.providers）变化 → agent-only changed", () => {
      const newCredentials: ZhixingCredentials = {
        providers: {
          siliconflow: { apiKey: "sk-new" },
        },
      };
      const result = computeDiff(
        baseConfig,
        baseCredentials,
        baseConfig,
        newCredentials,
      );
      expect(result.changedDomains).toEqual(["agent"]);
    });

    it("workspace.path 变化 → agent-only changed", () => {
      const newConfig: ZhixingConfig = {
        ...baseConfig,
        workspace: { path: "D:/NewWorkspace" },
      };
      const result = computeDiff(
        baseConfig,
        baseCredentials,
        newConfig,
        baseCredentials,
      );
      expect(result.changedDomains).toEqual(["agent"]);
    });

    it("agent.displayName 变化 → agent-only changed", () => {
      const newConfig: ZhixingConfig = {
        ...baseConfig,
        agent: { displayName: "My Agent" },
      };
      const result = computeDiff(
        baseConfig,
        baseCredentials,
        newConfig,
        baseCredentials,
      );
      expect(result.changedDomains).toEqual(["agent"]);
    });

    it("network.proxy 变化 → agent-only changed", () => {
      const newConfig: ZhixingConfig = {
        ...baseConfig,
        network: { proxy: "http://localhost:7890" },
      };
      const result = computeDiff(
        baseConfig,
        baseCredentials,
        newConfig,
        baseCredentials,
      );
      expect(result.changedDomains).toEqual(["agent"]);
    });

    it("light llm 变化 → agent-only changed", () => {
      const newConfig: ZhixingConfig = {
        llm: {
          main: { provider: "siliconflow", model: "Qwen/Qwen3-32B" },
          light: { provider: "openai", model: "gpt-4o-mini" },
        },
      };
      const result = computeDiff(
        baseConfig,
        baseCredentials,
        newConfig,
        baseCredentials,
      );
      expect(result.changedDomains).toEqual(["agent"]);
    });
  });

  describe("channels domain", () => {
    it("messaging 字段添加 → channels-only changed", () => {
      const newConfig: ZhixingConfig = {
        ...baseConfig,
        messaging: { feishu: { type: "feishu" } },
      };
      const result = computeDiff(
        baseConfig,
        baseCredentials,
        newConfig,
        baseCredentials,
      );
      expect(result.kind).toBe("changed");
      expect(result.channelsChanged).toBe(true);
      expect(result.agentChanged).toBe(false);
      expect(result.changedDomains).toEqual(["channels"]);
    });

    it("messaging 字段移除 → channels-only changed", () => {
      const oldConfig: ZhixingConfig = {
        ...baseConfig,
        messaging: { feishu: { type: "feishu" } },
      };
      const result = computeDiff(
        oldConfig,
        baseCredentials,
        baseConfig,
        baseCredentials,
      );
      expect(result.changedDomains).toEqual(["channels"]);
    });

    it("credentials.channels 字段变化 → channels-only changed", () => {
      const oldCredentials: ZhixingCredentials = {
        ...baseCredentials,
        channels: { feishu: { appSecret: "old" } },
      };
      const newCredentials: ZhixingCredentials = {
        ...baseCredentials,
        channels: { feishu: { appSecret: "new" } },
      };
      const result = computeDiff(
        baseConfig,
        oldCredentials,
        baseConfig,
        newCredentials,
      );
      expect(result.changedDomains).toEqual(["channels"]);
    });
  });

  describe("both domains", () => {
    it("messaging + llm.main.model 同时变化 → both changed", () => {
      const newConfig: ZhixingConfig = {
        llm: { main: { provider: "siliconflow", model: "DeepSeek-V3" } },
        messaging: { feishu: { type: "feishu" } },
      };
      const result = computeDiff(
        baseConfig,
        baseCredentials,
        newConfig,
        baseCredentials,
      );
      expect(result.kind).toBe("changed");
      expect(result.channelsChanged).toBe(true);
      expect(result.agentChanged).toBe(true);
      expect(result.changedDomains).toEqual(["channels", "agent"]);
    });
  });

  describe("array order sensitivity", () => {
    it("数组元素顺序不同 → 视为变化（intentional——保持顺序敏感）", () => {
      const oldCredentials: ZhixingCredentials = {
        providers: {
          siliconflow: {
            apiKey: "sk-old",
            models: ["model-a", "model-b"],
          },
        },
      };
      const newCredentials: ZhixingCredentials = {
        providers: {
          siliconflow: {
            apiKey: "sk-old",
            models: ["model-b", "model-a"],
          },
        },
      };
      const result = computeDiff(
        baseConfig,
        oldCredentials,
        baseConfig,
        newCredentials,
      );
      expect(result.changedDomains).toEqual(["agent"]);
    });
  });
});
