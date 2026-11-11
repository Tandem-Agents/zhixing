import { describe, expect, it } from "vitest";
import type { SessionSecurityResult } from "@zhixing-ai/rpc";
import { TERMINAL_LIMITS, TERMINAL_SUMMARY_LIMITS } from "@zhixing-ai/terminal-ui/protocol";
import { TerminalChannel } from "@zhixing-ai/terminal-ui/channel";
import { securityOverview, securityRulesDetail, SECURITY_DETAIL_BYTES, SECURITY_OVERVIEW_ROWS } from "../security-summary.js";
import { summaryLines } from "../../summary-projection.js";
import { chooseTerminalSelection, terminalSelectionActions, type TerminalSelectionPort } from "../../terminal/selection.js";

type Builtin = SessionSecurityResult["builtinRules"][number];
type Permission = SessionSecurityResult["permissionRules"][number];

const builtin = (id: string, patch: Partial<Builtin> = {}): Builtin => ({
  id, name: `规则 ${id}`, description: `${id} 的说明`, enabled: true, match: { type: "command", pattern: id },
  action: "confirm", bypassImmune: false, severity: "high", category: "destructive_operation", ...patch,
} as Builtin);
const permission = (id: string, scope: Permission["scope"], decision: Permission["decision"] = "allow"): Permission => ({
  id, pattern: { tool: "bash", argument: `${id} *` }, decision, scope, createdAt: 0, lastMatchedAt: 0, matchCount: 0,
});
const snapshot = (patch: Partial<SessionSecurityResult> = {}): SessionSecurityResult => ({
  contextId: { kind: "main" }, workspacePath: null, permissionRules: [], builtinRules: [], rateLimits: [], confirmations: [], ...patch,
});
const leadText = (summary: ReturnType<typeof securityOverview>) => summary.lead.map((line) => line.map((part) => part.text).join(""));
const section = (summary: ReturnType<typeof securityOverview>, title: string) => summary.sections.find((entry) => entry.title.startsWith(title));
const page = (summary: ReturnType<typeof securityOverview>) => ({ kind: "selection" as const, title: "安全状态", summary, choices: [{ id: "option:done", label: "返回输入" }] });
/** 说明页的全部页里，标题以 title 开头（含“（续）”）的区块 */
const detailSections = (pages: ReturnType<typeof securityRulesDetail>, title: string) => pages.flatMap((entry) => entry.sections).filter((entry) => entry.title.startsWith(title));
const detailRows = (pages: ReturnType<typeof securityRulesDetail>, title: string) => detailSections(pages, title).flatMap((entry) => entry.rows ?? []);

