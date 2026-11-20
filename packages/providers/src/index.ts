// Provider 层公开 API

// 类型导出
export type {
  AgentConfig,
  ChannelCredentialProjection,
  ConnectionAuthConfig,
  ConnectionDialectConfig,
  ConnectionNetworkConfig,
  IntentConfig,
  LegacyLLMConfigV1,
  LLMConfigV2,
  LLMRoleConfig,
  McpCredentialProjection,
  McpConfig,
  McpServerConfigEntry,
  MessagingChannelEntry,
  MigrationPendingItem,
  ModelAdapterId,
  ModelBudgetOverride,
  ModelConnectionConfig,
  ModelInputCapabilitiesOverride,
  ModelRoleId,
  ModelSecretEntryV2,
  ModelSelectionParams,
  ModelSpecOverride,
  NetworkConfig,
  PendingModelSecretRetirement,
  Protocol,
  ProviderCredentialEntry,
  ProviderCredentialProjection,
  ProviderPreset,
  ProviderQuirks,
  ResolvedProvider,
  RoleSelection,
  WorkspaceConfig,
  ZhixingConfig,
  ZhixingCredentials,
} from "./types.js";
export { DEFAULT_QUIRKS, isLegacyLLMConfigV1, isLLMConfigV2 } from "./types.js";

