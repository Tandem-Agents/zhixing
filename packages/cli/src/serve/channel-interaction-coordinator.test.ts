import { describe, expect, it, vi } from "vitest";
import type { ChannelChallengeAction } from "@zhixing/core";
import type { DataPlaneTicket } from "@zhixing/core/contracts";
import { channelSurfacePrincipal } from "@zhixing/owner-kernel";
import {
  ChannelInteractionCoordinator,
  JobRelayObligationDirectory,
  type JobRelayOpening,
} from "./channel-interaction-coordinator.js";
import type { JobOwnerRelay } from "./job-owner-relay.js";
import { JobStatusDirectory } from "./job-status-directory.js";

const jobToken = {
  challengeId: "challenge-1",
  ref: {
    execution: "job" as const,
    taskId: "task-1",
    jobRunId: "job-run-1",
    anchorEpoch: 1,
  },
  assignmentId: "asg-job-1",
  interactionRequestId: "interaction-1",
  route: { channelId: "feishu", to: "ou_user" },
  displayDigest: `sha256:${"a".repeat(64)}`,
  issuedAt: "2026-07-28T00:00:00.000Z",
  expiry: "2026-07-28T01:00:00.000Z",
  signature: { alg: "ed25519", keyId: "device:owner", sig: "sig" },
};

const conversationToken = {
  ...jobToken,
  challengeId: "challenge-conv",
  assignmentId: "asg-conv-1",
  ref: {
    execution: "conversation" as const,
    conversationId: "conv-1",
    runId: "run-1",
    ownerEpoch: 1,
  },
};

function action(token: typeof jobToken | typeof conversationToken): ChannelChallengeAction {
  return {
    token: token as ChannelChallengeAction["token"],
    responder: { channelId: "feishu", platformSubject: "ou_user" },
    decision: { allowed: true },
  };
}

function fakeRelay(): JobOwnerRelay & {
  readonly callbacks: unknown[];
} {
  const callbacks: unknown[] = [];
  return {
    callbacks,
    checkpoint: vi.fn(),
    poll: vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { path: "direct", accepted: 0, checkpoint: {} };
    }),
    materializeInteractionDisplay: vi.fn(),
    resolveCallback: vi.fn(async (input: unknown) => {
      callbacks.push(input);
      return {} as never;
    }),
    rotateControlLease: vi.fn(),
    close: vi.fn(async () => undefined),
  } as unknown as JobOwnerRelay & { readonly callbacks: unknown[] };
}

function opening(
  relayJournal: Partial<JobRelayOpening["journal"]> = {},
): JobRelayOpening {
  return {
    assignmentId: "asg-job-1",
    sourceRevision: "dispatch-digest-1",
    ref: jobToken.ref,
    executorId: "exec-1",
    controlLeaseId: "lease-1",
    journal: {
      pendingChannelChallenges: vi.fn(async () => []),
      recordChannelChallengeDelivered: vi.fn(),
      closeChannelChallenge: vi.fn(),
      channelRelayCheckpoint: vi.fn(),
      adoptChannelRelayFrame: vi.fn(),
      prepareChannelRelayRequest: vi.fn(),
      grantChannelChallenge: vi.fn(),
      statusHistory: vi.fn(async () => []),
      onStatus: vi.fn(() => () => undefined),
      ...relayJournal,
    } as unknown as JobRelayOpening["journal"],
    answers: {
      deliverGrant: vi.fn(async () => undefined),
      resolveNoInteractiveSurface: vi.fn(async () => undefined),
    },
  };
}

function coordinator(overrides?: {
  readonly relay?: ReturnType<typeof fakeRelay>;
  readonly listOpenJobRelays?: () => Promise<readonly JobRelayOpening[]>;
}) {
  const relay = overrides?.relay ?? fakeRelay();
  const openConversationChannel = vi.fn(async () => ({
    close: vi.fn(async () => undefined),
  }));
  const handleChallengeAction = vi.fn(async () => undefined);
  const createJobOwnerRelay = vi.fn(async () => relay);
  const instance = new ChannelInteractionCoordinator({
    dataPlane: {
      openConversationChannel,
      createJobOwnerRelay,
      handleChallengeAction,
    } as never,
    channels: () => undefined,
    jobRelays: (() => {
      const directory = new JobRelayObligationDirectory();
      if (overrides?.listOpenJobRelays) {
        const original = overrides.listOpenJobRelays;
        vi.spyOn(directory, "listOpen").mockImplementation(original);
      }
      return directory;
    })(),
    jobStatus: new JobStatusDirectory(),
  });
  return {
    instance,
    relay,
    openConversationChannel,
    handleChallengeAction,
    createJobOwnerRelay,
  };
}

