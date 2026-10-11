import { expect, it } from "vitest";
import { logFailureEvidence, failureSourceFrames, restoreFailureDiagnostic } from "@zhixing/core/logging";
import { toJsonRpcError } from "../handlers.js";
import { RpcClientError } from "../../client/rpc-client.js";
it("preserves bounded original evidence across JSON RPC without private error text",()=>{
  const original=Object.assign(Error("private path and input"),{name:"StorageMaintenanceAdmissionError",admission:{kind:"backpressured",blockedBy:"probe-unavailable"}});
  original.stack="Error: private\n    at file:///C:/private/packages/core/src/authority/log.js:17:4";
  const wire=JSON.parse(JSON.stringify(toJsonRpcError(new AggregateError([original, Error("other private")],"private wrapper"))));
  const client=new RpcClientError(wire.code,wire.message,wire.data);
  expect(logFailureEvidence(client)).toEqual({category:"resource-admission",code:"backpressured",operation:"probe-unavailable"});
  expect(failureSourceFrames(client)).toContain("core/authority/log.js:17:4");
  expect(JSON.stringify(wire)).not.toContain("private");
  expect(restoreFailureDiagnostic({failure:{category:"secret",code:"secret"},sourceFrames:[]})).toBeUndefined();
  expect(failureSourceFrames(restoreFailureDiagnostic({failure:{category:"Error"},sourceFrames:["core/../../secret.js:1:1"]}))).toEqual([]);
});
