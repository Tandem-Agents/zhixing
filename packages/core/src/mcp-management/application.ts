import type { McpSetupCandidate, McpResolveDeps } from "./setup.js";
import { resolveMcpSetup, extractMcpCandidate } from "./setup.js";
import type { McpManagementInfrastructurePort } from "./ports.js";
import { isValidMcpServerId, type McpServerConfigEntry } from "./types.js";
import {
  bindProductApiOperation,
  defineProductApiContribution,
  defineProductApiExactSet,
  defineProductApiQuery,
} from "../product-api/catalog.js";
import { parseConversationId } from "../conversation/scope-id.js";

export * from "./types.js";
export * from "./ports.js";
export * from "./setup.js";
export * from "./discovery.js";
export * from "./presets.js";

export type McpConnectionResult =
  | { readonly status: "active"; readonly serverId: string }
  | {
      readonly status: "needs-credentials";
      readonly candidate: McpSetupCandidate;
    }
  | { readonly status: "failed"; readonly message: string };

export interface McpPendingConnection {
  readonly candidate: McpSetupCandidate;
  readonly goal: string;
  readonly deviceId?: string;
  readonly status?: "needs-credentials" | "pending";
}

export const MCP_PENDING_QUERY = defineProductApiQuery<
  "mcp-management.query.pending",
  { conversationId: string },
  readonly McpPendingConnection[]
>("mcp-management.query.pending");
export const MCP_MANAGEMENT_PRODUCT_API_EXACT_SET = defineProductApiExactSet({
  operations: [MCP_PENDING_QUERY],
  factEvents: [],
});

export function createMcpManagementProductApiContribution(
  pending: (conversationId: string) => Promise<readonly McpPendingConnection[]>,
) {
  return defineProductApiContribution({
    operations: [
      bindProductApiOperation(MCP_PENDING_QUERY, async ({ conversationId }) => {
        parseConversationId(conversationId);
        return { result: await pending(conversationId), facts: [] };
      }),
    ],
    factEvents: [],
  });
}

export interface McpConnectionScope {
  readonly deviceId: string;
  readonly configurationRevision: string;
}

/** Trusted local editor input. This secret-bearing command is never bound as a model tool. */
export interface McpManagementEdit {
  readonly servers: Record<string, McpServerConfigEntry>;
  readonly credentials: Record<string, Record<string, string>>;
}

export interface McpManagementEditorPort {
  save(edit: McpManagementEdit): Promise<void>;
  activate(): Promise<void>;
}

/** Configuration/Secret provider and Host lifecycle implement this privileged edge.
 * Model-facing calls never accept or return credential values. */
export interface McpConnectionPort {
  pendingStatus?(candidate: McpSetupCandidate, scope: McpConnectionScope): Promise<"needs-credentials" | "pending">;
  connect(
    candidate: McpSetupCandidate,
    signal?: AbortSignal,
    isCurrent?: () => Promise<boolean>,
    scope?: McpConnectionScope,
  ): Promise<McpConnectionResult>;
}

export interface McpConnectionInfrastructure {
  inspect(
    candidate: McpSetupCandidate,
    scope?: McpConnectionScope,
  ): Promise<{
    conflict: boolean;
    credentialsReady: boolean;
    active: boolean;
    configured: boolean;
    unavailable?: string;
  }>;
  commit(
    candidate: McpSetupCandidate,
    scope?: McpConnectionScope,
  ): Promise<"added" | "unchanged" | "conflict">;
  activate(candidate: McpSetupCandidate): Promise<boolean>;
}

