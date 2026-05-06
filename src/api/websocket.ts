type MessageHandler = (data: unknown) => void;

const WS_URL_MAINNET = 'wss://mainnet-gw.sodex.dev/ws/perps';
const WS_URL_TESTNET = 'wss://testnet-gw.sodex.dev/ws/perps';

class WebSocketService {
  private ws: WebSocket | null = null;
  private subscriptions = new Map<string, Set<MessageHandler>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
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
      this.disconnect();
      this.reconnectAttempts = 0;
    }

    this.isTestnet = isTestnet;
    const url = isTestnet ? WS_URL_TESTNET : WS_URL_MAINNET;

    try {
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        
        // Start ping interval (30s)
        this.pingTimer = setInterval(() => {
          this.send({ op: 'ping' });
        }, 30000);

        for (const [channelKey] of this.subscriptions.entries()) {
          this.sendSubscribeStr(channelKey);
        }
      };

      this.ws.onmessage = (event: MessageEvent) => {
        try {
          const data = JSON.parse(event.data);
          
          if (data.op === 'pong') return;

          const channel = data.channel ?? data.stream ?? data.e ?? '';
          if (channel) {
            // Find all handlers whose key includes the channel.
            // E.g. {"channel":"ticker","symbols":["BTC-USD"]} 
            for (const [key, handlers] of this.subscriptions.entries()) {
              if (key.includes(`"channel":"${channel}"`) || key === channel) {
                 for (const handler of handlers) handler(data);
              }
            }
          }
          if (this.subscriptions.has('*')) {
            const handlers = this.subscriptions.get('*')!;
            for (const handler of handlers) handler(data);
          }
        } catch {
          // Ignore
        }
      };

      this.ws.onclose = () => this.scheduleReconnect();
      this.ws.onerror = () => this.ws?.close();
    } catch {
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.reconnectAttempts = this.maxReconnectAttempts;
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  // Expect params inside channel string or raw JSON parseable. 
  // Backward compatibility: If channel is pure string e.g. "ticker", we'll wrap it.
  subscribe(channel: string, handler: MessageHandler): () => void {
    let subParams: unknown = { channel };
    try {
      const parsed = JSON.parse(channel);
      if (typeof parsed === 'object') subParams = parsed;
    } catch { /* empty */ }

    const channelKey = JSON.stringify(subParams);

    if (!this.subscriptions.has(channelKey)) {
      this.subscriptions.set(channelKey, new Set());
    }
    this.subscriptions.get(channelKey)!.add(handler);

    if (this.connected) {
      this.send({ op: 'subscribe', params: subParams });
    }

    return () => {
      const handlers = this.subscriptions.get(channelKey);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          this.subscriptions.delete(channelKey);
          if (this.connected) {
            this.send({ op: 'unsubscribe', params: subParams });
          }
        }
      }
    };
  }

  private sendSubscribeStr(channelKey: string): void {
    if (channelKey === '*') return;
    try {
      this.send({ op: 'subscribe', params: JSON.parse(channelKey) });
    } catch {
      this.send({ op: 'subscribe', params: { channel: channelKey } });
    }
  }

  private send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private scheduleReconnect(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    const delay = this.baseDelay * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.connect(this.isTestnet);
    }, delay);
  }
}

export const wsService = new WebSocketService();
