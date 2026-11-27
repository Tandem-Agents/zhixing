import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CORE_DIR = path.join(REPO_ROOT, "packages", "core");
const CORE_DIST = path.join(CORE_DIR, "dist");
const CLI_DIR = path.join(REPO_ROOT, "packages", "cli");
const TARGET_FILE = path.join(CORE_DIR, "src", "skills", "generated-extension-kit-resources.ts");

const MAX_MEMBERS = 64;
const MAX_MEMBER_BYTES = 524_288;
const MAX_TOTAL_BYTES = 2_097_152;
const MAX_DEPTH = 6;
const MAX_PATH_BYTES = 256;

const STARTER_CHANNEL_TS = `import { serveChannelExtension } from "../kit/channel-sdk.mjs";

type CreateAdapter = Parameters<typeof serveChannelExtension>[0];
type Adapter = ReturnType<CreateAdapter>;
type ChannelCtx = Parameters<Adapter["connect"]>[0];
type InboundMsg = Parameters<ChannelCtx["onMessage"]>[0];
type SendTarget = Parameters<Adapter["send"]>[0];
type SendContent = Parameters<Adapter["send"]>[1];
type SendMeta = Parameters<Adapter["send"]>[2];
type DeliveryRes = Awaited<ReturnType<Adapter["send"]>>;

interface HttpRequestLike {
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array | string>;
}

interface HttpResponseLike {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(chunk?: string): void;
}

interface Utf8Decoder {
  decode(input?: Uint8Array, options?: { stream?: boolean }): string;
}

function createUtf8Decoder(): Utf8Decoder {
  const Decoder = (globalThis as unknown as { TextDecoder?: new () => Utf8Decoder }).TextDecoder;
  if (!Decoder) {
    throw new Error("TextDecoder is unavailable in current runtime");
  }
  return new Decoder();
}

async function readWebhookPayload(req: HttpRequestLike): Promise<Record<string, unknown>> {
  let rawText = "";
  if (typeof req.body === "string") {
    rawText = req.body;
  } else if (req.body instanceof Uint8Array) {
    rawText = createUtf8Decoder().decode(req.body);
  } else if (req.body && typeof req.body === "object") {
    return req.body as Record<string, unknown>;
  } else if (typeof req[Symbol.asyncIterator] === "function") {
    const decoder = createUtf8Decoder();
    const parts: string[] = [];
    for await (const chunk of req as AsyncIterable<Uint8Array | string>) {
      parts.push(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
    }
    parts.push(decoder.decode());
    rawText = parts.join("");
  }
  const parsed = rawText ? (JSON.parse(rawText) as unknown) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid JSON webhook body");
  }
  return parsed as Record<string, unknown>;
}

function sendJson(res: HttpResponseLike, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

export function createStarterAdapter(instanceId: string): Adapter {
  let activeContext: ChannelCtx | undefined;
  let connected = false;
  let accountId = "";
  let endpointUrl = "";
  let apiToken = "";

  return {
    id: instanceId,
    capabilities: {
      chatTypes: ["dm", "group"],
      media: false,
      edit: false,
      streaming: false,
    },
    bindingPolicy: { group: "per-group" },
    async connect(ctx: ChannelCtx): Promise<void> {
      accountId = (ctx.config.credentials.accountId ?? "").trim();
      endpointUrl = (ctx.config.credentials.endpointUrl ?? "").trim().replace(/\\/+$/, "");
      apiToken = (ctx.config.credentials.apiToken ?? "").trim();
      if (!accountId || !endpointUrl || !apiToken) {
        throw new Error("Missing starter channel credentials (accountId, endpointUrl, apiToken)");
      }
      ctx.registerHttpRoute(\`/channels/\${encodeURIComponent(instanceId)}/webhook\`, async (rawReq, rawRes) => {
        const req = rawReq as HttpRequestLike;
        const res = rawRes as HttpResponseLike;
        const headerToken = req.headers?.["x-starter-token"];
        const tokenValue = Array.isArray(headerToken) ? headerToken[0] : headerToken;
        if (tokenValue !== undefined && tokenValue !== apiToken) {
          sendJson(res, 401, { ok: false, error: "Unauthorized webhook token" });
          return;
        }
        try {
          const payload = await readWebhookPayload(req);
          const messageId = typeof payload.messageId === "string" ? payload.messageId.trim() : "";
          const from = typeof payload.from === "string" ? payload.from.trim() : "";
          const text = typeof payload.text === "string" ? payload.text : "";
          if (!messageId || !from || typeof payload.text !== "string") {
            sendJson(res, 400, { ok: false, error: "Webhook requires messageId, from, and text" });
            return;
          }
          const rawChatType = payload.chatType;
          const chatType: InboundMsg["chatType"] =
            rawChatType === "group" || rawChatType === "thread" || rawChatType === "channel"
              ? rawChatType
              : "dm";
          const inbound: InboundMsg = {
            channelId: instanceId,
            messageId,
            from,
            text,
            chatType,
            ...(typeof payload.groupId === "string" && payload.groupId ? { groupId: payload.groupId } : {}),
            ...(typeof payload.threadId === "string" && payload.threadId ? { threadId: payload.threadId } : {}),
          };
          await ctx.onMessage(inbound);
          sendJson(res, 200, { ok: true, messageId });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Inbound rejected";
          const status = /验证|blocked|rejected/i.test(msg) ? 403 : 500;
          sendJson(res, status, { ok: false, error: msg });
        }
      });
      activeContext = ctx;
      connected = true;
    },
    async disconnect(): Promise<void> {
      connected = false;
      activeContext = undefined;
    },
    health(): "ready" | "unavailable" {
      return connected ? "ready" : "unavailable";
    },
    async send(target: SendTarget, content: SendContent, meta?: SendMeta): Promise<DeliveryRes> {
      if (!connected || !activeContext || !endpointUrl || !apiToken) {
        return { success: false, retryable: true, attempted: false, error: "Not connected" };
      }
      try {
        const response = await fetch(\`\${endpointUrl}/outbound\`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: \`Bearer \${apiToken}\`,
            ...(meta?.idempotencyKey ? { "idempotency-key": meta.idempotencyKey } : {}),
          },
          body: JSON.stringify({ accountId, target, content, meta }),
        });
        if (!response.ok) {
          return {
            success: false,
            retryable: response.status >= 500 || response.status === 429,
            error: \`HTTP \${response.status}\`,
          };
        }
        const receipt = (await response.json()) as { ok?: unknown; messageId?: unknown };
        if (receipt?.ok !== true || typeof receipt.messageId !== "string" || !receipt.messageId) {
          return { success: false, retryable: false, error: "Malformed outbound receipt" };
        }
        return {
          success: true,
          retryable: false,
          messageId: receipt.messageId,
        };
      } catch (err) {
        return {
          success: false,
          retryable: true,
          attempted: false,
          error: err instanceof Error ? err.message : "Network error",
        };
      }
    },
  };
}

export async function forwardInbound(ctx: ChannelCtx, msg: InboundMsg): Promise<void> {
  await ctx.onMessage(msg);
}

serveChannelExtension((instanceId) => createStarterAdapter(instanceId));
`;

