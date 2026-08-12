import { Buffer } from "node:buffer";
import {
  canonicalize,
  validateExecutorRemovalReceipt,
  type DeviceLifecycleAbort,
  type ExecutorRemovalReceipt,
  type ProtocolSignatureVerifier,
} from "@zhixing/core/protocol";
import type { MeshServiceClient } from "@zhixing/mesh/request-channel";
import type { MeshServiceRegistry } from "@zhixing/mesh/service-registry";
import {
  CurrentIssuerDeviceRemovalAuthority,
  ExecutorRemovalTarget,
  type ExecutorRemovalPublicState,
} from "./device-removal.js";

export const DEVICE_REMOVAL_TARGET_SERVICE = "device.removal.target";
export const DEVICE_REMOVAL_ISSUER_SERVICE = "device.removal.issuer";

export class DeviceRemovalTargetMeshClient {
  constructor(private readonly client: MeshServiceClient) {}

  async accept(receipt: ExecutorRemovalReceipt): Promise<{
    readonly conversations: readonly string[];
    readonly hasAcceptedWork: boolean;
  }> {
    const result = await this.#request({ v: 1, op: "accept", receipt }, ["conversations", "hasAcceptedWork", "v"]);
    return {
      conversations: requiredStrings(result.conversations, "Removal conversations"),
      hasAcceptedWork: result.hasAcceptedWork === true,
    };
  }

  async decide(input: {
    readonly operationId: string;
    readonly mode: "transfer" | "destroy";
    readonly currentAnchorDeviceId: string;
  }): Promise<ExecutorRemovalPublicState> {
    const result = await this.#request({ v: 1, op: "decide", ...input }, ["state", "v"]);
    return validatePublicState(result.state);
  }

  async status(operationId: string): Promise<ExecutorRemovalPublicState | undefined> {
    const result = await this.#request({ v: 1, op: "status", operationId }, ["state", "v"]);
    return result.state === null ? undefined : validatePublicState(result.state);
  }

  async abort(operationId: string, abort: DeviceLifecycleAbort): Promise<ExecutorRemovalPublicState> {
    const result = await this.#request({ v: 1, op: "abort", operationId, abort }, ["state", "v"]);
    return validatePublicState(result.state);
  }

  async #request(value: Record<string, unknown>, keys: readonly string[]): Promise<Record<string, unknown>> {
    const response = await this.client.request(
      DEVICE_REMOVAL_TARGET_SERVICE,
      Buffer.from(canonicalize(value), "utf8"),
    );
    return decodeExactObject(response, "Device removal target response", keys);
  }
}

export class DeviceRemovalIssuerMeshClient {
  constructor(
    private readonly client: MeshServiceClient,
    private readonly verifier: ProtocolSignatureVerifier,
  ) {}

  async acceptSelf(input: {
    readonly requestId: string;
    readonly operationId: string;
  }): Promise<ExecutorRemovalReceipt> {
    const response = await this.client.request(
      DEVICE_REMOVAL_ISSUER_SERVICE,
      Buffer.from(canonicalize({ v: 1, op: "accept-self", ...input }), "utf8"),
    );
    return validateExecutorRemovalReceipt(
      decodeExactObject(response, "Device removal issuer response", ["receipt", "v"]).receipt,
      this.verifier,
    );
  }

  async ready(receipt: ExecutorRemovalReceipt): Promise<ExecutorRemovalReceipt> {
    const response = await this.client.request(
      DEVICE_REMOVAL_ISSUER_SERVICE,
      Buffer.from(canonicalize({ v: 1, op: "ready", receipt }), "utf8"),
    );
    return validateExecutorRemovalReceipt(
      decodeExactObject(response, "Device removal issuer response", ["receipt", "v"]).receipt,
      this.verifier,
    );
  }

  async cleanupReady(receipt: ExecutorRemovalReceipt): Promise<ExecutorRemovalReceipt> {
    const response = await this.client.request(
      DEVICE_REMOVAL_ISSUER_SERVICE,
      Buffer.from(canonicalize({ v: 1, op: "cleanup-ready", receipt }), "utf8"),
    );
    return validateExecutorRemovalReceipt(
      decodeExactObject(response, "Device removal issuer response", ["receipt", "v"]).receipt,
      this.verifier,
    );
  }

  async targetAborted(receipt: ExecutorRemovalReceipt): Promise<void> {
    const response = await this.client.request(
      DEVICE_REMOVAL_ISSUER_SERVICE,
      Buffer.from(canonicalize({ v: 1, op: "target-aborted", receipt }), "utf8"),
    );
    decodeExactObject(response, "Device removal issuer response", ["accepted", "v"]);
  }

