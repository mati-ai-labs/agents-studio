/**
 * @fileoverview Connector tool definitions — schemas and implementations for
 * MCP tools exposed by connected integrations (Google Workspace, Notion, Linear).
 *
 * These tools are available to agents when a connector is in "connected" state.
 * Each tool wraps a REST API call using the connector's stored credentials.
 *
 * @see connector-registry.ts for credential management
 */

import type { Db } from "@paperclipai/db";
import { connectorRegistryService } from "./connector-registry.js";
import { logger } from "../middleware/logger.js";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface ConnectorToolInput {
  companyId: string;
  args: Record<string, unknown>;
}

export interface ConnectorToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// Google Workspace tools
// ---------------------------------------------------------------------------

async function gworkspace_get_credentials(db: Db, companyId: string) {
  const registry = connectorRegistryService(db);
  return registry.getCredentialsAsync(companyId, "google_workspace");
}

export async function gworkspace_gmail_send(db: Db, input: ConnectorToolInput): Promise<ConnectorToolResult> {
  try {
    const creds = await gworkspace_get_credentials(db, input.companyId);
    if (!creds) return { success: false, error: "Google Workspace not connected" };

    const { to, subject, body, cc, bcc } = input.args as {
      to: string; subject: string; body: string; cc?: string; bcc?: string;
    };

    const emailRaw = [
      `To: ${to}`,
      `Subject: ${subject}`,
      cc ? `Cc: ${cc}` : "",
      bcc ? `Bcc: ${bcc}` : "",
      "",
      body,
    ].filter(Boolean).join("\r\n");

    const encoded = Buffer.from(emailRaw).toString("base64url");

    const resp = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw: encoded }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      logger.error({ err, status: resp.status }, "gmail_send failed");
      return { success: false, error: `Gmail API error: ${resp.status}` };
    }

    const result = await resp.json();
    return { success: true, data: result };
  } catch (err) {
    logger.error({ err }, "gmail_send error");
    return { success: false, error: String(err) };
  }
}

