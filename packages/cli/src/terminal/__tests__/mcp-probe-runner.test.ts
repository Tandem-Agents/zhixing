import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { serialize } from 'node:v8';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createMcpProbeObligations, createTerminalMcpProbe } from '../mcp-probe-runner.js';
import { handleMcpProbeRequest } from '../../runtime/mcp-probe-request.js';

// 不经 S 的真实子进程工厂：验证终端侧适配与 runner 本身，S 的登记与回收由 supervisor 用例覆盖
const create = (executable: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
  const child = spawn(executable, [...args], { env: options.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  return { child, ready: once(child, 'spawn').then(() => undefined), closed: once(child, 'close').then(([code, signal]) => ({ code, signal })) } as never;
};
const worker = ['--import=tsx/esm', fileURLToPath(new URL('../../runtime/mcp-probe-worker.ts', import.meta.url))];
const draft = { serverId: 'probe', transport: 'http' as const, url: 'http://127.0.0.1:9/mcp', credentials: {} };
// 同步忙等的 runner：模拟首次加载 SDK 时整段卡住、无法响应取消
const stalled = (ms: number, then = '') => ['-e', `const t=Date.now()+${ms};while(Date.now()<t){}${then}`];
const frameOk = `const v8=require('v8');const b=v8.serialize({ok:true});const h=Buffer.alloc(4);h.writeUInt32BE(b.length);`;
// 回复后自行退出（runner 的正常形态）；replyStay 回复后不退出
const replyOk = `${frameOk}process.stdout.write(Buffer.concat([h,b]),()=>process.exit(0));`;
const replyStay = `${frameOk}process.stdout.write(Buffer.concat([h,b]));setTimeout(()=>{},30000);`;
// 假 owner：结果帧照常送达，关闭回执由用例控制
const fakeOwner = (closed: Promise<unknown>) => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
  void closed.catch(() => {});
  return { child, ready: Promise.resolve(), closed };
};
const sendOk = (child: { stdout: PassThrough }) => {
  const bytes = serialize({ ok: true }), header = Buffer.alloc(4); header.writeUInt32BE(bytes.length);
  child.stdout.write(Buffer.concat([header, bytes]));
};
// 最小 stdio MCP server：initialize 与 tools/list
const mcpServer = ['-e', `require('readline').createInterface({input:process.stdin}).on('line',l=>{let m;try{m=JSON.parse(l)}catch{return}if(m.id===undefined)return;
const r=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:x})+'\\n');
if(m.method==='initialize')r({protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}});
else if(m.method==='tools/list')r({tools:[]});else r({});});`];
// 按 host-launch 的排空合同实现的 owner：子进程输出经 PassThrough 交给使用方，
// 关闭回执在子进程关闭后还要等两条 PassThrough 结束，1 秒内等不到即拒绝（使用方销毁了输出流就等不到）
const drainingCreate = (executable: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
  const process = spawn(executable, [...args], { env: options.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const stdout = new PassThrough(), stderr = new PassThrough();
  stdout.on('error', () => {}); stderr.on('error', () => {});
  process.stdout.pipe(stdout); process.stderr.pipe(stderr);
  const finished = (stream: PassThrough) => stream.writableFinished ? Promise.resolve() : new Promise<void>(resolve => stream.once('finish', resolve));
  const closed = once(process, 'close').then(async ([code, signal]) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([Promise.all([finished(stdout), finished(stderr)]),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('terminal-helper-output-drain-unconfirmed')), 1000); })]);
    } finally { clearTimeout(timer); }
    return { code, signal };
  });
  void closed.catch(() => {});
  const child = Object.assign(new EventEmitter(), { stdin: process.stdin, stdout, stderr, kill: (signal?: NodeJS.Signals) => process.kill(signal) });
  process.once('error', error => child.emit('error', error));
  return { child, ready: once(process, 'spawn').then(() => undefined), closed } as never;
};
const stdioOwner = (receipt: 'confirmed' | 'unconfirmed') => (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => {
  const child = spawn(command, [...args], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const exited = once(child, 'close');
  return { child, ready: once(child, 'spawn').then(() => undefined),
    closed: receipt === 'confirmed' ? exited : exited.then(() => { throw Error('terminal-helper-output-drain-unconfirmed'); }) };
};

describe('terminal MCP probe in a managed runner', () => {
  it('runs the original probe in the runner and returns its failure reason unchanged', async () => {
    const probe = createTerminalMcpProbe({ signal: new AbortController().signal, create, runnerArgs: worker });
    const result = await probe(draft);
    expect(result).toMatchObject({ ok: false });
    expect((result as { error: string }).error).toMatch(/SSRF/u);
  }, 60_000);

  it('keeps this process responsive while the runner is stuck, then kills it on cancel', async () => {
    const children: { exitCode: number | null; signalCode: NodeJS.Signals | null }[] = [];
    const tracked = ((executable: string, args: readonly string[], options: { env?: NodeJS.ProcessEnv }) => {
      const owner = (create as unknown as (...a: unknown[]) => { child: (typeof children)[number] })(executable, args, options);
      children.push(owner.child);
      return owner;
    }) as never;
    const cancel = new AbortController();
    const probe = createTerminalMcpProbe({ signal: new AbortController().signal, create: tracked, runnerArgs: stalled(6000) });
    let last = performance.now(), maxGap = 0;
    const beat = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 20);
    const pending = probe(draft, cancel.signal);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const started = performance.now();
    cancel.abort();
    expect(await pending).toEqual({ ok: false, error: '已取消' });
    clearInterval(beat);
    // runner 整段卡住，终端这边的计时器照常触发；取消不等 runner 响应
    expect(maxGap).toBeLessThan(500);
    expect(performance.now() - started).toBeLessThan(1000);
    // 取消结果在关闭回执之后才交回：此时 runner 已经退出
    const runner = children[0]!;
    expect(runner.exitCode !== null || runner.signalCode !== null).toBe(true);
  }, 20_000);

  it('bounds the whole probe including the loading stage and kills a stuck runner on timeout', async () => {
    const probe = createTerminalMcpProbe({ signal: new AbortController().signal, create, runnerArgs: stalled(6000), totalMs: 800 });
    const started = performance.now();
    expect(await probe(draft)).toEqual({ ok: false, error: 'MCP 连接验证超时' });
    expect(performance.now() - started).toBeLessThan(2000);
  }, 20_000);

  it('accepts a runner success and ignores a result that arrives after cancellation', async () => {
    const success = createTerminalMcpProbe({ signal: new AbortController().signal, create, runnerArgs: ['-e', replyOk] });
    expect(await success(draft)).toEqual({ ok: true });
    const cancel = new AbortController();
    const late = createTerminalMcpProbe({ signal: new AbortController().signal, create, runnerArgs: stalled(800, replyOk) });
    const pending = late(draft, cancel.signal);
    setTimeout(() => cancel.abort(), 200);
    expect(await pending).toEqual({ ok: false, error: '已取消' });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(await pending).toEqual({ ok: false, error: '已取消' });
  }, 20_000);

  it('stops the probe when the terminal itself is closing', async () => {
    const terminal = new AbortController();
    const probe = createTerminalMcpProbe({ signal: terminal.signal, create, runnerArgs: stalled(6000) });
    const pending = probe(draft);
    setTimeout(() => terminal.abort(), 300);
    expect(await pending).toEqual({ ok: false, error: '已取消' });
  }, 20_000);
});

describe('terminal MCP probe hands back a result only after the runner is closed', () => {
  it('does not report success when the owner cannot confirm the runner closed', async () => {
    const owner = fakeOwner(Promise.reject(Error('terminal-helper-output-drain-unconfirmed')));
    const obligations = createMcpProbeObligations();
    const probe = createTerminalMcpProbe({ signal: new AbortController().signal, create: (() => owner) as never, closeGraceMs: 200, obligations });
    const pending = probe(draft);
    sendOk(owner.child);
    expect(await pending).toEqual({ ok: false, error: 'MCP 验证进程未能确认结束' });
    // 回执已拒绝：结局永久未知，仍归原 owner
    expect(obligations.unsettled.size).toBe(1);
  });

  it('starts no new runner, even from a reopened editor, until the earlier runner is confirmed closed', async () => {
    const obligations = createMcpProbeObligations();
    const closers: ((receipt: unknown) => void)[] = [];
    const create = () => {
      const owner = fakeOwner(new Promise(resolve => { closers.push(resolve); }));
      setImmediate(() => sendOk(owner.child));
      return owner;
    };
    const open = () => createTerminalMcpProbe({ signal: new AbortController().signal, create: create as never, closeGraceMs: 5, obligations });
    expect(await open()(draft)).toEqual({ ok: false, error: 'MCP 验证进程未能确认结束' });
    // 重新打开编辑器得到新的适配器：未结责任在终端进程里，仍不创建
    const reopened = open();
    expect(await reopened(draft)).toEqual({ ok: false, error: '上一次 MCP 验证进程尚未确认结束，暂不能开始新的验证' });
    expect(closers).toHaveLength(1);
    // 原 owner 之后确认收束才解除
    closers[0]!({ code: 0, signal: null });
    await new Promise(resolve => setImmediate(resolve));
    expect(obligations.unsettled.size).toBe(0);
    await reopened(draft);
    expect(closers).toHaveLength(2);
  });

  it('escalates a runner that stays after replying and does not report it as a clean success', async () => {
    const probe = createTerminalMcpProbe({ signal: new AbortController().signal, create, runnerArgs: ['-e', replyStay], closeGraceMs: 300 });
    const started = performance.now();
    expect(await probe(draft)).toEqual({ ok: false, error: 'MCP 验证进程未按时结束' });
    expect(performance.now() - started).toBeLessThan(5_000);
  }, 20_000);

  it('returns a cancellation only after the closing receipt and refuses to stack a second probe meanwhile', async () => {
    let close!: (receipt: unknown) => void;
    const owner = fakeOwner(new Promise(resolve => { close = resolve; }));
    const cancel = new AbortController();
    const probe = createTerminalMcpProbe({ signal: new AbortController().signal, create: (() => owner) as never, closeGraceMs: 2_000 });
    let settled = false;
    const pending = probe(draft, cancel.signal).then(result => { settled = true; return result; });
    cancel.abort();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(owner.child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(settled).toBe(false);
    expect(await probe(draft)).toEqual({ ok: false, error: '上一次 MCP 验证仍在结束，请稍后再试' });
    close({ code: null, signal: 'SIGKILL' });
    expect(await pending).toEqual({ ok: false, error: '已取消' });
  });

  it('reports a runner success once the owner has drained its output and closed', async () => {
    const probe = createTerminalMcpProbe({ signal: new AbortController().signal, create: drainingCreate, runnerArgs: ['-e', replyOk] });
    expect(await probe(draft)).toEqual({ ok: true });
  }, 20_000);

  it('returns a plain cancellation once the killed runner has closed with its output drained', async () => {
    const cancel = new AbortController();
    const probe = createTerminalMcpProbe({ signal: new AbortController().signal, create: drainingCreate, runnerArgs: stalled(6000) });
    const pending = probe(draft, cancel.signal);
    setTimeout(() => cancel.abort(), 300);
    expect(await pending).toEqual({ ok: false, error: '已取消' });
  }, 20_000);
});

describe('MCP probe runner request', () => {
  const stdio = { v: 1, timeoutMs: 20_000, spec: { serverId: 'fixture', transport: 'stdio', command: process.execPath, args: mcpServer, env: {} } } as const;
  it('replies success only after the external command it created has closed', async () => {
    expect(await handleMcpProbeRequest(stdio, stdioOwner('confirmed') as never)).toEqual({ ok: true });
  }, 30_000);

  it('replies failure when the external command closure cannot be confirmed', async () => {
    expect(await handleMcpProbeRequest(stdio, stdioOwner('unconfirmed') as never, 500))
      .toEqual({ ok: false, error: 'MCP 外部命令未能确认结束' });
  }, 30_000);
});