// 目录窄读口、单源策展目录、三层合成、原生发现、隔离缓存、可选验证与 TUF 可信更新
export {
  createBuiltinModelCatalogPort,
  createModelCatalogPortFromBundle,
  curatedModelToModelInfo,
  curatedPresetToProviderPreset,
  DEFAULT_MODEL_CATALOG_PORT,
  IMPLEMENTED_MODEL_ADAPTERS,
  isAdapterImplemented,
} from "./catalog-port.js";
export type {
  CatalogPresetEntry,
  ModelCatalogPort,
  PresetUpdateSuggestion,
} from "./catalog-port.js";
export {
  CURATED_CATALOG_SCHEMA_VERSION,
  CatalogSchemaError,
  LOCAL_SUPPORTED_CATALOG_CAPABILITIES,
  REGISTERED_PARAM_SEMANTICS,
  evaluateCapabilities,
  isStrictRfc3339Utc,
  normalizeOllamaEndpoints,
  parseCuratedCatalogBundle,
  resolveInferenceBaseUrl,
} from "./catalog/schema.js";
export type {
  CatalogCapabilityGate,
  CatalogLifecycle,
  CatalogUpgradeNotice,
  CuratedAttentionThreshold,
  CuratedCatalogBundle,
  CuratedModelEntry,
  CuratedPreset,
  CuratedRecommendation,
  DiscoveryKind,
  DiscoveryTemplate,
  ModelPricingInfo,
  ModelPurpose,
  NormalizedOllamaEndpoints,
  PresetUiMetadata,
  RegisteredParamSemanticId,
} from "./catalog/schema.js";
export { BUILTIN_CURATED_CATALOG } from "./catalog/builtin-catalog.js";
export {
  isStructuredNonChatModel,
  synthesizeConnectionModels,
  validateModelSpecOverrideAgainstHardConstraints,
} from "./catalog/synthesis.js";
export type {
  DiscoveredModelRecord,
  FieldProvenanceSource,
  HardConstraintConflict,
  SourcedField,
  SynthesizeConnectionModelsInput,
  SynthesizedConnectionModelsResult,
  SynthesizedModelCandidate,
} from "./catalog/synthesis.js";
export {
  TUF_ALLOWED_ROLES,
  TufSecurityPolicyError,
  refreshCatalogWithTuf,
  resolveActiveCatalogPath,
  resolveActiveTargetsProofPath,
  resolvePreviousCatalogPath,
  resolvePreviousTargetsProofPath,
  resolveTufMetadataDir,
  resolveTufRootHistoryDir,
  validateTufMetadataBytes,
  verifyAcceptedDiskCatalog,
  verifyTufEnvelopeSignatureAgainstRoot,
} from "./catalog/tuf/restricted-tuf-client.js";
export type {
  RefreshCatalogWithTufOptions,
  TufMetadataSummary,
  TufRefreshOutcome,
  TufRepositorySource,
  TufRoleName,
  UnverifiedDiskCatalogOutcome,
  VerifiedDiskCatalogOutcome,
} from "./catalog/tuf/restricted-tuf-client.js";
export {
  DEFAULT_OFFICIAL_CATALOG_REPOSITORY,
  OFFICIAL_BOOTSTRAP_ROOT_BYTES,
  OFFICIAL_BOOTSTRAP_ROOT_JSON,
  loadConfiguredCatalogRepository,
  resolveCatalogRepositorySourcePath,
} from "./catalog/tuf/default-repository.js";
export type { PersistedCatalogRepositorySourceFile } from "./catalog/tuf/default-repository.js";
export {
  DEFAULT_CATALOG_AUTO_CHECK_INTERVAL_MS,
  ModelCatalogManager,
  resolveCatalogStoreDir,
} from "./catalog/catalog-manager.js";
export type {
  CatalogManagerStatus,
  CatalogRefreshResult,
  CatalogRefreshStatusKind,
  CatalogSourceKind,
  ModelCatalogManagerOptions,
} from "./catalog/catalog-manager.js";
export {
  buildRootSignedObject,
  checkTufRenewalDue,
  collectUpstreamCatalogCandidate,
  computeCatalogReviewBinding,
  diffCuratedCatalogs,
  formatCatalogDiffMarkdown,
  generateTufEd25519KeyPair,
  generateTufFourRoleKeySet,
  publishTufCatalogRepository,
  publishTufCatalogUpdate,
  renewTufMetadata,
  rotateTufRoot,
  signTufEnvelope,
  verifyCatalogCompatibilityForReader,
  verifyCatalogReviewBinding,
} from "./catalog/maintenance.js";
export type {
  CatalogReviewBinding,
  CatalogReviewResult,
  CollectUpstreamCatalogInput,
  CollectUpstreamCatalogResult,
  CompatibilityCheckReport,
  CuratedCatalogDiff,
  FieldChange,
  ModelDiffEntry,
  PresetDiffEntry,
  PublishTufCatalogUpdateInput,
  PublishTufRepositoryInput,
  PublishedTufRepositoryResult,
  RecommendationDiffEntry,
  RotateTufRootInput,
  RotateTufRootResult,
  TufFourRoleKeySet,
  TufOnlineRoleKeySet,
  TufRenewalDueCheckResult,
  TufRoleKeyPair,
  UpstreamCatalogCollectionSource,
  UpstreamSourceCollectionReport,
} from "./catalog/maintenance.js";
export {
  DEFAULT_DISCOVERY_CACHE_TTL_MS,
  ModelDiscoveryCache,
  computeCredentialRevisionToken,
  computeDiscoveryPartitionKey,
  resolveDiscoveryCachePath,
  sanitizeEndpointForCache,
} from "./discovery/discovery-cache.js";
export type {
  ConnectionDiscoveryFactsSnapshot,
  ConnectionDiscoveryWatermark,
  DiscoveryCacheEntry,
  DiscoveryCacheReadResult,
  DiscoveryCacheWriteOptions,
  DiscoveryPartitionIdentity,
  DiscoveryProbeStatus,
  GenerationVerificationReceipt,
} from "./discovery/discovery-cache.js";
export {
  discoverConnectionModels,
  resolveDiscoveryPlan,
} from "./discovery/native-discovery.js";
export type {
  DiscoverConnectionModelsInput,
  DiscoverConnectionModelsResult,
  ResolvedDiscoveryPlan,
} from "./discovery/native-discovery.js";
export {
  DEFAULT_LEGAL_VERIFICATION_MAX_TOKENS,
  GENERATION_VERIFICATION_PROMPT,
  MIN_LEGAL_VERIFICATION_MAX_TOKENS,
  describeGenerationVerification,
  resolveLegalVerificationMaxTokens,
  verifyModelGeneration,
} from "./discovery/generation-verify.js";
export type {
  GenerationVerificationNotice,
  VerifyModelGenerationInput,
  VerifyModelGenerationResult,
} from "./discovery/generation-verify.js";

// 协议族默认 budget（cli/server 在调用 core.resolveModelInfo 时注入）
export { PROTOCOL_BUDGET_DEFAULTS } from "./protocol-defaults.js";

// 预设
export { getPreset, getPresetIds, PROVIDER_PRESETS } from "./presets.js";

// 模型注意力阈值（领域知识，随知行版本演进；用户可通过 functional 配置覆盖）
export {
  MODEL_CAPABILITIES,
  UNKNOWN_MODEL_CAPABILITY,
  getModelCapabilityOverride,
  normalizeModelId,
  resolveModelCapability,
} from "./model-capability.js";
export type {
  ModelCapability,
  ModelCapabilityOverride,
} from "./model-capability.js";

// 配置解析
export {
  assertModelCapabilitySupported,
  computeSourceOriginKey,
  ProviderConfigError,
  resolveConnection,
  resolveFromConfig,
  resolveLLMRoles,
  resolveProvider,
  resolveSessionOverride,
} from "./resolve.js";
export type {
  ConnectionDiscoveryFacts,
  ResolveConnectionOptions,
  ResolveLLMRolesOptions,
  ResolvedLLMRole,
  ResolvedLLMRoles,
  RoleDegradation,
} from "./resolve.js";

