import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createTempDir } from "@zhixing/test-utils";
import { describe, expect, it } from "vitest";
import { EncryptedVaultSecretStore } from "../vault-secret-store.js";
import { MemoryMasterKeyProvider } from "../master-key.js";
import {
  type CommandRunner,
  createPlatformSecretStore,
  getPlatformSecretStoreProtectedPaths,
  readPlatformSecretStoreBackendBinding,
} from "../platform-secret-store.js";

async function fixture() {
  const directory = await createTempDir("secret-vault");
  const vaultPath = path.join(directory, "vault.json");
  const store = new EncryptedVaultSecretStore({
    vaultPath,
    masterKey: new MemoryMasterKeyProvider(Buffer.alloc(32, 7)),
  });
  return { directory, vaultPath, store };
}

describe("EncryptedVaultSecretStore", () => {
  it("公开覆盖 vault、密钥、锁和临时文件的单一文件族保护前缀", async () => {
    const directory = await createTempDir("secret-path-boundary");
    expect(getPlatformSecretStoreProtectedPaths(directory)).toEqual([
      path.join(path.resolve(directory), "secret-vault"),
    ]);
    expect(() => getPlatformSecretStoreProtectedPaths("relative-home")).toThrow(
      "must be absolute",
    );
  });

  it.runIf(process.platform === "win32")(
    "opens the Windows DPAPI backend and reopens the same vault",
    async () => {
    const directory = await createTempDir("platform-vault");
    const ref = { kind: "provider" as const, bindingId: "credentials/v1/platform" };
    const first = createPlatformSecretStore({ homeDir: directory });
    await first.put(ref, "platform-secret");
    const reopened = createPlatformSecretStore({ homeDir: directory });
    expect(await reopened.get(ref)).toBe("platform-secret");
    expect(await readFile(path.join(directory, "secret-vault.json"), "utf8")).not.toContain(
      "platform-secret",
    );
    },
    15_000,
  );

  it("persists references while keeping secret values out of the vault envelope", async () => {
    const { vaultPath, store } = await fixture();
    const provider = { kind: "provider" as const, bindingId: "credentials/v1/deepseek" };
    const channel = { kind: "channel" as const, bindingId: "credentials/v1/feishu" };

    await Promise.all([
      store.put(provider, "provider-secret-value"),
      store.put(channel, "channel-secret-value"),
    ]);

    expect(await store.get(provider)).toBe("provider-secret-value");
    expect(await store.list("provider/credentials/v1/")).toEqual([provider]);
    const bytes = await readFile(vaultPath, "utf8");
    expect(bytes).not.toContain("provider-secret-value");
    expect(bytes).not.toContain("channel-secret-value");
    expect(JSON.parse(bytes)).toEqual({
      v: 1,
      nonce: expect.any(String),
      ciphertext: expect.any(String),
      tag: expect.any(String),
    });
  });

  it("rejects tampering instead of returning unauthenticated plaintext", async () => {
    const { vaultPath, store } = await fixture();
    const ref = { kind: "mcp" as const, bindingId: "credentials/v1/github" };
    await store.put(ref, "secret");
    const envelope = JSON.parse(await readFile(vaultPath, "utf8")) as { ciphertext: string };
    envelope.ciphertext = `${envelope.ciphertext.slice(0, -1)}A`;
    await writeFile(vaultPath, JSON.stringify(envelope), "utf8");
    await expect(store.unlockState()).resolves.toBe("unavailable");
    await expect(store.get(ref)).rejects.toThrow("cannot be authenticated or decrypted");
  });

  it("serializes concurrent mutations without dropping either entry", async () => {
    const { store } = await fixture();
    const refs = Array.from({ length: 16 }, (_, index) => ({
      kind: "provider" as const,
      bindingId: `credentials/v1/provider-${index}`,
    }));
    await Promise.all(refs.map((ref, index) => store.put(ref, `secret-${index}`)));
    expect(await store.list("provider/credentials/v1/")).toEqual(
      [...refs].sort((left, right) => left.bindingId.localeCompare(right.bindingId)),
    );
  });

  it("serializes composite operations across independent store instances", async () => {
    const directory = await createTempDir("secret-exclusive");
    const vaultPath = path.join(directory, "vault.json");
    const first = new EncryptedVaultSecretStore({
      vaultPath,
      masterKey: new MemoryMasterKeyProvider(Buffer.alloc(32, 9)),
    });
    const second = new EncryptedVaultSecretStore({
      vaultPath,
      masterKey: new MemoryMasterKeyProvider(Buffer.alloc(32, 9)),
    });
    let active = 0;
    let maximum = 0;
    const operation = async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      active -= 1;
    };

    await Promise.all([first.runExclusive(operation), second.runExclusive(operation)]);
    expect(maximum).toBe(1);
  });

  it.each([
    { platform: "darwin" as const, env: {}, backend: "security" },
    {
      platform: "linux" as const,
      env: { XDG_CURRENT_DESKTOP: "test" },
      backend: "secret-tool",
    },
  ])("reopens desktop vaults through the $backend credential backend", async ({
    platform,
    env,
    backend,
  }) => {
    const directory = await createTempDir(`platform-${platform}`);
    const credentialBackend = fakeCredentialBackend();
    const ref = { kind: "channel" as const, bindingId: "credentials/v1/desktop" };
    const first = createPlatformSecretStore({
      homeDir: directory,
      platform,
      env,
      commandRunner: credentialBackend.run,
    });
    await first.put(ref, "desktop-secret");
    const reopened = createPlatformSecretStore({
      homeDir: directory,
      platform,
      env,
      commandRunner: credentialBackend.run,
    });
    const otherDirectory = await createTempDir(`platform-${platform}-other`);
    const other = createPlatformSecretStore({
      homeDir: otherDirectory,
      platform,
      env,
      commandRunner: credentialBackend.run,
    });
    await other.put(ref, "other-profile-secret");

    expect(await reopened.get(ref)).toBe("desktop-secret");
    expect(credentialBackend.commands).toContain(backend);
    expect(await readFile(path.join(directory, "secret-vault.json"), "utf8")).not.toContain(
      "desktop-secret",
    );
  });

  it("uses the machine-bound encrypted backend for a headless Linux device", async () => {
    const directory = await createTempDir("platform-headless");
    const ref = { kind: "mcp" as const, bindingId: "credentials/v1/headless" };
    const rejectCredentialBackend: CommandRunner = async () => {
      throw new Error("headless SecretStore must not call a desktop credential backend");
    };
    const first = createPlatformSecretStore({
      homeDir: directory,
      platform: "linux",
      env: {},
      machineIdentity: "test-headless-machine",
      commandRunner: rejectCredentialBackend,
    });
    await first.put(ref, "headless-secret");
    const reopened = createPlatformSecretStore({
      homeDir: directory,
      platform: "linux",
      env: {},
      machineIdentity: "test-headless-machine",
      commandRunner: rejectCredentialBackend,
    });

    expect(await reopened.get(ref)).toBe("headless-secret");
    expect(await readFile(path.join(directory, "secret-vault.key"))).toHaveLength(32);
    expect(await readFile(path.join(directory, "secret-vault.json"), "utf8")).not.toContain(
      "headless-secret",
    );
    expect(await readPlatformSecretStoreBackendBinding(directory)).toBe("machine-bound");
  });

  it("keeps the desktop backend binding when managed Linux has no display session", async () => {
    const directory = await createTempDir("platform-linux-bound-desktop");
    const ref = { kind: "provider" as const, bindingId: "credentials/v1/bound" };
    const backend = fakeCredentialBackend();
    const foreground = createPlatformSecretStore({
      homeDir: directory,
      platform: "linux",
      env: { DISPLAY: ":0" },
      commandRunner: backend.run,
    });
    await foreground.put(ref, "desktop-bound-secret");

    const managed = createPlatformSecretStore({
      homeDir: directory,
      platform: "linux",
      env: {},
      context: "managed",
      machineIdentity: "must-not-be-used",
      commandRunner: backend.run,
    });
    expect(await managed.get(ref)).toBe("desktop-bound-secret");
    expect(await readPlatformSecretStoreBackendBinding(directory)).toBe(
      "linux-secret-service",
    );
    await expect(readFile(path.join(directory, "secret-vault.key"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not initialize a new SecretStore from managed startup", async () => {
    const directory = await createTempDir("platform-managed-first-open");
    const store = createPlatformSecretStore({
      homeDir: directory,
      platform: "linux",
      env: {},
      context: "managed",
      machineIdentity: "managed-first-open",
    });
    expect(await store.unlockState()).toBe("unavailable");
    expect(await readPlatformSecretStoreBackendBinding(directory)).toBeUndefined();
    await expect(readFile(path.join(directory, "secret-vault.key"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails closed on a malformed backend binding", async () => {
    const directory = await createTempDir("platform-invalid-binding");
    await writeFile(
      path.join(directory, "secret-vault.backend.json"),
      JSON.stringify({ v: 1, backend: "unknown" }),
      "utf8",
    );
    const store = createPlatformSecretStore({
      homeDir: directory,
      platform: "linux",
      env: {},
      machineIdentity: "invalid-binding",
    });
    expect(await store.unlockState()).toBe("unavailable");
  });

  it("never replaces a desktop master key when an existing vault cannot be unlocked", async () => {
    const directory = await createTempDir("platform-keyring-locked");
    const ref = { kind: "provider" as const, bindingId: "credentials/v1/locked" };
    const initializedBackend = fakeCredentialBackend();
    const initialized = createPlatformSecretStore({
      homeDir: directory,
      platform: "darwin",
      env: {},
      commandRunner: initializedBackend.run,
    });
    await initialized.put(ref, "protected-secret");

    let replacementAttempts = 0;
    const lockedBackend: CommandRunner = async (_command, args) => {
      if (args[0] === "add-generic-password") replacementAttempts += 1;
      return result(44);
    };
    const reopened = createPlatformSecretStore({
      homeDir: directory,
      platform: "darwin",
      env: {},
      commandRunner: lockedBackend,
    });

    expect(await reopened.unlockState()).toBe("unavailable");
    expect(replacementAttempts).toBe(0);
  });

  it("clears a crash-left machine-key temp before initializing the headless vault", async () => {
    const directory = await createTempDir("platform-headless-key-temp");
    const temporary = path.join(
      directory,
      "secret-vault.key.4242.0123456789ab.tmp",
    );
    await writeFile(temporary, Buffer.alloc(32, 9));
    const store = createPlatformSecretStore({
      homeDir: directory,
      platform: "linux",
      env: {},
      machineIdentity: "test-headless-key-temp",
    });

    expect(await store.unlockState()).toBe("unlocked");
    await expect(readFile(temporary)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a headless machine store as unavailable when its key seed is invalid", async () => {
    const directory = await createTempDir("platform-headless-invalid");
    await writeFile(path.join(directory, "secret-vault.key"), "invalid", "utf8");
    const store = createPlatformSecretStore({
      homeDir: directory,
      platform: "linux",
      env: {},
      machineIdentity: "test-headless-invalid-machine",
      commandRunner: async () => {
        throw new Error("headless SecretStore must not call a desktop credential backend");
      },
    });

    expect(await store.unlockState()).toBe("unavailable");
  });

  it("fails closed when a headless platform has no stable machine identity", async () => {
    const directory = await createTempDir("platform-headless-no-identity");
    const store = createPlatformSecretStore({
      homeDir: directory,
      platform: "aix",
      env: {},
    });

    expect(await store.unlockState()).toBe("unavailable");
  });
});

function fakeCredentialBackend(): {
  readonly commands: string[];
  readonly run: CommandRunner;
} {
  const stored = new Map<string, string>();
  const commands: string[] = [];
  return {
    commands,
    run: async (command, args, input) => {
      const executable = path.basename(command);
      commands.push(executable);
      if (executable === "secret-tool") {
        const account = args[args.indexOf("account") + 1] ?? "";
        if (args[0] === "lookup") {
          const value = stored.get(account) ?? "";
          return result(value ? 0 : 1, value);
        }
        if (args[0] === "store") {
          stored.set(account, Buffer.from(input ?? []).toString("utf8").trim());
          return result(0);
        }
      }
      if (executable === "security") {
        const account = args[args.indexOf("-a") + 1] ?? "";
        if (args[0] === "find-generic-password") {
          const value = stored.get(account) ?? "";
          return result(value ? 0 : 44, value);
        }
        if (args[0] === "add-generic-password") {
          const passwordIndex = args.indexOf("-w");
          const value = args[passwordIndex + 1] ?? "";
          if (value) stored.set(account, value);
          return result(value ? 0 : 1);
        }
      }
      return result(1);
    },
  };
}

function result(code: number, stdout = "") {
  return {
    code,
    stdout: Buffer.from(stdout, "utf8"),
    stderr: Buffer.alloc(0),
  };
}
