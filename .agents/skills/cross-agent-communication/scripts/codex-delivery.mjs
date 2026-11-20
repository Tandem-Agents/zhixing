import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const INACTIVE = /^(?:Conversation .+ is not being streamed\.|Cannot steer conversation .+ because its active turn already ended)$/;
const frame = value => {
  const body = Buffer.from(JSON.stringify(value));
  const result = Buffer.alloc(body.length + 4);
  result.writeUInt32LE(body.length);
  body.copy(result, 4);
  return result;
};

function queueIdle(exe, threadId, message) {
  return new Promise(resolve => {
    let settled = false;
    const child = spawn(exe, ['queue', '--thread', threadId, '--message', message], {
      windowsHide: true, stdio: 'ignore', shell: false,
    });
    const finish = result => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    const timer = setTimeout(() => { child.kill(); finish({ phase: 'unknown', code: 'idle-queue-timeout' }); }, 20000);
    child.once('error', error => finish({ phase: 'failed', code: error.code || 'idle-queue-spawn-error' }));
    child.once('exit', code => finish(code === 0
      ? { phase: 'submitted', mode: 'queue-idle' }
      : { phase: 'failed', code: `idle-queue-exit-${code}` }));
  });
}

/** Use the current desktop's native follow-up tool. Explicit pipePath retains the legacy protocol. */
export async function deliverCodex(options = {}) {
  if (!options.threadId || !options.message || !options.cwd) return { phase: 'failed', code: 'missing-delivery-input' };
  if (options.pipePath) return deliverLegacyCodex(options);
  let pipePath = options.appToolsPipePath;
  if (!pipePath && process.platform === 'win32') {
    let names;
    try { names = fs.readdirSync('\\\\.\\pipe\\').filter(name => /^codex-app-tools-[a-f0-9-]+$/i.test(name)); }
    catch (error) { return { phase: 'failed', code: error.code || 'desktop-pipe-discovery-failed' }; }
    // Never choose a different desktop instance by recency or by an arbitrary first match.
    if (names.length > 1) return { phase: 'failed', code: 'multiple-app-tools-instances' };
    if (names.length === 1) pipePath = '\\\\.\\pipe\\' + names[0];
  }
  return pipePath ? deliverAppToolsCodex({ ...options, pipePath }) : deliverLegacyCodex(options);
}

/** Protocol comes from the installed codex-app-tools MCP, without extracting host credentials. */
export async function deliverAppToolsCodex({ threadId, message, cwd, deliveryId,
  pipePath, timeoutMs = 10000 } = {}) {
  const id = deliveryId || createHash('sha256').update(`${threadId}\0${message}`).digest('hex');
  const socket = net.createConnection(pipePath);
  let buffer = Buffer.alloc(0), pending, sequence = 0, sendWritten = false;
  const fail = error => pending?.reject(error);
  socket.on('error', fail);
  socket.on('close', () => fail(new Error('app-tools-connection-closed')));
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    try {
      while (buffer.length >= 4) {
        const size = buffer.readUInt32LE();
        if (!size || size > 8388608) throw new Error('invalid-app-tools-frame');
        if (buffer.length < size + 4) break;
        const reply = JSON.parse(buffer.subarray(4, size + 4));
        buffer = buffer.subarray(size + 4);
        if (reply.jsonrpc !== '2.0') throw new Error('invalid-app-tools-response');
        if (reply.id === pending?.id) pending.resolve(reply);
      }
    } catch (error) { fail(error); socket.destroy(); }
  });
  const request = (method, params, isSend = false) => new Promise((resolve, reject) => {
    const requestId = ++sequence;
    const finish = (fn, value) => { clearTimeout(timer); pending = undefined; fn(value); };
    const timer = setTimeout(() => finish(reject, new Error('app-tools-request-timeout')), timeoutMs);
    pending = { id: requestId, resolve: r => finish(resolve, r), reject: e => finish(reject, e) };
    if (isSend) sendWritten = true;
    socket.write(frame({ jsonrpc: '2.0', id: requestId, method, params }));
  });
  const contents = result => {
    if (result?.success !== true || !Array.isArray(result.contentItems)) return null;
    for (const item of result.contentItems) {
      if (item.type !== 'inputText') continue;
      try { return JSON.parse(item.text); } catch { /* Require a structured receipt. */ }
    }
    return null;
  };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('app-tools-connect-timeout')); }, timeoutMs);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.once('error', e => { clearTimeout(timer); reject(e); });
    });
    const listed = await request('tools/list', { threadStartKind: 'all' });
    const tools = listed.result?.tools;
    const read = tools?.find(t => t.name === 'read_thread');
    const send = tools?.find(t => t.name === 'send_message_to_thread');
    if (!read?.namespace || !send?.namespace) return { phase: 'failed', code: 'app-tools-protocol-unavailable' };
    const call = (tool, args, isSend = false) => request('tools/call', {
      arguments: args, callerSource: 'codex', hostId: 'local', namespace: tool.namespace,
      // This is an authorized ingress into the target context, not a new executor.
      // The original message retains its external sender identity and has no new authority.
      threadId, tool: tool.name, callId: id + ':' + tool.name, turnId: 'mcp-turn-' + id,
    }, isSend);
    const readReply = await call(read, { threadId, hostId: 'local', includeTurns: false });
    const target = contents(readReply.result)?.thread;
    const normalize = value => typeof value === 'string' ? path.resolve(value).toLowerCase() : null;
    if (!target || target.id !== threadId || target.hostId !== 'local' || target.kind !== 'codex' || normalize(target.cwd) !== normalize(cwd)) {
      return { phase: 'failed', code: 'app-tools-target-mismatch' };
    }
    const sent = await call(send, { threadId, hostId: 'local', prompt: message }, true);
    if (sent.error) return { phase: 'failed', code: 'app-tools-send-rejected' };
    if (contents(sent.result)?.threadId !== threadId) return { phase: 'unknown', code: 'app-tools-send-not-confirmed' };
    return { phase: 'submitted', mode: 'native-follow-up', clientUserMessageId: id };
  } catch (error) {
    return { phase: sendWritten ? 'unknown' : 'failed', code: error.code || error.message || 'app-tools-error' };
  } finally { socket.destroy(); }
}