/** Connection policy is product-owned; infrastructure never decides continuation or success. */
export class McpConnectionApplication implements McpConnectionPort {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly port: McpConnectionInfrastructure) {}

  async pendingStatus(candidate: McpSetupCandidate, scope: McpConnectionScope): Promise<"needs-credentials" | "pending"> {
    const state = await this.port.inspect(candidate, scope);
    return !state.conflict && !state.unavailable && !state.credentialsReady ? "needs-credentials" : "pending";
  }

  connect(
    candidate: McpSetupCandidate,
    signal?: AbortSignal,
    isCurrent?: () => Promise<boolean>,
    scope?: McpConnectionScope,
  ): Promise<McpConnectionResult> {
    validateMcpCandidate(candidate);
    const proposal = structuredClone(candidate);
    const expectedScope = scope && structuredClone(scope);
    const work = this.tail.then(async (): Promise<McpConnectionResult> => {
      const current = async () => {
        signal?.throwIfAborted();
        return !isCurrent || (await isCurrent());
      };
      const failed = (message: string): McpConnectionResult => ({
        status: "failed",
        message,
      });
      if (!(await current())) return failed("原任务已停止，未接入新能力");
      let state: Awaited<ReturnType<McpConnectionInfrastructure["inspect"]>>;
      try {
        state = await this.port.inspect(proposal, expectedScope);
      } catch {
        return failed("无法核实配置或凭据状态，未接入新能力");
      }
      if (state.unavailable) return failed(state.unavailable);
      if (state.conflict)
        return failed(`服务 ${proposal.serverId} 已有不同配置，未覆盖。请通过管理入口核对。`);
      if (!state.credentialsReady) return { status: "needs-credentials", candidate: proposal };
      if (state.active) return { status: "active", serverId: proposal.serverId };
      // Persist the approved binding before any process/network effect. The normal
      // Host connection validates it; a separate trial would launch stdio twice
      // and could be replayed after a crash before the binding was committed.
      if (!(await current())) return failed("原任务已停止，未提交配置");
      let committed = await this.port
        .commit(proposal, expectedScope)
        .catch(() => "uncertain" as const);
      if (committed === "uncertain") {
        // Read the exact binding instead of replaying a write of unknown outcome.
        const saved = await this.port.inspect(proposal, expectedScope).catch(() => undefined);
        if (!saved?.configured || saved.conflict || saved.unavailable || !saved.credentialsReady)
          return failed("配置提交未确认，未尝试启用；请先核对已保存状态");
        if (saved.active) return { status: "active", serverId: proposal.serverId };
        committed = "unchanged";
      }
      if (committed === "conflict")
        return failed(`服务 ${proposal.serverId} 在接入期间被修改，未覆盖。`);
      if (!(await current())) return failed("配置已保存，但原任务已停止，未继续接入");
      try {
        if (await this.port.activate(proposal))
          return { status: "active", serverId: proposal.serverId };
      } catch {
        /* Preserve the committed/active distinction without exposing transport secrets. */
      }
      return failed(`服务 ${proposal.serverId} 配置已保存，但运行能力未生效。`);
    });
    this.tail = work.catch(() => {});
    return work;
  }
}

/** One product use case for UI and model bindings; transport, storage and secrets stay outside. */
export class McpManagementApplication {
  pendingStatus(candidate: McpSetupCandidate, scope: McpConnectionScope): Promise<"needs-credentials" | "pending"> {
    return this.ports.connection?.pendingStatus?.(candidate, scope) ?? Promise.resolve("pending");
  }
  constructor(
    private readonly ports: {
      discovery: McpManagementInfrastructurePort;
      llm?: McpResolveDeps["llm"];
      connection?: McpConnectionPort;
      editor?: McpManagementEditorPort;
    },
  ) {}

  resolve(input: string, signal?: AbortSignal, progress?: (text: string) => void) {
    return resolveMcpSetup(input, this.resolvePorts(), signal, progress);
  }

  extract(name: string, signal?: AbortSignal) {
    return extractMcpCandidate(name, this.resolvePorts(), signal);
  }

  snapshot() {
    return this.ports.discovery.snapshot();
  }
  search(query: string, signal?: AbortSignal) {
    return this.ports.discovery.search(query, signal);
  }
  readSource(name: string, signal?: AbortSignal) {
    return this.ports.discovery.readSource(name, signal);
  }

  connect(
    candidate: McpSetupCandidate,
    signal?: AbortSignal,
    isCurrent?: () => Promise<boolean>,
    scope?: McpConnectionScope,
  ) {
    validateMcpCandidate(candidate);
    signal?.throwIfAborted();
    if (!this.ports.connection)
      return Promise.resolve({
        status: "failed" as const,
        message: "此绑定仅提供发现，接入需通过受控管理入口",
      });
    return this.ports.connection.connect(structuredClone(candidate), signal, isCurrent, scope);
  }

