import type { IncomingMessage, Server as HttpServer } from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import type { Db } from "@paperclipai/db";
import type { DeploymentMode } from "@paperclipai/shared";
import type { BetterAuthSessionResult } from "../auth/better-auth.js";
import { logger } from "../middleware/logger.js";
import { previewLeaseService } from "../services/previews.js";
import {
  buildPreviewUpstreamHeaders,
  buildPreviewUpstreamUrl,
  parsePreviewRequestTarget,
} from "../services/preview-proxy.js";
import {
  authorizeUpgrade,
  headersFromIncomingMessage,
  rejectUpgrade,
} from "./live-events-ws.js";

interface WsSocket {
  readyState: number;
  send(data: unknown, options?: { binary?: boolean }): void;
  close(code?: number, reason?: string | Buffer): void;
  terminate(): void;
  on(event: string, listener: (...args: any[]) => void): void;
}

interface WsServer {
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (ws: WsSocket) => void,
  ): void;
}

const require = createRequire(import.meta.url);
const { WebSocket, WebSocketServer } = require("ws") as {
  WebSocket: {
    new (url: string, options?: { headers?: Record<string, string>; protocols?: string[] }): WsSocket;
    OPEN: number;
  };
  WebSocketServer: new (opts: { noServer: boolean }) => WsServer;
};

function headersToObject(headers: Headers) {
  return Object.fromEntries(headers.entries());
}

function removePaperclipToken(search: string) {
  const params = new URLSearchParams(search);
  params.delete("token");
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

function websocketProtocols(req: IncomingMessage) {
  const raw = req.headers["sec-websocket-protocol"];
  const value = Array.isArray(raw) ? raw.join(",") : raw;
  return value
    ?.split(",")
    .map((protocol) => protocol.trim())
    .filter(Boolean);
}

function rejectPreviewUpgrade(socket: Duplex, status: number, message: string) {
  const statusText = status === 404
    ? "Not Found"
    : status === 410
      ? "Gone"
      : status === 503
        ? "Service Unavailable"
        : status === 403
          ? "Forbidden"
          : "Bad Gateway";
  rejectUpgrade(socket, `${status} ${statusText}`, message);
}

function bridgeWebSockets(client: WsSocket, upstream: WsSocket, expiresAt: Date) {
  const pending: Array<{ data: unknown; binary: boolean }> = [];
  let closed = false;
  const expiryTimer = setTimeout(() => {
    if (client.readyState === WebSocket.OPEN) client.close(1000, "Preview expired");
    if (upstream.readyState === WebSocket.OPEN) upstream.close(1000, "Preview expired");
  }, Math.max(0, expiresAt.getTime() - Date.now()));
  expiryTimer.unref?.();

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(expiryTimer);
  };

  client.on("message", (data: unknown, isBinary: boolean) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
      return;
    }
    pending.push({ data, binary: isBinary });
  });
  client.on("close", () => {
    cleanup();
    if (upstream.readyState === WebSocket.OPEN) upstream.close();
    else upstream.terminate();
  });
  client.on("error", () => {
    cleanup();
    upstream.terminate();
  });

  upstream.on("open", () => {
    for (const message of pending.splice(0)) {
      if (client.readyState !== WebSocket.OPEN) break;
      upstream.send(message.data, { binary: message.binary });
    }
  });
  upstream.on("message", (data: unknown, isBinary: boolean) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  upstream.on("close", (code: number, reason: Buffer) => {
    cleanup();
    if (client.readyState === WebSocket.OPEN) client.close(code, reason);
  });
  upstream.on("error", (err: Error) => {
    cleanup();
    logger.warn({ err }, "preview websocket upstream error");
    if (client.readyState === WebSocket.OPEN) client.close(1011, "Preview upstream failed");
  });
}

export function setupPreviewWebSocketServer(
  server: HttpServer,
  db: Db,
  opts: {
    deploymentMode: DeploymentMode;
    resolveSessionFromHeaders?: (headers: Headers) => Promise<BetterAuthSessionResult | null>;
  },
) {
  const wss = new WebSocketServer({ noServer: true });
  const previews = previewLeaseService(db);

  server.on("upgrade", (req, socket, head) => {
    if (!req.url) {
      rejectPreviewUpgrade(socket, 400, "missing url");
      return;
    }

    const requestUrl = new URL(req.url, "http://paperclip-preview.local");
    const isPreviewPath = requestUrl.pathname === "/preview" || requestUrl.pathname.startsWith("/preview/");
    if (!isPreviewPath) return;
    const target = parsePreviewRequestTarget(req.url);
    if (!target) {
      rejectPreviewUpgrade(socket, 400, "invalid preview path");
      return;
    }

    const rawUrl = req.url;
    void (async () => {
      const preview = await previews.getBySlug(target.slug);
      if (!preview) {
        rejectPreviewUpgrade(socket, 404, "preview not found");
        return;
      }
      if (preview.lease.status === "expired") {
        rejectPreviewUpgrade(socket, 410, "preview expired");
        return;
      }
      if (preview.lease.status === "revoked") {
        rejectPreviewUpgrade(socket, 410, "preview revoked");
        return;
      }

      const port = preview.runtimeService.port;
      if (
        preview.runtimeService.provider !== "local_process" ||
        !port ||
        port < 1 ||
        port > 65_535 ||
        preview.runtimeService.status !== "running"
      ) {
        rejectPreviewUpgrade(socket, 503, "preview runtime service is not running");
        return;
      }

      const url = new URL(rawUrl, "http://paperclip-preview.local");
      const context = await authorizeUpgrade(db, req, preview.lease.companyId, url, opts);
      if (!context) {
        rejectPreviewUpgrade(socket, 403, "forbidden");
        return;
      }

      const sourceHeaders = headersFromIncomingMessage(req);
      sourceHeaders.delete("sec-websocket-key");
      sourceHeaders.delete("sec-websocket-version");
      sourceHeaders.delete("sec-websocket-extensions");
      sourceHeaders.delete("sec-websocket-protocol");
      const upstreamHeaders = buildPreviewUpstreamHeaders({
        source: sourceHeaders,
        port,
        slug: target.slug,
        forwardedFor: req.socket.remoteAddress,
      });

      wss.handleUpgrade(req, socket, head, (client) => {
        const upstream = new WebSocket(
          buildPreviewUpstreamUrl(port, {
            targetPath: target.targetPath,
            search: removePaperclipToken(target.search),
          }).replace(/^http:/, "ws:"),
          {
            headers: headersToObject(upstreamHeaders),
            protocols: websocketProtocols(req),
          },
        );
        bridgeWebSockets(client, upstream, preview.lease.expiresAt);
      });
    })()
      .catch((err) => {
        logger.error({ err, path: rawUrl }, "failed preview websocket upgrade");
        rejectPreviewUpgrade(socket, 502, "preview upgrade failed");
      });
  });

  return wss;
}
