import { runWithLogAttribution } from "@zhixing/core/logging";
import { MeshProtocolError } from "./errors.js";
import {
  assertSecureMeshConnection,
  type SecureMeshConnection,
} from "./session.js";

export type MeshServiceHandler = (
  payload: Uint8Array,
  connection: SecureMeshConnection,
  signal: AbortSignal,
) => Promise<Uint8Array>;

export type MeshServiceDefinition =
  | {
      readonly access: "read";
      readonly availability: "negotiated-version" | "version-independent";
      readonly authorize?: (connection: SecureMeshConnection) => boolean | Promise<boolean>;
      readonly handler: MeshServiceHandler;
    }
  | {
      readonly access: "write";
      readonly availability: "negotiated-version";
      readonly authorize?: (connection: SecureMeshConnection) => boolean | Promise<boolean>;
      readonly handler: MeshServiceHandler;
    };

type RegisteredMeshService = MeshServiceDefinition;

/** Registry starts empty; later business adapters must opt in explicitly. */
export class MeshServiceRegistry {
  private readonly services = new Map<string, RegisteredMeshService>();

  /**
   * foreground：本设备的前台活动。对端请求在本机处理期间（核验与处理）计为前台，后台维护在请求在途时让路，
   * 与 RPC 请求处理同一口径。
   */
  constructor(private readonly options: { readonly foreground?: { enter(): () => void } } = {}) {}

  register(serviceId: string, definition: MeshServiceDefinition): () => void {
    if (!/^[a-z][a-z0-9.-]{0,63}$/.test(serviceId)) {
      throw new TypeError(`Invalid mesh service id: ${serviceId}`);
    }
    if (
      (definition.access !== "read" && definition.access !== "write") ||
      (definition.availability !== "negotiated-version" &&
        definition.availability !== "version-independent") ||
      (definition.access === "write" &&
        definition.availability !== "negotiated-version") ||
      (definition.authorize !== undefined &&
        typeof definition.authorize !== "function") ||
      typeof definition.handler !== "function"
    ) {
      throw new TypeError("Mesh service definition is invalid");
    }
    if (this.services.has(serviceId)) {
      throw new TypeError(`Mesh service is already registered: ${serviceId}`);
    }
    const service = Object.freeze({
      access: definition.access,
      availability: definition.availability,
      ...(definition.authorize ? { authorize: definition.authorize } : {}),
      handler: definition.handler,
    }) as RegisteredMeshService;
    this.services.set(serviceId, service);
    return () => {
      if (this.services.get(serviceId) === service) this.services.delete(serviceId);
    };
  }

  list(): readonly string[] {
    return [...this.services.keys()].sort();
  }

  async dispatch(
    serviceId: string,
    payload: Uint8Array,
    connection: SecureMeshConnection,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    assertSecureMeshConnection(connection);
    const service = this.services.get(serviceId);
    if (!service) {
      throw new MeshProtocolError(
        "service-unavailable",
        `Mesh service is not registered: ${serviceId}`,
      );
    }
    const leave = this.options.foreground?.enter();
    try {
      // 授权可以是异步的精确核验：等到结果再放行，不把 Promise 当放行值
      if (service.authorize && !(await service.authorize(connection))) {
        throw new MeshProtocolError(
          "unauthorized-peer",
          `Mesh peer is not authorized for service: ${serviceId}`,
        );
      }
      if (
        connection.compatibility.mode === "read-only" &&
        service.availability !== "version-independent"
      ) {
        throw new MeshProtocolError(
          "incompatible-version",
          `Mesh service is unavailable during protocol-version skew: ${serviceId}`,
        );
      }
      // 经这次服务调用发起的存储工作按服务归属（已注册服务，标签集合有限；内层更具体的标签照旧覆盖）；只记录
      return await runWithLogAttribution(`mesh:${serviceId}`, () => service.handler(payload, connection, signal));
    } finally {
      leave?.();
    }
  }
}