  async terminal(operationId: string): Promise<ExecutorRemovalReceipt | undefined> {
    const response = await this.client.request(
      DEVICE_REMOVAL_ISSUER_SERVICE,
      Buffer.from(canonicalize({ v: 1, op: "terminal", operationId }), "utf8"),
    );
    const receipt = decodeExactObject(response, "Device removal issuer response", ["receipt", "v"]).receipt;
    return receipt === null ? undefined : validateExecutorRemovalReceipt(receipt, this.verifier);
  }
}

export function registerDeviceRemovalTargetMeshService(
  registry: MeshServiceRegistry,
  input: {
    readonly target: ExecutorRemovalTarget;
    readonly issuerFor: (deviceId: string) => DeviceRemovalIssuerMeshClient;
    readonly authorizeIssuer: (deviceId: string) => boolean;
  },
): () => void {
  return registry.register(DEVICE_REMOVAL_TARGET_SERVICE, {
    access: "write",
    availability: "negotiated-version",
    authorize: (connection) => input.authorizeIssuer(connection.peer.deviceId),
    handler: async (payload, connection) => {
      const command = decodeObject(payload, "Device removal target command");
      if (command.v !== 1) throw new TypeError("Device removal target command version is invalid");
      if (command.op === "accept") {
        assertExactCommand(command, ["op", "receipt", "v"], "Device removal target accept");
        const snapshot = await input.target.accept(command.receipt as ExecutorRemovalReceipt);
        return encode({ v: 1,
          conversations: snapshot.conversations.map((item) => item.displayName),
          hasAcceptedWork: Object.values(snapshot.acceptedWork).some((count) => count > 0),
        });
      }
      if (command.op === "decide") {
        assertExactCommand(
          command,
          ["currentAnchorDeviceId", "mode", "op", "operationId", "v"],
          "Device removal target decide",
        );
        const operationId = requiredString(command.operationId, "Removal operationId");
        const mode = command.mode === "transfer" || command.mode === "destroy"
          ? command.mode
          : (() => { throw new TypeError("Removal mode is invalid"); })();
        const currentAnchorDeviceId = requiredString(
          command.currentAnchorDeviceId,
          "Removal current anchor",
        );
        const decision = await input.target.decide({ operationId, mode, currentAnchorDeviceId });
        if (decision.kind === "preflight-changed") {
          return encode({ v: 1, state: await input.target.state(operationId) });
        }
        const issuer = input.issuerFor(connection.peer.deviceId);
        const cleanupReady = await input.target.finish(await issuer.ready(decision.receipt));
        if (!cleanupReady) throw new Error("Device removal did not produce cleanup-ready");
        await input.target.finish(await issuer.cleanupReady(cleanupReady));
        return encode({ v: 1, state: await input.target.state(operationId) });
      }
      if (command.op === "status") {
        assertExactCommand(command, ["op", "operationId", "v"], "Device removal target status");
        const operationId = requiredString(command.operationId, "Removal operationId");
        return encode({ v: 1, state: await input.target.state(operationId) ?? null });
      }
      if (command.op === "abort") {
        assertExactCommand(
          command,
          ["abort", "op", "operationId", "v"],
          "Device removal target abort",
        );
        const operationId = requiredString(command.operationId, "Removal operationId");
        const abort = command.abort as DeviceLifecycleAbort;
        if (abort.authorizedByDeviceId !== connection.peer.deviceId) {
          throw new TypeError("Removal abort peer does not match the issuer device");
        }
        const receipt = await input.target.abort(operationId, abort);
        const issuer = input.issuerFor(connection.peer.deviceId);
        if (receipt.phase === "aborted") {
          await issuer.targetAborted(receipt);
        } else if (receipt.phase === "revocation-ready") {
          const cleanupReady = await input.target.finish(await issuer.ready(receipt));
          if (cleanupReady) await input.target.finish(await issuer.cleanupReady(cleanupReady));
        } else {
          throw new Error("Device removal abort did not return a durable target winner");
        }
        return encode({ v: 1, state: await input.target.state(operationId) });
      }
      throw new TypeError("Device removal target command operation is invalid");
    },
  });
}

