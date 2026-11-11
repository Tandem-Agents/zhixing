import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PermissionRule } from "@zhixing-ai/core/security";
import { workspaceTrustIdentity } from "@zhixing-ai/core/trust-administration";
import { createTempDir } from "@zhixing-ai/test-utils";
import { createPermissionStorageInfrastructure } from "../permission-storage-infrastructure.js";
import { createTrustAdministrationApplication } from "../trust-administration-adapter.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

function rule(
  id: string,
  scope: PermissionRule["scope"],
  argument: string,
): PermissionRule {
  return {
    id,
    scope,
    pattern: { tool: "bash", argument },
    decision: "allow",
    createdAt: 1,
    lastMatchedAt: 0,
    matchCount: 0,
    ...(scope === "context" ? { contextId: { kind: "main" } } : {}),
  };
}

function runtimeRequest() {
  return Object.freeze({
    extractArgument: (request: { readonly arguments: Readonly<Record<string, unknown>> }) =>
      String(request.arguments.command ?? ""),
    builtinRuleSets: Object.freeze([
      Object.freeze({
        namespace: "shell-defaults",
        rules: Object.freeze([rule("builtin", "builtin", "pwd")]),
      }),
    ]),
    workspacePath: null,
  });
}

function securityRequest(command: string) {
  return {
    tool: "bash",
    arguments: { command },
    context: {
      cwd: process.cwd(),
      trust: { kind: "global" as const },
      sessionType: "interactive" as const,
    },
  };
}

