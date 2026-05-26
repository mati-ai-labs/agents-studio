/**
 * MCP connector tools for the Paperclip MCP server.
 *
 * These tools expose connector functionality (Gmail, Calendar, Drive, Notion, Linear)
 * as MCP-native tools via the existing `paperclipApiRequest` tool pattern.
 *
 * Each connector tool is a Zod schema + a function that calls `paperclipApiRequest`
 * with the appropriate connector route path. The actual connector execution is
 * performed server-side by `executeConnectorTool` in `server/src/services/connector-tools.ts`.
 *
 * The MCP server is a stdio process that uses `PaperclipApiClient` to call the
 * Paperclip REST API. Since connector tools are part of the unified tool dispatcher
 * (executed via `POST /api/plugins/tools/execute`), we expose them here as well
 * by calling that same endpoint.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

export const companyIdOptional = z.string().uuid().optional().nullable();
const companyIdSchema = z.string().uuid();

// ---------------------------------------------------------------------------
// Google Workspace tools
// ---------------------------------------------------------------------------

export const gmailSendSchema = z.object({
  companyId: companyIdOptional,
  to: z.string().email(),
  subject: z.string().min(1),
  body: z.string().min(1),
  cc: z.string().optional(),
  bcc: z.string().optional(),
});

export const gmailReadSchema = z.object({
  companyId: companyIdOptional,
  query: z.string().optional(),
  maxResults: z.number().int().positive().max(100).default(10),
});

export const calendarEventsSchema = z.object({
  companyId: companyIdOptional,
  timeMin: z.string().datetime().optional(),
  timeMax: z.string().datetime().optional(),
  maxResults: z.number().int().positive().max(100).default(20),
});

export const calendarCreateSchema = z.object({
  companyId: companyIdOptional,
  summary: z.string().min(1),
  description: z.string().optional(),
  start: z.string().datetime(),
  end: z.string().datetime(),
  attendees: z.array(z.string().email()).optional(),
});

export const driveListSchema = z.object({
  companyId: companyIdOptional,
  query: z.string().optional(),
  pageSize: z.number().int().positive().max(100).default(20),
});

// ---------------------------------------------------------------------------
// Notion tools
// ---------------------------------------------------------------------------

export const notionSearchSchema = z.object({
  companyId: companyIdOptional,
  query: z.string().min(1),
  filter: z.enum(["page", "database"]).optional(),
  sort: z.enum([" relevance", "last_edited", "created"]).optional(),
  pageSize: z.number().int().positive().max(100).default(10),
});

export const notionGetPageSchema = z.object({
  companyId: companyIdOptional,
  pageId: z.string().min(1),
});

export const notionCreatePageSchema = z.object({
  companyId: companyIdOptional,
  parentId: z.string().min(1),
  properties: z.record(z.any()).optional(),
  children: z.array(z.any()).optional(),
  title: z.string().min(1).optional(),
});

// ---------------------------------------------------------------------------
// Linear tools
// ---------------------------------------------------------------------------

export const linearSearchIssuesSchema = z.object({
  companyId: companyIdOptional,
  query: z.string().optional(),
  teamId: z.string().optional(),
  assigneeId: z.string().optional(),
  status: z.string().optional(),
  limit: z.number().int().positive().max(100).default(20),
});

export const linearCreateIssueSchema = z.object({
  companyId: companyIdOptional,
  teamId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  assigneeId: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  priority: z.enum(["urgent", "high", "medium", "low", "none"]).optional(),
});

export const linearUpdateIssueSchema = z.object({
  companyId: companyIdOptional,
  issueId: z.string().min(1),
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  assigneeId: z.string().optional(),
  status: z.string().optional(),
  priority: z.enum(["urgent", "high", "medium", "low", "none"]).optional(),
});

export const linearListTeamsSchema = z.object({
  companyId: companyIdOptional,
});

// ---------------------------------------------------------------------------
// Connector tool definitions for the MCP server
//
// The MCP server uses a PaperclipApiClient that calls POST /api/plugins/tools/execute.
// Since connector tools are registered in the unified tool dispatcher alongside plugin
// tools, we expose them here by name. The `paperclipApiRequest` tool handles the
// actual HTTP call to the MCP server's `/api/plugins/tools/execute` endpoint.
//
// For the MCP server to expose connector tools natively (without needing
// `paperclipApiRequest`), the server would need to call the unified dispatcher
// directly. That's a future enhancement. For now, agents using the MCP server
// can call connector tools via `paperclipApiRequest`.
//
// The tools below are defined as Zod schemas for documentation/validation purposes
// but are NOT registered as MCP tools directly — they are accessible via
// `paperclipApiRequest({ method: "POST", path: "/plugins/tools/execute", jsonBody: { ... }})`.
//
// To add native MCP connector tools, add them to `packages/mcp-server/src/tools.ts`
// similar to the existing paperclip* tools, calling the unified dispatcher's
// `/api/plugins/tools/execute` endpoint.
// ---------------------------------------------------------------------------

export interface ConnectorMcpTool {
  /** Bare tool name matching the server-side executeConnectorTool switch (e.g. "gmail_send"). */
  bareName: string;
  /** MCP-visible tool name (e.g. "google_gmail_send"). */
  mcpToolName: string;
  description: string;
  schema: z.ZodObject<any>;
  connectorType: string;
}

