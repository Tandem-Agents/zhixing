import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const server = http.createServer((request, response) => {
  if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
    response.writeHead(404).end();
    return;
  }
  request.resume();
  request.once("end", () => {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    for (const content of ["frame-1\n", "frame-2\n", "frame-3\n"]) {
      response.write(`data: ${JSON.stringify({
        id: "s7-fixed",
        object: "chat.completion.chunk",
        created: 0,
        model: "s7-fixed",
        choices: [{ index: 0, delta: { content }, finish_reason: null }],
      })}\n\n`);
    }
    response.write(`data: ${JSON.stringify({
      id: "s7-fixed",
      object: "chat.completion.chunk",
      created: 0,
      model: "s7-fixed",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(43891, "127.0.0.1", resolve);
});

const child = spawn(process.execPath, [path.join(args.target, "packages/cli/dist/index.js")], {
  cwd: args.target,
  env: {
    ...process.env,
    ZHIXING_HOME: args.home,
    ZHIXING_CONFIG_PATH: path.join(args.home, "config.jsonc"),
    ZHIXING_INPUT_TYPEAHEAD: "off",
  },
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.once("exit", (code) => {
  server.close(() => process.exit(code ?? 1));
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => child.kill(signal));
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("S7 terminal driver arguments are incomplete");
    result[key.slice(2)] = value;
  }
  for (const key of ["target", "home"]) if (!result[key]) throw new Error(`Missing --${key}`);
  return result;
}
