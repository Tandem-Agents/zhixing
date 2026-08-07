/** RPC 投影所需的最小连接能力，不绑定 WebSocket 或具体网关实现。 */
export interface RpcNotificationConnection {
  readonly id: string | number;
  readonly authenticated: boolean;
  readonly loopback: boolean;
  readonly closed: boolean;
  readonly surfacePrincipal?: string;
  notify(method: string, params?: unknown): void;
}