export const CONNECTOR_MCP_TOOLS: ConnectorMcpTool[] = [
  // Google Workspace — bareNames match server-side executeConnectorTool switch
  {
    bareName: "gmail_send",
    mcpToolName: "google_gmail_send",
    description: "Send an email via Gmail",
    schema: gmailSendSchema,
    connectorType: "google_workspace",
  },
  {
    bareName: "gmail_read",
    mcpToolName: "google_gmail_read",
    description: "Search and read emails from Gmail",
    schema: gmailReadSchema,
    connectorType: "google_workspace",
  },
  {
    bareName: "calendar_events",
    mcpToolName: "google_calendar_events",
    description: "List calendar events from Google Calendar",
    schema: calendarEventsSchema,
    connectorType: "google_workspace",
  },
  {
    bareName: "calendar_create",
    mcpToolName: "google_calendar_create",
    description: "Create a calendar event in Google Calendar",
    schema: calendarCreateSchema,
    connectorType: "google_workspace",
  },
  {
    bareName: "drive_list",
    mcpToolName: "google_drive_list",
    description: "List files in Google Drive",
    schema: driveListSchema,
    connectorType: "google_workspace",
  },
  // Notion
  {
    bareName: "notion_search",
    mcpToolName: "notion_search",
    description: "Search Notion pages and databases",
    schema: notionSearchSchema,
    connectorType: "notion",
  },
  {
    bareName: "notion_get_page",
    mcpToolName: "notion_get_page",
    description: "Get a Notion page by ID",
    schema: notionGetPageSchema,
    connectorType: "notion",
  },
  {
    bareName: "notion_create_page",
    mcpToolName: "notion_create_page",
    description: "Create a new Notion page",
    schema: notionCreatePageSchema,
    connectorType: "notion",
  },
  // Linear — bareNames match server-side executeConnectorTool switch
  {
    bareName: "linear_issues",
    mcpToolName: "linear_search_issues",
    description: "Search Linear issues",
    schema: linearSearchIssuesSchema,
    connectorType: "linear",
  },
  {
    bareName: "linear_create_issue",
    mcpToolName: "linear_create_issue",
    description: "Create a Linear issue",
    schema: linearCreateIssueSchema,
    connectorType: "linear",
  },
  {
    bareName: "linear_update_issue",
    mcpToolName: "linear_update_issue",
    description: "Update a Linear issue",
    schema: linearUpdateIssueSchema,
    connectorType: "linear",
  },
  {
    bareName: "linear_list_teams",
    mcpToolName: "linear_list_teams",
    description: "List Linear teams",
    schema: linearListTeamsSchema,
    connectorType: "linear",
  },
];