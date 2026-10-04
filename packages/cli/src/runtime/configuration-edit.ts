import type { ZhixingConfig, ZhixingCredentials } from "@zhixing/providers";
import type { SupportedChannel } from "../registries/channels.js";

export type ConfigurationEditResult =
  | { kind: "completed"; config: ZhixingConfig; credentials: ZhixingCredentials; channelIntents?: Readonly<Record<string, boolean>> }
  | { kind: "cancelled" }
  | { kind: "non-tty" };

/**
 * 仅 Node 同进程受信编辑回调。owner 保留基线、保存和恢复；编辑器暂存秘密。
 * 这不是公共查询/未来 UI 或 IPC 模型，不含 WorkingState、FieldSpec、屏幕或输入流。
 */
export interface NodeConfigurationEditSession {
  readonly initialConfig: ZhixingConfig;
  readonly initialCredentials: ZhixingCredentials;
  readonly channelCatalog?: readonly SupportedChannel[];
  readonly channelSetup?: Readonly<Record<string, string>>;
  readonly channelStates?: Readonly<Record<string, {
    enabled: boolean; revision: number; intentRevision: number; type?: string; configurationIssue?: string;
  }>>;
  readonly writers: {
    save(result: Extract<ConfigurationEditResult, { kind: "completed" }>): Promise<void>;
  };
}

export type NodeConfigurationEditor = (session: NodeConfigurationEditSession) => Promise<ConfigurationEditResult>;
