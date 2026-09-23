import {
  asString,
  asStringArray,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";

type OpenCodeMcpServer = Record<string, unknown>;

function readHeadersRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const headers: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (typeof rawValue !== "string") continue;
    const headerKey = key.trim();
    const headerValue = rawValue.trim();
    if (!headerKey || !headerValue) continue;
    headers[headerKey] = headerValue;
  }
  return headers;
}

function readBearerHeaders(candidate: Record<string, unknown>): Record<string, string> {
  const configured = readHeadersRecord(candidate.headers);
  if (Object.keys(configured).length > 0) return configured;

  const accessToken =
    asString(candidate.accessToken, "").trim() || asString(candidate.token, "").trim();
  return accessToken
    ? { Authorization: `Bearer ${accessToken}` }
    : {};
}

function readRemoteServer(
  candidate: Record<string, unknown>,
  fallbackName: string,
): [string, OpenCodeMcpServer] | null {
  const url = asString(candidate.url, "").trim();
  if (!url) return null;
  const serverName = asString(candidate.serverName, fallbackName).trim() || fallbackName;
  const headers = readBearerHeaders(candidate);
  return [
    serverName,
    {
      type: "remote",
      url,
      enabled: true,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    },
  ];
}

function readJiraServer(candidate: Record<string, unknown>): [string, OpenCodeMcpServer] | null {
  const serverName = asString(candidate.serverName, "jira").trim() || "jira";
  const command = asString(candidate.command, "").trim();
  const args = asStringArray(candidate.args).map((entry) => entry.trim()).filter(Boolean);
  if (command) {
    const environment = readHeadersRecord(candidate.env);
    return [
      serverName,
      {
        type: "local",
        command: [command, ...args],
        enabled: true,
        ...(Object.keys(environment).length > 0 ? { environment } : {}),
      },
    ];
  }

  return readRemoteServer(candidate, serverName);
}

/**
 * Convert Paperclip's adapter MCP hints into OpenCode's runtime config shape.
 * Credentials are intentionally only materialized into the run-scoped config;
 * this function never logs or returns a diagnostic containing a credential.
 */
export function buildOpenCodeMcpConfig(value: unknown): Record<string, OpenCodeMcpServer> {
  const root = parseObject(value);
  const servers: Record<string, OpenCodeMcpServer> = {};

  const add = (entry: [string, OpenCodeMcpServer] | null) => {
    if (!entry) return;
    servers[entry[0]] = entry[1];
  };

  add(readRemoteServer(parseObject(root.googleWorkspace ?? root["google-workspace"]), "google-workspace"));
  add(readJiraServer(parseObject(root.jira)));
  add(readRemoteServer(parseObject(root.github), "github"));
  add(readRemoteServer(parseObject(root.metaAds ?? root["meta-ads"]), "meta-ads"));

  return servers;
}