export function registerDeviceRemovalIssuerMeshService(
  registry: MeshServiceRegistry,
  input: {
    readonly authority: CurrentIssuerDeviceRemovalAuthority;
    readonly authorizeTarget: (deviceId: string) => boolean;
    readonly terminalOnly?: boolean;
  },
): () => void {
  return registry.register(DEVICE_REMOVAL_ISSUER_SERVICE, {
    access: "write",
    availability: "negotiated-version",
    authorize: (connection) => input.authorizeTarget(connection.peer.deviceId),
    handler: async (payload, connection) => {
      const command = decodeObject(payload, "Device removal issuer command");
      if (command.v !== 1) throw new TypeError("Device removal issuer command version is invalid");
      if (
        input.terminalOnly === true &&
        command.op !== "ready" &&
        command.op !== "cleanup-ready" &&
        command.op !== "target-aborted" &&
        command.op !== "terminal"
      ) {
        throw new TypeError("Historical device removal transport only accepts terminal effects");
      }
      if (command.op === "accept-self") {
        assertExactCommand(
          command,
          ["op", "operationId", "requestId", "v"],
          "Device removal issuer accept",
        );
        const requestId = requiredString(command.requestId, "Removal requestId");
        const operationId = requiredString(command.operationId, "Removal operationId");
        const receipt = await input.authority.acceptForDevice({
          requestId,
          operationId,
          targetDeviceId: connection.peer.deviceId,
        });
        return encode({ v: 1, receipt });
      }
      if (command.op === "ready") {
        assertExactCommand(command, ["op", "receipt", "v"], "Device removal issuer ready");
        const receipt = command.receipt as ExecutorRemovalReceipt;
        if (receipt.targetDeviceId !== connection.peer.deviceId) {
          throw new TypeError("Removal ready peer does not match the target device");
        }
        return encode({ v: 1, receipt: await input.authority.commitReady(receipt) });
      }
      if (command.op === "cleanup-ready") {
        assertExactCommand(
          command,
          ["op", "receipt", "v"],
          "Device removal issuer cleanup-ready",
        );
        const receipt = command.receipt as ExecutorRemovalReceipt;
        if (receipt.targetDeviceId !== connection.peer.deviceId) {
          throw new TypeError("Removal cleanup-ready peer does not match the target device");
        }
        return encode({ v: 1, receipt: await input.authority.commitCleanupReady(receipt) });
      }
      if (command.op === "target-aborted") {
        assertExactCommand(
          command,
          ["op", "receipt", "v"],
          "Device removal issuer target-aborted",
        );
        const receipt = command.receipt as ExecutorRemovalReceipt;
        if (receipt.targetDeviceId !== connection.peer.deviceId) {
          throw new TypeError("Removal aborted peer does not match the target device");
        }
        await input.authority.acceptTargetAborted(receipt);
        return encode({ v: 1, accepted: true });
      }
      if (command.op === "terminal") {
        assertExactCommand(
          command,
          ["op", "operationId", "v"],
          "Device removal issuer terminal",
        );
        const operationId = requiredString(command.operationId, "Removal operationId");
        const operation = await input.authority.operation(operationId);
        if (!operation || operation.targetDeviceId !== connection.peer.deviceId) {
          throw new TypeError("Removal terminal peer does not match the accepted target device");
        }
        return encode({ v: 1, receipt: await input.authority.terminal(operationId) ?? null });
      }
      throw new TypeError("Device removal issuer command operation is invalid");
    },
  });
}

function encode(input: unknown): Uint8Array {
  return Buffer.from(canonicalize(input), "utf8");
}

function decodeObject(input: Uint8Array, label: string): Record<string, unknown> {
  try {
    const value = JSON.parse(Buffer.from(input).toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
  } catch (error) {
    throw new TypeError(`${label} is invalid`, { cause: error });
  }
}

function decodeExactObject(
  input: Uint8Array,
  label: string,
  keys: readonly string[],
): Record<string, unknown> {
  const value = decodeObject(input, label);
  if (
    value.v !== 1 ||
    canonicalize(Object.keys(value).sort()) !== canonicalize([...keys].sort())
  ) {
    throw new TypeError(`${label} shape is invalid`);
  }
  return value;
}

function assertExactCommand(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  if (canonicalize(Object.keys(value).sort()) !== canonicalize([...keys].sort())) {
    throw new TypeError(`${label} shape is invalid`);
  }
}

function requiredString(input: unknown, label: string): string {
  if (typeof input !== "string" || input.length === 0 || input.length > 480) {
    throw new TypeError(`${label} is invalid`);
  }
  return input;
}

function requiredStrings(input: unknown, label: string): readonly string[] {
  if (!Array.isArray(input)) throw new TypeError(`${label} must be an array`);
  return input.map((value, index) => requiredString(value, `${label} ${index}`));
}

function validatePublicState(input: unknown): ExecutorRemovalPublicState {
  const value = input as Partial<ExecutorRemovalPublicState> | null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Device removal public state is invalid");
  }
  if (canonicalize(Object.keys(value).sort()) !== canonicalize([
    "conversations",
    "credentialActions",
    "localData",
    "phase",
  ])) {
    throw new TypeError("Device removal public state shape is invalid");
  }
  if (!new Set([
    "waiting-for-device",
    "needs-conversation-decision",
    "moving-conversations",
    "revoking-access",
    "cleaning-device",
    "removed",
    "cancelled",
  ]).has(value.phase as string)) {
    throw new TypeError("Device removal public phase is invalid");
  }
  if (!new Set(["known", "unknown", "removed"]).has(value.localData as string)) {
    throw new TypeError("Device removal local data state is invalid");
  }
  return Object.freeze({
    phase: value.phase!,
    localData: value.localData!,
    conversations: requiredStrings(value.conversations, "Removal conversations"),
    credentialActions: requiredStrings(value.credentialActions, "Removal credential actions"),
  });
}