export async function gworkspace_gmail_read(db: Db, input: ConnectorToolInput): Promise<ConnectorToolResult> {
  try {
    const creds = await gworkspace_get_credentials(db, input.companyId);
    if (!creds) return { success: false, error: "Google Workspace not connected" };

    const { query = "", maxResults = 10 } = input.args as { query?: string; maxResults?: number };

    const params = new URLSearchParams({
      q: query,
      maxResults: String(maxResults),
    });

    const resp = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`,
      { headers: { Authorization: `Bearer ${creds.accessToken}` } },
    );

    if (!resp.ok) return { success: false, error: `Gmail API error: ${resp.status}` };
    const data = await resp.json();
    return { success: true, data };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export async function gworkspace_calendar_events(db: Db, input: ConnectorToolInput): Promise<ConnectorToolResult> {
  try {
    const creds = await gworkspace_get_credentials(db, input.companyId);
    if (!creds) return { success: false, error: "Google Workspace not connected" };

    const { timeMin, timeMax, maxResults = 20 } = input.args as {
      timeMin?: string; timeMax?: string; maxResults?: number;
    };

    const params = new URLSearchParams({ maxResults: String(maxResults) });
    if (timeMin) params.set("timeMin", timeMin);
    if (timeMax) params.set("timeMax", timeMax);

    const resp = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
      { headers: { Authorization: `Bearer ${creds.accessToken}` } },
    );

    if (!resp.ok) return { success: false, error: `Calendar API error: ${resp.status}` };
    const data = await resp.json();
    return { success: true, data };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export async function gworkspace_calendar_create(db: Db, input: ConnectorToolInput): Promise<ConnectorToolResult> {
  try {
    const creds = await gworkspace_get_credentials(db, input.companyId);
    if (!creds) return { success: false, error: "Google Workspace not connected" };

    const { summary, description, start, end, attendees } = input.args as {
      summary: string; description?: string; start: string; end: string; attendees?: string[];
    };

    const event = {
      summary,
      description,
      start: { dateTime: start, timeZone: "UTC" },
      end: { dateTime: end, timeZone: "UTC" },
      attendees: attendees?.map((email) => ({ email })),
    };

    const resp = await fetch(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${creds.accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(event),
      },
    );

    if (!resp.ok) return { success: false, error: `Calendar API error: ${resp.status}` };
    const data = await resp.json();
    return { success: true, data };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export async function gworkspace_drive_list(db: Db, input: ConnectorToolInput): Promise<ConnectorToolResult> {
  try {
    const creds = await gworkspace_get_credentials(db, input.companyId);
    if (!creds) return { success: false, error: "Google Workspace not connected" };

    const { query = "trashed=false", pageSize = 20 } = input.args as { query?: string; pageSize?: number };

    const params = new URLSearchParams({ q: query, pageSize: String(pageSize) });
    const resp = await fetch(
      `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
      { headers: { Authorization: `Bearer ${creds.accessToken}` } },
    );

    if (!resp.ok) return { success: false, error: `Drive API error: ${resp.status}` };
    const data = await resp.json();
    return { success: true, data };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Notion tools
// ---------------------------------------------------------------------------

async function notion_get_credentials(db: Db, companyId: string) {
  const registry = connectorRegistryService(db);
  return registry.getCredentialsAsync(companyId, "notion");
}

async function notion_api(
  db: Db,
  companyId: string,
  path: string,
  options: RequestInit = {},
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const creds = await notion_get_credentials(db, companyId);
  if (!creds) return { ok: false, error: "Notion not connected" };

  const resp = await fetch(`https://api.notion.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!resp.ok) {
    const err = await resp.text();
    return { ok: false, error: err };
  }
  const data = await resp.json();
  return { ok: true, data };
}

export async function notion_search(db: Db, input: ConnectorToolInput): Promise<ConnectorToolResult> {
  try {
    const { query = "", pageSize = 20 } = input.args as { query?: string; pageSize?: number };
    const result = await notion_api(db, input.companyId, "/search", {
      method: "POST",
      body: JSON.stringify({ query, page_size: pageSize }),
    });
    return result;
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export async function notion_get_page(db: Db, input: ConnectorToolInput): Promise<ConnectorToolResult> {
  try {
    const { pageId } = input.args as { pageId: string };
    const result = await notion_api(db, input.companyId, `/pages/${pageId}`);
    return result;
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export async function notion_create_page(db: Db, input: ConnectorToolInput): Promise<ConnectorToolResult> {
  try {
    const { parentId, title, content } = input.args as {
      parentId: string; title: string; content?: string;
    };
    const result = await notion_api(db, input.companyId, "/pages", {
      method: "POST",
      body: JSON.stringify({
        parent: { page_id: parentId },
        properties: {
          title: { title: [{ text: { content: title } }] },
        },
        children: content ? [{
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: [{ type: "text", text: { content } }] },
        }] : [],
      }),
    });
    return result;
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Linear tools
// ---------------------------------------------------------------------------

async function linear_get_credentials(db: Db, companyId: string) {
  const registry = connectorRegistryService(db);
  return registry.getCredentialsAsync(companyId, "linear");
}

async function linear_graphql(
  db: Db,
  companyId: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const creds = await linear_get_credentials(db, companyId);
  if (!creds) return { ok: false, error: "Linear not connected" };

  const resp = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    return { ok: false, error: err };
  }
  const data = await resp.json() as { data?: unknown; errors?: unknown };
  if (data.errors) return { ok: false, error: JSON.stringify(data.errors) };
  return { ok: true, data: data.data };
}

export async function linear_issues(db: Db, input: ConnectorToolInput): Promise<ConnectorToolResult> {
  try {
    const { filter = "{}", limit = 20 } = input.args as { filter?: string; limit?: number };
    const result = await linear_graphql(
      db,
      input.companyId,
      `query Issues($filter: IssueFilter, $limit: Int) {
        issues(filter: $filter, first: $limit) { nodes { id identifier title state { name } assignee { name } createdAt updatedAt } } }
      }`,
      { filter: JSON.parse(filter), limit },
    );
    return result;
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export async function linear_create_issue(db: Db, input: ConnectorToolInput): Promise<ConnectorToolResult> {
  try {
    const { teamId, title, description, priority, labelIds } = input.args as {
      teamId: string; title: string; description?: string; priority?: number; labelIds?: string[];
    };
    const result = await linear_graphql(
      db,
      input.companyId,
      `mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) { success issue { id identifier title } }
      }`,
      {
        input: {
          teamId,
          title,
          description,
          priority: priority ?? 0,
          labelIds,
        },
      },
    );
    return result;
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Tool registry — maps connector tool name → implementation
// ---------------------------------------------------------------------------

export interface ConnectorToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const CONNECTOR_TOOLS: Record<ConnectorType, ConnectorToolDef[]> = {
  google_workspace: [
    {
      name: "gmail_send",
      description: "Send an email via Gmail. Requires: to, subject, body. Optional: cc, bcc.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email address" },
          subject: { type: "string", description: "Email subject" },
          body: { type: "string", description: "Email body text" },
          cc: { type: "string", description: "CC recipients (comma-separated)" },
          bcc: { type: "string", description: "BCC recipients (comma-separated)" },
        },
        required: ["to", "subject", "body"],
      },
    },
    {
      name: "gmail_read",
      description: "Search and read emails from Gmail. Requires: query (optional).",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Gmail search query" },
          maxResults: { type: "number", description: "Max results to return", default: 10 },
        },
      },
    },
    {
      name: "calendar_events",
      description: "List calendar events from Google Calendar.",
      inputSchema: {
        type: "object",
        properties: {
          timeMin: { type: "string", description: "ISO 8601 start time" },
          timeMax: { type: "string", description: "ISO 8601 end time" },
          maxResults: { type: "number", default: 20 },
        },
      },
    },
    {
      name: "calendar_create",
      description: "Create a calendar event in Google Calendar.",
      inputSchema: {
        type: "object",
        properties: {
          summary: { type: "string" },
          description: { type: "string" },
          start: { type: "string", description: "ISO 8601 start datetime" },
          end: { type: "string", description: "ISO 8601 end datetime" },
          attendees: { type: "array", items: { type: "string" }, description: "Email addresses" },
        },
        required: ["summary", "start", "end"],
      },
    },
    {
      name: "drive_list",
      description: "List files in Google Drive.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", default: "trashed=false" },
          pageSize: { type: "number", default: 20 },
        },
      },
    },
  ],
  notion: [
    {
      name: "notion_search",
      description: "Search Notion pages and databases.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          pageSize: { type: "number", default: 20 },
        },
      },
    },
    {
      name: "notion_get_page",
      description: "Retrieve a Notion page by ID.",
      inputSchema: {
        type: "object",
        properties: { pageId: { type: "string" } },
        required: ["pageId"],
      },
    },
    {
      name: "notion_create_page",
      description: "Create a new page in a Notion parent page.",
      inputSchema: {
        type: "object",
        properties: {
          parentId: { type: "string", description: "Parent page ID" },
          title: { type: "string" },
          content: { type: "string" },
        },
        required: ["parentId", "title"],
      },
    },
  ],
  linear: [
    {
      name: "linear_issues",
      description: "List Linear issues with optional filter.",
      inputSchema: {
        type: "object",
        properties: {
          filter: { type: "string", description: "JSON filter object", default: "{}" },
          limit: { type: "number", default: 20 },
        },
      },
    },
    {
      name: "linear_create_issue",
      description: "Create a Linear issue.",
      inputSchema: {
        type: "object",
        properties: {
          teamId: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          priority: { type: "number" },
          labelIds: { type: "array", items: { type: "string" } },
        },
        required: ["teamId", "title"],
      },
    },
  ],
};

type ConnectorType = "google_workspace" | "notion" | "linear";

/**
 * Execute a connector tool by name. Returns the result or an error.
 */
export async function executeConnectorTool(
  db: Db,
  toolName: string,
  companyId: string,
  args: Record<string, unknown>,
): Promise<ConnectorToolResult> {
  switch (toolName) {
    // Google Workspace
    case "gmail_send": return gworkspace_gmail_send(db, { companyId, args });
    case "gmail_read": return gworkspace_gmail_read(db, { companyId, args });
    case "calendar_events": return gworkspace_calendar_events(db, { companyId, args });
    case "calendar_create": return gworkspace_calendar_create(db, { companyId, args });
    case "drive_list": return gworkspace_drive_list(db, { companyId, args });
    // Notion
    case "notion_search": return notion_search(db, { companyId, args });
    case "notion_get_page": return notion_get_page(db, { companyId, args });
    case "notion_create_page": return notion_create_page(db, { companyId, args });
    // Linear
    case "linear_issues": return linear_issues(db, { companyId, args });
    case "linear_create_issue": return linear_create_issue(db, { companyId, args });
    default:
      return { success: false, error: `Unknown connector tool: ${toolName}` };
  }
}