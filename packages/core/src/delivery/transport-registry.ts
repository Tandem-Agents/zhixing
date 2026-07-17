import type { DeliveryEndpointDto } from "../contracts/index.js";
import type {
  DeliveryEndpointTransport,
  DeliveryTransport,
} from "./types.js";
import {
  requireDeliveryEndpointTransport,
  requireDeliveryReadiness,
} from "./transport-contract.js";

/**
 * Capability registry for delivery endpoint kinds. Missing adapters are not
 * delivery failures: items remain queued until the capability becomes ready.
 */
export class DeliveryTransportRegistry implements DeliveryTransport {
  readonly #transports = new Map<DeliveryEndpointDto["kind"], DeliveryEndpointTransport>();

  register(transport: DeliveryEndpointTransport): () => void {
    requireDeliveryEndpointTransport(transport);
    if (this.#transports.has(transport.endpointKind)) {
      throw new Error(`Delivery transport already registered: ${transport.endpointKind}`);
    }
    this.#transports.set(transport.endpointKind, transport);
    return () => {
      if (this.#transports.get(transport.endpointKind) === transport) {
        this.#transports.delete(transport.endpointKind);
      }
    };
  }

  resolve(endpoint: DeliveryEndpointDto): DeliveryEndpointTransport | undefined {
    const transport = this.#transports.get(endpoint.kind);
    if (!transport) return undefined;
    requireDeliveryEndpointTransport(transport, endpoint.kind);
    return requireDeliveryReadiness(transport.isReady(endpoint)) ? transport : undefined;
  }
}
