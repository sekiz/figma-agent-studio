import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  ClientMessageSchema,
  DEFAULT_BRIDGE_PORT,
  HEARTBEAT_INTERVAL_MS,
  PROTOCOL_VERSION,
  type ServerMessage,
} from "@figma-studio/shared-types";

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

/** stdout belongs to the MCP stdio transport, so the bridge only ever logs to stderr. */
export const stderrLogger: Logger = {
  info: (m) => process.stderr.write(`[bridge] ${m}\n`),
  warn: (m) => process.stderr.write(`[bridge] WARN ${m}\n`),
};

export interface BridgeOptions {
  port?: number;
  /** Bind address. Keep the default: the bridge must never be reachable from the network. */
  host?: string;
  heartbeatMs?: number;
  maxFailedJoins?: number;
  logger?: Logger;
}

export interface Bridge {
  port: number;
  close(): Promise<void>;
  stats(): { rooms: number; plugins: number; agents: number; pending: number };
}

/**
 * Browsers do not apply CORS to WebSockets, so any web page could otherwise talk to a localhost
 * socket. The Figma plugin UI runs in an opaque-origin iframe ("null"); Node clients send no Origin.
 * Everything else is refused.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === "" || origin === "null") return true;
  return /^https:\/\/([a-z0-9-]+\.)*figma\.com$/i.test(origin);
}

interface Peer {
  ws: WebSocket;
  role: "unknown" | "plugin" | "agent";
  code?: string;
  alive: boolean;
  failedJoins: number;
}

interface Room {
  code: string;
  plugin: Peer | null;
  fileName?: string;
  agents: Set<Peer>;
}

interface Pending {
  agent: Peer;
  originalId: string;
  code: string;
}

export function startBridge(options: BridgeOptions = {}): Promise<Bridge> {
  const log = options.logger ?? stderrLogger;
  const maxFailedJoins = options.maxFailedJoins ?? 5;
  const rooms = new Map<string, Room>();
  const pending = new Map<string, Pending>();
  const peers = new Set<Peer>();
  let seq = 0;

  const wss = new WebSocketServer({
    host: options.host ?? "127.0.0.1",
    port: options.port ?? DEFAULT_BRIDGE_PORT,
    maxPayload: 32 * 1024 * 1024,
    verifyClient: (info: { origin: string; req: IncomingMessage }) => {
      const ok = isAllowedOrigin(info.origin || undefined);
      if (!ok) log.warn(`rejected connection from origin ${info.origin}`);
      return ok;
    },
  });

  const send = (peer: Peer, msg: ServerMessage) => {
    if (peer.ws.readyState === WebSocket.OPEN) peer.ws.send(JSON.stringify(msg));
  };

  const failPendingFor = (code: string, reason: string) => {
    for (const [id, p] of pending) {
      if (p.code !== code) continue;
      send(p.agent, { type: "response", id: p.originalId, error: { code: "plugin_disconnected", message: reason } });
      pending.delete(id);
    }
  };

  const detach = (peer: Peer) => {
    peers.delete(peer);
    if (!peer.code) return;
    const room = rooms.get(peer.code);
    if (!room) return;
    if (peer.role === "plugin" && room.plugin === peer) {
      room.plugin = null;
      failPendingFor(room.code, "The Figma plugin disconnected while handling the request.");
      room.agents.forEach((a) => send(a, { type: "peer_left", role: "plugin" }));
      log.info(`plugin left room ${room.code}`);
    }
    if (peer.role === "agent") {
      room.agents.delete(peer);
      for (const [id, p] of pending) if (p.agent === peer) pending.delete(id);
      room.plugin && send(room.plugin, { type: "peer_left", role: "agent" });
    }
    if (!room.plugin && room.agents.size === 0) rooms.delete(room.code);
  };

  wss.on("connection", (ws) => {
    const peer: Peer = { ws, role: "unknown", alive: true, failedJoins: 0 };
    peers.add(peer);
    ws.on("pong", () => (peer.alive = true));
    ws.on("close", () => detach(peer));
    ws.on("error", (err) => log.warn(`socket error: ${err.message}`));

    ws.on("message", (raw) => {
      let json: unknown;
      try {
        json = JSON.parse(raw.toString());
      } catch {
        return send(peer, { type: "error", code: "bad_json", message: "Message is not valid JSON." });
      }
      const parsed = ClientMessageSchema.safeParse(json);
      if (!parsed.success) {
        return send(peer, { type: "error", code: "bad_message", message: parsed.error.issues.map((i) => i.message).join("; ") });
      }
      const msg = parsed.data;

      switch (msg.type) {
        case "register_plugin": {
          if (msg.protocolVersion !== PROTOCOL_VERSION) {
            return send(peer, { type: "error", code: "protocol_mismatch", message: `Bridge speaks protocol ${PROTOCOL_VERSION}, plugin sent ${msg.protocolVersion}. Update the plugin or the MCP server.` });
          }
          const existing = rooms.get(msg.pairingCode);
          if (existing?.plugin && existing.plugin !== peer && existing.plugin.ws.readyState === WebSocket.OPEN) {
            return send(peer, { type: "error", code: "code_in_use", message: "Another plugin window already uses this pairing code." });
          }
          const room = existing ?? { code: msg.pairingCode, plugin: null, agents: new Set<Peer>() };
          room.plugin = peer;
          room.fileName = msg.fileName;
          rooms.set(room.code, room);
          peer.role = "plugin";
          peer.code = room.code;
          send(peer, { type: "registered", pairingCode: room.code });
          // Agents that were waiting in this room (plugin reload/reconnect) are re-attached automatically.
          room.agents.forEach((a) => send(a, { type: "joined", pairingCode: room.code, fileName: room.fileName }));
          log.info(`plugin registered room ${room.code}${room.fileName ? ` (${room.fileName})` : ""}`);
          return;
        }
        case "join": {
          if (msg.protocolVersion !== PROTOCOL_VERSION) {
            return send(peer, { type: "error", code: "protocol_mismatch", message: `Bridge speaks protocol ${PROTOCOL_VERSION}, agent sent ${msg.protocolVersion}.` });
          }
          const room = rooms.get(msg.pairingCode);
          if (!room?.plugin) {
            peer.failedJoins++;
            send(peer, { type: "error", code: "unknown_code", message: "No open Figma plugin shows this pairing code. Open the plugin and copy the code it displays." });
            if (peer.failedJoins >= maxFailedJoins) {
              log.warn("too many failed pairing attempts; closing connection");
              ws.close(1008, "too many failed pairing attempts");
            }
            return;
          }
          if (peer.code && peer.code !== room.code) rooms.get(peer.code)?.agents.delete(peer);
          peer.role = "agent";
          peer.code = room.code;
          room.agents.add(peer);
          send(peer, { type: "joined", pairingCode: room.code, fileName: room.fileName });
          log.info(`agent joined room ${room.code}`);
          return;
        }
        case "request": {
          const room = peer.role === "agent" && peer.code ? rooms.get(peer.code) : undefined;
          if (!room) return send(peer, { type: "response", id: msg.id, error: { code: "not_paired", message: "Pair with the Figma plugin first." } });
          if (!room.plugin) return send(peer, { type: "response", id: msg.id, error: { code: "plugin_offline", message: "The Figma plugin is not open. Re-open it in the same file; pairing resumes automatically." } });
          const id = `b${++seq}`;
          pending.set(id, { agent: peer, originalId: msg.id, code: room.code });
          send(room.plugin, { type: "request", id, method: msg.method, params: msg.params });
          return;
        }
        case "response":
        case "progress": {
          if (peer.role !== "plugin") return;
          const p = pending.get(msg.id);
          if (!p) return;
          if (msg.type === "progress") {
            send(p.agent, { type: "progress", id: p.originalId, done: msg.done, total: msg.total, message: msg.message });
          } else {
            pending.delete(msg.id);
            send(p.agent, { type: "response", id: p.originalId, result: msg.result, error: msg.error });
          }
          return;
        }
      }
    });
  });

  const heartbeat = setInterval(() => {
    for (const peer of peers) {
      if (!peer.alive) {
        peer.ws.terminate();
        continue;
      }
      peer.alive = false;
      peer.ws.ping();
    }
  }, options.heartbeatMs ?? HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  return new Promise((resolve, reject) => {
    wss.once("error", reject);
    wss.once("listening", () => {
      wss.off("error", reject);
      wss.on("error", (err) => log.warn(err.message));
      const address = wss.address();
      const port = typeof address === "object" && address ? address.port : options.port ?? DEFAULT_BRIDGE_PORT;
      log.info(`listening on ws://${options.host ?? "127.0.0.1"}:${port}`);
      resolve({
        port,
        stats: () => ({
          rooms: rooms.size,
          plugins: [...rooms.values()].filter((r) => r.plugin).length,
          agents: [...rooms.values()].reduce((n, r) => n + r.agents.size, 0),
          pending: pending.size,
        }),
        close: () =>
          new Promise<void>((done) => {
            clearInterval(heartbeat);
            peers.forEach((p) => p.ws.terminate());
            wss.close(() => done());
          }),
      });
    });
  });
}
