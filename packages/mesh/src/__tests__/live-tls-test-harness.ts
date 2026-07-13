import { X509Certificate } from "node:crypto";
import { once } from "node:events";
import {
  connect as connectTls,
  createServer as createTlsServer,
  type ConnectionOptions,
  type SecureContextOptions,
  type Server as TlsServer,
  type ServerOptions as TlsServerOptions,
  type TLSSocket,
} from "node:tls";
import type {
  DeviceKey,
  DeviceTlsCredential,
  DeviceTlsCredentialOptions,
} from "../device-identity.js";
import {
  connectAuthenticatedMesh,
  createAuthenticatedMeshServer,
  type MeshClientConnectionOptions,
  type MeshDeviceIdentity,
  type MeshServerOptions,
} from "../handshake.js";
import type { SecureMeshConnection } from "../transport.js";

const MINIMUM_REMAINING_VALIDITY_MS = 60_000;
const credentialKind = Symbol("live TLS test credential");

export type CurrentLiveTlsCredential = DeviceTlsCredential & {
  readonly [credentialKind]: "current";
};

export type ExpiredLiveTlsCredential = DeviceTlsCredential & {
  readonly [credentialKind]: "expired";
};

export interface UnboundAuthenticatedMeshServer {
  readonly listening: false;
  readonly secureContextUpdates: readonly SecureContextOptions[];
  close(): void;
}

type LiveServerOptions = Omit<MeshServerOptions, "identity" | "now"> & {
  readonly identity: MeshDeviceIdentity;
};

type LiveClientOptions = Omit<MeshClientConnectionOptions, "identity" | "now"> & {
  readonly identity: MeshDeviceIdentity;
};

type RawServerOptions = Omit<
  TlsServerOptions,
  "key" | "cert" | "pfx" | "secureContext" | "passphrase"
>;
type RawClientOptions = Omit<
  ConnectionOptions,
  "key" | "cert" | "pfx" | "secureContext" | "passphrase"
>;

export interface LiveTlsTestHarness {
  readonly timestamp: number;
  readonly now: () => number;
  identity(identity: MeshDeviceIdentity): MeshDeviceIdentity;
  issueCredential(
    key: DeviceKey,
    options?: DeviceTlsCredentialOptions,
  ): Promise<CurrentLiveTlsCredential>;
  acceptExpiredCredential(credential: DeviceTlsCredential): ExpiredLiveTlsCredential;
  createAuthenticatedServer(
    options: LiveServerOptions,
    onConnection: (connection: SecureMeshConnection) => void | Promise<void>,
  ): Promise<TlsServer>;
  openAuthenticatedConnection(options: LiveClientOptions): Promise<SecureMeshConnection>;
  createUnboundAuthenticatedServer(
    options: MeshServerOptions,
    onConnection: (connection: SecureMeshConnection) => void | Promise<void>,
  ): Promise<UnboundAuthenticatedMeshServer>;
  createRawServer(
    credential: CurrentLiveTlsCredential,
    options: RawServerOptions,
    listener?: (socket: TLSSocket) => void,
  ): TlsServer;
  openRawConnection(
    credential: CurrentLiveTlsCredential | ExpiredLiveTlsCredential,
    options: RawClientOptions,
  ): Promise<TLSSocket>;
  openUnauthenticatedConnection(options: RawClientOptions): Promise<TLSSocket>;
}