describe("ChannelInteractionCoordinator", () => {
  it("adopts a conversation obligation idempotently per assignment", async () => {
    const { instance, openConversationChannel } = coordinator();
    const input = {
      executorId: "exec-1",
      assignmentId: "asg-conv-1",
      ref: conversationToken.ref,
      ticket: {} as never,
      journal: {} as never,
    };
    const first = await instance.openConversationChannel(input);
    const second = await instance.openConversationChannel(input);
    expect(second).toBe(first);
    expect(openConversationChannel).toHaveBeenCalledTimes(1);

    await first.close();
    await instance.openConversationChannel(input);
    expect(openConversationChannel).toHaveBeenCalledTimes(2);
    await instance.close();
  });

  it("rebuilds conversation channel openings only from durable challenges and tickets", async () => {
    const { instance, openConversationChannel } = coordinator();
    const responder = {
      channelId: "fixed",
      platformSubject: "user-1",
    };
    const ticket = {
      ticketId: "ticket-conversation-recovery",
      kind: "run-interact",
      assignmentId: conversationToken.assignmentId,
      executorId: "exec-1",
      surfacePrincipal: channelSurfacePrincipal(responder),
      ref: conversationToken.ref,
    } as DataPlaneTicket;
    const journal = {
      pendingChannelChallenges: vi.fn(async () => [
        {
          prepared: {
            assignmentId: conversationToken.assignmentId,
            ref: conversationToken.ref,
            responder,
          },
        },
      ]),
      dataPlaneTicketFacts: vi.fn(async () => ({
        issued: [ticket],
        revokedTicketIds: [],
      })),
    };

    await expect(
      instance.recoverConversationChannels(journal as never),
    ).resolves.toBe(1);
    expect(openConversationChannel).toHaveBeenCalledWith({
      executorId: ticket.executorId,
      assignmentId: ticket.assignmentId,
      ref: ticket.ref,
      ticket,
      journal,
    });
    await instance.close();
  });

  it("routes job callbacks to the durable grant chain and awaits the outcome", async () => {
    const { instance, relay } = coordinator();
    await instance.openJobRelay(opening());

    await instance.handleChallengeAction(action(jobToken));
    expect(relay.callbacks).toEqual([
      expect.objectContaining({
        token: expect.objectContaining({ challengeId: "challenge-1" }),
        decision: { allowed: true },
      }),
    ]);
    await instance.close();
  });

  it("rejects a job callback without an active obligation instead of dropping it", async () => {
    const { instance } = coordinator();
    await expect(
      instance.handleChallengeAction(action(jobToken)),
    ).rejects.toThrow(/active job obligation/u);
    await instance.close();
  });

  it("forwards conversation callbacks to the conversation session router", async () => {
    const { instance, handleChallengeAction } = coordinator();
    await instance.handleChallengeAction(action(conversationToken));
    expect(handleChallengeAction).toHaveBeenCalledTimes(1);
    await instance.close();
  });

  it("recovers open job obligations idempotently from the durable listing", async () => {
    const listed = opening();
    const { instance, createJobOwnerRelay } = coordinator({
      listOpenJobRelays: async () => [listed],
    });
    await instance.recover();
    await instance.recover();
    expect(createJobOwnerRelay).toHaveBeenCalledTimes(1);

    await instance.handleChallengeAction(action(jobToken));
    await instance.close();
  });

  it("pairs production registration, status ownership, and durable recovery", async () => {
    const directory = new JobRelayObligationDirectory();
    const status = new JobStatusDirectory();
    const relay = fakeRelay();
    const createJobOwnerRelay = vi.fn(async () => relay);
    const registered = opening({
      statusHistory: vi.fn(async () => [
        {
          ref: jobToken.ref,
          state: "running",
          statusRevision: 1,
          actions: [],
          at: "2026-07-28T00:00:00.000Z",
        },
      ] as never),
    });
    const instance = new ChannelInteractionCoordinator({
      dataPlane: {
        openConversationChannel: async () => ({
          close: async () => undefined,
        }),
        openFirstPartySurfaceSession: async () => {
          throw new Error("unused");
        },
        createJobOwnerRelay,
        handleChallengeAction: async () => undefined,
      } as never,
      channels: () => undefined,
      jobRelays: directory,
      jobStatus: status,
    });

    const session = await instance.registerJobRelay(registered);
    expect(() => directory.register(registered)).toThrowError(
      /already registered/u,
    );
    await expect(
      status.statusHistory([
        {
          taskId: jobToken.ref.taskId,
          jobRunId: jobToken.ref.jobRunId,
          afterStatusRevision: 0,
        },
      ]),
    ).resolves.toEqual(expect.objectContaining({
      notices: [expect.objectContaining({ statusRevision: 1 })],
    }));

    await session.close();
    expect(await directory.listOpen()).toEqual([]);
    await instance.close();
  });

  it("holds recovered executor work until its durable job owner is registered", async () => {
    const directory = new JobRelayObligationDirectory();
    const controller = new AbortController();
    const pending = directory.waitForSubmission("asg-job-1", controller.signal);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    const registered = opening();
    directory.register(registered);
    await expect(pending).resolves.toBe(registered.journal);
  });

  it("releases a pending submission wait when the executor owner closes", async () => {
    const directory = new JobRelayObligationDirectory();
    const controller = new AbortController();
    const pending = directory.waitForSubmission("asg-job-1", controller.signal);

    controller.abort(new Error("owner closed"));
    await expect(pending).rejects.toThrow(/owner closed/u);
  });

  it("closes every session and refuses further callbacks after close", async () => {
    const { instance, relay } = coordinator();
    await instance.openJobRelay(opening());
    await instance.close();
    expect(relay.close).toHaveBeenCalled();
    await expect(
      instance.handleChallengeAction(action(jobToken)),
    ).rejects.toThrow(/closed/u);
  });
});
