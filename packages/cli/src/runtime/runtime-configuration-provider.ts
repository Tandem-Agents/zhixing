import {
  describeProxy,
  type ProxyDescription,
} from "@zhixing/network";
import {
  loadConfig,
  type ZhixingConfig,
} from "@zhixing/providers";
import {
  projectRuntimeConfiguration,
  type RuntimeTopologyConfigurationProjection,
} from "./runtime-configuration-projections.js";

export interface RuntimePrimaryModelDisplayProjection {
  readonly providerId: string;
  readonly model: string;
}

export interface RuntimeNetworkProxyDisplayProjection {
  readonly mode: ProxyDescription["mode"];
  readonly hasResolvedProxy: boolean;
  readonly display: string;
}

export interface ReplRuntimeConfigurationProjection {
  readonly primaryModel: RuntimePrimaryModelDisplayProjection;
  readonly networkProxy: RuntimeNetworkProxyDisplayProjection;
}

interface RuntimeConfigurationSourceOptions {
  readonly homeDir?: string;
  readonly env?: Record<string, string | undefined>;
  readonly noAutoCreate?: boolean;
}

export interface RuntimeConfigurationProvider {
  readReplSurface(): ReplRuntimeConfigurationProjection;
  readTopology(options: {
    readonly homeDir: string;
  }): RuntimeTopologyConfigurationProjection;
}

/**
 * The one read-only Configuration Provider used by ordinary CLI Surfaces.
 * Raw loader values stay inside this adapter and are immediately reduced by
 * the canonical purpose projector; callers receive only frozen finite values.
 */
export function createRuntimeConfigurationProvider(
  loadConfiguration: (
    options?: RuntimeConfigurationSourceOptions
  ) => ZhixingConfig = loadConfig,
): RuntimeConfigurationProvider {
  const project = (options?: RuntimeConfigurationSourceOptions) =>
    projectRuntimeConfiguration(loadConfiguration(options));

  return Object.freeze({
    readReplSurface(): ReplRuntimeConfigurationProjection {
      const configuration = project();
      const main = configuration.model.llm?.main;
      const proxy = describeProxy(configuration.mcp.network?.proxy);
      return Object.freeze({
        primaryModel: Object.freeze({
          providerId: main?.provider ?? "",
          model: main?.model ?? "",
        }),
        networkProxy: Object.freeze({
          mode: proxy.mode,
          hasResolvedProxy: proxy.resolved !== null,
          display: proxy.display,
        }),
      });
    },
    readTopology(options: {
      readonly homeDir: string;
    }): RuntimeTopologyConfigurationProjection {
      return project(options).topology;
    },
  });
}