describe("Host permission storage infrastructure", () => {
  it("owns the one P04 root while exposing separate runtime and management roles", async () => {
    const home = await createTempDir("permission-storage-infrastructure");
    cleanup.push(home);
    const infrastructure = createPermissionStorageInfrastructure({ zhixingHome: home, persistentApprovals: true });
    const runtime = infrastructure.runtime
      .bind(Object.freeze({}))
      .create(runtimeRequest());
    const context = { kind: "main" } as const;

    await runtime.recordApproval({
      kind: "allow-global",
      pattern: {
        pattern: { tool: "bash", argument: "npm *" },
        label: "npm commands",
      },
      requestId: "request-global",
    });

    await expect(
      fs.readFile(path.join(home, "permissions", "global.json"), "utf8"),
    ).resolves.toContain('"argument": "npm *"');
    await expect(infrastructure.management.list(context)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: "global", pattern: { tool: "bash", argument: "npm *" } }),
      ]),
    );
    expect(runtime.permissionRuleSource.match(securityRequest("pwd"))).toMatchObject({
      id: "builtin",
      scope: "builtin",
    });
  });

  it("keeps session rules in one runtime binding and excludes them after re-issuance", async () => {
    const home = await createTempDir("permission-storage-session");
    cleanup.push(home);
    const infrastructure = createPermissionStorageInfrastructure({ zhixingHome: home });
    const context = { kind: "main" } as const;
    const factory = infrastructure.runtime.bind(Object.freeze({}));
    const first = factory.create(runtimeRequest());
    await first.recordApproval({
      kind: "allow-session",
      pattern: {
        pattern: { tool: "bash", argument: "git status" },
        label: "git status",
      },
    });

    expect(first.permissionRuleSource.match(securityRequest("git status"))).toMatchObject({
      scope: "session",
    });
    const restarted = factory.create(runtimeRequest());
    expect(
      restarted.permissionRuleSource.match(securityRequest("git status")),
    ).toBeNull();
    await expect(infrastructure.management.list(context)).resolves.toEqual([]);
  });

  it("derives the trust scope only from authenticated scope facts, never from the local path", async () => {
    const home = await createTempDir("permission-storage-context");
    cleanup.push(home);
    const infrastructure = createPermissionStorageInfrastructure({ zhixingHome: home });
    const workspacePath = path.join(home, "workspace");
    const requestWithWorkspace = Object.freeze({
      ...runtimeRequest(),
      workspacePath,
    });
    const binding = { deviceId: "device-1", bindingRef: "binding-1", workspaceBindingRevision: 2 };

    const scene = infrastructure.runtime
      .bind(Object.freeze({ sceneId: "scene-1", workspace: binding }))
      .create(requestWithWorkspace);
    const workspace = infrastructure.runtime
      .bind(Object.freeze({ workspace: binding }))
      .create(requestWithWorkspace);
    const pathOnly = infrastructure.runtime
      .bind(Object.freeze({}))
      .create(requestWithWorkspace);
    const global = infrastructure.runtime
      .bind(Object.freeze({}))
      .create(runtimeRequest());

    expect(scene.contextId).toEqual({ kind: "scene", sceneId: "scene-1" });
    expect(scene.trustContext).toEqual({ kind: "scene", sceneId: "scene-1" });
    expect(scene.securitySnapshot().workspacePath).toBeNull();
    expect(workspace.contextId).toEqual({
      kind: "workspace",
      hash: workspaceTrustIdentity("device-1", "binding-1"),
      revision: 2,
    });
    expect(workspace.trustContext).toEqual({ kind: "workspace", dir: workspacePath });
    // 本机路径只决定执行环境约束，不决定授权范围
    expect(pathOnly.contextId).toEqual({ kind: "main" });
    expect(pathOnly.trustContext).toEqual({ kind: "workspace", dir: workspacePath });
    expect(global.contextId).toEqual({ kind: "main" });
    expect(global.trustContext).toEqual({ kind: "global" });
  });

  it("composes the dispatch snapshot for the requested run scope across all binding revisions", async () => {
    const home = await createTempDir("permission-storage-snapshot");
    cleanup.push(home);
    const infrastructure = createPermissionStorageInfrastructure({ zhixingHome: home, persistentApprovals: true });
    const binding = { deviceId: "device-1", bindingRef: "binding-1" };
    const executor = infrastructure.runtime
      .bind(Object.freeze({ workspace: { ...binding, workspaceBindingRevision: 1 } }))
      .create(runtimeRequest());
    await executor.recordApproval({
      kind: "allow-context",
      pattern: { pattern: { tool: "bash", argument: "npm test" }, label: "npm test" },
      requestId: "request-context",
    });
    const owner = infrastructure.runtime.bind(Object.freeze({})).create(runtimeRequest());
    expect(owner.executionPermissionRules().map((entry) => entry.scope)).toEqual(["builtin"]);
    const runScope = { kind: "workspace", hash: workspaceTrustIdentity("device-1", "binding-1") } as const;
    expect(owner.executionPermissionRules(runScope).map((entry) => `${entry.scope}:${entry.pattern.argument}`))
      .toEqual(["context:npm test", "builtin:pwd"]);
    expect(Object.isFrozen(owner.executionPermissionRules(runScope)[0])).toBe(true);
  });

  it("offers persistent approvals only on the rule authority and never treats them as once elsewhere", async () => {
    const home = await createTempDir("permission-storage-persistent");
    cleanup.push(home);
    const anchor = createPermissionStorageInfrastructure({ zhixingHome: home, persistentApprovals: true });
    const conversation = anchor.runtime.bind(Object.freeze({})).create(runtimeRequest());
    const job = anchor.runtime.bind(Object.freeze({}), { persistentApprovals: false }).create(runtimeRequest());
    expect(conversation.persistentApprovals).toBe(true);
    expect(job.persistentApprovals).toBe(false);
    // 没有耐久决定生命周期的运行：确认解析即接纳，按（范围、请求）确定 id 发布，重复读取同一规则
    const approval = {
      kind: "allow-context" as const,
      pattern: { pattern: { tool: "bash", argument: "npm test" }, label: "npm test" },
      requestId: "request-direct",
    };
    const first = await conversation.recordApproval(approval);
    const again = await conversation.recordApproval(approval);
    expect(first).toMatchObject({ kind: "rule-created" });
    expect(again).toEqual(first);
    await expect(job.recordApproval(approval)).rejects.toThrow(/不支持持久授权/u);

    const executorOnly = createPermissionStorageInfrastructure({ zhixingHome: await createTempDir("permission-storage-executor") });
    const remote = executorOnly.runtime.bind(Object.freeze({})).create(runtimeRequest());
    expect(remote.persistentApprovals).toBe(false);
    expect(executorOnly.explicitApprovals).toBeUndefined();
    await expect(remote.recordApproval(approval)).rejects.toThrow(/不支持持久授权/u);
  });

  it("accepts mirrored sediments only for the authenticated scope, the representative pattern and answered user contributions", async () => {
    const home = await createTempDir("permission-storage-sediment");
    cleanup.push(home);
    const anchor = createPermissionStorageInfrastructure({ zhixingHome: home, persistentApprovals: true });
    const port = anchor.trustSediments!;
    const binding = { deviceId: "device-1", bindingRef: "binding-1", workspaceBindingRevision: 4 };
    const fact = (overrides: Partial<import("@zhixing-ai/core/contracts").TrustSedimentFact> = {}) => ({
      pattern: { tool: "bash", argument: "npm install *" },
      riskLevel: "medium" as const,
      operation: { tool: "bash", arguments: { command: "npm install left-pad" } },
      contributors: [
        { origin: "user" as const, timestamp: 1, requestId: "request-1" },
        { origin: "steward" as const, timestamp: 2 },
        { origin: "steward" as const, timestamp: 3 },
      ],
      ...overrides,
    });
    const offer = async (requestId: string, sediment: ReturnType<typeof fact>, answered = true) => {
      const entry = { ordinal: 1, seq: 1, requestId, kind: "trust-sediment" as const, sediment, at: "2026-11-01T00:00:00.000Z" };
      const input = { conversationId: "conversation-1", assignmentId: "assignment-1", executorId: "executor-1",
        environment: { workspace: binding }, entry, answered: async () => answered };
      await port.prepare(input);
      return entry;
    };
    const scope = { kind: "workspace", hash: workspaceTrustIdentity("device-1", "binding-1") } as const;
    const listed = async () => (await anchor.management.list(scope)).map((rule) => rule.pattern.argument);

    // 不一致的事实一律无效果、不上抛（不堵镜像通道）
    await offer("trust-sediment:1", fact({ pattern: { tool: "bash", argument: "*" } }));
    await offer("trust-sediment:2", fact({ contributors: [{ origin: "steward", timestamp: 1 }] }));
    await offer("trust-sediment:3", fact(), false);
    await expect(listed()).resolves.toEqual([]);

    const entry = await offer("trust-sediment:4", fact());
    // 提交前只有待生效记录，不生效
    await expect(listed()).resolves.toEqual([]);
    await port.accept({ conversationId: "conversation-1", assignmentId: "assignment-1", entry });
    const rules = await anchor.management.list(scope);
    expect(rules).toMatchObject([{
      scope: "context",
      pattern: { tool: "bash", argument: "npm install *" },
      contextId: { kind: "workspace", hash: scope.hash, revision: 4 },
    }]);

    // 撤销后同一沉淀重放（重新准备、接纳）不复活，也不上抛
    await expect(anchor.management.revoke(scope, rules[0]!.id)).resolves.toBe(true);
    await offer("trust-sediment:4", fact());
    await port.accept({ conversationId: "conversation-1", assignmentId: "assignment-1", entry });
    await expect(listed()).resolves.toEqual([]);
  });

  it("derives a job sediment's scope from its manifest workspace and freezes the same scope into the next job snapshot", async () => {
    const home = await createTempDir("permission-storage-job-sediment");
    cleanup.push(home);
    const anchor = createPermissionStorageInfrastructure({ zhixingHome: home, persistentApprovals: true });
    const port = anchor.jobTrustSediments!;
    const sediment = (argument: string) => ({
      pattern: { tool: "bash", argument },
      riskLevel: "medium" as const,
      operation: { tool: "bash", arguments: { command: argument.replace("*", "x") } },
      contributors: [
        { origin: "steward" as const, timestamp: 1 },
        { origin: "steward" as const, timestamp: 2 },
        { origin: "steward" as const, timestamp: 3 },
      ],
    });
    const deliver = async (
      assignmentId: string,
      argument: string,
      environment: { workspace?: { deviceId: string; bindingRef: string; workspaceBindingRevision: number } },
    ) => {
      const entry = { ordinal: 1, seq: 1, requestId: "trust-sediment:1", kind: "trust-sediment" as const,
        sediment: sediment(argument), at: "2026-11-01T00:00:00.000Z" };
      await port.prepare({ taskId: "task-1", assignmentId, executorId: "executor-1", environment: {
        credentialBindings: [], ...environment }, entry, answered: async () => false });
      await port.accept({ taskId: "task-1", assignmentId, entry });
    };
    const binding = (workspaceBindingRevision: number) =>
      ({ deviceId: "device-1", bindingRef: "binding-1", workspaceBindingRevision });
    const workspace = { kind: "workspace", hash: workspaceTrustIdentity("device-1", "binding-1") } as const;

    // 带工作区的 job：沉淀进该工作区（含修订），不泛化到主范围
    await deliver("assignment-ws", "npm test *", { workspace: binding(2) });
    await expect(anchor.management.list(workspace)).resolves.toMatchObject([
      { pattern: { argument: "npm test *" }, contextId: { kind: "workspace", hash: workspace.hash, revision: 2 } },
    ]);
    expect(anchor.executionRulesFor({}).map((rule) => rule.pattern.argument)).toEqual([]);
    // 下一次派发按同一范围冻结：同修订带上，改路径（新修订）后失效
    expect(anchor.executionRulesFor({ workspace: binding(2) }).map((rule) => rule.pattern.argument)).toEqual(["npm test *"]);
    expect(anchor.executionRulesFor({ workspace: binding(3) })).toEqual([]);

    // 无工作区的 job：主范围
    await deliver("assignment-main", "npm run *", {});
    expect(anchor.executionRulesFor({}).map((rule) => rule.pattern.argument)).toEqual(["npm run *"]);
    expect(anchor.executionRulesFor({ workspace: binding(2) }).map((rule) => rule.pattern.argument)).toEqual(["npm test *"]);

    // 撤销后同一 job 沉淀重放不复活，下一次派发不再带它
    const [mainRule] = await anchor.management.list({ kind: "main" });
    await expect(anchor.management.revoke({ kind: "main" }, mainRule!.id)).resolves.toBe(true);
    await deliver("assignment-main", "npm run *", {});
    expect(anchor.executionRulesFor({})).toEqual([]);
  });

  it("keeps a job sediment pending until its task journal confirms the mirror after a restart", async () => {
    const home = await createTempDir("permission-storage-job-sediment-restart");
    cleanup.push(home);
    const anchor = createPermissionStorageInfrastructure({ zhixingHome: home, persistentApprovals: true });
    const entry = { ordinal: 1, seq: 1, requestId: "trust-sediment:1", kind: "trust-sediment" as const,
      sediment: {
        pattern: { tool: "bash", argument: "npm ci *" },
        riskLevel: "medium" as const,
        operation: { tool: "bash", arguments: { command: "npm ci x" } },
        contributors: [1, 2, 3].map((timestamp) => ({ origin: "steward" as const, timestamp })),
      },
      at: "2026-11-01T00:00:00.000Z" };
    // 准备后进程退出、没来得及接纳
    await anchor.jobTrustSediments!.prepare({ taskId: "task-1", assignmentId: "assignment-1", executorId: "executor-1",
      environment: { credentialBindings: [] }, entry, answered: async () => false });

    const restarted = createPermissionStorageInfrastructure({ zhixingHome: home, persistentApprovals: true });
    const verified: unknown[] = [];
    let mirrored = false;
    restarted.bindExplicitApprovalVerifier(async (pending) => {
      verified.push({ taskId: pending.taskId, assignmentId: pending.assignmentId, requestId: pending.requestId });
      return mirrored ? "accepted" : "unknown";
    });
    expect(restarted.executionRulesFor({})).toEqual([]);
    await vi.waitFor(() => expect(verified).toEqual([
      { taskId: "task-1", assignmentId: "assignment-1", requestId: "assignment-1/trust-sediment:1" },
    ]));
    expect(restarted.executionRulesFor({})).toEqual([]);

    mirrored = true;
    const again = createPermissionStorageInfrastructure({ zhixingHome: home, persistentApprovals: true });
    again.bindExplicitApprovalVerifier(async () => (mirrored ? "accepted" : "unknown"));
    again.executionRulesFor({});
    await vi.waitFor(() => expect(again.executionRulesFor({}).map((rule) => rule.pattern.argument)).toEqual(["npm ci *"]));
  });

  it("reports a sediment only after the authority accepted it, and writes directly only on the authority host", async () => {
    const home = await createTempDir("permission-storage-sediment-runtime");
    cleanup.push(home);
    const anchor = createPermissionStorageInfrastructure({ zhixingHome: home, persistentApprovals: true });
    let durableRun = true;
    // 另一个来源（job）不在绑定里时返回 undefined，不影响对话来源
    anchor.addTrustSedimentRecorder(async () => undefined);
    anchor.addTrustSedimentRecorder(async (sediment) => {
      if (!durableRun) return undefined;
      // 本机执行端：owner 日志在同一进程里准备并接纳
      const entry = { ordinal: 1, seq: 1, requestId: "trust-sediment:1", kind: "trust-sediment" as const, sediment,
        at: "2026-11-01T00:00:00.000Z" };
      await anchor.trustSediments!.prepare({ conversationId: "conversation-1", assignmentId: "assignment-1",
        executorId: "executor-1", environment: {}, entry, answered: async () => true });
      await anchor.trustSediments!.accept({ conversationId: "conversation-1", assignmentId: "assignment-1", entry });
      return { assignmentId: "assignment-1", requestId: "trust-sediment:1", mirrored: true };
    });
    const approve = (runtime: ReturnType<ReturnType<typeof anchor.runtime.bind>["create"]>, index: number) =>
      runtime.recordApproval({
        kind: "allow-once",
        operation: { tool: "bash", arguments: { command: `npm install pkg-${index}` } },
        riskLevel: "medium",
        origin: "user",
        bypassImmune: false,
        requestId: `request-${index}`,
      });
    const conversation = anchor.runtime.bind(Object.freeze({})).create(runtimeRequest());
    await approve(conversation, 1);
    await approve(conversation, 2);
    const sedimented = await approve(conversation, 3);
    expect(sedimented).toMatchObject({ kind: "rule-sedimented", rule: { pattern: { argument: "npm install *" } } });
    // 运行内快照冻结，同一键不重复沉淀
    await expect(approve(conversation, 4)).resolves.toEqual({ kind: "recorded" });

    // 没有耐久对话回程（定时任务）：规则权威宿主直接写
    durableRun = false;
    const scheduled = anchor.runtime.bind(Object.freeze({}), { persistentApprovals: false }).create(runtimeRequest());
    for (const index of [5, 6]) await approve(scheduled, index);
    await expect(approve(scheduled, 7)).resolves.toMatchObject({ kind: "rule-sedimented" });

    // 执行端角色宿主没有回程时不写本机库
    const executorOnly = createPermissionStorageInfrastructure({ zhixingHome: await createTempDir("permission-storage-sediment-remote") });
    const remote = executorOnly.runtime.bind(Object.freeze({})).create(runtimeRequest());
    for (const index of [8, 9]) await approve(remote, index);
    await expect(approve(remote, 10)).resolves.toEqual({ kind: "recorded" });
    await expect(executorOnly.management.list({ kind: "main" })).resolves.toEqual([]);
  });

  it("pages other scopes from file names only and names stale or unknown workspaces as no longer effective", async () => {
    const home = await createTempDir("permission-storage-scopes");
    cleanup.push(home);
    const anchor = createPermissionStorageInfrastructure({ zhixingHome: home, persistentApprovals: true });
    const approve = async (workspace: { deviceId: string; bindingRef: string; workspaceBindingRevision: number }, requestId: string) =>
      anchor.runtime.bind(Object.freeze({ workspace })).create(runtimeRequest()).recordApproval({
        kind: "allow-context",
        pattern: { pattern: { tool: "bash", argument: `npm ${requestId}` }, label: requestId },
        requestId,
      });
    await approve({ deviceId: "device-1", bindingRef: "current", workspaceBindingRevision: 3 }, "r-current");
    await approve({ deviceId: "device-1", bindingRef: "repathed", workspaceBindingRevision: 1 }, "r-repathed");
    await approve({ deviceId: "device-1", bindingRef: "removed", workspaceBindingRevision: 1 }, "r-removed");
    await fs.writeFile(path.join(home, "permissions", "stray.json.1.tmp"), "{}");

    const first = await anchor.management.listScopes!({ limit: 2 });
    expect(first.scopes).toHaveLength(2);
    expect(first.next).toBeDefined();
    const second = await anchor.management.listScopes!({ after: first.next!, limit: 2 });
    expect(second.scopes).toHaveLength(1);
    expect(second.next).toBeUndefined();
    expect([...first.scopes, ...second.scopes].every((scope) => scope.context.kind === "workspace" && !("revision" in scope.context)))
      .toBe(true);

    const application = createTrustAdministrationApplication({
      repository: anchor.management,
      workspaces: async () => new Map([
        [workspaceTrustIdentity("device-1", "current"), { name: "当前项目", revision: 3 }],
        [workspaceTrustIdentity("device-1", "repathed"), { name: "改过路径", revision: 2 }],
      ]),
    });
    const view = await application.query({ kind: "list", otherScopes: { limit: 10 } });
    const byLabel = Object.fromEntries((view.otherScopes?.groups ?? []).map((group) => [group.label, group.effective]));
    expect(byLabel).toEqual({
      "工作区「当前项目」": true,
      "工作区「改过路径」": false,
      [`工作区 ${workspaceTrustIdentity("device-1", "removed").slice(0, 8)}`]: false,
    });
  });

  it("verifies pending explicit approvals found on reload only once the host binds its durable decision lookup", async () => {
    const home = await createTempDir("permission-storage-reload");
    cleanup.push(home);
    const before = createPermissionStorageInfrastructure({ zhixingHome: home, persistentApprovals: true });
    await before.explicitApprovals!.prepare({
      requestId: "request-reload",
      assignmentId: "assignment-1",
      contextId: { kind: "main" },
      decision: { kind: "allow-context", pattern: { pattern: { tool: "bash", argument: "npm test" }, label: "npm test" } },
      decisionDigest: "digest:reload",
    });
    const after = createPermissionStorageInfrastructure({ zhixingHome: home, persistentApprovals: true });
    const context = { kind: "main" } as const;
    await expect(after.management.list(context)).resolves.toEqual([]);
    const verified: string[] = [];
    after.bindExplicitApprovalVerifier(async (entry) => {
      verified.push(entry.requestId);
      return entry.decisionDigest === "digest:reload" ? "accepted" : "rejected";
    });
    await expect.poll(async () => (await after.management.list(context)).map((rule) => rule.pattern.argument))
      .toEqual(["npm test"]);
    expect(verified).toEqual(["request-reload"]);
  });
});