// 角色集注册表（角色集单一事实源）
export { AUX_ROLE_SPECS, ROLE_SPECS } from "./role-spec.js";
export type { RoleId, RoleSpec } from "./role-spec.js";

// 档位推荐（"某档位首选哪一对 provider+model"的语义抽象层）
export { ROLE_RECOMMENDATIONS } from "./role-recommendations.js";
export type { RoleRecommendation } from "./role-recommendations.js";

// 协议适配器
export { createOpenAICompatibleProvider } from "./adapters/openai-compatible.js";
export { createAnthropicProvider } from "./adapters/anthropic-messages.js";
export {
  createOpenAIResponsesProvider,
  extractResponsesUsage,
  usesDeveloperPrefixSystemPrompt,
} from "./adapters/openai-responses.js";
export {
  createGoogleInteractionsProvider,
  extractGoogleInteractionsUsage,
  resolveGoogleInteractionsUrl,
} from "./adapters/google-interactions.js";
export {
  buildAnthropicThinkingParam,
  buildAnthropicThinkingRequestFields,
  buildGoogleInteractionsThinkingParams,
  buildOpenAICompatibleThinkingParams,
  buildOpenAIResponsesThinkingParam,
  isAnthropicAdaptiveThinkingModel,
  supportsOpenAICompatibleReasoningContentReplay,
} from "./adapters/thinking-params.js";

// 配置加载
export {
  applyConfigPatch,
  ConfigSchemaError,
  ensureWorkspaceDir,
  getDefaultWorkspacePath,
  getGlobalConfigDir,
  getGlobalConfigPath,
  loadConfig,
  resolveHomeDir,
  resolveWorkspace,
  resolveWorkspaceSessionType,
  writeConfig,
  addMcpServerConfiguration,
  mcpConfigurationRevision,
} from "./config-loader.js";
export type {
  ResolvedWorkspace,
  WorkspaceDirStatus,
  WorkspaceSessionType,
  WorkspaceSource,
} from "./config-loader.js";

// 凭证加载
export {
  applyCredentialsPatch,
  compromisedSecretToken,
  CredentialCommitStateUnknownError,
  CredentialPostCommitError,
  CredentialRetirementError,
  CredentialsSchemaError,
  isModelManagementSecretRef,
  loadCredentialSnapshot,
  loadCredentials,
  MODEL_RETIREMENTS_REF,
  parsePendingModelRetirements,
  readManifestMetadataUnlocked,
  readPendingModelRetirementsUnlocked,
  writeCredentials,
  readCredentialBindingState,
  inspectMcpCredentialBinding,
} from "./credentials-loader.js";
export {
  editConfiguration,
  loadConfigurationSnapshot,
  mergeLegacyModelOverrides,
  migrateConfigurationV1ToV2,
  settlePendingModelRetirements,
  ConfigurationEditPendingError,
} from "./configuration-edit.js";
export type {
  ConfigurationMigrationResult,
  ConfigurationSnapshotResult,
  EditConfigurationOptions,
} from "./configuration-edit.js";
export type {
  CredentialManifestMetadata,
  CredentialMutationOptions,
  CredentialSnapshotOptions,
  CredentialStoreCoordinator,
} from "./credentials-loader.js";

// 配置语义校验（凭证字段 / 密字段拒绝）
export {
  BUILTIN_VALIDATORS,
  ConfigSemanticError,
  hasExplicitUrlCredentialsOrQueryAuth,
  isReservedModelSecretRef,
  validateConfigSemantics,
} from "./config-validator.js";
export type { ConfigSemanticIssue, ConfigValidator } from "./config-validator.js";

// 一站式工厂与受控单跳传输
export {
  createConnectionDeliveryFetch,
  deliveryFetch,
  newDelivery,
  provenUndelivered,
  withDelivery,
} from "./adapters/delivery-transport.js";
export type { ConnectionDeliveryTransport, DeliveryRecord } from "./adapters/delivery-transport.js";
export {
  bindRole,
  createProvider,
  createProviderDirect,
  createProviderFromResolved,
  createProviderRoles,
  prepareProviderRoles,
} from "./create-provider.js";
export type {
  ProviderRolesOptions,
  ProviderRolesResult,
} from "./create-provider.js";
export { CONFIGURATION_LOG_SOURCE } from "./configuration-edit.js";

export { runtimeConfigurationObservation } from "./configuration-logging.js";
