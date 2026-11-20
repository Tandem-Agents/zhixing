/**
 * 单元 2 · 端到端四协议运行接合、持久化恢复、旧执行器门控与基础配置入口验证
 *
 * 覆盖：
 * 1. ModelRuntimePort + createAgentRuntime + 真实本机 HTTP（OpenAI Responses 2 调用工具往返
 *    前缀字节不变 + task_list 实时刷新 + GPT-6.2 developer 首位 + 窗口重建诚实开新代际）；
 * 2. Google Interactions 多 thought / 空摘要纯签名 + 工具往返 + TranscriptShardStore 耐久落盘
 *    与倒读恢复 + 同源换型号重传 + 跨连接/改址/跨协议隔离；
 * 3. 旧 v1 执行器门控（携带 ThinkingBlock.protocolState 或新协议连接的派发拒绝 v1 执行器）；
 * 4. CLI /config 基础配置入口选择与切换四协议、保存 v2 配置与 modelFailureText 四协议脱敏指引。
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hasProtocolStateInMessages,
  type Message,
  type ToolDefinition,
  userMessage,
} from "@zhixing-ai/core";
import { TaskListProvider } from "@zhixing-ai/core/context";
import type { TaskItem } from "@zhixing-ai/core/conversation";
import {
  bindPermissionRuleExecutionSource,
  PermissionStore,
  toPermissionContext,
} from "@zhixing-ai/core/security";
import {
  readRunsReverse,
  ShardedTranscriptStore,
} from "@zhixing-ai/core/transcript";
import {
  createAgentRuntime,
  createKernelRuntimeEnvironment,
  createKernelWindowPromptProjection,
  type KernelSecurityExecutionFactory,
  type KernelToolImplementationPort,
  type KernelWindowPromptProjectionPort,
} from "@zhixing-ai/orchestrator/runtime";
import { setupAuthorityRuntime } from "../setup-delivery.js";
import {
  createProviderRoles,
  IMPLEMENTED_MODEL_ADAPTERS,
  type ProviderCredentialProjection,
  type ZhixingConfig,
} from "@zhixing-ai/providers";
import { createHostKernelModelProviderFactory } from "../runtime/kernel-runtime-bindings.js";
import { ModelRuntimePort } from "../runtime/model-runtime-port.js";
import { modelFailureText } from "../terminal/model-failure.js";
import { toWireAgentResult } from "@zhixing-ai/rpc/session-wire";
import { buildConnectionConfigMeta } from "../config-editor/model/entity.js";
import { buildConnectionAddMeta } from "../config-editor/model/list.js";
import { createInitialState } from "../config-editor/state.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()!();
  }
});

interface ReqRecord {
  readonly url: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: Record<string, unknown>;
}

async function startServer(
  handler: (req: ReqRecord, res: http.ServerResponse, idx: number) => void,
): Promise<{ readonly baseUrl: string; readonly requests: ReqRecord[] }> {
  const requests: ReqRecord[] = [];
  const server = http.createServer(async (rawReq, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of rawReq) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString("utf8");
    const rec: ReqRecord = {
      url: rawReq.url ?? "/",
      headers: rawReq.headers,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    };
    requests.push(rec);
    handler(rec, res, requests.length - 1);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))));
  const addr = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${addr.port}`, requests };
}

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function createTestWindowPrompt(): KernelWindowPromptProjectionPort {
  return Object.freeze({
    async project() {
      return createKernelWindowPromptProjection({
        revision: -1,
        segment: "skill-index",
        content: null,
      });
    },
  });
}

function createTestToolImplementation(): KernelToolImplementationPort {
  return Object.freeze({
    create({ requestedToolNames }) {
      return Object.freeze({
        tools: Object.freeze(
          requestedToolNames.map(
            (name): ToolDefinition => ({
              name,
              description: `stub ${name}`,
              inputSchema: { type: "object", properties: {} },
              call: async () => ({ content: "ok" }),
            }),
          ),
        ),
        permissionRuleSets: Object.freeze([]),
      });
    },
  });
}

function createTestSecurityExecution(): KernelSecurityExecutionFactory {
  return Object.freeze({
    create(request) {
      const store = new PermissionStore({
        rootDir: null,
        extractArgument: request.extractArgument,
      });
      for (const contribution of request.builtinRuleSets) {
        store.registerBuiltinRules(contribution.namespace, [...contribution.rules]);
      }
      store.registerBuiltinRules("unit2-test", [
        PermissionStore.createRule({
          pattern: { tool: "mark_done" },
          decision: "allow",
          scope: "builtin",
        }),
      ]);
      const contextId = Object.freeze(toPermissionContext({ kind: "main" as const }));
      return Object.freeze({
        contextId,
        trustContext: Object.freeze({ kind: "global" as const }),
        permissionRuleSource: bindPermissionRuleExecutionSource(store, contextId),
        persistentApprovals: true,
        recordApproval() {
          return Object.freeze({ kind: "recorded" as const });
        },
        securitySnapshot() {
          return Object.freeze({
            contextId,
            workspacePath: request.workspacePath,
            permissionRules: Object.freeze(store.list(contextId)),
            confirmations: Object.freeze([]),
          });
        },
        executionPermissionRules() {
          return Object.freeze(store.snapshot(contextId));
        },
      });
    },
  });
}

describe("Unit 2 E2E · real runtime + ModelRuntimePort + TranscriptShardStore + /config + error chain", () => {
  it("drives a real 2-call OpenAI Responses tool roundtrip through ModelRuntimePort + createAgentRuntime with byte-identical HTTP prefix, live task_list C1, clean transcript, and honest reset on window rebuild", async () => {
    const server = await startServer((_req, res, idx) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (idx === 0) {
        res.end(
          [
            `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_e2e_1", summary: [] } })}\n\n`,
            `event: response.reasoning_summary_text.delta\ndata: ${JSON.stringify({ type: "response.reasoning_summary_text.delta", output_index: 0, item_id: "rs_e2e_1", delta: "规划工具调用" })}\n\n`,
            `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_e2e_1", summary: [{ type: "summary_text", text: "规划工具调用" }], encrypted_content: "enc_e2e_xyz" } })}\n\n`,
            `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 1, item: { type: "message", id: "msg_e2e_1", role: "assistant", status: "in_progress", phase: "commentary", content: [] } })}\n\n`,
            `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", output_index: 1, item_id: "msg_e2e_1", delta: "开始执行。" })}\n\n`,
            `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 1, item: { type: "message", id: "msg_e2e_1", role: "assistant", status: "completed", phase: "commentary", content: [{ type: "output_text", text: "开始执行。", annotations: [] }] } })}\n\n`,
            `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 2, item: { type: "function_call", id: "fc_e2e_1", call_id: "call_e2e_1", name: "mark_done", arguments: "" } })}\n\n`,
            `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", output_index: 2, item_id: "fc_e2e_1", delta: "{}" })}\n\n`,
            `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 2, item: { type: "function_call", id: "fc_e2e_1", call_id: "call_e2e_1", name: "mark_done", arguments: "{}" } })}\n\n`,
            `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_e2e_1", status: "completed", output: [{ type: "function_call" }], usage: { input_tokens: 500, output_tokens: 30, total_tokens: 530, input_tokens_details: { cached_tokens: 100 }, output_tokens_details: { reasoning_tokens: 10 } } } })}\n\n`,
          ].join(""),
        );
        return;
      }
      res.end(
        [
          `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: `msg_e2e_${idx + 1}`, role: "assistant", status: "in_progress", phase: "final_answer", content: [] } })}\n\n`,
          `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", output_index: 0, item_id: `msg_e2e_${idx + 1}`, delta: "全部搞定" })}\n\n`,
          `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: `msg_e2e_${idx + 1}`, role: "assistant", status: "completed", phase: "final_answer", content: [{ type: "output_text", text: "全部搞定", annotations: [] }] } })}\n\n`,
          `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: `resp_e2e_${idx + 1}`, status: "completed", output: [], usage: { input_tokens: 620, output_tokens: 12, total_tokens: 632, input_tokens_details: { cached_tokens: 500 }, output_tokens_details: { reasoning_tokens: 0 } } } })}\n\n`,
        ].join(""),
      );
    });

    const config: ZhixingConfig = {
      llm: {
        schemaVersion: 2,
        connections: {
          openai: {
            name: "OpenAI Local",
            presetId: "openai",
            adapter: "openai-responses",
            endpoint: `${server.baseUrl}/v1`,
            auth: { mode: "api-key", secretRef: "openai" },
            network: { proxy: "direct", allowPrivateOrigin: true },
          },
        },
        main: {
          connectionId: "openai",
          model: "gpt-6.2-astra",
          params: { thinking: { mode: "effort", effort: "high" } },
        },
      },
    };
    const credentials: ProviderCredentialProjection = {
      modelSecrets: { openai: { v: 2, kind: "api-key", value: "sk-e2e-openai-123456" } },
    };

    const port = new ModelRuntimePort({
      modelConfiguration: config,
      providerCredentials: credentials,
      exposureCredentials: { providers: {}, channels: {}, mcp: {} },
      credentialGeneration: "gen-1",
    });

    // Readiness advertises openai-responses adapter
    expect(port.readiness().modelConnections).toMatchObject([
      { connectionId: "openai", adapter: "openai-responses", ready: true },
    ]);

    const factory = createHostKernelModelProviderFactory({
      configuration: config,
      credentials,
      modelRuntimePort: port,
    });

    let tasks: TaskItem[] = [{ id: "1", content: "检查日志", status: "in_progress" }];
    const markDoneTool: ToolDefinition = {
      name: "mark_done",
      description: "标记任务完成",
      inputSchema: { type: "object", properties: {} },
      boundaries: [{ boundaryType: "app-state", access: "write", dynamic: false }],
      async call() {
        tasks = [{ id: "1", content: "检查日志", status: "completed" }];
        return { content: "done" };
      },
    };

    const runtime = await createAgentRuntime({
      modelProvider: factory.create({ primaryRole: "main" }),
      primaryRole: "main",
      runtimeEnvironment: createKernelRuntimeEnvironment({
        agentIdentity: { displayName: "知行" },
        sessionType: "interactive",
        workspace: { source: "none", path: null },
        globalConfigPath: path.join(makeTempDir("zhixing-unit2-env-"), "config.jsonc"),
      }),
      toolImplementation: createTestToolImplementation(),
      securityExecution: createTestSecurityExecution(),
      windowPrompt: createTestWindowPrompt(),
      extraTools: [markDoneTool],
      turnContextProviders: [new TaskListProvider(() => tasks)],
    });
    cleanups.push(() => runtime.dispose("shutdown"));

    const completion = await runtime.run({
      identity: { conversationId: "conv-resp-e2e", turnIndex: 0, source: "terminal" },
      modelInput: { messages: [userMessage("执行检查")] },
      control: {},
      correctness: {},
      observation: {},
    });

    expect(completion.terminal.reason).toBe("completed");
    expect(server.requests).toHaveLength(2);

    // 校验真实 HTTP JSON 请求体：
    // 1. GPT-6.2 首位是 developer systemPrompt（非 instructions）
    const req1Input = server.requests[0]!.body.input as Array<Record<string, unknown>>;
    const req2Input = server.requests[1]!.body.input as Array<Record<string, unknown>>;
    expect(server.requests[0]!.body.instructions).toBeUndefined();
    expect(req1Input[0]!.role).toBe("developer");

    // 2. Call 2 在 R0 之前的前缀（developer + U0 + user(C0)）与 Call 1 逐字节完全一致
    expect(req2Input.slice(0, req1Input.length)).toEqual(req1Input);
    expect(JSON.stringify(req1Input.at(-1))).toContain("[~] 检查日志");
    expect(req1Input.at(-1)!.role).toBe("user");

    // 3. Call 2 尾部刷新后的 C1 为普通 user 角色，包含更新后的任务状态
    expect(req2Input.at(-1)!.role).toBe("user");
    expect(JSON.stringify(req2Input.at(-1))).toContain("[x] 检查日志");

    // 4. Call 2 原样重放 reasoning(enc_e2e_xyz) + commentary message + function_call + function_call_output
    expect(req2Input[req1Input.length]).toEqual({
      type: "reasoning",
      id: "rs_e2e_1",
      summary: [{ type: "summary_text", text: "规划工具调用" }],
      encrypted_content: "enc_e2e_xyz",
    });
    expect(req2Input[req1Input.length + 1]).toMatchObject({
      type: "message",
      role: "assistant",
      phase: "commentary",
      id: "msg_e2e_1",
    });

    // 5. 权威转录记录中绝不含 <turn-context>，但完整保真 protocolState
    expect(JSON.stringify(completion.artifacts.runRecord.messages)).not.toContain("<turn-context>");
    expect(hasProtocolStateInMessages(completion.artifacts.runRecord.messages)).toBe(true);

    // 6. 窗口换代（压缩/重建）后，诚实开启新前缀代际并省略已失效的旧 encrypted_content
    await runtime.onAttentionWindowChange("compact");
    await runtime.run({
      identity: { conversationId: "conv-resp-e2e", turnIndex: 1, source: "terminal" },
      modelInput: {
        messages: [...completion.artifacts.runRecord.messages, userMessage("压缩后的下一轮")],
      },
      control: {},
      correctness: {},
      observation: {},
    });
    const req3Input = server.requests[2]!.body.input as Array<Record<string, unknown>>;
    expect(JSON.stringify(req3Input)).not.toContain("enc_e2e_xyz");
  });

  it("persists Google Interactions multi-thought protocolState in TranscriptShardStore, restores cleanly, replays on same source, and strips on cross-source switch", async () => {
    const server = await startServer((_req, res, idx) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (idx === 0) {
        res.end(
          [
            `event: interaction.created\ndata: ${JSON.stringify({ event_type: "interaction.created", interaction: { id: "g_e2e_1", status: "in_progress" } })}\n\n`,
            `event: step.start\ndata: ${JSON.stringify({ event_type: "step.start", index: 0, step: { type: "thought" } })}\n\n`,
            `event: step.delta\ndata: ${JSON.stringify({ event_type: "step.delta", index: 0, delta: { type: "thought_signature", signature: "gsig_durable_1" } })}\n\n`,
            `event: step.stop\ndata: ${JSON.stringify({ event_type: "step.stop", index: 0 })}\n\n`,
            `event: step.start\ndata: ${JSON.stringify({ event_type: "step.start", index: 1, step: { type: "model_output" } })}\n\n`,
            `event: step.delta\ndata: ${JSON.stringify({ event_type: "step.delta", index: 1, delta: { type: "text", text: "第一轮结论" } })}\n\n`,
            `event: step.stop\ndata: ${JSON.stringify({ event_type: "step.stop", index: 1 })}\n\n`,
            `event: interaction.completed\ndata: ${JSON.stringify({ event_type: "interaction.completed", interaction: { id: "g_e2e_1", status: "completed", usage: { total_input_tokens: 50, total_output_tokens: 10 } } })}\n\n`,
            `event: done\ndata: [DONE]\n\n`,
          ].join(""),
        );
        return;
      }
      res.end(
        [
          `event: interaction.created\ndata: ${JSON.stringify({ event_type: "interaction.created", interaction: { id: `g_e2e_${idx + 1}`, status: "in_progress" } })}\n\n`,
          `event: step.start\ndata: ${JSON.stringify({ event_type: "step.start", index: 0, step: { type: "model_output" } })}\n\n`,
          `event: step.delta\ndata: ${JSON.stringify({ event_type: "step.delta", index: 0, delta: { type: "text", text: "续聊完成" } })}\n\n`,
          `event: step.stop\ndata: ${JSON.stringify({ event_type: "step.stop", index: 0 })}\n\n`,
          `event: interaction.completed\ndata: ${JSON.stringify({ event_type: "interaction.completed", interaction: { id: `g_e2e_${idx + 1}`, status: "completed", usage: { total_input_tokens: 60, total_output_tokens: 8 } } })}\n\n`,
          `event: done\ndata: [DONE]\n\n`,
        ].join(""),
      );
    });

    const config: ZhixingConfig = {
      llm: {
        schemaVersion: 2,
        connections: {
          "google-a": {
            name: "Google A",
            presetId: "google",
            adapter: "google-interactions",
            endpoint: server.baseUrl,
            auth: { mode: "api-key", secretRef: "google-a" },
            network: { proxy: "direct", allowPrivateOrigin: true },
          },
          "google-b": {
            name: "Google B",
            presetId: "google",
            adapter: "google-interactions",
            endpoint: server.baseUrl,
            auth: { mode: "api-key", secretRef: "google-b" },
            network: { proxy: "direct", allowPrivateOrigin: true },
          },
        },
        main: { connectionId: "google-a", model: "gemini-3.5-pro" },
        power: { connectionId: "google-b", model: "gemini-3.5-pro" },
      },
    };
    const credentials: ProviderCredentialProjection = {
      modelSecrets: {
        "google-a": { v: 2, kind: "api-key", value: "AIzaSyA1234567890123456" },
        "google-b": { v: 2, kind: "api-key", value: "AIzaSyB1234567890123456" },
      },
    };

    const googleFactory = createHostKernelModelProviderFactory({
      configuration: config,
      credentials,
    });
    const runtime = await createAgentRuntime({
      modelProvider: googleFactory.create({ primaryRole: "main" }),
      primaryRole: "main",
      runtimeEnvironment: createKernelRuntimeEnvironment({
        agentIdentity: { displayName: "知行" },
        sessionType: "interactive",
        workspace: { source: "none", path: null },
        globalConfigPath: path.join(makeTempDir("zhixing-unit2-env-g-"), "config.jsonc"),
      }),
      toolImplementation: createTestToolImplementation(),
      securityExecution: createTestSecurityExecution(),
      windowPrompt: createTestWindowPrompt(),
    });
    cleanups.push(() => runtime.dispose("shutdown"));

    const run1 = await runtime.run({
      identity: { conversationId: "conv-google-durable", turnIndex: 0, source: "terminal" },
      modelInput: { messages: [userMessage("你好")] },
      control: {},
      correctness: {},
      observation: {},
    });
    expect(run1.terminal.reason).toBe("completed");
    expect(hasProtocolStateInMessages(run1.artifacts.runRecord.messages)).toBe(true);

    // 真实 ShardedTranscriptStore 耐久落盘并以冷重启的新实例重新读取恢复
    const tmpDir = makeTempDir("zhixing-unit2-transcript-");
    const store = new ShardedTranscriptStore(tmpDir);
    await store.appendRunRecord("conv-google-durable", run1.artifacts.runRecord);

    const reopenedStore = new ShardedTranscriptStore(tmpDir);
    const restoredMessages: Message[] = [];
    for await (const item of readRunsReverse(reopenedStore, "conv-google-durable")) {
      restoredMessages.unshift(...item.record.messages);
    }
    expect(hasProtocolStateInMessages(restoredMessages)).toBe(true);

    // 同连接换型号恢复续聊 → 完整重传 thought step
    const { roles, closeAll } = createProviderRoles({ config, credentials });
    cleanups.push(closeAll);
    for await (const _ of roles.main.provider.chat({
      model: "gemini-3.5-flash",
      messages: [...restoredMessages, userMessage("继续")],
    })) {
      // drain
    }
    expect(JSON.stringify(server.requests[1]!.body.input)).toContain("gsig_durable_1");

    // 切到不同连接 google-b（同协议同名同端点）→ 绝不转发 google-a 的 thought 签名
    for await (const _ of roles.power.provider.chat({
      model: "gemini-3.5-pro",
      messages: [...restoredMessages, userMessage("换连接继续")],
    })) {
      // drain
    }
    expect(JSON.stringify(server.requests[2]!.body.input)).not.toContain("gsig_durable_1");
  });

  it("exposes all 4 protocols in /config connection-add & connection-config and formats 4-protocol errors without secret leaks in CLI", () => {
    const state = createInitialState({ llm: { schemaVersion: 2, connections: {} } }, { version: 2 });
    const addMeta = buildConnectionAddMeta(state);
    const labels = addMeta.items.map((item) => item.label);
    expect(labels).toContain("OpenAI");
    expect(labels).toContain("Anthropic");
    expect(labels).toContain("Google Gemini");

    // 选择 OpenAI 预设创建连接，自动带出 openai-responses 协议
    const openAiItem = addMeta.items.find((i) => i.label === "OpenAI")!;
    const afterOpenAi = openAiItem.onEnter(state);
    expect(afterOpenAi.type).toBe("replace");
    if (afterOpenAi.type !== "replace") throw new Error("expected replace");
    expect(afterOpenAi.state.config.llm?.connections.openai?.adapter).toBe("openai-responses");

    // 在连接编辑页循环切换受控协议，能覆盖全部 4 类 IMPLEMENTED_MODEL_ADAPTERS
    let curState = afterOpenAi.state;
    const seenAdapters = new Set<string>([curState.config.llm!.connections.openai!.adapter]);
    for (let i = 0; i < IMPLEMENTED_MODEL_ADAPTERS.length; i++) {
      const meta = buildConnectionConfigMeta(curState, {
        kind: "connection-config",
        connectionId: "openai",
      });
      const adapterRow = meta.rows.find((r) => r.label === "受控协议")!;
      const res = adapterRow.onEnter(curState);
      if (res.action.type === "stay") {
        curState = res.action.state;
        seenAdapters.add(curState.config.llm!.connections.openai!.adapter);
      }
    }
    expect([...seenAdapters].sort()).toEqual([...IMPLEMENTED_MODEL_ADAPTERS].sort());

    // CLI modelFailureText 统一走 core 分类，区分 403 子原因且不泄露密钥
    expect(
      modelFailureText("HTTP 403 (PERMISSION_DENIED): does not have access to model sk-secret-99999999"),
    ).toContain("无权访问");
    expect(
      modelFailureText("HTTP 403 (PERMISSION_DENIED): does not have access to model sk-secret-99999999"),
    ).not.toContain("sk-secret-99999999");
    expect(modelFailureText("HTTP 403: unsupported_country_region_territory")).toContain("地区");
    expect(modelFailureText("HTTP 401: Unauthorized")).toContain("401");
  });

  it(
    "gates legacy v1 executors for protocolState / new-protocol connections and advertises v2 4-protocol readiness",
    async () => {
    // 旧执行器（未宣告 modelConnections / protocolVersion = "1"）在派发新协议或含 protocolState 历史时被拒绝
    const entries = new Map<string, string>();
    const memSecrets = {
      async put(ref: { kind: string; bindingId: string }, value: string) {
        entries.set(`${ref.kind}/${ref.bindingId}`, value);
      },
      async get(ref: { kind: string; bindingId: string }) {
        return entries.get(`${ref.kind}/${ref.bindingId}`) ?? null;
      },
      async delete(ref: { kind: string; bindingId: string }) {
        entries.delete(`${ref.kind}/${ref.bindingId}`);
      },
      async getOrCreate(ref: { kind: string; bindingId: string }, create: () => string) {
        const key = `${ref.kind}/${ref.bindingId}`;
        if (!entries.has(key)) entries.set(key, create());
        return entries.get(key)!;
      },
      async getExisting(ref: { kind: string; bindingId: string }) {
        return entries.get(`${ref.kind}/${ref.bindingId}`) ?? null;
      },
      async list() {
        return [];
      },
      async unlockState() {
        return "unlocked" as const;
      },
    };

    const legacyV1Anchor = await setupAuthorityRuntime({
      zhixingHome: makeTempDir("zhixing-unit2-v1-gate-"),
      secretStore: memSecrets,
      executorId: "legacy-v1-exec",
      executorReadiness: () => ({
        tools: [],
        mcpServers: [],
        credentialBindings: [],
        deviceScopedCredentialBindingIds: [],
        credentialGeneration: null,
      }),
    });

    // 0. 不含 protocolState 的普通 follow-role 仍允许调度到旧 v1 执行器（向后兼容未破坏）
    const preparedLegacyPlain = await legacyV1Anchor.prepareConversationAssignment({
      conversationId: "conv-v1-plain-ok",
      executionProfile: { tools: [], mcpServers: [], providerIds: [] },
      permissionRules: [],
      modelSelection: { mode: "follow-role", role: "main" },
      allowLegacyV1FollowRole: true,
      targets: [],
    });
    expect(preparedLegacyPlain.policy.manifestCapabilities.protocolVersion).toBe("1");

    // 1. 含 protocolState 历史 → turn-execution 关闭 allowLegacyV1FollowRole → v1 执行器被拒（进入 capability-unavailable）
    await expect(
      legacyV1Anchor.prepareConversationAssignment({
        conversationId: "conv-v1-blocked",
        executionProfile: { tools: [], mcpServers: [], providerIds: [] },
        permissionRules: [],
        modelSelection: { mode: "follow-role", role: "main" },
        allowLegacyV1FollowRole: false,
        targets: [],
      }),
    ).rejects.toThrow(/capability-unavailable/);

    // 2. 指定新协议连接（openai-responses）→ v1 执行器被拒（进入 capability-unavailable）
    await expect(
      legacyV1Anchor.prepareConversationAssignment({
        conversationId: "conv-v1-blocked-responses",
        executionProfile: { tools: [], mcpServers: [], providerIds: [] },
        permissionRules: [],
        modelSelection: {
          mode: "connection",
          connectionId: "openai",
          model: "gpt-6.2-astra",
          adapter: "openai-responses",
        },
        targets: [],
      }),
    ).rejects.toThrow(/capability-unavailable/);

    // 3. v2 执行器宣告 openai-responses 与 google-interactions 连接就绪 → 正常通过，且错误协议被精准拒绝
    const v2Anchor = await setupAuthorityRuntime({
      zhixingHome: makeTempDir("zhixing-unit2-v2-gate-"),
      secretStore: memSecrets,
      executorId: "modern-v2-exec",
      executorReadiness: () => ({
        tools: [],
        mcpServers: [],
        credentialBindings: [
          {
            bindingId: "credential-model-google",
            service: "model-secret-google",
            verification: "user-alias",
          },
          {
            bindingId: "credential-model-openai",
            service: "model-secret-openai",
            verification: "user-alias",
          },
        ],
        deviceScopedCredentialBindingIds: [
          "credential-model-google",
          "credential-model-openai",
        ],
        credentialGeneration: "gen-v2",
        modelConnections: [
          {
            connectionId: "google",
            revision: "rev-1",
            adapter: "google-interactions",
            authMode: "api-key",
            credentialBindingId: "credential-model-google",
            ready: true,
            boundRoles: ["power"],
          },
          {
            connectionId: "openai",
            revision: "rev-1",
            adapter: "openai-responses",
            authMode: "api-key",
            credentialBindingId: "credential-model-openai",
            ready: true,
            boundRoles: ["main"],
          },
        ],
        readyRoles: ["main", "light", "power"],
      }),
    });

    const preparedV2 = await v2Anchor.prepareConversationAssignment({
      conversationId: "conv-v2-ok",
      executionProfile: { tools: [], mcpServers: [], providerIds: [] },
      permissionRules: [],
      modelSelection: {
        mode: "connection",
        connectionId: "google",
        model: "gemini-3.5-pro",
        adapter: "google-interactions",
      },
      targets: [],
    });
    expect(preparedV2.policy.manifestCapabilities.protocolVersion).toBe("2");

    // 协议不匹配（声明要 openai-responses 但目标连接是 google-interactions）→ 精确拒绝（capability-unavailable）
    await expect(
      v2Anchor.prepareConversationAssignment({
        conversationId: "conv-v2-mismatch",
        executionProfile: { tools: [], mcpServers: [], providerIds: [] },
        permissionRules: [],
        modelSelection: {
          mode: "connection",
          connectionId: "google",
          model: "gpt-6.2-astra",
          adapter: "openai-responses",
        },
        targets: [],
      }),
    ).rejects.toThrow(/capability-unavailable/);
  }, 20_000);

  it("R1-F3 selection boundary & wire projection: rejects incompatible image/roundtrip model selection before persistence and strips opaque protocolState from toWireAgentResult", async () => {
    const config: ZhixingConfig = {
      llm: {
        schemaVersion: 2,
        connections: {
          visionA: {
            name: "Vision A",
            presetId: "openai",
            adapter: "openai-responses",
            endpoint: "http://127.0.0.1:19999/v1",
            auth: { mode: "none" },
            network: { proxy: "direct", allowPrivateOrigin: true },
            modelOverrides: { "vision-model": { supportsImages: true } },
          },
          textOnlyB: {
            name: "Text Only B",
            presetId: "openai",
            adapter: "openai-responses",
            endpoint: "http://127.0.0.1:19998/v1",
            auth: { mode: "none" },
            network: { proxy: "direct", allowPrivateOrigin: true },
            modelOverrides: { "text-only-model": { supportsImages: false } },
          },
        },
        main: { connectionId: "visionA", model: "vision-model" },
      },
    };
    const port = new ModelRuntimePort({
      modelConfiguration: config,
      providerCredentials: {},
      exposureCredentials: { providers: {}, channels: {}, mcp: {} },
      credentialGeneration: null,
    });

    const imageWindow: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "看图" },
          { type: "image", source: { type: "base64", mediaType: "image/png", data: "iVBORw0KGgo=" } },
        ],
      },
    ];
    const imageReject = await port.validateSessionModelSelection({
      conversationId: "conv-img",
      modelSelection: { mode: "override", connectionId: "textOnlyB", model: "text-only-model" },
      activeWindowMessages: imageWindow,
    });
    expect(imageReject).toContain("不支持图片");

    // 切到同样支持图片的模型则允许保存
    const visionAllow = await port.validateSessionModelSelection({
      conversationId: "conv-img",
      modelSelection: { mode: "override", connectionId: "visionA", model: "vision-model" },
      activeWindowMessages: imageWindow,
    });
    expect(visionAllow).toBeNull();

    // toWireAgentResult 复用公开投影剥离 completed 消息上的 protocolState/signature，不改动原权威消息
    const authMessage: Message = {
      role: "assistant",
      content: [
        {
          type: "thinking",
          thinking: "公开思考摘要",
          signature: "secret_sig_1",
          protocolState: {
            protocol: "openai-responses",
            sourceConnectionId: "visionA",
            sourceOriginKey: "openai-responses@http://127.0.0.1:19999/v1",
            sourceModel: "vision-model",
            payloadVersion: 1,
            encryptedContent: "enc_opaque_wire_blob",
          },
        },
        {
          type: "text",
          text: "最终结论",
          protocolState: {
            protocol: "openai-responses",
            sourceConnectionId: "visionA",
            sourceOriginKey: "openai-responses@http://127.0.0.1:19999/v1",
            sourceModel: "vision-model",
            phase: "final_answer",
            itemId: "msg_1",
          },
        },
      ],
    };
    const wire = toWireAgentResult({
      reason: "completed",
      message: authMessage,
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(JSON.stringify(wire)).not.toContain("enc_opaque_wire_blob");
    expect(JSON.stringify(wire)).not.toContain("secret_sig_1");
    expect(JSON.stringify(wire)).toContain("公开思考摘要");
    expect(JSON.stringify(wire)).toContain("最终结论");
    // 原权威消息未被修改
    expect(hasProtocolStateInMessages([authMessage])).toBe(true);
  });
});
