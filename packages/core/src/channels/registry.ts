import type {
  ChannelAdapter,
  ChannelConfig,
  ChannelContext,
  ChannelEventMap,
  ChannelLogger,
  ChannelStatus,
  InboundMessage,
  HttpHandler,
} from "./types.js";
import type { IEventBus } from "../events/index.js";

// ─── ChannelRegistry ───

export interface ChannelRegistryOptions {
  eventBus: IEventBus<ChannelEventMap>;
  logger: ChannelLogger;
  onMessage: (msg: InboundMessage) => void;
  registerHttpRoute?: (path: string, handler: HttpHandler) => void;
}

export class ChannelRegistry {
  private readonly adapters = new Map<string, ChannelAdapter>();
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly statuses = new Map<string, ChannelStatus>();
  private readonly options: ChannelRegistryOptions;
  private disposed = false;

  constructor(options: ChannelRegistryOptions) {
    this.options = options;
  }

  register(adapter: ChannelAdapter): void {
    if (this.disposed) throw new Error("ChannelRegistry is disposed");
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Channel adapter already registered: ${adapter.id}`);
    }
    this.adapters.set(adapter.id, adapter);
    this.statuses.set(adapter.id, {
      channelId: adapter.id,
      state: "disconnected",
    });
  }

  get(id: string): ChannelAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): ChannelAdapter[] {
    return [...this.adapters.values()];
  }

  getStatus(id: string): ChannelStatus | undefined {
    return this.statuses.get(id);
  }

  listStatuses(): ChannelStatus[] {
    return [...this.statuses.values()];
  }

  async connect(id: string, config: ChannelConfig): Promise<void> {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Channel adapter not found: ${id}`);

    const status = this.statuses.get(id)!;
    if (status.state === "connected" || status.state === "connecting") return;

    this.updateStatus(id, "connecting");

    const abortController = new AbortController();
    this.abortControllers.set(id, abortController);
    const ctx = this.createContext(id, config, abortController.signal);

    try {
      await adapter.connect(ctx);
      this.updateStatus(id, "connected", { connectedAt: new Date().toISOString() });
      this.options.eventBus.emit("channel:connected", { channelId: id });
    } catch (err) {
      this.abortControllers.delete(id);
      const message = err instanceof Error ? err.message : String(err);
      this.updateStatus(id, "error", { error: message });
      this.options.eventBus.emit("channel:error", { channelId: id, error: message });
      throw err;
    }
  }

  async disconnect(id: string): Promise<void> {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Channel adapter not found: ${id}`);

    const status = this.statuses.get(id)!;
    if (status.state === "disconnected") return;

    try {
      this.abortControllers.get(id)?.abort();
      await adapter.disconnect();
    } finally {
      this.abortControllers.delete(id);
      this.updateStatus(id, "disconnected");
      this.options.eventBus.emit("channel:disconnected", { channelId: id });
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    const ids = [...this.adapters.keys()];
    await Promise.allSettled(ids.map((id) => this.disconnect(id)));
    this.adapters.clear();
    this.abortControllers.clear();
    this.statuses.clear();
  }

  private createContext(
    channelId: string,
    config: ChannelConfig,
    abortSignal: AbortSignal,
  ): ChannelContext {
    const { eventBus, logger, onMessage, registerHttpRoute } = this.options;
    return {
      config,
      abortSignal,
      eventBus,
      logger,
      onMessage: (msg: InboundMessage) => {
        this.updateStatus(channelId, "connected", {
          lastMessageAt: new Date().toISOString(),
        });
        eventBus.emit("channel:message-received", { channelId, message: msg });
        onMessage(msg);
      },
      registerHttpRoute: registerHttpRoute ?? (() => {
        throw new Error("HTTP route registration not available");
      }),
    };
  }

  private updateStatus(
    id: string,
    state: ChannelStatus["state"],
    extra?: Partial<ChannelStatus>,
  ): void {
    const current = this.statuses.get(id);
    if (!current) return;
    this.statuses.set(id, { ...current, state, error: undefined, ...extra });
  }
}
