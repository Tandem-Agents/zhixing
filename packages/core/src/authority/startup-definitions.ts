/** Domain-owned fixed definitions for the composition root. Importing these
 * ports creates no runtime, worker, model, tool connection or business state. */
export { registerDeviceLifecycleProjection } from "./device-lifecycle-journal.js";
export { registerSkillAuthorityProjection } from "../skills/global-state-adapter.js";
export { registerWorksceneAuthorityProjection } from "../workscene/authority-registry.js";
export { registerRubricAuthorityProjection } from "../rubrics/global-state-adapter.js";
export { registerWorksceneActivityProjection } from "../workscene/activity-projection.js";
export { registerWorkspaceBindingProjection } from "../environment/workspace-bindings.js";
export { registerWorkspaceProbeProjection } from "../environment/workspace-probe.js";
export { registerDeliveryAuthorityProjection } from "../delivery/authority-index.js";
export {
  RESOURCE_CAPABILITY_ACTIVATION_PROJECTION_ID,
  RESOURCE_GOVERNOR_INDEX_PROJECTION_ID,
  registerResourceCapabilityActivations,
  registerResourceGovernorIndex,
} from "./resource-governor-index.js";
