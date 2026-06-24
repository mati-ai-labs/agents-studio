/**
 * @fileoverview Frontend API client for connector management.
 *
 * Maps 1:1 to REST endpoints on server/src/routes/connectors.ts.
 *
 * @see server/src/routes/connectors.ts
 * @see server/src/services/connector-registry.ts
 */

import { api } from "./client";

export type ConnectorType = "google_workspace" | "notion" | "linear" | "jira" | "github" | "aws" | "hostinger" | "surge";
export type ConnectorStatus = "disconnected" | "connecting" | "connected" | "error";

export interface ConnectorRecord {
  id: string;
  companyId: string;
  type: ConnectorType;
  config: Record<string, unknown>;
  status: ConnectorStatus;
  displayName: string | null;
  lastError: string | null;
  connectedAt: string | null;
  disconnectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorListResponse {
  connectors: ConnectorRecord[];
}

export interface InitiateOAuthResponse {
  authorizationUrl: string;
  state: string;
}

export interface ConfigureConnectorInput {
  baseUrl?: string;
  email?: string;
  accessToken?: string;
  // AWS fields
  awsAccessKeyId?: string;
  awsSecretAccessKey?: string;
  region?: string;
  bucketName?: string;
  // Hostinger fields
  apiToken?: string;
  domain?: string;
  // Surge fields
  token?: string;
  default_domain?: string;
}

function withCompanyId(path: string, companyId?: string): string {
  if (!companyId) return path;
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}companyId=${encodeURIComponent(companyId)}`;
}

/** List all connectors for the current company. */
async function list(companyId?: string): Promise<ConnectorRecord[]> {
  const res = await api.get<ConnectorListResponse>(withCompanyId("/connectors", companyId));
  return res.connectors;
}

/** Get a single connector by type. */
async function get(type: ConnectorType, companyId?: string): Promise<ConnectorRecord> {
  return api.get<ConnectorRecord>(withCompanyId(`/connectors/${type}`, companyId));
}

/** Initiate OAuth flow for a connector type. Returns authorization URL. */
async function initiateConnect(type: ConnectorType, companyId?: string): Promise<InitiateOAuthResponse> {
  return api.post<InitiateOAuthResponse>(withCompanyId(`/connectors/${type}/connect`, companyId), {});
}

/** Disconnect (remove credentials) for a connector type. */
async function disconnect(type: ConnectorType, companyId?: string): Promise<void> {
  await api.delete(withCompanyId(`/connectors/${type}`, companyId));
}

/** Enable MCP tools for a connector. */
async function enable(type: ConnectorType, companyId?: string): Promise<ConnectorRecord> {
  const res = await api.post<{ success: boolean; connector: ConnectorRecord }>(
    withCompanyId(`/connectors/${type}/enable`, companyId),
    {},
  );
  return res.connector;
}

/** Disable MCP tools for a connector. */
async function disable(type: ConnectorType, companyId?: string): Promise<ConnectorRecord> {
  const res = await api.post<{ success: boolean; connector: ConnectorRecord }>(
    withCompanyId(`/connectors/${type}/disable`, companyId),
    {},
  );
  return res.connector;
}

/** Configure a manual-credentials connector (jira/github). */
async function configure(type: ConnectorType, input: ConfigureConnectorInput, companyId?: string): Promise<ConnectorRecord> {
  const res = await api.post<{ success: boolean; connector: ConnectorRecord }>(
    withCompanyId(`/connectors/${type}/configure`, companyId),
    input,
  );
  return res.connector;
}

export const connectorsApi = {
  list,
  get,
  initiateConnect,
  configure,
  disconnect,
  enable,
  disable,
};