describe("security summary projection", () => {
  const rules = [
    builtin("git", { action: "block", bypassImmune: true, severity: "critical" }),
    builtin("ssh", { action: "block", bypassImmune: true, severity: "critical" }),
    builtin("config", { action: "confirm", bypassImmune: true, severity: "critical" }),
    builtin("rm"), builtin("net", { severity: "medium" }),
    builtin("trace", { action: "audit", severity: "low" }),
    builtin("off", { enabled: false }),
  ];

  it("classifies built-in rules by their relation to trust rules and never calls block rules confirmations", () => {
    const summary = securityOverview(snapshot({ builtinRules: rules }));
    expect(leadText(summary)).toEqual(["主模式 · 本对话的默认范围", "内置规则 6 条：直接拦截 2 · 每次确认 1 · 需要确认 2 · 只记录 1"]);
    expect(summary.lead[0]![0]).toEqual({ text: "主模式", tone: "accent" });
    expect(summary.sections.slice(0, 4).map((entry) => [entry.title, entry.aside, entry.items])).toEqual([
      ["直接拦截 · 2 项", "信任规则不能放行", ["规则 git", "规则 ssh"]],
      ["每次确认 · 1 项", "信任规则不能免除确认", ["规则 config"]],
      ["需要确认 · 2 项", "可用信任规则放行", ["规则 rm", "规则 net"]],
      ["只记录 · 1 项", "不拦截", ["规则 trace"]],
    ]);
    const all = JSON.stringify([summary, securityRulesDetail(snapshot({ builtinRules: rules })), summaryLines(summary)]);
    expect(all).not.toMatch(/禁区|保护生效中|规则 off/u);
    expect(page(summary)).toBeDefined(); expect(() => terminalSelectionActions(page(summary))).not.toThrow();
  });

  it("states only what the snapshot proves for empty, workspace and run scopes", () => {
    const empty = securityOverview(snapshot());
    expect(leadText(empty)).toEqual(["主模式 · 本对话的默认范围", "当前没有启用的内置规则"]);
    expect(empty.sections.map((entry) => entry.title)).toEqual(["信任规则 · 共 0 条", "允许累计", "调用频率（当前窗口）"]);
    expect(section(empty, "允许累计")).toMatchObject({ rows: [], empty: "暂无" });
    expect(section(empty, "调用频率")).toMatchObject({ rows: [], empty: "当前窗口暂无调用记录" });

    const run = securityOverview(snapshot({
      contextId: { kind: "workspace", hash: "h" }, workspacePath: "D:\\work\\\x1b[31m项目\u202e",
      permissionRules: [permission("a", "context")],
      scope: { kind: "run", runId: "r1", contextId: { kind: "scene", sceneId: "s" }, permissionRules: [permission("x", "session"), permission("y", "context"), permission("z", "global")] },
    }));
    // 工作区与工作场景按实际类型称呼；两份范围不同就都附标识；路径明确属于默认范围
    expect(leadText(run)).toEqual(["本次运行：工作场景（标识 s） · 使用开始时锁定的 3 条信任规则", "本对话的默认范围：工作区（标识 h）",
      "默认范围路径：D:\\work\\项目 ", "当前没有启用的内置规则"]);
    expect(run.lead[1]![0]!.tone).toBe("dim");
    // 运行实际用的条数只在页首；下面的信任规则统计明确属于对话默认范围
    expect(section(run, "对话默认范围的信任规则")?.title).toBe("对话默认范围的信任规则 · 共 1 条");

    // 默认是工作区 a、运行是工作区 b：两者都写“工作区”，靠标识区分，路径只标为默认范围的
    const twoWorkspaces = securityOverview(snapshot({ contextId: { kind: "workspace", hash: "aaaaaaaa1111" }, workspacePath: "D:/default-workspace",
      scope: { kind: "run", runId: "r2", contextId: { kind: "workspace", hash: "bbbbbbbb2222" }, permissionRules: [] } }));
    expect(leadText(twoWorkspaces)).toEqual(["本次运行：工作区（标识 bbbbbbbb） · 使用开始时锁定的 0 条信任规则", "本对话的默认范围：工作区（标识 aaaaaaaa）",
      "默认范围路径：D:/default-workspace", "当前没有启用的内置规则"]);
    // 运行范围与默认范围相同：不重复标识，直接说明相同
    const same = securityOverview(snapshot({ contextId: { kind: "scene", sceneId: "s1" },
      scope: { kind: "run", runId: "r3", contextId: { kind: "scene", sceneId: "s1" }, permissionRules: [permission("x", "context")] } }));
    expect(leadText(same)[0]).toBe("本次运行：工作场景（与本对话的默认范围相同） · 使用开始时锁定的 1 条信任规则");
    expect(leadText(securityOverview(snapshot({ contextId: { kind: "workspace", hash: "h" } })))[0]).toBe("工作区 · 本对话的默认范围");
    expect(leadText(securityOverview(snapshot({ contextId: { kind: "scene", sceneId: "s" } })))[0]).toBe("工作场景 · 本对话的默认范围");
  });

  it("counts trust rules by scope, reports denials as ordinary facts and points to the real management entry", () => {
    const trust = section(securityOverview(snapshot({ permissionRules: [
      permission("a", "session"), permission("b", "context", "deny"), permission("c", "global"), permission("d", "global"),
    ] })), "信任规则");
    expect(trust).toEqual({ title: "信任规则 · 共 4 条", items: ["本对话 1", "当前范围 1", "所有范围 2"],
      notes: ["其中拒绝 1 条", "浏览与撤销：在输入框输入 /trust 后加空格"] });
  });

  it("lists allowance tallies without timing or self-approval claims and keeps the overview bounded", () => {
    const confirmations = Array.from({ length: 20 }, (_, index) => ({ key: `bash::cmd-${index} *`, count: index + 1, highestRisk: "medium" as const }));
    const overview = section(securityOverview(snapshot({ confirmations })), "允许累计")!;
    expect(overview.rows).toHaveLength(SECURITY_OVERVIEW_ROWS);
    expect(overview.rows![0]).toEqual({ label: "bash · cmd-19 *", value: "已允许 20 次 · 最高风险 中" });
    expect(overview.notes).toEqual(["另有 12 项，见规则说明"]);
    const detail = securityRulesDetail(snapshot({ confirmations }));
    expect(detailRows(detail, "允许累计")).toHaveLength(20);
    expect(detailSections(detail, "允许累计")[0]!.notes![0]).toMatch(/会尝试提交为当前范围的信任规则；最高风险不会。实际是否形成规则，以信任规则列表为准/u);
    expect(JSON.stringify(securityOverview(snapshot({ confirmations })))).not.toMatch(/近期|自动记住|你允许/u);
  });

  it("warns only when a tool approaches its known limit, with words as well as tone", () => {
    const rate = section(securityOverview(snapshot({ rateLimits: [{ key: "read", used: 50, limit: 100 }, { key: "bash", used: 86, limit: 100 }] })), "调用频率")!;
    expect(rate.rows).toEqual([
      { label: "bash", value: "86 / 100 · 接近上限", tone: "warn" },
      { label: "read", value: "50 / 100" },
    ]);
  });

  it("keeps every fact of the former rules listing in the explanation page", () => {
    const detail = securityRulesDetail(snapshot({ builtinRules: rules }));
    expect(detail).toHaveLength(1);
    expect(leadText(detail[0]!)).toEqual(["内置规则 6 条：直接拦截 2 · 每次确认 1 · 需要确认 2 · 只记录 1"]);
    expect(detailRows(detail, "直接拦截")[0]).toEqual({ label: "规则 git", value: "风险 极高 · git · 不可覆盖", note: "git 的说明" });
    expect(detailRows(detail, "需要确认").map((row) => row.value)).toEqual(["风险 高 · rm", "风险 中 · net"]);
    expect(() => terminalSelectionActions({ ...page(detail[0]!), title: "规则说明" })).not.toThrow();
  });

  it("keeps every allowance tally reachable across pages and merges the notes instead of overwriting them", () => {
    // 520 条：超过一个区块的行数上限 512，拆成“允许累计”与“允许累计（续）”，沉淀说明与全部条目都在
    const confirmations = Array.from({ length: 520 }, (_, index) => ({ key: `bash::cmd-${index} *`, count: 600 - index, highestRisk: "low" as const }));
    const detail = securityRulesDetail(snapshot({ confirmations }));
    const rows = detailRows(detail, "允许累计");
    expect(rows).toHaveLength(520);
    expect(new Set(rows.map((row) => row.label)).size).toBe(520);
    expect(detailSections(detail, "允许累计").map((entry) => entry.title)).toEqual(["允许累计", "允许累计（续）"]);
    // 区块说明是区块末尾的弱化说明：跨页时放在最后一段
    expect(detailSections(detail, "允许累计")[0]!.notes).toBeUndefined();
    expect(detailSections(detail, "允许累计").at(-1)!.notes).toEqual([expect.stringMatching(/会尝试提交为当前范围的信任规则/u)]);
    expect(JSON.stringify(detail)).not.toMatch(/未能显示/u);
    for (const entry of detail) {
      expect(Buffer.byteLength(JSON.stringify(entry))).toBeLessThanOrEqual(TERMINAL_SUMMARY_LIMITS.bytes);
      expect(() => terminalSelectionActions({ ...page(entry), title: "规则说明" })).not.toThrow();
    }
  });

  it("cleans control and bidi characters and keeps the byte bound with an explicit note", () => {
    const hostile = securityOverview(snapshot({ builtinRules: [builtin("x", { name: "名\x1b[31m字\u202e\n尾" })] }));
    // ANSI 序列整段去掉；双向覆写与换行换成空格
    expect(hostile.sections[0]!.items).toEqual(["名字  尾"]);
    // 合计超过说明页总容量：分到多页，每页守住预算，最后一页写明真实的未显示条数，显示的与未显示的合起来正好是全部
    const confirmations = Array.from({ length: 4000 }, (_, index) => ({ key: `bash::${"长".repeat(200)}${index}`, count: 1, highestRisk: "low" as const }));
    const detail = securityRulesDetail(snapshot({ confirmations }));
    expect(detail.length).toBeGreaterThan(1);
    for (const entry of detail) {
      expect(Buffer.byteLength(JSON.stringify(entry))).toBeLessThanOrEqual(TERMINAL_SUMMARY_LIMITS.bytes);
      expect(() => terminalSelectionActions({ ...page(entry), title: "规则说明" })).not.toThrow();
    }
    expect(detail.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)), 0)).toBeLessThanOrEqual(SECURITY_DETAIL_BYTES + 64 * 1024);
    const omitted = Number(/^另有 (\d+) 项未能显示（超出展示容量）$/u.exec(detail.at(-1)!.sections.at(-1)!.notes!.at(-1)!)?.[1]);
    expect(detailRows(detail, "允许累计").length + omitted).toBe(4000);
  });

  it("sends every page through the real terminal channel without tripping the frame limit", async () => {
    // 与复验反例同量级：快照约 250 KB；概览与说明页的每一页都经真实通道发送，不报超大帧、不关通道
    // 说明页会被填满一页预算：每页都能整帧发出，没有一页被拒为“无法完整展示”，发出的各页合起来正好是全部条目
    const confirmations = Array.from({ length: 1200 }, (_, index) => ({ key: `bash::${"命令".repeat(40)} ${index}`, count: index + 1, highestRisk: "high" as const }));
    const source = snapshot({ confirmations, builtinRules: rules });
    expect(Buffer.byteLength(JSON.stringify(source))).toBeGreaterThan(250 * 1024);
    const failures: string[] = [], packets: number[] = [], views: { title: string; rows: number }[] = [];
    const channel = new TerminalChannel("instance-0123456789abcdef", (packet, done) => { packets.push(Buffer.byteLength(JSON.stringify(packet))); done(); },
      () => {}, (reason) => failures.push(reason));
    const sent: Promise<void>[] = [];
    const choose: TerminalSelectionPort = async (view) => {
      views.push({ title: view.title, rows: (view.summary?.sections ?? []).filter((entry) => entry.title.startsWith("允许累计")).reduce((sum, entry) => sum + (entry.rows?.length ?? 0), 0) });
      sent.push(channel.send({ type: "view", view: { ...view, generation: Number.MAX_SAFE_INTEGER, requestId: "request-0123456789abcdef" } }).catch((error) => { failures.push(String(error)); }));
      return { itemId: view.choices?.some((choice) => choice.id === "next") ? "next" : "return" };
    };
    await chooseTerminalSelection({ title: "安全状态", summary: securityOverview(source), options: [{ value: "done", label: "返回输入" }] }, choose);
    const detail = securityRulesDetail(source);
    expect(detail.length).toBeGreaterThan(1);
    await chooseTerminalSelection({ title: "规则说明", summary: detail, options: [{ value: "back", label: "返回安全状态" }] }, choose);
    await Promise.resolve();
    expect(failures).toEqual([]);
    expect(views.map((view) => view.title)).not.toContain("无法完整展示此请求");
    expect(views.filter((view) => view.title.startsWith("规则说明")).reduce((sum, view) => sum + view.rows, 0)).toBe(1200);
    expect(Math.max(...packets)).toBeLessThanOrEqual(TERMINAL_LIMITS.frameBytes);
    channel.close(); await Promise.allSettled(sent);
  });

  it("refuses a page whose whole frame would exceed the channel limit instead of sending it", async () => {
    // 信息内容本身在一页预算之内（能通过入口校验），但连同其余字段（这里是 30 个带长说明的选项）整帧会超过通道上限：发页前就拒绝
    const near = { lead: [], sections: Array.from({ length: 4 }, (_, index) => ({ title: `区块 ${index}`, items: Array.from({ length: 63 }, () => "长".repeat(300)) })) };
    expect(Buffer.byteLength(JSON.stringify(near))).toBeLessThanOrEqual(TERMINAL_SUMMARY_LIMITS.bytes);
    expect(() => terminalSelectionActions(page(near))).not.toThrow();
    const options = Array.from({ length: 30 }, (_, index) => ({ value: `o${index}`, label: `选项 ${index}`, description: "说".repeat(600) }));
    const shown: string[] = [];
    await chooseTerminalSelection({ title: "安全状态", summary: near, options }, async (view) => { shown.push(view.title); return { itemId: "return" }; });
    expect(shown).toEqual(["无法完整展示此请求"]);
  });

  it("rejects summaries that mix message text, carry control characters or exceed bounds", () => {
    const summary = securityOverview(snapshot());
    expect(() => terminalSelectionActions({ ...page(summary), message: "x" })).toThrow("terminal-selection-summary");
    expect(() => terminalSelectionActions(page({ ...summary, sections: [{ title: "a\nb" }] }))).toThrow("terminal-selection-summary");
    expect(() => terminalSelectionActions(page({ ...summary, sections: Array.from({ length: 17 }, () => ({ title: "x" })) }))).toThrow("terminal-selection-summary");
    expect(() => terminalSelectionActions(page({ ...summary, lead: [[{ text: "x", tone: "loud" as never }]] }))).toThrow("terminal-selection-summary");
  });

  it("renders the same facts through the former text exit", () => {
    const lines = summaryLines(securityOverview(snapshot({ builtinRules: rules, rateLimits: [{ key: "bash", used: 90, limit: 100 }] })));
    expect(lines).toContain("▎ 直接拦截 · 2 项（信任规则不能放行）");
    expect(lines).toContain("  规则 git · 规则 ssh");
    expect(lines).toContain("  bash  90 / 100 · 接近上限");
    expect(lines).toContain("  浏览与撤销：在输入框输入 /trust 后加空格");
  });
});
