import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { TerminalForegroundProcesses } from '../foreground-process.js';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error('POSIX fixture lifecycle unconfirmed')), 8000); })]); }
  finally { clearTimeout(timer); }
}

describe.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')('terminal POSIX execution gate', () => {
  it('holds admission, preserves arguments, drains a probe group, and reaps a sealed late creation', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'zhixing-gate-fixture-'));
    const artifact = fileURLToPath(new URL(`../../../../terminal-ui/dist/${process.platform}-${process.arch}/foreground.node`, import.meta.url));
    const owner = new TerminalForegroundProcesses(artifact);
    const exits: Promise<void>[] = [];
    const observe = (child: ReturnType<TerminalForegroundProcesses['create']>) => {
      child.on('error', () => {});
      const closed = new Promise<void>(resolve => child.once('close', resolve)); exits.push(closed); return closed;
    };
    try {
      const marker = path.join(directory, 'admitted');
      const child = owner.create(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1],process.argv[2]);', marker, 'spaces "引号" \\ preserved'], process.env, false, true, { scope: 'execution', pipeEnvironment: false });
      const closed = observe(child);
      await bounded(child.created);
      expect(child.pid).toBeGreaterThan(0); expect(child.birth).toMatch(/^[1-9][0-9]*$/u);
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      child.resume(); await bounded(closed);
      expect(await readFile(marker, 'utf8')).toBe('spaces "引号" \\ preserved');
      const messages: { event: string; ticket?: string; generation?: number; output?: string; error?: string }[] = [];
      let creation!: Socket, framing = Buffer.alloc(0);
      const receiver = owner.create(process.execPath, [fileURLToPath(new URL('./fixtures/posix-channel-owner.cjs', import.meta.url)), artifact], process.env, false, true, { scope: 'execution', creationOwner: true });
      const receiverClosed = observe(receiver);
      receiver.once('owner-channel', (socket: Socket) => {
        creation = socket;
        socket.on('error', () => {});
        socket.on('data', data => {
          framing = Buffer.concat([framing, data]);
          expect(framing.length).toBeLessThanOrEqual(4096);
          for (;;) { const end = framing.indexOf(10); if (end < 0) return; messages.push(JSON.parse(framing.subarray(0, end).toString())); framing = framing.subarray(end + 1); }
        });
      });
      await bounded(receiver.created); receiver.resume();
      await vi.waitFor(() => expect(messages.some(value => value.event === 'ready')).toBe(true));
      for (const cancel of [false, true]) {
        const ticket = randomUUID();
        const gate = owner.create(owner.gate, ['private', '', artifact, String(Date.now() + 5000)], process.env, false, true, { scope: 'execution', pipeEnvironment: false, channels: 'private' });
        const gateClosed = observe(gate); await bounded(gate.created);
        expect(() => gate.resume()).toThrow('resume-denied');
        const generation = gate.handoffChannels(receiver, ticket);
        expect(() => gate.handoffChannels(receiver, ticket)).toThrow('handoff');
        await vi.waitFor(() => expect(messages.find(value => value.ticket === ticket && value.event === 'received')).toMatchObject({ generation }));
        if (cancel) {
          gate.kill(); creation.write(JSON.stringify({ type: 'discard', ticket }) + '\n');
          await bounded(gateClosed);
          await vi.waitFor(() => expect(messages.some(value => value.ticket === ticket && value.event === 'discarded')).toBe(true));
          expect(messages.some(value => value.ticket === ticket && value.event === 'result')).toBe(false);
        } else {
          gate.resume(); creation.write(JSON.stringify({ type: 'deliver', ticket }) + '\n');
          await vi.waitFor(() => expect(messages.find(value => value.ticket === ticket && value.event === 'result')).toMatchObject({ output: '私有:input', error: 'fixture-error' }));
          await bounded(gateClosed);
        }
      }
      creation.write(JSON.stringify({ type: 'close' }) + '\n'); await bounded(receiverClosed);
      const probeMarker = path.join(directory, 'probe-group');
      const probeProgram = `
        const {spawn}=require('node:child_process'),fs=require('node:fs');
        const member=spawn(process.execPath,['-e','process.send("ready");setInterval(()=>{},1000)'],{stdio:['ignore','ignore','ignore','ipc']});
        member.once('message',()=>{
          let terminal=false;try{const fd=fs.openSync('/dev/tty','r');fs.closeSync(fd);terminal=true}catch{}
          fs.writeFileSync(process.argv[1],JSON.stringify({root:process.pid,member:member.pid,terminal,stdio:[!!process.stdin.isTTY,!!process.stdout.isTTY,!!process.stderr.isTTY]}));
          setInterval(()=>{if(fs.existsSync(process.argv[1]+'.release'))process.exit(0)},10);
        });
      `;
      const probe = owner.create(process.execPath, ['-e', probeProgram, probeMarker], process.env, false, true, { scope: 'probe', pipeEnvironment: false });
      const probeClosed = observe(probe); await bounded(probe.created); probe.resume();
      await vi.waitFor(async () => expect(JSON.parse(await readFile(probeMarker, 'utf8'))).toMatchObject({ terminal: false, stdio: [false, false, false] }), { timeout: 5000 });
      expect(owner.executionState()).toMatchObject({ active: 1, creating: 0, ownedActive: 0, ownedCreating: 0 });
      await writeFile(probeMarker + '.release', 'exit');
      await bounded(probeClosed);
      const group = JSON.parse(await readFile(probeMarker, 'utf8')) as { root: number; member: number };
      expect(group.root).toBe(probe.pid); expect(group.member).toBeGreaterThan(0);
      // The owner may release the root only after its final group termination;
      // a surviving member or zombie keeps branchActive and prevents close.
      expect(() => process.kill(-group.root, 0)).toThrow();
      expect(() => process.kill(group.member, 0)).toThrow();
      expect(owner.executionState()).toEqual({ active: 0, creating: 0, ownedActive: 0, ownedCreating: 0 });
      const lateMarker = path.join(directory, 'forbidden-late');
      const late = owner.create(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1],"forbidden");', lateMarker], process.env, false, true, { scope: 'execution', pipeEnvironment: false });
      const lateClosed = observe(late);
      // start() was queued first: seal races the actual asynchronous creator,
      // while no owner has issued a permit to the newly created gate.
      queueMicrotask(() => owner.seal());
      await bounded(lateClosed);
      await expect(readFile(lateMarker)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(owner.executionState()).toEqual({ active: 0, creating: 0, ownedActive: 0, ownedCreating: 0 });
      expect(owner.children.size).toBe(0);
    } finally {
      owner.seal(); owner.terminateExecution();
      try { await bounded(Promise.all(exits)); }
      finally { owner.finish(); }
      await rm(directory, { recursive: true, force: true });
    }
  }, 45_000);
});
