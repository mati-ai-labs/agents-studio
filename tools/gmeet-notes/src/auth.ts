/** OAuth 2.0 authorization-code setup with PKCE (S256) and CSRF state check. */

import { spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { saveConfig, type Dirs } from "./config.js";
import { SCOPES, TOKEN_ENDPOINT } from "./core.js";
import { pkcePair, randomState, truncate } from "./util.js";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

export interface AuthSetupOptions {
  clientId: string;
  clientSecret: string;
  email?: string;
  port: number;
}

function respond(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<html><body><h2>${message}</h2><p>You can close this tab.</p></body></html>`);
}

/** Best-effort browser open. Never uses a shell; the URL is ours. */
function tryOpen(url: string): void {
  try {
    const child =
      process.platform === "win32"
        ? spawn("cmd", ["/c", "start", "", url], { stdio: "ignore" })
        : spawn(process.platform === "darwin" ? "open" : "xdg-open", [url], { stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The URL is printed regardless; ignore open failures.
  }
}

/**
 * Wait for the OAuth redirect on 127.0.0.1:port. Resolves only when the `state`
 * matches (CSRF protection). Rejects on error, timeout, or bind failure.
 */
function waitForCode(port: number, expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", `http://localhost:${port}`);
      const error = u.searchParams.get("error");
      if (error) {
        respond(res, 400, "Authorization error.");
        cleanup();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }
      const code = u.searchParams.get("code");
      const state = u.searchParams.get("state");
      if (!code || state !== expectedState) {
        // Stray request (favicon, wrong state) — do not resolve.
        respond(res, 400, "Invalid or missing state/code.");
        return;
      }
      respond(res, 200, "Authorization received.");
      cleanup();
      resolve(code);
    });

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for OAuth callback"));
    }, CALLBACK_TIMEOUT_MS);

    function cleanup(): void {
      clearTimeout(timer);
      server.close();
    }

    server.on("error", (e) => {
      cleanup();
      reject(new Error(`could not bind 127.0.0.1:${port} (${(e as Error).message})`));
    });
    // Loopback only — never exposed to the network.
    server.listen(port, "127.0.0.1");
  });
}

export async function runAuthSetup(dirs: Dirs, opts: AuthSetupOptions): Promise<void> {
  const redirectUri = `http://localhost:${opts.port}/`;
  const state = randomState();
  const { verifier, challenge } = pkcePair();

  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
    scope: SCOPES.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const url = `${AUTH_ENDPOINT}?${params}`;
  console.log("Open this URL and complete consent:\n\n" + url + "\n");
  tryOpen(url);
  console.log(`Waiting for the OAuth callback on ${redirectUri} ...`);

  const code = await waitForCode(opts.port, state);

  const body = new URLSearchParams({
    code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    code_verifier: verifier,
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`token exchange failed (HTTP ${res.status}): ${truncate(text)}`);
  }
  const tok = JSON.parse(text) as { refresh_token?: string; access_token?: string; scope?: string };
  if (typeof tok.refresh_token !== "string") {
    throw new Error("no refresh_token returned; re-run auth setup with a freshly authorized account");
  }

  saveConfig(dirs, {
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    refresh_token: tok.refresh_token,
    access_token: tok.access_token,
    scope: tok.scope ?? SCOPES.join(" "),
    token_endpoint: TOKEN_ENDPOINT,
    email: opts.email ?? "",
    calendar_id: opts.email || "primary",
  });
  console.log("Saved credentials. Next: gmeet-notes check");
}
