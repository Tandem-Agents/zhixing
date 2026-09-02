import {
  bindDeliveryLifecycleDecisionRecords,
  projectDeliveryApplicationProjection,
  projectDeliveryLifecycleRecords,
  type DeliveryAuthority,
  type DeliveryStatusProjectionPort,
} from "@zhixing/core/delivery";
import { AuthorityStorageError } from "@zhixing/core/authority";
import {
  DeliveryLifecycleApplicationService,
  DeliveryObligationApplicationService,
  DeliveryProjectionInvariantError,
  type DeliveryLifecycleApplication,
  type DeliveryLifecycleAdmissionDecisionContext,
  type DeliveryLifecycleAdmissionMutation,
  type DeliveryLifecycleCommit,
  type DeliveryLifecycleCorrectnessPort,
  type DeliveryLifecycleDecisionContext,
  type DeliveryLifecycleMutation,
  type DeliveryLifecycleProjectionPort,
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
        (projection, _inputs, _commitAt, lifecycleAdmission) =>
          decide({
            projection: projectDeliveryApplicationProjection(projection),
            lifecycleAdmission,
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

export interface OwnerDeliveryLifecycleBinding {
  readonly application: DeliveryLifecycleApplication;
  readonly projection: DeliveryLifecycleProjectionPort & DeliveryStatusProjectionPort;
}

/**
 * The only production adapter allowed to turn Authority serialization and
 * projection mechanisms into the Delivery lifecycle application boundary.
 */
export function createOwnerDeliveryLifecycleBinding(options: {
  readonly authority: DeliveryAuthority;
  readonly baseRetryDelayMs?: number;
}): OwnerDeliveryLifecycleBinding {
  const correctness: DeliveryLifecycleCorrectnessPort = Object.freeze({
    snapshot: () => options.authority.snapshot(),
    transact: <Value>(
      decide: (
        context: DeliveryLifecycleDecisionContext,
      ) => DeliveryLifecycleMutation<Value>,
    ) =>
      options.authority.transactDeliveryLifecycle<DeliveryLifecycleCommit<Value>>((context) => {
        try {
          const decision = decide({
            projection: projectDeliveryApplicationProjection(context.projection),
            transactionAt: context.transactionAt,
          });
          const records = bindDeliveryLifecycleDecisionRecords(
            context.projection,
            decision.records,
            context.currentAnchorEpoch,
          );
          const projected = projectDeliveryLifecycleRecords(
            context.projection,
            records,
            context.transactionAt,
          );
          return {
            records,
            value: {
              value: decision.value,
              projection: projectDeliveryApplicationProjection(projected),
            },
          };
        } catch (error) {
          if (error instanceof DeliveryProjectionInvariantError) {
            throw new AuthorityStorageError("commit-log-corrupt", error.message, {
              cause: error,
            });
          }
          throw error;
        }
      }),
    transactAdmission: <Value>(
      decide: (
        context: DeliveryLifecycleAdmissionDecisionContext,
      ) => DeliveryLifecycleAdmissionMutation<Value>,
    ) => options.authority.transactDeliveryAdmission<Value>((context) =>
      decide({
        projection: projectDeliveryApplicationProjection(context.projection),
        admission: context.admission,
      })),
  });
  const projection: OwnerDeliveryLifecycleBinding["projection"] = Object.freeze({
    list: () => options.authority.list(),
    snapshot: () => options.authority.snapshot(),
    statusNotice: (itemId: string, statusRevision: number) =>
      options.authority.statusNotice(itemId, statusRevision),
  });
  const application = new DeliveryLifecycleApplicationService(
    correctness,
    options.baseRetryDelayMs === undefined
      ? {}
      : { baseRetryDelayMs: options.baseRetryDelayMs },
  );
  return Object.freeze({ application, projection });
}
