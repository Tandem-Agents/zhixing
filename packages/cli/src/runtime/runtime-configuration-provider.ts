import type { SessionModelSelection } from "@zhixing-ai/core";
import {
  describeProxy,
  type ProxyDescription,
} from "@zhixing-ai/network/proxy";
import {
  isLLMConfigV2,
  loadConfig,
  type LegacyLLMConfigV1,
  type ModelCatalogPort,
  type ProviderCredentialProjection,
  type ZhixingConfig,
} from "@zhixing-ai/providers/configuration";
import {
  projectRuntimeConfiguration,
  type RuntimeTopologyConfigurationProjection,
} from "./runtime-configuration-projections.js";
import {
  projectEffectiveModelDisplay,
  type EffectiveModelDisplay,
} from "./model-display-projection.js";

export type RuntimePrimaryModelDisplayProjection = EffectiveModelDisplay;

export interface EffectiveModelSurfaceProjectionOptions {
  readonly credentials?: ProviderCredentialProjection;
  readonly sessionMode?: "normal" | "workscene";
  readonly sessionSelection?: SessionModelSelection;
  readonly catalog?: ModelCatalogPort;
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
  projectEffectiveModel?(
    options?: EffectiveModelSurfaceProjectionOptions,
  ): RuntimePrimaryModelDisplayProjection;
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
      const rawLlm = configuration.model.llm as unknown;
      const mainProviderId = isLLMConfigV2(rawLlm)
        ? (rawLlm.main?.connectionId ?? "")
        : ((rawLlm as LegacyLLMConfigV1 | undefined)?.main?.provider ?? "");
      const mainModel = isLLMConfigV2(rawLlm)
        ? (rawLlm.main?.model ?? "")
        : ((rawLlm as LegacyLLMConfigV1 | undefined)?.main?.model ?? "");
      const proxy = describeProxy(configuration.mcp.network?.proxy);
      return Object.freeze({
        primaryModel: Object.freeze({
          providerId: mainProviderId,
          model: mainModel,
        }),
        networkProxy: Object.freeze({
          mode: proxy.mode,
          hasResolvedProxy: proxy.resolved !== null,
          display: proxy.display,
        }),
      });
    },
    projectEffectiveModel(
      options?: EffectiveModelSurfaceProjectionOptions,
    ): RuntimePrimaryModelDisplayProjection {
      const configuration = project();
      return projectEffectiveModelDisplay({
        config: configuration.model,
        credentials: options?.credentials,
        sessionMode: options?.sessionMode,
        sessionSelection: options?.sessionSelection,
        catalog: options?.catalog,
      });
    },
    readTopology(options: {
      readonly homeDir: string;
    }): RuntimeTopologyConfigurationProjection {
      return project(options).topology;
    },
  });
}
