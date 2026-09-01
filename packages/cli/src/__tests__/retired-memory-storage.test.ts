import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";

const fsGuard = vi.hoisted(() => ({
  forbiddenRoots: [] as string[],
  forbiddenAccesses: [] as string[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  type UnknownFunction = (...args: unknown[]) => unknown;
  const guardedMethods = [
    "access",
    "appendFile",
    "chmod",
    "chown",
    "copyFile",
    "cp",
    "lchmod",
    "lchown",
    "link",
    "lstat",
    "mkdir",
    "mkdtemp",
    "open",
    "opendir",
    "readFile",
    "readdir",
    "readlink",
    "realpath",
    "rename",
    "rm",
    "rmdir",
    "stat",
    "symlink",
    "truncate",
    "unlink",
    "utimes",
    "writeFile",
  ] as const;

  const overrides: Record<string, UnknownFunction> = {};
  for (const method of guardedMethods) {
    const original = actual[method] as unknown as UnknownFunction;
    overrides[method] = (...args: unknown[]) => {
      for (const argument of args) {
        const candidate = normalizeFsPath(argument);
        if (
          candidate &&
          fsGuard.forbiddenRoots.some(
            (root) => candidate === root || candidate.startsWith(`${root}/`),
          )
        ) {
          fsGuard.forbiddenAccesses.push(`${method}:${candidate}`);
          throw new Error(`retired memory storage was accessed by ${method}`);
        }
      }
      return Reflect.apply(original, actual, args);
    };
  }

  return {
    ...actual,
    ...overrides,
    default: {
      ...actual,
      ...overrides,
    },
  };
});

import {
  getWorkSceneConversationsRoot,
  getWorkSceneDir,
} from "@zhixing/core";
import type { SecretRef, SecretStorePort } from "@zhixing/core/contracts";
import { setupAuthorityRuntime } from "../setup-delivery.js";
import { createWorksceneStorageCleanupInfrastructure } from "../serve/workscene-storage-cleanup.js";

const TEST_EXECUTOR_READINESS = {
  tools: [] as string[],
  mcpServers: [] as string[],
  credentialBindings: [],
  deviceScopedCredentialBindingIds: [] as string[],
  credentialGeneration: null,
};

describe("retired memory storage remains inert", () => {
  afterEach(() => {
    fsGuard.forbiddenRoots = [];
    fsGuard.forbiddenAccesses = [];
  });

  it("does not touch personal or workscene me directories during authority startup, shutdown, or conversation cleanup", async () => {
    const home = await createTempDir("retired-memory-storage");
    const sceneId = "scene-a";
    const personalMemory = path.join(home, "me");
    const sceneDirectory = getWorkSceneDir(sceneId, home);
    const sceneMemory = path.join(sceneDirectory, "me");
    const conversationDirectory = path.join(
      getWorkSceneConversationsRoot(sceneId, home),
      "conversation-a",
    );
    const personalSentinel = path.join(personalMemory, "sentinel.txt");
    const sceneSentinel = path.join(sceneMemory, "sentinel.txt");

    mkdirSync(personalMemory, { recursive: true });
    mkdirSync(sceneMemory, { recursive: true });
    mkdirSync(conversationDirectory, { recursive: true });
    writeFileSync(personalSentinel, "personal-sentinel", "utf8");
    writeFileSync(sceneSentinel, "scene-sentinel", "utf8");
    writeFileSync(path.join(conversationDirectory, "meta.json"), "{}", "utf8");

    fsGuard.forbiddenRoots = [personalMemory, sceneMemory].map(normalizeFsPath);
    let authority: Awaited<ReturnType<typeof setupAuthorityRuntime>> | undefined;
    try {
      authority = await setupAuthorityRuntime({
        zhixingHome: home,
        secretStore: new MemorySecretStore(),
        executorReadiness: TEST_EXECUTOR_READINESS,
      });
      await authority.startupCleanup.run();
      authority = undefined;

      const cleanup = createWorksceneStorageCleanupInfrastructure({
        zhixingHome: home,
      });
      await cleanup.conversations.removeConversation(sceneId, "conversation-a");
    } finally {
      fsGuard.forbiddenRoots = [];
      await authority?.startupCleanup.run();
    }

    expect(fsGuard.forbiddenAccesses).toEqual([]);
    expect(existsSync(personalSentinel)).toBe(true);
    expect(existsSync(sceneSentinel)).toBe(true);
    expect(readFileSync(personalSentinel, "utf8")).toBe("personal-sentinel");
    expect(readFileSync(sceneSentinel, "utf8")).toBe("scene-sentinel");
    expect(existsSync(conversationDirectory)).toBe(false);
  }, 120_000);
});

function normalizeFsPath(input: unknown): string {
  if (typeof input !== "string") return "";
  return input.replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
}

class MemorySecretStore implements SecretStorePort {
  readonly #values = new Map<string, string>();

  async put(ref: SecretRef, value: string): Promise<void> {
    this.#values.set(secretKey(ref), value);
  }

  async get(ref: SecretRef): Promise<string | null> {
    return this.#values.get(secretKey(ref)) ?? null;
  }

  async delete(ref: SecretRef): Promise<void> {
    this.#values.delete(secretKey(ref));
  }

  async list(prefix: string): Promise<SecretRef[]> {
    return [...this.#values.keys()]
      .filter((value) => value.startsWith(prefix))
      .map((value) => {
        const separator = value.indexOf("/");
        return {
          kind: value.slice(0, separator) as SecretRef["kind"],
          bindingId: value.slice(separator + 1),
        };
      });
  }

  async unlockState(): Promise<"unlocked"> {
    return "unlocked";
  }
}

function secretKey(ref: SecretRef): string {
  return `${ref.kind}/${ref.bindingId}`;
}
