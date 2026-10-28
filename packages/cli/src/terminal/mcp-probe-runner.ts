import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { McpManagementServerDraft } from '@zhixing/core/mcp-management';
import type { NetworkPolicy } from '@zhixing/network';
import { LogWorkerChannel } from '../logging/terminal-worker.js';
import { toServerSpec } from '../runtime/mcp-config.js';
import type { McpProbeRunnerRequest, McpProbeRunnerResult } from '../runtime/mcp-probe-request.js';
import { createTerminalOwnedProcessFactory } from './host-launch.js';

/** 原探测的连接期限，与 probeServer 默认一致（首次 npx 下载常超过 10 秒）。 */
const PROBE_TIMEOUT_MS = 60_000;
/** 从请求起算的总期限：覆盖 runner 创建、SDK 加载与探测本身。 */
const PROBE_TOTAL_MS = 75_000;
/** 结果决定后等 runner 关闭回执的期限；到期升级强杀，再等同样的期限。 */
const CLOSE_GRACE_MS = 5_000;
const UNCONFIRMED = 'MCP 验证进程未能确认结束';

type Create = ReturnType<typeof createTerminalOwnedProcessFactory>;
type Owner = ReturnType<Create>;

/**
 * 本终端进程里 MCP 验证 runner 的未结责任：进行中的一次，以及没能确认收束、仍归原 owner 的那些。
 * 与 owner 同寿命（终端进程），不随编辑器或适配器重建；未结的只在其关闭回执真正到达后移除，回执拒绝即一直未结。
 */
export interface McpProbeObligations {
  active: boolean;
  readonly unsettled: Set<Owner>;
}

export function createMcpProbeObligations(): McpProbeObligations {
  return { active: false, unsettled: new Set() };
}

const processObligations = createMcpProbeObligations();

/**
 * 终端应用进程里的一次性 MCP 探测：只做请求/结果适配，SDK 加载与建链都在受管 runner 里，
 * 本进程事件循环不被同步加载卡住。草稿凭据只经私有帧传给 runner；取消或超时直接强杀 runner
 * （不依赖它在同步加载中响应），结果只决定一次，迟到结果丢弃。决定之后仍等 owner 的关闭回执再交回：
 * 回执拒绝或等不到时不报成功；同一时刻只允许一次探测，上一次没收束不开新的。
 * 结果语义与原地探测相同：成功、失败原因、取消都以 { ok } 返回，不抛出。
 */
