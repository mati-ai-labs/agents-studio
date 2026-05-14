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
function list(): Promise<ConnectorRecord[]> {
   return api.get<ConnectorListResponse>("/api/connectors");
}

/** Get a single connector by type. */
function get(type: ConnectorType): Promise<ConnectorRecord> {
  return api.get<ConnectorRecord>(`/api/connectors/${type}`);
}

/** Initiate OAuth flow for a connector type. Returns authorization URL. */
function initiateConnect(type: ConnectorType): Promise<InitiateOAuthResponse> {
  return api.post<InitiateOAuthResponse>(`/api/connectors/${type}/connect`);
}

/** Disconnect (remove credentials) for a connector type. */
function disconnect(type: ConnectorType): Promise<void> {
  await api.delete(`/api/connectors/${type}`);
}

/** Enable MCP tools for a connector. */
function enable(type: ConnectorType): Promise<ConnectorRecord> {
   return api.post<{ success: boolean; connector: ConnectorRecord }>(
    `/api/connectors/${type}/enable`,
  );
}

/** Disable MCP tools for a connector. */
function disable(type: ConnectorType): Promise<ConnectorRecord> {
   return api.post<{ success: boolean; connector: ConnectorRecord }>(
    `/api/connectors/${type}/disable`,
  );
}

export const connectorsApi = {
  list,
  get,
  initiateConnect,
  disconnect,
  enable,
  disable,
};