const STARTER_MANIFEST_JSON = `${JSON.stringify({
  id: "starter-channel",
  version: "0.1.0",
  digest: "0000000000000000000000000000000000000000000000000000000000000000",
  runtime: "node24",
  entry: "index.mjs",
  protocol: 1,
  type: "channel",
  contract: 1,
  declaration: {
    label: "Starter Channel",
    description: "Minimal bidirectional Channel extension starter matching protocol 1 / contract 1.",
    identityFields: ["accountId"],
    bindingPolicy: { group: "per-group" },
    requiredFields: [
      {
        id: "accountId",
        label: "Account ID",
        hint: "Public account identifier for duplicate-instance isolation.",
        example: "bot-starter-01",
        sensitive: false,
      },
      {
        id: "endpointUrl",
        label: "Platform Endpoint URL",
        hint: "External platform HTTPS/HTTP base URL accepting POST /outbound.",
        example: "https://platform.example.com",
        sensitive: false,
      },
      {
        id: "apiToken",
        label: "API Token",
        hint: "Secret token entered by the owner inside /config on host.",
        example: "token-placeholder",
        sensitive: true,
      },
    ],
    capabilities: {
      chatTypes: ["dm", "group"],
      media: false,
      edit: false,
      streaming: false,
    },
  },
}, null, 2)}
`;

const NEGATIVE_MISSING_FIELD_JSON = `${JSON.stringify({
  id: "bad-missing-field",
  version: "0.1.0",
  digest: "0000000000000000000000000000000000000000000000000000000000000000",
  runtime: "node24",
  entry: "index.mjs",
  protocol: 1,
  type: "channel",
  contract: 1,
  declaration: {
    label: "Invalid Missing IdentityFields",
    requiredFields: [],
    capabilities: { chatTypes: ["dm"], media: false, edit: false, streaming: false },
  },
}, null, 2)}
`;

