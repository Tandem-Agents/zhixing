import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PROFILES } from "../profile.js";

const read = (file: string) => readFile(new URL("../" + file, import.meta.url), "utf8");

describe("Host static construction graph", () => {
  it("connects all fourteen factories directly, before their consumers become reachable", async () => {
    const command = await read("command.ts");
    const calls = [
      "await prepareAuthorityServices({",
      "await createConversationServices({",
      "new RuntimeHost({",
      "await createLocalConversationOwner({",
      "await createExecutorJobOwner({",
      "await startAssetMaintenance({",
      "return prepareMeshRuntime({",
      "await bindAdvancementEvidenceTopology({",
      "await prepareChannel({",
      "await createHostLosslessDataPlane({",
      "conversationLosslessDataPlane.assertComplete()",
      "await startExecutorJobOwner({",
      "await recoverChannelInteractions({",
      "await prepareDelivery({",
      "await installConfirmationBridge({",
      "await startConversationRecovery({",
    ];
    let previous = -1;
    for (const call of calls) {
      expect(command.split(call), call).toHaveLength(2);
      const position = command.indexOf(call);
      expect(position, call).toBeGreaterThan(previous);
      previous = position;
    }
    expect(command).toContain("const localExecutor = executor ?");
    expect(command.indexOf("await localExecutor?.owner.start("))
      .toBeGreaterThan(command.indexOf("communicationHandle.bind(routedCommunication)"));
    expect(command.indexOf("await localExecutor?.owner.start("))
      .toBeGreaterThan(command.indexOf("meshRuntime?.bindConversationCommunication("));
    expect(command).toContain("executorJobOwnerAssembly: localExecutor.jobs");
    expect(command).toContain("conversationProtocol: conversationServices.conversationProtocol");
    expect(command).toContain("channelCoordinator: losslessDataPlane.coordinator");
    expect(command).toContain("meshRuntimePreparation: preparedMeshRuntime");
    expect(command).toContain("channelChallengeAction: losslessDataPlane.onChallengeAction");
    expect(command.indexOf("beforeActivate: async (openingRunner) =>"))
      .toBeLessThan(command.indexOf("await installConfirmationBridge({"));
    expect(command.indexOf("await startConversationRecovery({"))
      .toBeLessThan(command.indexOf("startupRollback.commit()"));
  });

  it("uses finite readonly inputs and returns products rather than a writable service bus", async () => {
    const sources = await Promise.all(["command.ts", "access-surface.ts", "access-surfaces.ts"].map(read));
    for (const source of sources) {
      expect(source).not.toMatch(/\b(?:AssemblyContext|setupAssemblyUnits|createAssemblyUnits|OrderedAssemblyUnit)\b/u);
    }
    const factories = sources[2]!;
    expect(factories).not.toMatch(/\bctx\b/u);
    const inputs = [...factories.matchAll(/export interface \w+Input \{([\s\S]*?)\n\}/gu)];
    expect(inputs).toHaveLength(14);
    for (const [, body] of inputs) {
      for (const line of body!.split("\n").filter((line) => /^  \w/u.test(line))) {
        expect(line).toMatch(/^  readonly /u);
      }
    }
    expect(factories).toContain("return Object.freeze({");
    expect(factories).not.toMatch(/\binput\.\w+\s*(?:=(?!=)|\?\?=)/u);
  });

  it("lets the profile select adapters, never the core or recovery obligations", () => {
    expect(PROFILES.full.surfaces).toEqual([
      "mesh-control", "channel", "delivery", "confirmation-bridge",
    ]);
  });
});
