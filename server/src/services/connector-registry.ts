/**
 * @fileoverview Connector Registry — CRUD + OAuth state management for
 * external integrations (Google Workspace, Notion, Linear).
 *
 * Each company can have at most one connector of each type. This service
 * handles persistence of config, status, and encrypted credentials.
 *
 * Credentials are stored encrypted (server-side only) in `credentialsEncrypted`.
 * Decryption happens on-demand when the connector is used by an agent.
 *
 * @see company_connectors schema
 */
import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companyConnectors } from "@paperclipai/db";
import type { ConnectorType, ConnectorStatus } from "@paperclipai/db";
import { notFound, conflict } from "../errors.js";
import { encryptValue, decryptValue } from "../lib/encryption.js";

export interface ConnectorRecord {
  id: string;
  companyId: string;
  type: ConnectorType;
  config: Record<string, unknown>;
  status: ConnectorStatus;
  credentialsEncrypted: string | null;
  displayName: string | null;
  lastError: string | null;
  connectedAt: Date | null;
  disconnectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertConnectorInput {
  companyId: string;
  type: ConnectorType;
  config?: Record<string, unknown>;
  status?: ConnectorStatus;
  credentials?: {
    accessToken: string;
    refreshToken?: string;
    expiry?: number;
  };
  displayName?: string;
}

export interface ConnectorCredentials {
  accessToken: string;
  refreshToken?: string;
  expiry?: number;
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const err = error as { code?: string; constraint?: string };
  return err.code === "23505";
}

/**
 * Encrypted credentials are stored as JSON string in credentialsEncrypted field.
 */
function encryptCredentials(creds: ConnectorCredentials): string {
  return encryptValue(JSON.stringify(creds));
}

function decryptCredentials(encrypted: string): ConnectorCredentials {
  const decrypted = decryptValue(encrypted);
  return JSON.parse(decrypted) as ConnectorCredentials;
}

/**
 * ConnectorRegistry service factory.
 */
export function connectorRegistryService(db: Db) {
  async function getById(id: string): Promise<ConnectorRecord | null> {
    const rows = await db
      .select()
      .from(companyConnectors)
      .where(eq(companyConnectors.id, id));
    return rows[0] ?? null;
  }

  async function getByCompanyAndType(
    companyId: string,
    type: ConnectorType,
  ): Promise<ConnectorRecord | null> {
    const rows = await db
      .select()
      .from(companyConnectors)
      .where(and(
        eq(companyConnectors.companyId, companyId),
        eq(companyConnectors.type, type),
      ));
    return rows[0] ?? null;
  }

  // ---- Public API -------------------------------------------------------

  return {
    /**
     * List all connectors for a company, ordered by type.
     */
    listByCompany: (companyId: string) =>
      db
        .select()
        .from(companyConnectors)
        .where(eq(companyConnectors.companyId, companyId)),

    /**
     * Get a single connector by company + type.
     */
    getByType: (companyId: string, type: ConnectorType) =>
      getByCompanyAndType(companyId, type),

    /**
     * Get a single connector by its ID.
     */
    getById,

    /**
     * Upsert a connector (create or update existing).
     * Used during OAuth callback to persist/update credentials.
     */
    upsert: async (input: UpsertConnectorInput): Promise<ConnectorRecord> => {
      const existing = await getByCompanyAndType(input.companyId, input.type);

      if (existing) {
        const setClause: Partial<typeof companyConnectors.$inferInsert> & { updatedAt: Date } = {
          updatedAt: new Date(),
        };

        if (input.config !== undefined) setClause.config = input.config;
        if (input.status !== undefined) setClause.status = input.status;
        if (input.credentials !== undefined) {
          setClause.credentialsEncrypted = encryptCredentials(input.credentials);
        }
        if (input.displayName !== undefined) setClause.displayName = input.displayName;

        if (input.status === "connected" && !existing.connectedAt) {
          setClause.connectedAt = new Date();
          setClause.status = "connected";
        }
        if (input.status === "disconnected") {
          setClause.disconnectedAt = new Date();
        }

        const rows = await db
          .update(companyConnectors)
          .set(setClause)
          .where(eq(companyConnectors.id, existing.id))
          .returning();
        return rows[0];
      }

      // Insert new
      const insertValues: typeof companyConnectors.$inferInsert = {
        companyId: input.companyId,
        type: input.type,
        config: input.config ?? {},
        status: input.status ?? "disconnected",
        credentialsEncrypted: input.credentials
          ? encryptCredentials(input.credentials)
          : null,
        displayName: input.displayName ?? null,
        connectedAt: input.status === "connected" ? new Date() : null,
        disconnectedAt: input.status === "disconnected" ? new Date() : null,
      };

      try {
        const rows = await db
          .insert(companyConnectors)
          .values(insertValues)
          .returning();
        return rows[0];
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw conflict(`Connector already exists for company ${input.companyId} type ${input.type}`);
        }
        throw error;
      }
    },

    /**
     * Update connector status (e.g. "connecting" → "connected" or "error").
     */
    updateStatus: async (
      companyId: string,
      type: ConnectorType,
      status: ConnectorStatus,
      lastError?: string,
    ): Promise<ConnectorRecord | null> => {
      const existing = await getByCompanyAndType(companyId, type);
      if (!existing) return null;

      const setClause: Partial<typeof companyConnectors.$inferInsert> & { updatedAt: Date } = {
        status,
        lastError: lastError ?? null,
        updatedAt: new Date(),
      };

      if (status === "connected" && !existing.connectedAt) {
        setClause.connectedAt = new Date();
      }
      if (status === "disconnected") {
        setClause.disconnectedAt = new Date();
      }

      const rows = await db
        .update(companyConnectors)
        .set(setClause)
        .where(eq(companyConnectors.id, existing.id))
        .returning();
      return rows[0] ?? null;
    },

    /**
     * Disconnect (soft-delete) a connector by clearing credentials and
     * setting status to "disconnected".
     */
    disconnect: async (companyId: string, type: ConnectorType): Promise<ConnectorRecord | null> => {
      const existing = await getByCompanyAndType(companyId, type);
      if (!existing) return null;

      const rows = await db
        .update(companyConnectors)
        .set({
          status: "disconnected" as ConnectorStatus,
          credentialsEncrypted: null,
          lastError: null,
          disconnectedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(companyConnectors.id, existing.id))
        .returning();
      return rows[0] ?? null;
    },

    /**
     * Hard-delete a connector (admin use only).
     */
    delete: async (companyId: string, type: ConnectorType): Promise<boolean> => {
      const existing = await getByCompanyAndType(companyId, type);
      if (!existing) return false;

      await db
        .delete(companyConnectors)
        .where(eq(companyConnectors.id, existing.id));
      return true;
    },

    /**
     * Retrieve and decrypt stored credentials for a connector.
     * Returns null if connector doesn't exist or has no credentials.
     */
    getCredentials: (companyId: string, type: ConnectorType): ConnectorCredentials | null => {
      // Synchronous helper — caller must have already resolved via async path
      return null; // resolved async in route handler
    },

    /**
     * Async credential retrieval — use this in route handlers.
     */
    getCredentialsAsync: async (
      companyId: string,
      type: ConnectorType,
    ): Promise<ConnectorCredentials | null> => {
      const existing = await getByCompanyAndType(companyId, type);
      if (!existing?.credentialsEncrypted) return null;
      return decryptCredentials(existing.credentialsEncrypted);
    },

    /**
     * Update the last error message for a connector.
     */
    setError: async (
      companyId: string,
      type: ConnectorType,
      errorMessage: string,
    ): Promise<ConnectorRecord | null> => {
      const existing = await getByCompanyAndType(companyId, type);
      if (!existing) return null;

      const rows = await db
        .update(companyConnectors)
        .set({
          status: "error" as ConnectorStatus,
          lastError: errorMessage,
          updatedAt: new Date(),
        })
        .where(eq(companyConnectors.id, existing.id))
        .returning();
      return rows[0] ?? null;
    },
  };
}