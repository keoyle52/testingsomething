type MessageHandler = (data: unknown) => void;

const WS_URL_MAINNET = 'wss://mainnet-gw.sodex.dev/ws';
const WS_URL_TESTNET = 'wss://testnet-gw.sodex.dev/ws';

class WebSocketService {
  private ws: WebSocket | null = null;
  private subscriptions = new Map<string, Set<MessageHandler>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isTestnet = true;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private baseDelay = 1000;

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  switchNetwork(isTestnet: boolean): void {
    if (this.isTestnet !== isTestnet) {
      this.disconnect();
      this.reconnectAttempts = 0;
      this.connect(isTestnet);
    }
  }

  connect(isTestnet: boolean): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      if (this.isTestnet === isTestnet) return;
      // Network changed while connected — disconnect and reconnect
      this.disconnect();
      this.reconnectAttempts = 0;
    }

    this.isTestnet = isTestnet;
    const url = isTestnet ? WS_URL_TESTNET : WS_URL_MAINNET;

    try {
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        // Resubscribe to all channels
        for (const channel of this.subscriptions.keys()) {
          this.sendSubscribe(channel);
        }
      };

      this.ws.onmessage = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          const channel = data.channel ?? data.stream ?? data.e ?? '';
          if (channel && this.subscriptions.has(channel)) {
            const handlers = this.subscriptions.get(channel)!;
            for (const handler of handlers) {
              handler(data);
            }
          }
          // Also notify wildcard listeners
          if (this.subscriptions.has('*')) {
            const handlers = this.subscriptions.get('*')!;
            for (const handler of handlers) {
              handler(data);
            }
          }
        } catch {
          // Ignore malformed messages
        }
      };

      this.ws.onclose = () => {
        this.scheduleReconnect();
      };

      this.ws.onerror = () => {
        this.ws?.close();
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = this.maxReconnectAttempts;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  subscribe(channel: string, handler: MessageHandler): () => void {
    if (!this.subscriptions.has(channel)) {
      this.subscriptions.set(channel, new Set());
    }
    this.subscriptions.get(channel)!.add(handler);

    if (this.connected) {
      this.sendSubscribe(channel);
    }

    return () => {
      const handlers = this.subscriptions.get(channel);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          this.subscriptions.delete(channel);
          if (this.connected) {
            this.sendUnsubscribe(channel);
          }
        }
      }
    };
  }

  private sendSubscribe(channel: string): void {
    if (channel === '*') return;
    this.send({ method: 'SUBSCRIBE', params: [channel] });
  }

  private sendUnsubscribe(channel: string): void {
    if (channel === '*') return;
    this.send({ method: 'UNSUBSCRIBE', params: [channel] });
  }

  private send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    const delay = this.baseDelay * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.connect(this.isTestnet);
    }, delay);
  }
}

export const wsService = new WebSocketService();
