import type { LogPage, LogStatus } from "@zhixing/core/logging";
import {
  parseLogPolicyRequest,
  parseLogReadRequest,
  parseLogSearchRequest,
  type LogPolicyRequest,
  type LogReadRequest,
  type LogSearchRequest,
} from "@zhixing/core/logging/application";

/** Transport binding only: authorization and all query/policy semantics stay in LogApplication. */
export class LogRpcClient {
  constructor(
    private readonly link: {
      getClient(): Promise<{
        request<T>(method: string, params?: unknown): Promise<T>;
      }>;
    },
  ) {}
  async search(request: LogSearchRequest = {}): Promise<LogPage> {
    return (await this.link.getClient()).request(
      "logs.search",
      parseLogSearchRequest(request),
    );
  }
  async read(
    request: LogReadRequest,
  ): Promise<LogPage & { readonly detail?: unknown }> {
    return (await this.link.getClient()).request(
      "logs.read",
      parseLogReadRequest(request),
    );
  }
  async status(): Promise<LogStatus> {
    return (await this.link.getClient()).request("logs.status");
  }
  async applyPolicy(request: LogPolicyRequest): Promise<LogStatus> {
    return (await this.link.getClient()).request(
      "logs.apply-policy",
      parseLogPolicyRequest(request),
    );
  }
}
