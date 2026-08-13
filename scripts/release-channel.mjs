import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const inputPath = value("--input");
const input = exact(JSON.parse(await readFile(resolve(inputPath), "utf8")), ["indexUrl", "keyId", "publicKeySpki"]);
const url = new URL(string(input.indexUrl, "indexUrl"));
if (url.protocol !== "https:" || url.username || url.password) throw new Error("stable index URL must be credential-free HTTPS");
const keyId = string(input.keyId, "keyId");
if (!/^[A-Za-z0-9._-]{1,128}$/u.test(keyId)) throw new Error("release keyId is invalid");
const publicKeySpki = string(input.publicKeySpki, "publicKeySpki");
const keyBytes = Buffer.from(publicKeySpki, "base64url");
if (keyBytes.byteLength < 32 || keyBytes.toString("base64url") !== publicKeySpki) throw new Error("release public key is invalid");

const output = `export interface EmbeddedReleaseTrust {\n  readonly keyId: string;\n  readonly publicKeySpki: string;\n}\n\nexport const STABLE_RELEASE_INDEX_URL = ${JSON.stringify(url.href)};\nexport const EMBEDDED_RELEASE_TRUST: EmbeddedReleaseTrust = Object.freeze(${JSON.stringify({ keyId, publicKeySpki })});\n`;
await writeFile(resolve(root, "packages/cli/src/generated/release-channel.ts"), output, "utf8");

function value(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${flag} is required`);
  return process.argv[index + 1];
}
function exact(input, fields) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("release channel input must be an object");
  if (JSON.stringify(Object.keys(input).sort()) !== JSON.stringify([...fields].sort())) throw new Error("release channel input has unknown or missing fields");
  return input;
}
function string(input, label) {
  if (typeof input !== "string" || !input) throw new Error(`${label} is invalid`);
  return input;
}