export function createTerminalMcpProbe(input: {
  readonly signal: AbortSignal;
  readonly proxy?: NetworkPolicy['proxy'];
  readonly create?: Create;
  readonly runnerArgs?: readonly string[];
  readonly totalMs?: number;
  readonly closeGraceMs?: number;
  readonly obligations?: McpProbeObligations;
}) {
  const create = input.create ?? createTerminalOwnedProcessFactory('mcp-probe-runner');
  const obligations = input.obligations ?? processObligations;
  return async (draft: McpManagementServerDraft, signal?: AbortSignal): Promise<McpProbeRunnerResult> => {
    if (obligations.active) return { ok: false, error: '上一次 MCP 验证仍在结束，请稍后再试' };
    if (obligations.unsettled.size) return { ok: false, error: '上一次 MCP 验证进程尚未确认结束，暂不能开始新的验证' };
    obligations.active = true;
    try { return await probeOnce(draft, signal); }
    finally { obligations.active = false; }
  };

  async function probeOnce(draft: McpManagementServerDraft, signal?: AbortSignal): Promise<McpProbeRunnerResult> {
    const spec = toServerSpec(draft.serverId, {
      type: draft.transport,
      ...(draft.command === undefined ? {} : { command: draft.command }),
      ...(draft.args === undefined ? {} : { args: [...draft.args] }),
      ...(draft.url === undefined ? {} : { url: draft.url }),
    }, { ...draft.credentials });
    const stop = signal ? AbortSignal.any([input.signal, signal]) : input.signal;
    if (stop.aborted) return { ok: false, error: '已取消' };
    const env: NodeJS.ProcessEnv = { ...process.env, ZHIXING_MCP_PROBE_STDIO: '1' };
    for (const key of ['NODE_OPTIONS', 'NODE_PATH']) delete env[key];
    const owner = create(process.execPath, input.runnerArgs ?? runnerArgs(), { env, signal: stop, deadline: Date.now() + 5000 });
    const channel = new LogWorkerChannel(owner.child.stdout, owner.child.stdin);
    owner.child.stderr.resume();
    const decided = await new Promise<{ result: McpProbeRunnerResult; killed: boolean }>((resolve) => {
      let settled = false;
      const settle = (result: McpProbeRunnerResult, kill: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        stop.removeEventListener('abort', cancelled);
        // 只结束 runner 的输入；输出要继续读到 owner 排空收束，销毁它会让关闭回执无从确认
        owner.child.stdin.end();
        // 取消、超时或通道失败：runner 可能卡在同步加载里，不等它响应，直接强杀；正常结果后它自行退出
        if (kill) owner.child.kill('SIGKILL');
        resolve({ result, killed: kill });
      };
      const cancelled = () => settle({ ok: false, error: '已取消' }, true);
      const timer = setTimeout(() => settle({ ok: false, error: 'MCP 连接验证超时' }, true), input.totalMs ?? PROBE_TOTAL_MS);
      stop.addEventListener('abort', cancelled, { once: true });
      channel.once('message', (message: unknown) => {
        const value = message as Partial<McpProbeRunnerResult> | null;
        if (value?.ok === true) settle({ ok: true }, false);
        else settle({ ok: false, error: typeof (value as { error?: unknown } | null)?.error === 'string' ? (value as { error: string }).error : 'MCP 验证结果无效' }, false);
      });
      channel.once('disconnect', () => settle({ ok: false, error: 'MCP 验证进程意外结束' }, true));
      channel.on('error', () => settle({ ok: false, error: 'MCP 验证进程通道失败' }, true));
      owner.child.once('error', () => settle({ ok: false, error: '无法启动 MCP 验证进程' }, true));
      owner.ready.then(() => {
        if (settled) return;
        const request: McpProbeRunnerRequest = { v: 1, spec, ...(input.proxy ? { proxy: input.proxy } : {}), timeoutMs: PROBE_TIMEOUT_MS };
        channel.send(request, (error) => { if (error) settle({ ok: false, error: 'MCP 验证请求未能送达' }, true); });
      }, () => settle({ ok: false, error: '无法启动 MCP 验证进程' }, true));
    });
    // 交回之前确认 runner 已由 owner 收束：成功只在按时收到退出码 0 的关闭回执时成立
    const closure = await confirmClosed(owner, decided.killed, input.closeGraceMs ?? CLOSE_GRACE_MS);
    channel.close();
    // 没能确认收束：runner 仍归原 owner，记为未结，直到它的关闭回执真正到达
    if (closure === 'unconfirmed') {
      obligations.unsettled.add(owner);
      void owner.closed.then(() => { obligations.unsettled.delete(owner); }, () => {});
    }
    const { result } = decided;
    if (result.ok) return closure === 'clean' ? result : { ok: false, error: closure === 'closed' ? 'MCP 验证进程未按时结束' : UNCONFIRMED };
    return closure === 'unconfirmed' ? { ok: false, error: `${result.error}（${UNCONFIRMED}）` } : result;
  }
}

/**
 * 有限等待 owner 的关闭回执：宽限内没到就升级强杀再等一次。
 * clean=未升级且退出码 0；closed=有回执但经过强杀或退出码非 0；unconfirmed=回执拒绝或两次都没等到。
 */
async function confirmClosed(owner: Owner, killed: boolean, graceMs: number): Promise<'clean' | 'closed' | 'unconfirmed'> {
  const receipt = owner.closed.then(value => value, () => undefined);
  const within = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([receipt, new Promise<'late'>(resolve => { timer = setTimeout(() => resolve('late'), graceMs); })]); }
    finally { clearTimeout(timer); }
  };
  let value = await within();
  let escalated = killed;
  if (value === 'late') {
    owner.child.kill('SIGKILL'); escalated = true;
    value = await within();
  }
  if (value === 'late' || value === undefined) return 'unconfirmed';
  return !escalated && value.code === 0 ? 'clean' : 'closed';
}

/** runner 入口：构建产物与本模块同在 dist 根下；源码运行时经 tsx 加载 runtime 下的源文件。 */
function runnerArgs(): string[] {
  const built = new URL('./mcp-probe-worker.js', import.meta.url);
  if (existsSync(fileURLToPath(built))) return [fileURLToPath(built)];
  return ['--import=tsx/esm', fileURLToPath(new URL('../runtime/mcp-probe-worker.ts', import.meta.url))];
}
