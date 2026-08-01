import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const config = {
  llm: { main: { provider: "s7-deterministic", model: "s7-fixed" } },
  ...(args.mode === "s1-workspace"
    ? { workspace: { root: path.resolve(args.workspace) } }
    : {}),
};
const credentials = {
  providers: {
    "s7-deterministic": {
      apiKey: "s7-local-only",
      baseUrl: "http://127.0.0.1:43891/v1",
      protocol: "openai-compatible",
    },
  },
};
await mkdir(args.home, { recursive: true });
await writeFile(path.join(args.home, "config.jsonc"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
await writeFile(path.join(args.home, "credentials.json"), `${JSON.stringify(credentials, null, 2)}\n`, "utf8");

if (args.mode === "current-workspace") {
  await runPublicCli(args.target, args.home, ["workspace", "create", "performance", args.workspace]);
} else if (args.mode !== "current-no-workspace" && args.mode !== "s1-workspace" && args.mode !== "s1-no-workspace") {
  throw new Error("Unknown S7 public scenario setup mode");
}

function runPublicCli(target, home, cliArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(target, "packages/cli/dist/index.js"), ...cliArgs], {
      cwd: target,
      env: {
        ...process.env,
        ZHIXING_HOME: home,
        ZHIXING_CONFIG_PATH: path.join(home, "config.jsonc"),
      },
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Public CLI setup failed (${code})`)));
  });
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("S7 scenario setup arguments are incomplete");
    result[key.slice(2)] = value;
  }
  for (const key of ["target", "home", "workspace", "mode"]) if (!result[key]) throw new Error(`Missing --${key}`);
  return result;
}
