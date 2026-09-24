import { LogRequestError } from "./errors.js";
import {
  bindProductApiOperation,
  defineProductApiCommand,
  defineProductApiContribution,
  defineProductApiExactSet,
  defineProductApiQuery,
} from "../product-api/catalog.js";
import type { LogApplication } from "./application.js";
import type {
  LogFilter,
  LogPage,
  LogPolicy,
  LogReadContext,
  LogStatus,
} from "./contracts.js";
import { DEFAULT_LOG_POLICY } from "./policy.js";

export interface LogSearchRequest {
  readonly filter?: LogFilter;
  readonly cursor?: string;
}
export interface LogReadRequest {
  readonly address: string;
  readonly view?: "overview" | "timeline" | "detail";
  readonly cursor?: string;
}
export interface LogPolicyRequest {
  readonly patch: Partial<LogPolicy>;
  readonly expectedVersion: number;
}
/** Host-issued capability. Neither transport nor model input can supply this function. */
export interface LogInvocation<Request> {
  readonly context: () => LogReadContext;
  readonly request: Request;
}
export interface LogApplicationHost {
  use<T>(
    context: () => LogReadContext,
    action: (application: LogApplication) => Promise<T>,
  ): Promise<T>;
}
export const LOG_SEARCH = defineProductApiQuery<
  "logs.search",
  LogInvocation<LogSearchRequest>,
  LogPage
>("logs.search");
export const LOG_READ = defineProductApiQuery<
  "logs.read",
  LogInvocation<LogReadRequest>,
  LogPage & { readonly detail?: unknown }
>("logs.read");
export const LOG_STATUS = defineProductApiQuery<
  "logs.status",
  LogInvocation<undefined>,
  LogStatus
>("logs.status");
export const LOG_APPLY_POLICY = defineProductApiCommand<
  "logs.apply-policy",
  LogInvocation<LogPolicyRequest>,
  LogStatus,
  never
>("logs.apply-policy", []);
export const LOG_PRODUCT_API_EXACT_SET = defineProductApiExactSet({
  operations: [LOG_SEARCH, LOG_READ, LOG_STATUS, LOG_APPLY_POLICY],
  factEvents: [],
});

export function createLogProductApiContribution(host: LogApplicationHost) {
  return defineProductApiContribution({
    factEvents: [],
    operations: [
      bindProductApiOperation(LOG_SEARCH, async ({ context, request }) => {
        const parsed = parseLogSearchRequest(request);
        return {
          facts: [],
          result: await host.use(context, (app) =>
            app.search(parsed.filter, parsed.cursor),
          ),
        };
      }),
      bindProductApiOperation(LOG_READ, async ({ context, request }) => {
        const parsed = parseLogReadRequest(request);
        return {
          facts: [],
          result: await host.use(context, (app) =>
            app.read(parsed.address, parsed.view, parsed.cursor),
          ),
        };
      }),
      bindProductApiOperation(LOG_STATUS, async ({ context }) => ({
        facts: [],
        result: await host.use(context, (app) => app.status()),
      })),
      bindProductApiOperation(
        LOG_APPLY_POLICY,
        async ({ context, request }) => {
          const parsed = parseLogPolicyRequest(request);
          return {
            facts: [],
            result: await host.use(context, async (app) => {
              const { policy } = await app.status();
              return app.applyPolicy(
                { ...(policy.desired ?? policy.effective), ...parsed.patch },
                parsed.expectedVersion,
              );
            }),
          };
        },
      ),
    ],
  });
}

export function parseLogSearchRequest(input: unknown): LogSearchRequest {
  const value = object(input ?? {}, ["filter", "cursor"]);
  const filter = object(value.filter ?? {}, [
    "afterSequence",
    "from",
    "until",
    "source",
    "level",
    "ref",
    "id",
  ]);
  const ref =
    filter.ref === undefined
      ? undefined
      : object(filter.ref, ["kind", "id", "storeId"]);
  for (const key of ["from", "until", "afterSequence"] as const)
    if (
      filter[key] !== undefined &&
      (!Number.isSafeInteger(filter[key]) || (filter[key] as number) < 0)
    )
      throw new LogRequestError("日志时间应为毫秒时间戳");
  for (const key of ["source", "id"] as const)
    if (filter[key] !== undefined) boundedText(filter[key], 128);
  if (
    filter.level !== undefined &&
    !["debug", "info", "warn", "error"].includes(filter.level as string)
  )
    throw new LogRequestError("日志级别无效");
  if (ref) {
    boundedText(ref.kind, 128);
    boundedText(ref.id, 128);
    if (ref.storeId !== undefined) boundedText(ref.storeId, 128);
  }
  return {
    filter: structuredClone(filter) as LogFilter,
    ...(value.cursor === undefined
      ? {}
      : { cursor: boundedText(value.cursor, 8192) }),
  };
}
export function parseLogReadRequest(input: unknown): LogReadRequest {
  const value = object(input, ["address", "view", "cursor"]);
  if (
    value.view !== undefined &&
    !["overview", "timeline", "detail"].includes(value.view as string)
  )
    throw new LogRequestError("日志视图无效");
  return {
    address: boundedText(value.address, 512),
    ...(value.view === undefined
      ? {}
      : { view: value.view as LogReadRequest["view"] }),
    ...(value.cursor === undefined
      ? {}
      : { cursor: boundedText(value.cursor, 8192) }),
  };
}
export function parseLogPolicyRequest(input: unknown): LogPolicyRequest {
  const value = object(input, ["patch", "expectedVersion"]);
  const patch = object(value.patch, Object.keys(DEFAULT_LOG_POLICY));
  if (
    !Object.keys(patch).length ||
    Object.values(patch).some(
      (value) => !Number.isSafeInteger(value) || (value as number) <= 0,
    )
  )
    throw new LogRequestError("日志策略需包含有效的正整数限额");
  if (
    !Number.isSafeInteger(value.expectedVersion) ||
    (value.expectedVersion as number) < 1
  )
    throw new LogRequestError("修改日志策略需要当前版本");
  return {
    patch: { ...patch } as Partial<LogPolicy>,
    expectedVersion: value.expectedVersion as number,
  };
}
function object(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(input))
  )
    throw new LogRequestError("日志请求应为普通对象");
  if (
    Reflect.ownKeys(input).some(
      (key) =>
        typeof key !== "string" ||
        !keys.includes(key) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key)!, "value"),
    )
  )
    throw new LogRequestError("日志请求不接受额外字段或自报权限");
  return input as Record<string, unknown>;
}
function boundedText(input: unknown, limit: number): string {
  if (typeof input !== "string" || !input.length || input.length > limit)
    throw new LogRequestError("日志参数缺失或过长");
  return input;
}