const NEGATIVE_EXPORT_SHAPE_MJS = `// Negative example (Layer 2: export/bundle contract violation):
// Fails because external third-party packages ("express") are not bundled and
// serveChannelExtension(instanceId => adapter) is missing.
import express from "express";
export default function createChannel() {
  return express();
}
`;

const NEGATIVE_DIGEST_MISMATCH_JSON = `${JSON.stringify({
  manifest: {
    id: "bad-digest-mismatch",
    version: "0.1.0",
    digest: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    runtime: "node24",
    entry: "index.mjs",
    protocol: 1,
    type: "channel",
    contract: 1,
    declaration: {
      label: "Digest Mismatch Example",
      identityFields: ["accountId"],
      requiredFields: [
        { id: "accountId", label: "Account", hint: "Account ID", example: "acc-1", sensitive: false },
      ],
      capabilities: { chatTypes: ["dm"], media: false, edit: false, streaming: false },
    },
  },
  code: 'import { serveChannelExtension } from "./channel-sdk.mjs"; serveChannelExtension(() => ({ id: "x" }));\n',
  provenance: { url: "https://example.com/starter", revision: "v0.1.0", kind: "authored" },
  sources: { "index.ts": "// mismatch" },
  build: "node esbuild.mjs",
}, null, 2)}
`;

const NEGATIVE_SYNTAX_ERROR_MJS = `// Negative example (Layer 4: fails node --check --input-type=module):
export function broken( {
  return ;
`;

function toLf(text) {
  return text.replace(/\r\n/g, "\n");
}

function inferMediaType(memberPath) {
  const lower = memberPath.toLowerCase();
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".ts")) return "text/typescript";
  if (lower.endsWith(".mjs") || lower.endsWith(".js")) return "text/javascript";
  return "text/plain";
}

function loadEsbuild() {
  const req = createRequire(path.join(CORE_DIR, "package.json"));
  const tsupPath = req.resolve("tsup", { paths: [CORE_DIR, CLI_DIR, REPO_ROOT] });
  return createRequire(tsupPath)("esbuild");
}

