import { WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  type PluginMethod,
  type PluginParams,
  type PluginResult,
  type RpcError,
  type ServerMessage,
} from "@figma-studio/shared-types";

export class BridgeRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "BridgeRequestError";
  }
}

interface PendingRequest {
  resolve(v: unknown): void;
  reject(e: Error): void;
  timer: NodeJS.Timeout;
  timeoutMs: number;
  onProgress?: (done: number, total: number, message?: string) => void;
}

export interface RequestOptions {
  /** Idle timeout: reset whenever the plugin reports progress. */
  timeoutMs?: number;
  onProgress?: (done: number, total: number, message?: string) => void;
}

export interface BridgeClientOptions {
  url: string;
  reconnect?: boolean;
  log?: (msg: string) => void;
}

/**
 * Agent-side connection to the bridge. Reconnects with exponential backoff and re-joins the last
 * pairing code automatically, so a restarted bridge or a reloaded plugin doesn't break the session.
 */
export class BridgeClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private seq = 0;
  private backoff = 500;
  private closed = false;
  private pairingCode: string | null = null;
  private joinWaiter: { resolve(v: { fileName?: string }): void; reject(e: Error): void } | null = null;
  private openWaiters: Array<() => void> = [];

  paired = false;
  pluginOnline = false;
  fileName: string | undefined;

  constructor(private readonly options: BridgeClientOptions) {}

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.options.url);
    this.ws = ws;
    ws.on("open", () => {
      this.backoff = 500;
      this.openWaiters.splice(0).forEach((w) => w());
      if (this.pairingCode) this.sendRaw({ type: "join", protocolVersion: PROTOCOL_VERSION, pairingCode: this.pairingCode });
    });
    ws.on("message", (raw) => this.onMessage(raw.toString()));
    ws.on("error", () => {
      /* surfaced via close */
    });
    ws.on("close", () => {
      this.paired = false;
      this.pluginOnline = false;
      this.failAll("bridge_disconnected", "Lost connection to the local bridge.");
      if (!this.closed && this.options.reconnect !== false) {
        const delay = this.backoff;
        this.backoff = Math.min(this.backoff * 2, 15_000);
        setTimeout(() => this.connect(), delay).unref();
      }
    });
  }

  waitForOpen(timeoutMs = 5_000): Promise<void> {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new BridgeRequestError("bridge_unreachable", `Local bridge at ${this.options.url} is not reachable.`)), timeoutMs);
      this.openWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  async pair(code: string, timeoutMs = 5_000): Promise<{ fileName?: string }> {
    await this.waitForOpen();
    this.pairingCode = code;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.joinWaiter = null;
        reject(new BridgeRequestError("pair_timeout", "Pairing timed out."));
      }, timeoutMs);
      this.joinWaiter = {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          this.pairingCode = null;
          reject(e);
        },
      };
      this.sendRaw({ type: "join", protocolVersion: PROTOCOL_VERSION, pairingCode: code });
    });
  }

  request<M extends PluginMethod>(method: M, params: PluginParams<M>, options: RequestOptions = {}): Promise<PluginResult<M>> {
    if (!this.connected) return Promise.reject(new BridgeRequestError("bridge_disconnected", "Not connected to the local bridge."));
    if (!this.paired) return Promise.reject(new BridgeRequestError("not_paired", "Not paired with a Figma plugin. Call figma_connect with the code shown in the plugin."));
    const id = `a${++this.seq}`;
    const timeoutMs = options.timeoutMs ?? 30_000;
    return new Promise<PluginResult<M>>((resolve, reject) => {
      const entry: PendingRequest = {
        resolve: resolve as (v: unknown) => void,
        reject,
        timeoutMs,
        onProgress: options.onProgress,
        timer: setTimeout(() => this.timeout(id), timeoutMs),
      };
      this.pending.set(id, entry);
      this.sendRaw({ type: "request", id, method, params });
    });
  }

  close(): void {
    this.closed = true;
    this.failAll("closed", "Client closed.");
    this.ws?.close();
  }

  private timeout(id: string): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.reject(new BridgeRequestError("timeout", `The Figma plugin did not answer within ${Math.round(p.timeoutMs / 1000)}s.`));
  }

  private failAll(code: string, message: string): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new BridgeRequestError(code, message));
      this.pending.delete(id);
    }
  }

  private sendRaw(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private onMessage(raw: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    switch (msg.type) {
      case "joined":
        this.paired = true;
        this.pluginOnline = true;
        this.fileName = msg.fileName;
        this.joinWaiter?.resolve({ fileName: msg.fileName });
        this.joinWaiter = null;
        this.options.log?.(`paired with plugin ${msg.pairingCode}${msg.fileName ? ` (${msg.fileName})` : ""}`);
        return;
      case "peer_left":
        if (msg.role === "plugin") this.pluginOnline = false;
        return;
      case "error":
        if (this.joinWaiter) {
          this.joinWaiter.reject(new BridgeRequestError(msg.code, msg.message));
          this.joinWaiter = null;
        } else {
          this.options.log?.(`bridge error ${msg.code}: ${msg.message}`);
        }
        return;
      case "progress": {
        const p = this.pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        p.timer = setTimeout(() => this.timeout(msg.id), p.timeoutMs);
        p.onProgress?.(msg.done, msg.total, msg.message);
        return;
      }
      case "response": {
        const p = this.pending.get(msg.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(toError(msg.error));
        else p.resolve(msg.result);
        return;
      }
      default:
        return;
    }
  }
}

function toError(e: RpcError): BridgeRequestError {
  return new BridgeRequestError(e.code, e.message, e.data);
}
