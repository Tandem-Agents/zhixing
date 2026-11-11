import type { AuthorityCommitLog, ProjectionTransactionContext } from "@zhixing-ai/core/authority";
import { localConversationId } from "@zhixing-ai/core/conversation";
import { CONVERSATION_IDENTITY_PROJECTION_ID } from "@zhixing-ai/owner-kernel/control-admission";
import { CONVERSATION_TRANSFER_PROJECTION_ID } from "@zhixing-ai/owner-kernel/conversation-transfer";
import { describe, expect, it } from "vitest";
import { createConversationAuthorityVerifier } from "./conversation-authority-verifier.js";
import type { HomeAuthoritySources } from "./home-authority-sources.js";

// 共享当前权威谓词的本地分支：本机铸造、仍归本机的会话，只接纳本机以本地代次签发、且不带锚点任期的声明，
// 执行前在同一前缀复核。锚点分支的拒绝反例在 planned-anchor-transfer.test.ts。
// 投影以内存视图代替；判定与投影读取函数都是生产实现。

const DEVICE_ID = "device-local-a";
const LOCAL_OWNER_EPOCH = 7;
const CONVERSATION_ID = localConversationId(DEVICE_ID, "01K1ZZZZZZ0000000000000000");

function fixture(options: { readonly identityExists?: boolean } = {}) {
  const transfer = new Map<string, unknown>();
  const projection = (id: string) => ({
    get: async (key: string) => {
      if (id === CONVERSATION_TRANSFER_PROJECTION_ID) return transfer.get(key);
      if (id === CONVERSATION_IDENTITY_PROJECTION_ID) {
        return options.identityExists !== false && key.endsWith(CONVERSATION_ID)
          ? { conversationId: CONVERSATION_ID }
          : undefined;
      }
      return undefined;
    },
  });
  const context = { readProjection: projection } as unknown as ProjectionTransactionContext;
  const executorLog = {
    transactDurableProjection: async (
      id: string,
      run: (view: unknown, context: ProjectionTransactionContext) => Promise<{ readonly value: unknown }>,
    ) => ({ value: (await run(projection(id), context)).value }),
  } as unknown as AuthorityCommitLog;
  const verifier = createConversationAuthorityVerifier({
    // 本地分支在会话仍归本机时不触及家级信任来源。
    sources: {} as HomeAuthoritySources,
    deviceId: DEVICE_ID,
    localOwnerEpoch: LOCAL_OWNER_EPOCH,
    executorLog,
    standaloneAnchorEpoch: () => undefined,
  });
  return { verifier, transfer, context };
}

const claim = { conversationId: CONVERSATION_ID, ownerEpoch: LOCAL_OWNER_EPOCH, signerDeviceId: DEVICE_ID };

describe("conversation authority verifier local branch", () => {
  it("admits the local owner's own claim", async () => {
    await expect(fixture().verifier.verify(claim)).resolves.toBeUndefined();
  });

  it.each([
    ["another signer", { signerDeviceId: "device-remote-b" }],
    ["another owner epoch", { ownerEpoch: LOCAL_OWNER_EPOCH + 1 }],
    ["an anchor tenure", { anchorEpoch: 1 }],
  ])("rejects a local claim carrying %s", async (_name, change) => {
    await expect(fixture().verifier.verify({ ...claim, ...change }))
      .rejects.toThrow("Request does not belong to this local conversation authority");
  });

  it("rejects a local claim for a conversation the identity projection does not know", async () => {
    await expect(fixture({ identityExists: false }).verifier.verify(claim))
      .rejects.toThrow("Request does not belong to this local conversation authority");
  });

  it("rechecks local ownership at the execution prefix", async () => {
    const { verifier, transfer, context } = fixture();
    const commit = await verifier.prepare(claim);
    transfer.set(`conversation:${CONVERSATION_ID}`, {
      phase: "committed",
      identity: { sourceDeviceId: DEVICE_ID, sourceOwnerEpoch: LOCAL_OWNER_EPOCH },
    });
    await expect(commit(context)).rejects.toThrow("Local conversation authority changed before execution");
  });
});
