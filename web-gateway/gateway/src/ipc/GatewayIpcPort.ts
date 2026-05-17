import { UNHANDLED_CODEX_CHANNEL, type IGatewayCodexIpcPort } from "./codex/IGatewayCodexIpcPort";
import { IGatewayIpcPort } from "./IGatewayIpcPort";
import type { GatewayInvokeContext, GatewayIpcBroadcastMessage, GatewayWebClient } from "./types";

const TARGETED_EVENT_QUEUE_TTL_MS = 15_000;
const MAX_PENDING_TARGETED_EVENTS_PER_CLIENT = 100;

interface PendingTargetedEvent {
  channel: string;
  args: unknown[];
  expiresAtMs: number;
}

/**
 * gateway IPC 的组合实现。
 *
 * 它只做两件事：把浏览器 invoke 交给 Codex 业务层，以及把业务事件发回浏览器。
 */
export class GatewayIpcPort extends IGatewayIpcPort {
  private readonly codexIpcPort: IGatewayCodexIpcPort;
  private readonly requestContext: any;
  private readonly targetedChannels: Set<string>;
  private readonly createInvokeContext: (context: GatewayInvokeContext) => GatewayInvokeContext;
  private readonly clients = new Map<string, GatewayWebClient>();
  private readonly pendingTargetedEvents = new Map<string, PendingTargetedEvent[]>();

  constructor({
    codexIpcPort,
    requestContext,
    targetedChannels,
    createInvokeContext,
  }: {
    codexIpcPort: IGatewayCodexIpcPort;
    requestContext: any;
    targetedChannels: Set<string>;
    createInvokeContext: (context: GatewayInvokeContext) => GatewayInvokeContext;
  }) {
    super();
    this.codexIpcPort = codexIpcPort;
    this.requestContext = requestContext;
    this.targetedChannels = targetedChannels;
    this.createInvokeContext = createInvokeContext;
  }

  /** 统一入口：Codex 业务层负责所有支持的 renderer channel。 */
  async invokeGatewayIpc(channel: string, payload: unknown, context: GatewayInvokeContext): Promise<unknown> {
    const invokeContext = this.createInvokeContext(context || {});
    const codexResult = await this.codexIpcPort.handleCodexRequest(channel, payload, invokeContext);
    if (codexResult !== UNHANDLED_CODEX_CHANNEL) return codexResult;
    throw new Error(`Unsupported gateway IPC channel: ${channel}`);
  }

  private sendToClient(clientId: string, channel: string, args: unknown[]): boolean {
    const client = this.clients.get(clientId);
    if (!client || !client.isOpen()) return false;
    const payload = args.length <= 1 ? (args[0] ?? null) : args;
    return client.sendGatewayEvent(channel, payload);
  }

  private broadcastToClients(channel: string, args: unknown[]): boolean {
    let delivered = false;
    for (const client of this.clients.values()) {
      if (!client.isOpen()) continue;
      const payload = args.length <= 1 ? (args[0] ?? null) : args;
      delivered = client.sendGatewayEvent(channel, payload) || delivered;
    }
    return delivered;
  }

  /** 清理过期的定向事件，避免刷新/关闭页面后残留无主响应。 */
  private prunePendingTargetedEvents(clientId?: string): void {
    const now = Date.now();
    const clientIds = clientId ? [clientId] : [...this.pendingTargetedEvents.keys()];
    for (const id of clientIds) {
      const pending = this.pendingTargetedEvents.get(id);
      if (!pending) continue;
      const fresh = pending.filter((entry) => entry.expiresAtMs > now);
      if (fresh.length > 0) {
        this.pendingTargetedEvents.set(id, fresh);
      } else {
        this.pendingTargetedEvents.delete(id);
      }
    }
  }

  /** WebSocket hello 之前产生的 mcp/fetch 响应先暂存，客户端注册后再投递。 */
  private enqueuePendingTargetedEvent(clientId: string, channel: string, args: unknown[]): void {
    this.prunePendingTargetedEvents(clientId);
    const pending = this.pendingTargetedEvents.get(clientId) || [];
    pending.push({
      channel,
      args,
      expiresAtMs: Date.now() + TARGETED_EVENT_QUEUE_TTL_MS,
    });
    if (pending.length > MAX_PENDING_TARGETED_EVENTS_PER_CLIENT) {
      pending.splice(0, pending.length - MAX_PENDING_TARGETED_EVENTS_PER_CLIENT);
    }
    this.pendingTargetedEvents.set(clientId, pending);
  }

  /** 客户端完成 hello/attach 后，补发它在握手窗口内错过的定向响应。 */
  private flushPendingTargetedEvents(clientId: string): void {
    this.prunePendingTargetedEvents(clientId);
    const pending = this.pendingTargetedEvents.get(clientId);
    if (!pending || pending.length === 0) return;
    const remaining: PendingTargetedEvent[] = [];
    for (const entry of pending) {
      if (!this.sendToClient(clientId, entry.channel, entry.args)) {
        remaining.push(entry);
      }
    }
    if (remaining.length > 0) {
      this.pendingTargetedEvents.set(clientId, remaining);
    } else {
      this.pendingTargetedEvents.delete(clientId);
    }
  }

  /** 将 app-server 或本地业务事件发回浏览器，优先使用定向投递避免多端串台。 */
  broadcastGatewayIpc(message: GatewayIpcBroadcastMessage): boolean {
    if (!message || typeof message !== "object") return false;
    const channel = String(message.channel || "");
    if (!channel) return false;
    const explicitClientId = typeof message.targetClientId === "string" ? message.targetClientId : "";
    const store = (this.requestContext && this.requestContext.getStore && this.requestContext.getStore()) || {};
    const clientId = explicitClientId || store.clientId || "";
    if (clientId && this.targetedChannels.has(channel)) {
      // 审批、fetch、文件预览等事件必须尽量回到触发它的那台浏览器。
      const delivered = this.sendToClient(clientId, channel, [message.payload ?? null]);
      if (delivered) return true;
      this.enqueuePendingTargetedEvent(clientId, channel, [message.payload ?? null]);
      return true;
    }
    return this.broadcastToClients(channel, [message.payload ?? null]);
  }

  attachGatewayClient(client: GatewayWebClient): void {
    this.clients.set(client.clientId, client);
    this.flushPendingTargetedEvents(client.clientId);
  }

  detachGatewayClient(clientId: string): void {
    this.clients.delete(clientId);
  }

  isGatewayClientConnected(clientId: string): boolean {
    const client = this.clients.get(clientId);
    return !!client && client.isOpen();
  }
}
