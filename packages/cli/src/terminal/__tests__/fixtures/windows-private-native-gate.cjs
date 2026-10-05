const net = require('node:net');
const [artifact, controlEndpoint, endpoint, token, marker] = process.argv.slice(2);
const native = require(artifact);
function quote(value) {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}
const control = net.connect(controlEndpoint);
control.on('error', () => process.exit(70));
const deadline = Date.now() + 5000;
const command = [process.execPath, '-e',
  'const fs=require("node:fs");fs.writeFileSync(process.argv[1],"target-ran");process.stdin.once("data",data=>{process.stdout.write(data);process.stderr.write("fixture-error");});', marker].map(quote).join(' ');
const environment = Object.entries(process.env).filter(([, value]) => value !== undefined)
  .map(([key, value]) => `${key}=${value}`).join('\0') + '\0\0';
const id = native.createPrivate(process.execPath, command, environment, process.cwd(), endpoint, token, deadline);
let announced = false, admitted = false, released = false, buffer = '';
control.on('data', data => {
  buffer += data; if (buffer.length > 512) process.exit(71);
  const end = buffer.indexOf('\n'); if (end < 0) return;
  const packet = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
  if (packet.type !== 'permit' || packet.id !== id || !announced || admitted) process.exit(72);
  native.resume(id); admitted = true;
  let repeated = false; try { native.resume(id); } catch { repeated = true; }
  control.write(JSON.stringify({ type: 'resumed', repeated }) + '\n');
});
const poll = setInterval(() => {
  const state = native.snapshot(id);
  if (state.ready && !announced) {
    if (!state.created || !state.birth) process.exit(73);
    announced = true; control.write(JSON.stringify({ type: 'target', id, pid: state.pid, birth: state.birth }) + '\n');
  }
  if (state.creationExited && state.exited) {
    native.release(id); released = true; clearInterval(poll); control.end();
  } else if (Date.now() >= deadline && !admitted) native.stop(id);
}, 5);
control.once('close', () => { if (!admitted && !released) native.stop(id); });