export function createLiveTlsTestHarness(): LiveTlsTestHarness {
  const timestamp = Date.now();
  const now = () => timestamp;
  const currentCredentials = new WeakSet<DeviceTlsCredential>();
  const expiredCredentials = new WeakSet<DeviceTlsCredential>();

  function credentialWindow(credential: DeviceTlsCredential): {
    readonly validFrom: number;
    readonly validTo: number;
  } {
    const certificate = new X509Certificate(credential.certificateChainPem);
    const validFrom = Date.parse(certificate.validFrom);
    const validTo = Date.parse(certificate.validTo);
    if (!Number.isFinite(validFrom) || !Number.isFinite(validTo)) {
      throw new TypeError("Live TLS test credential has an invalid certificate window");
    }
    return { validFrom, validTo };
  }

  function acceptCurrentCredential(
    credential: DeviceTlsCredential,
  ): CurrentLiveTlsCredential {
    const { validFrom, validTo } = credentialWindow(credential);
    if (
      validFrom > timestamp ||
      validTo - timestamp < MINIMUM_REMAINING_VALIDITY_MS
    ) {
      throw new TypeError(
        "Live TLS test credentials must cover the captured system clock with a safety margin",
      );
    }
    currentCredentials.add(credential);
    return credential as CurrentLiveTlsCredential;
  }

  function acceptExpiredCredential(
    credential: DeviceTlsCredential,
  ): ExpiredLiveTlsCredential {
    const { validTo } = credentialWindow(credential);
    if (validTo > timestamp) {
      throw new TypeError(
        "Expired TLS test credentials must expire relative to the captured system clock",
      );
    }
    expiredCredentials.add(credential);
    return credential as ExpiredLiveTlsCredential;
  }

  function identity(source: MeshDeviceIdentity): MeshDeviceIdentity {
    return Object.freeze({
      deviceId: source.deviceId,
      issueTlsCredential: async (options?: DeviceTlsCredentialOptions) =>
        acceptCurrentCredential(await source.issueTlsCredential(options)),
    });
  }

  async function issueCredential(
    key: DeviceKey,
    options: DeviceTlsCredentialOptions = {},
  ): Promise<CurrentLiveTlsCredential> {
    return acceptCurrentCredential(
      await key.issueTlsCredential({
        ...options,
        now: options.now ?? now,
      }),
    );
  }

  async function createAuthenticatedServer(
    options: LiveServerOptions,
    onConnection: (connection: SecureMeshConnection) => void | Promise<void>,
  ): Promise<TlsServer> {
    return await createAuthenticatedMeshServer(
      {
        ...options,
        identity: identity(options.identity),
        now,
      },
      onConnection,
    );
  }

  async function openAuthenticatedConnection(
    options: LiveClientOptions,
  ): Promise<SecureMeshConnection> {
    return await connectAuthenticatedMesh({
      ...options,
      identity: identity(options.identity),
      now,
    });
  }

  async function createUnboundAuthenticatedServer(
    options: MeshServerOptions,
    onConnection: (connection: SecureMeshConnection) => void | Promise<void>,
  ): Promise<UnboundAuthenticatedMeshServer> {
    const server = await createAuthenticatedMeshServer(options, onConnection);
    if (server.listening) {
      server.close();
      throw new TypeError("Logical-clock mesh server tests must not open a listener");
    }
    const secureContextUpdates: SecureContextOptions[] = [];
    const setSecureContext = server.setSecureContext.bind(server);
    server.setSecureContext = (options: SecureContextOptions) => {
      secureContextUpdates.push(options);
      setSecureContext(options);
    };
    return Object.freeze({
      listening: false,
      get secureContextUpdates() {
        return Object.freeze([...secureContextUpdates]);
      },
      close: () => {
        server.emit("close");
      },
    });
  }

  function createRawServer(
    credential: CurrentLiveTlsCredential,
    options: RawServerOptions,
    listener?: (socket: TLSSocket) => void,
  ): TlsServer {
    if (!currentCredentials.has(credential)) {
      throw new TypeError("Raw TLS servers require a current harness-issued credential");
    }
    assertNoCredentialMaterial(options);
    return createTlsServer(
      {
        ...options,
        key: credential.privateKeyPem,
        cert: credential.certificateChainPem,
      },
      listener,
    );
  }

  async function openRawConnection(
    credential: CurrentLiveTlsCredential | ExpiredLiveTlsCredential,
    options: RawClientOptions,
  ): Promise<TLSSocket> {
    if (!currentCredentials.has(credential) && !expiredCredentials.has(credential)) {
      throw new TypeError("Raw TLS clients require a harness-validated credential");
    }
    assertNoCredentialMaterial(options);
    return await waitForSecureConnection(
      connectTls({
        ...options,
        key: credential.privateKeyPem,
        cert: credential.certificateChainPem,
      }),
    );
  }

  async function openUnauthenticatedConnection(
    options: RawClientOptions,
  ): Promise<TLSSocket> {
    assertNoCredentialMaterial(options);
    return await waitForSecureConnection(connectTls(options));
  }

  return Object.freeze({
    timestamp,
    now,
    identity,
    issueCredential,
    acceptExpiredCredential,
    createAuthenticatedServer,
    openAuthenticatedConnection,
    createUnboundAuthenticatedServer,
    createRawServer,
    openRawConnection,
    openUnauthenticatedConnection,
  });
}

function assertNoCredentialMaterial(options: object): void {
  for (const field of ["key", "cert", "pfx", "secureContext", "passphrase"]) {
    if (field in options) {
      throw new TypeError(`Raw TLS credential material must be supplied by the test harness`);
    }
  }
}

async function waitForSecureConnection(socket: TLSSocket): Promise<TLSSocket> {
  await Promise.race([
    once(socket, "secureConnect"),
    once(socket, "error").then(([error]) => Promise.reject(error)),
  ]);
  return socket;
}