async function collectDeclarationClosure(entryRelPath) {
  const seen = new Set();
  const collected = [];

  async function visit(filePath) {
    const resolved = path.resolve(filePath);
    if (seen.has(resolved)) return;
    const rel = path.relative(CORE_DIST, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Contract declaration escaped core dist: ${resolved}`);
    }
    seen.add(resolved);
    const content = toLf(await readFile(resolved, "utf8"));
    const posixRel = rel.split(path.sep).join("/");
    collected.push({
      path: `kit/contracts/${posixRel}`,
      mediaType: inferMediaType(posixRel),
      content,
    });
    for (const match of content.matchAll(/(?:from\s*|import\s*\(?\s*)["'](\.[^"']+)["']/g)) {
      const depSpec = match[1].replace(/\.js$/, ".d.ts");
      await visit(path.resolve(path.dirname(resolved), depSpec));
    }
  }

  await visit(path.join(CORE_DIST, entryRelPath));
  return collected;
}

function validateResources(resources) {
  // +1 accounts for root SKILL.md
  if (resources.length + 1 > MAX_MEMBERS) {
    throw new Error(`Extension kit resource count ${resources.length} exceeds limit ${MAX_MEMBERS - 1}`);
  }
  const seen = new Set();
  let totalBytes = 0;
  for (const item of resources) {
    if (seen.has(item.path)) throw new Error(`Duplicate resource path: ${item.path}`);
    seen.add(item.path);
    const segs = item.path.split("/");
    if (segs.length > MAX_DEPTH || segs.some((s) => !s || s === "." || s === "..")) {
      throw new Error(`Invalid resource path depth/segments: ${item.path}`);
    }
    if (Buffer.byteLength(item.path, "utf8") > MAX_PATH_BYTES) {
      throw new Error(`Resource path exceeds ${MAX_PATH_BYTES} bytes: ${item.path}`);
    }
    const buf = Buffer.from(item.content, "utf8");
    if (buf.includes(0)) throw new Error(`Binary NUL byte in ${item.path}`);
    if (buf.byteLength > MAX_MEMBER_BYTES) {
      throw new Error(`Member ${item.path} exceeds ${MAX_MEMBER_BYTES} bytes (${buf.byteLength})`);
    }
    totalBytes += buf.byteLength;
  }
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new Error(`Generated resources total ${totalBytes} bytes exceeds ${MAX_TOTAL_BYTES}`);
  }
}

async function generate() {
  const esbuild = loadEsbuild();
  const sdkResult = await esbuild.build({
    entryPoints: [path.join(CORE_DIR, "src", "channels", "extension-worker.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    external: ["node:*"],
    write: false,
    logLevel: "silent",
  });
  const sdkCode = toLf(sdkResult.outputFiles[0].text);

  const [authoringMd, manifestSchema, contractDecls] = await Promise.all([
    readFile(path.join(REPO_ROOT, "docs", "modules", "extensions", "authoring.md"), "utf8").then(toLf),
    readFile(path.join(CLI_DIR, "src", "runtime", "extensions", "manifest.schema.json"), "utf8").then(toLf),
    collectDeclarationClosure("channels/extension-worker.d.ts"),
  ]);

  const rawResources = [
    { path: "kit/authoring.md", mediaType: "text/markdown", content: authoringMd },
    { path: "kit/manifest.schema.json", mediaType: "application/json", content: manifestSchema },
    { path: "kit/channel-sdk.mjs", mediaType: "text/javascript", content: sdkCode },
    {
      path: "kit/channel-sdk.d.ts",
      mediaType: "text/typescript",
      content: 'export { serveChannelExtension } from "./contracts/channels/extension-worker.js";\n',
    },
    {
      path: "kit/channel-sdk.d.mts",
      mediaType: "text/typescript",
      content: 'export { serveChannelExtension } from "./contracts/channels/extension-worker.js";\n',
    },
    ...contractDecls,
    { path: "examples/starter-channel.ts", mediaType: "text/typescript", content: toLf(STARTER_CHANNEL_TS) },
    { path: "examples/manifest.json", mediaType: "application/json", content: toLf(STARTER_MANIFEST_JSON) },
    { path: "examples/bad-1-missing-field.json", mediaType: "application/json", content: toLf(NEGATIVE_MISSING_FIELD_JSON) },
    { path: "examples/bad-2-export-shape.mjs", mediaType: "text/javascript", content: toLf(NEGATIVE_EXPORT_SHAPE_MJS) },
    { path: "examples/bad-3-digest-mismatch.json", mediaType: "application/json", content: toLf(NEGATIVE_DIGEST_MISMATCH_JSON) },
    { path: "examples/bad-4-syntax-error.mjs", mediaType: "text/javascript", content: toLf(NEGATIVE_SYNTAX_ERROR_MJS) },
  ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  validateResources(rawResources);

  // Build-time self-check: bundle materialized examples/starter-channel.ts + kit/channel-sdk.mjs as-is
  const verifyDir = await mkdtemp(path.join(os.tmpdir(), "zx-extkit-verify-"));
  try {
    await mkdir(path.join(verifyDir, "kit"), { recursive: true });
    await mkdir(path.join(verifyDir, "examples"), { recursive: true });
    await writeFile(path.join(verifyDir, "kit", "channel-sdk.mjs"), sdkCode, "utf8");
    const starterEntry = path.join(verifyDir, "examples", "starter-channel.ts");
    await writeFile(starterEntry, toLf(STARTER_CHANNEL_TS), "utf8");
    await esbuild.build({
      entryPoints: [starterEntry],
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node24",
      external: ["node:*"],
      write: false,
      logLevel: "silent",
    });
  } finally {
    await rm(verifyDir, { recursive: true, force: true });
  }

  const output = `// AUTO-GENERATED by scripts/generate-builtin-skill-assets.mjs. Do not edit manually.
import type { BuiltinSkillResourceDef } from "./builtin.js";

export const GENERATED_EXTENSION_KIT_RESOURCES: readonly BuiltinSkillResourceDef[] = ${JSON.stringify(
    rawResources.map((r) => ({
      path: r.path,
      mediaType: r.mediaType,
      content: r.content,
    })),
    null,
    2,
  )} as const;
`;

  const previous = await readFile(TARGET_FILE, "utf8").catch(() => undefined);
  const changed = previous !== output;
  if (changed) {
    await writeFile(TARGET_FILE, output, "utf8");
  }
  return { changed, count: rawResources.length };
}

const rebuildIfChanged = process.argv.includes("--rebuild-if-changed");
const result = await generate();
if (rebuildIfChanged && result.changed) {
  execFileSync("pnpm", ["exec", "tsup"], {
    cwd: CORE_DIR,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}