describe("规则命中在规则权威侧累计", () => {
  async function homeWithGlobalRule(prefix: string): Promise<string> {
    const home = await createTempDir(prefix);
    cleanup.push(home);
    await fs.mkdir(path.join(home, "permissions"), { recursive: true });
    await fs.writeFile(path.join(home, "permissions", "global.json"), JSON.stringify({
      version: 1, scope: "global", rules: [rule("rule-global", "global", "curl *")],
    }));
    return home;
  }
  const matchCount = async (infrastructure: ReturnType<typeof createPermissionStorageInfrastructure>) =>
    (await infrastructure.management.list({ kind: "main" })).find((entry) => entry.id === "rule-global")?.matchCount;
  const entry = (n: number) => ({
    ordinal: n, seq: n, requestId: `trust-rule-hit:${n}`, kind: "trust-rule-hit" as const,
    hit: { ruleId: "rule-global" }, at: "2026-11-10T00:00:00.000Z",
  });
  const batch = (n: number, batchDigest: string) => ({
    origin: { conversationId: "conversation-1" }, assignmentId: "assignment-1", environment: {}, batchDigest, entries: [entry(n)],
  });

  it("运行的命中经回程交 owner 累计；无回程时只有规则权威直接记账；执行端宿主不记", async () => {
    const home = await homeWithGlobalRule("rule-hit-runtime");
    const anchor = createPermissionStorageInfrastructure({ zhixingHome: home, persistentApprovals: true });
    let durableRun = true;
    let n = 0;
    anchor.addTrustRuleHitRecorder(async () => undefined);
    anchor.addTrustRuleHitRecorder(async () => {
      if (!durableRun) return undefined;
      // 本机执行端：owner 日志在同一进程里准备并接纳
      n += 1;
      await anchor.trustRuleHits!.prepare(batch(n, `sha256:batch-${n}`));
      await anchor.trustRuleHits!.accept(batch(n, `sha256:batch-${n}`));
      return { assignmentId: "assignment-1", requestId: `trust-rule-hit:${n}` };
    });
    const conversation = anchor.runtime.bind(Object.freeze({})).create(runtimeRequest());
    expect(await matchCount(anchor)).toBe(0);
    await conversation.recordRuleHit!({ ruleId: "rule-global", scope: "global" });
    expect(await matchCount(anchor)).toBe(1);

    durableRun = false;
    const scheduled = anchor.runtime.bind(Object.freeze({}), { persistentApprovals: false }).create(runtimeRequest());
    await scheduled.recordRuleHit!({ ruleId: "rule-global", scope: "global" });
    expect(await matchCount(anchor)).toBe(2);

    const executorHome = await homeWithGlobalRule("rule-hit-remote");
    const executorOnly = createPermissionStorageInfrastructure({ zhixingHome: executorHome });
    const remote = executorOnly.runtime.bind(Object.freeze({})).create(runtimeRequest());
    await remote.recordRuleHit!({ ruleId: "rule-global", scope: "global" });
    expect(await matchCount(executorOnly)).toBe(0);
  });

  it("不在指派范围内的规则命中不计；同批重放只计一次", async () => {
    const home = await homeWithGlobalRule("rule-hit-scope");
    const anchor = createPermissionStorageInfrastructure({ zhixingHome: home, persistentApprovals: true });
    const stranger = { ...batch(1, "sha256:b"), entries: [{ ...entry(1), hit: { ruleId: "rule-elsewhere" } }] };
    await anchor.trustRuleHits!.prepare(stranger);
    await anchor.trustRuleHits!.accept(stranger);
    await anchor.trustRuleHits!.prepare(batch(2, "sha256:c"));
    await anchor.trustRuleHits!.accept(batch(2, "sha256:c"));
    await anchor.trustRuleHits!.accept(batch(2, "sha256:c"));
    expect(await matchCount(anchor)).toBe(1);
  });

  it("重开核对首次查询暂时失败：管理读取、重新绑定或 owner 接纳时再核对，不必再重开", async () => {
    const home = await homeWithGlobalRule("rule-hit-retry");
    const before = createPermissionStorageInfrastructure({ zhixingHome: home, persistentApprovals: true });
    await before.management.list({ kind: "main" });
    await before.trustRuleHits!.prepare(batch(1, "sha256:committed"));
    const reopened = createPermissionStorageInfrastructure({ zhixingHome: home, persistentApprovals: true });
    let available = false;
    let calls = 0;
    const verify = async () => {
      calls += 1;
      if (!available) throw new Error("temporary owner query unavailable");
      return "committed" as const;
    };
    reopened.bindTrustRuleHitVerifier(verify);
    await reopened.management.list({ kind: "main" });
    await vi.waitFor(() => expect(calls).toBe(1));
    expect(await matchCount(reopened)).toBe(0);
    // 故障解除后的下一次管理读取触发再核对，随后的读取看到计入
    available = true;
    await reopened.management.list({ kind: "main" });
    await vi.waitFor(async () => expect(await matchCount(reopened)).toBe(1));
    expect(calls).toBe(2);
    // 已解决后不再重复查询
    await reopened.management.list({ kind: "main" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toBe(2);
  });

  it("重开核对：已提交的计入，确定不会提交的清理，未知的保留待核", async () => {
    const home = await homeWithGlobalRule("rule-hit-reload");
    const before = createPermissionStorageInfrastructure({ zhixingHome: home, persistentApprovals: true });
    await before.management.list({ kind: "main" });
    for (const [n, digest] of [[1, "sha256:committed"], [2, "sha256:rejected"], [3, "sha256:unknown"]] as const) {
      await before.trustRuleHits!.prepare(batch(n, digest));
    }
    // 进程在提交后、接纳前退出
    const after = createPermissionStorageInfrastructure({ zhixingHome: home, persistentApprovals: true });
    const verified: string[] = [];
    after.bindTrustRuleHitVerifier(async (hit) => {
      verified.push(hit.batchDigest!);
      return hit.batchDigest === "sha256:committed" ? "committed" : hit.batchDigest === "sha256:rejected" ? "rejected" : "unknown";
    });
    await after.management.list({ kind: "main" });
    await vi.waitFor(async () => expect(await matchCount(after)).toBe(1));
    await vi.waitFor(async () => {
      const file = JSON.parse(await fs.readFile(path.join(home, "permissions", "global.json"), "utf8"));
      expect(file.hits.map((hit: { batchDigest: string }) => hit.batchDigest)).toEqual(["sha256:unknown"]);
    });
    // 未知的那条在之后的管理读取里会再核对，所以按去重后的集合比较
    expect([...new Set(verified)].sort()).toEqual(["sha256:committed", "sha256:rejected", "sha256:unknown"]);
  });
});
