import type { DeliveryAuthority } from "@zhixing/core/delivery";
import {
  DeliveryObligationApplicationService,
  type DeliveryObligationCorrectnessPort,
} from "@zhixing/core/delivery/application";
import { OwnerDeliveryParticipant } from "./delivery-participant.js";

/** Delivery projection/fence adapter; it contains no producer mapping or enqueue rule. */
export function createDeliveryObligationCorrectnessPort(
  authority: DeliveryAuthority,
): DeliveryObligationCorrectnessPort {
  const port: DeliveryObligationCorrectnessPort = {
    coordinate: <Result>(operation: () => Promise<Result>) =>
      authority.coordinate(operation),
    prepare: (inputs, commitAt, decide) =>
      authority.prepareEnqueues(
        inputs,
        commitAt,
        (projection, _inputs, _commitAt, bindings) =>
          decide({
            projection,
            lifecycleBindings: bindings,
          }),
      ),
  };
  return Object.freeze(port);
}

/** Composition boundary shared by production setup and direct producer tests. */
export function createOwnerDeliveryParticipant(options: {
  readonly authority: DeliveryAuthority;
  readonly maxAttempts?: number;
}): OwnerDeliveryParticipant {
  const application = new DeliveryObligationApplicationService(
    createDeliveryObligationCorrectnessPort(options.authority),
    options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts },
  );
  return new OwnerDeliveryParticipant({ application });
}
