import type { DeviceCapacityAdmission, DeviceCapacityBudget, DeviceCapacityRequest } from "@zhixing/core/resources";
import type { LogAppendReceipt, LogCapture, LogStatus, LogStorageFailure, LogFailureEvidence } from "@zhixing/core/logging";

export type StoreOperation = "initialize" | "append" | "maintain";
export type CapacityReply = Exclude<DeviceCapacityAdmission, { kind: "granted" }> | { kind: "granted"; budget: DeviceCapacityBudget };
export type StoreWorkerInput =
  | { kind: "call"; id: number; operation: StoreOperation; records?: readonly LogCapture[] }
  | { kind: "capacity"; id: number; result: CapacityReply }
  | { kind: "close" };
export type StoreWorkerOutput =
  | { kind: "result"; id: number; value: LogStatus | LogAppendReceipt }
  | { kind: "failure"; id: number; code: LogStorageFailure; evidence: LogFailureEvidence; indeterminate: boolean }
  | { kind: "acquire"; id: number; request: DeviceCapacityRequest }
  | { kind: "release"; id: number; used: DeviceCapacityBudget["quantum"] }
  | { kind: "cancel"; id: number };