/** Legacy desktop IPC: queue only after an explicit idle rejection. */
export async function deliverLegacyCodex({ threadId, message, cwd, queueExe, deliveryId,
  pipePath = process.platform === 'win32' ? '\\\\.\\pipe\\codex-ipc' : null,
  timeoutMs = 6000, queueMessage = queueIdle } = {}) {
  if (!threadId || !message || !cwd) return { phase: 'failed', code: 'missing-delivery-input' };
  if (!pipePath) return { phase: 'failed', code: 'desktop-ipc-platform-unverified' };
  const id = deliveryId || createHash('sha256').update(`${threadId}\0${message}`).digest('hex');
  const socket = net.createConnection(pipePath);
  let incoming = Buffer.alloc(0), clientId = 'initializing-client', activeRequest = null;
  let steerWritten = false, steerRejected = false;
  const failPending = error => activeRequest?.reject(error);
  socket.on('error', failPending);
  socket.on('close', () => failPending(new Error('ipc-connection-closed')));
  socket.on('data', chunk => {
    incoming = Buffer.concat([incoming, chunk]);
    try {
      while (incoming.length >= 4) {
        const size = incoming.readUInt32LE(0);
        if (size === 0 || size > 8388608) throw new Error('invalid-ipc-frame');
        if (incoming.length < size + 4) break;
        const reply = JSON.parse(incoming.subarray(4, size + 4).toString('utf8'));
        incoming = incoming.subarray(size + 4);
        if (reply.type === 'client-discovery-request') {
          socket.write(frame({ type: 'client-discovery-response', requestId: reply.requestId, response: { canHandle: false } }));
        } else if (reply.type === 'response' && reply.requestId === activeRequest?.id) {
          activeRequest.resolve(reply);
        }
      }
    } catch (error) { failPending(error); socket.destroy(); }
  });
  const request = (method, params, version, targetClientId) => new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const finish = (callback, value) => { clearTimeout(timer); activeRequest = null; callback(value); };
    const timer = setTimeout(() => finish(reject, new Error('ipc-request-timeout')), timeoutMs);
    activeRequest = { id: requestId, resolve: value => finish(resolve, value), reject: error => finish(reject, error) };
    if (method === 'thread-follower-steer-turn') steerWritten = true;
    socket.write(frame({ type: 'request', requestId, sourceClientId: clientId, method,
      params, version, targetClientId, timeoutMs }));
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('ipc-connect-timeout')); }, timeoutMs);
      socket.once('connect', () => { clearTimeout(timer); resolve(); });
      socket.once('error', error => { clearTimeout(timer); reject(error); });
    });
    const initialized = await request('initialize', { clientType: 'zhixing-mailbox' }, 0);
    if (initialized.resultType !== 'success' || !initialized.result?.clientId) throw new Error('ipc-initialize-rejected');
    clientId = initialized.result.clientId;
    const owner = await request('thread-owner-discovery', { hostId: 'local', conversationId: threadId }, 1);
    if (owner.resultType !== 'success' || !owner.handledByClientId) {
      return { phase: 'failed', code: owner.error || 'desktop-owner-unavailable' };
    }
    const reply = await request('thread-follower-steer-turn', {
      conversationId: threadId, clientUserMessageId: id,
      input: [{ type: 'text', text: message, text_elements: [] }],
      restoreMessage: { id, cwd, context: { workspaceRoots: [cwd], commentAttachments: [] } },
    }, 1, owner.handledByClientId);
    if (reply.resultType !== 'success') {
      steerRejected = true;
      socket.destroy();
      if (INACTIVE.test(reply.error || '') && queueExe) return await queueMessage(queueExe, threadId, message);
      return { phase: 'failed', code: reply.error || 'steer-rejected' };
    }
    const turnId = reply.result?.result?.turnId;
    if (!turnId) return { phase: 'unknown', code: 'steer-reply-missing-turn-id' };
    return { phase: 'submitted', mode: 'steer', turnId, clientUserMessageId: id };
  } catch (error) {
    return { phase: steerWritten && !steerRejected ? 'unknown' : 'failed', code: error.code || error.message || 'desktop-ipc-error' };
  } finally { socket.destroy(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i].startsWith('--') || args[i + 1] === undefined) throw new Error('Use --name value arguments');
    options[args[i].slice(2)] = args[i + 1];
  }
  const message = options.file ? fs.readFileSync(options.file, 'utf8') : options.message;
  const result = await deliverCodex({ threadId: options.thread, message, cwd: options.cwd,
    queueExe: options['queue-exe'], deliveryId: options.id });
  console.log(JSON.stringify(result));
  if (result.phase !== 'submitted') process.exitCode = 1;
}