  /** The editor stages changes; only its explicit save submits this application command. */
  async edit(edit: McpManagementEdit): Promise<{ status: "active" | "saved"; message: string }> {
    if (!this.ports.editor) throw new Error("未装配本地 MCP 配置入口");
    await this.ports.editor.save(edit);
    try {
      await this.ports.editor.activate();
      const statuses = await this.ports.discovery.snapshot();
      const enabled = Object.entries(edit.servers).filter(([, entry]) => entry.enabled !== false);
      if (
        enabled.every(([id]) =>
          statuses.some((item) => item.serverId === id && item.status === "connected"),
        ) &&
        statuses.every((item) => enabled.some(([id]) => id === item.serverId))
      )
        return { status: "active", message: "MCP 配置已保存并生效。" };
    } catch {
      /* Activation is not implied by a successful configuration commit. */
    }
    return {
      status: "saved",
      message: "MCP 配置已保存，但部分能力尚未确认生效；原任务会依据实际接入结果继续。",
    };
  }

  private resolvePorts(): McpResolveDeps {
    if (!this.ports.llm) throw new Error("未装配 MCP 来源解析模型");
    return {
      fetchSource: (name, signal) => this.ports.discovery.readSource(name, signal),
      search: (query, signal) => this.ports.discovery.search(query, signal),
      isServerIdValid: (id) => this.ports.discovery.isServerIdValid(id),
      llm: this.ports.llm,
    };
  }
}

/** Strict public proposal validation before confirmation, journal or configuration writes. */
export function validateMcpCandidate(value: unknown): asserts value is McpSetupCandidate {
  const candidate = record(value);
  exact(candidate, ["serverId", "entry", "secretFields", "source", "homepage"]);
  if (typeof candidate.serverId !== "string" || !isValidMcpServerId(candidate.serverId))
    throw new TypeError("无效的 MCP 服务标识");
  if (!["preset", "inferred"].includes(String(candidate.source)))
    throw new TypeError("无效的 MCP 来源");
  if (candidate.homepage !== undefined) publicUrl(candidate.homepage, true);
  const entry = record(candidate.entry);
  exact(entry, ["type", "command", "args", "url", "enabled"]);
  if (entry.enabled !== undefined && entry.enabled !== true)
    throw new TypeError("接入候选必须启用");
  if (entry.type === "http") {
    publicUrl(entry.url);
    if (entry.command !== undefined || entry.args !== undefined)
      throw new TypeError("HTTP 候选不能包含进程命令");
  } else {
    if (entry.type !== undefined && entry.type !== "stdio")
      throw new TypeError("无效的 MCP 传输类型");
    text(entry.command, 1024);
    if (entry.url !== undefined) throw new TypeError("stdio 候选不能包含 URL");
    if (entry.args !== undefined) strings(entry.args, 128, 4096);
  }
  if (!Array.isArray(candidate.secretFields) || candidate.secretFields.length > 32)
    throw new TypeError("无效的凭据字段描述");
  const keys = new Set<string>();
  for (const value of candidate.secretFields) {
    const field = record(value);
    exact(field, ["key", "label", "hint", "example", "docUrl", "template"]);
    if (
      typeof field.key !== "string" ||
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(field.key) ||
      keys.has(field.key) ||
      ["constructor", "prototype"].includes(field.key)
    )
      throw new TypeError("无效或重复的凭据字段");
    keys.add(field.key);
    text(field.label, 256);
    text(field.hint, 2048, true);
    text(field.example, 256, true);
    if (field.docUrl !== undefined) publicUrl(field.docUrl, true);
    if (field.template !== undefined) {
      text(field.template, 1024);
      if (!(field.template as string).includes("{value}"))
        throw new TypeError("凭据模板缺少值占位符");
    }
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("MCP 候选必须是对象");
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new TypeError("MCP 候选包含未知字段；凭据不能进入接入提案");
}
function text(value: unknown, limit: number, empty = false) {
  if (
    typeof value !== "string" ||
    (!empty && !value.trim()) ||
    value.length > limit ||
    /[\x00-\x08\x0b-\x1f]/.test(value)
  )
    throw new TypeError("无效或超长的 MCP 字段");
}
function strings(value: unknown, count: number, length: number) {
  if (!Array.isArray(value) || value.length > count) throw new TypeError("无效的 MCP 字段列表");
  value.forEach((item) => text(item, length, true));
}
function publicUrl(value: unknown, reference = false) {
  text(value, 4096);
  const url = new URL(value as string);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (!reference && (url.search || url.hash))
  )
    throw new TypeError("接入地址必须是不含凭据的公开 HTTP 地址");
}
