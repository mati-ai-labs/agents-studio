/**
 * @fileoverview Frontend API client for connector management.
 *
 * Maps 1:1 to REST endpoints on server/src/routes/connectors.ts.
 *
 * @see server/src/routes/connectors.ts
 * @see server/src/services/connector-registry.ts
 */

import { api } from "./client";

export type ConnectorType = "google_workspace" | "notion" | "linear";
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

/** List all connectors for the current company. */
async function list(): Promise<ConnectorRecord[]> {
  const res = await api.get<ConnectorListResponse>("/api/connectors");
  return res.data.connectors;
}

/** Get a single connector by type. */
async function get(type: ConnectorType): Promise<ConnectorRecord> {
  const res = await api.get<ConnectorRecord>(`/api/connectors/${type}`);
  return res.data;
}

/** Initiate OAuth flow for a connector type. Returns authorization URL. */
async function initiateConnect(type: ConnectorType): Promise<InitiateOAuthResponse> {
  const res = await api.post<InitiateOAuthResponse>(`/api/connectors/${type}/connect`);
  return res.data;
}

/** Disconnect (remove credentials) for a connector type. */
async function disconnect(type: ConnectorType): Promise<void> {
  await api.delete(`/api/connectors/${type}`);
}

/** Enable MCP tools for a connector. */
async function enable(type: ConnectorType): Promise<ConnectorRecord> {
  const res = await api.post<{ success: boolean; connector: ConnectorRecord }>(
    `/api/connectors/${type}/enable`,
  );
  return res.data.connector;
}

/** Disable MCP tools for a connector. */
async function disable(type: ConnectorType): Promise<ConnectorRecord> {
  const res = await api.post<{ success: boolean; connector: ConnectorRecord }>(
    `/api/connectors/${type}/disable`,
  );
  return res.data.connector;
}

export const connectorsApi = {
  list,
  get,
  initiateConnect,
  disconnect,
  enable,
  disable,
};