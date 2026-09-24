import { observationRefs, type BindLogSource } from "@zhixing/core/logging";
import { HANDOFF_LOG_SOURCE, type MeshRequestChannelOptions } from "@zhixing/mesh/request-channel";

/** These service messages carry explicit existing business identities; bodies are never recorded. */
export function handoffLogging(bind?: BindLogSource): MeshRequestChannelOptions | undefined {
  if (!bind) return undefined;
  return {
    records: bind(HANDOFF_LOG_SOURCE, { scope: "storage" }),
    observationRefs: (service, bytes) => {
      if (!/^(assignment\.|resource\.usage$|anchor\.transfer|disaster\.|conversation\.transfer)/u.test(service) || bytes.byteLength > 65536) return [];
      const input = JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>;
      return [...observationRefs(input), ...observationRefs(input.context), ...observationRefs(input.envelope), ...observationRefs(input.work), ...observationRefs(input.claim), ...observationRefs(input.record)].slice(0, 8);
    },
  };
}
