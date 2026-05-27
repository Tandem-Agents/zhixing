/**
 * WebFetch + SecurityPipeline 集成测试。
 *
 * 验证 21A 自描述链路 + 21A M4 builtin namespace + 21A 两阶段匹配:
 * - WebFetch 自描述 boundaries=[network/egress/false] + permissionArgumentKey="url"
 * - 入口注入 WEB_FETCH_DEFAULT_RULES 到 builtin namespace
 * - 用户池(session/workspace/global)规则任一命中击败 builtin(用户最终决定权)
 */

import {
  BoundaryRegistry,
  PermissionStore,
  SecurityPipeline,
  ToolArgumentExtractor,
  type IToolArgumentExtractor,
  type PermissionRule,
  type SessionType,
} from "@zhixing/core";
import { describe, expect, it } from "vitest";
import { createWebFetchTool, WEB_FETCH_DEFAULT_RULES } from "../index.js";

const WORKSPACE = "/tmp/test-workspace";
const CWD = "/tmp";

interface PipelineSetup {
  sessionType: SessionType;
  injectBuiltin?: boolean;
  userRules?: PermissionRule[];
}

function makePipeline(opts: PipelineSetup): SecurityPipeline {
  const tools = [createWebFetchTool()];
  const extractor: IToolArgumentExtractor = ToolArgumentExtractor.fromTools(tools);
  const store = new PermissionStore({
    rootDir: null, // 不写盘
    extractArgument: (req) => extractor.extract(req),
  });
  if (opts.injectBuiltin) {
    store.registerBuiltinRules("web_fetch", [...WEB_FETCH_DEFAULT_RULES]);
  }
  if (opts.userRules) {
    for (const rule of opts.userRules) {
      store.create(WORKSPACE, rule);
    }
  }
  return new SecurityPipeline({
    trustContext: { kind: "workspace", dir: WORKSPACE },
    sessionType: opts.sessionType,
    permissionStore: store,
    toolBoundaryRegistry: BoundaryRegistry.fromTools(tools),
  });
}

describe("WebFetch + SecurityPipeline — preapproved host (builtin allow)", () => {
  it("docs.anthropic.com 自动 allow,无需确认", async () => {
    const p = makePipeline({ sessionType: "interactive", injectBuiltin: true });
    const r = await p.evaluate(
      "web_fetch",
      { url: "https://docs.anthropic.com/claude/docs" },
      CWD,
    );
    expect(r.allowed).toBe(true);
    expect(r.requiresConfirmation).toBeFalsy();
  });

  it("github.com 嵌套路径自动 allow", async () => {
    const p = makePipeline({ sessionType: "interactive", injectBuiltin: true });
    const r = await p.evaluate(
      "web_fetch",
      { url: "https://github.com/anthropics/sdk/blob/main/README.md" },
      CWD,
    );
    expect(r.allowed).toBe(true);
    expect(r.requiresConfirmation).toBeFalsy();
  });

  it("不在 preapproved 列表的 host 不自动通过(待 confirmation)", async () => {
    const p = makePipeline({ sessionType: "interactive", injectBuiltin: true });
    const r = await p.evaluate("web_fetch", { url: "https://random.example/" }, CWD);
    // interactive 语义: allowed=true + requiresConfirmation=true → 需用户确认才能放行
    expect(r.requiresConfirmation).toBe(true);
  });
});

describe("WebFetch + SecurityPipeline — interactive 触发 confirmation", () => {
  it("未配置 host + interactive → requiresConfirmation=true", async () => {
    const p = makePipeline({ sessionType: "interactive", injectBuiltin: true });
    const r = await p.evaluate("web_fetch", { url: "https://random.example/" }, CWD);
    expect(r.requiresConfirmation).toBe(true);
  });
});

describe("WebFetch + SecurityPipeline — non-interactive fail-to-deny", () => {
  it("ci 模式 + 未配置 host → 不 allow,不要求 confirmation(直接 deny)", async () => {
    const p = makePipeline({ sessionType: "ci", injectBuiltin: true });
    const r = await p.evaluate("web_fetch", { url: "https://random.example/" }, CWD);
    expect(r.allowed).toBe(false);
    expect(r.requiresConfirmation).toBeFalsy();
  });
});

describe("WebFetch + SecurityPipeline — 用户池击败 builtin (ADR-TPE-008)", () => {
  it("用户加 web_fetch deny * → 即使 preapproved host 也 deny", async () => {
    const denyRule = PermissionStore.createRule({
      pattern: { tool: "web_fetch", argument: "*" },
      decision: "deny",
      scope: "global",
    });
    const p = makePipeline({
      sessionType: "interactive",
      injectBuiltin: true,
      userRules: [denyRule],
    });
    const r = await p.evaluate(
      "web_fetch",
      { url: "https://docs.anthropic.com/x" },
      CWD,
    );
    expect(r.allowed).toBe(false);
  });

  it("用户加 web_fetch allow * → 任何 host 都 allow", async () => {
    const allowAllRule = PermissionStore.createRule({
      pattern: { tool: "web_fetch", argument: "*" },
      decision: "allow",
      scope: "global",
    });
    const p = makePipeline({
      sessionType: "interactive",
      injectBuiltin: true,
      userRules: [allowAllRule],
    });
    const r = await p.evaluate("web_fetch", { url: "https://random.example/" }, CWD);
    expect(r.allowed).toBe(true);
  });
});

describe("WebFetch + SecurityPipeline — permissionArgumentKey 自描述生效", () => {
  it("ToolArgumentExtractor 提取 url 字段(不是 prompt 等其他 string 字段)", async () => {
    const p = makePipeline({ sessionType: "interactive", injectBuiltin: true });
    // url 是 preapproved host,但 prompt 含一个非 preapproved 的 URL 字符串
    // 验证 extractor 用 url 字段而非 prompt
    const r = await p.evaluate(
      "web_fetch",
      {
        url: "https://docs.anthropic.com/x",
        prompt: "Summarize this from https://random.example/",
      },
      CWD,
    );
    expect(r.allowed).toBe(true);
  });
});
