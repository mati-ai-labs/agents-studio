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
import { companyConnectors, type ConnectorType, type ConnectorStatus } from "@paperclipai/db";
import { conflict } from "../errors.js";
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
  userId?: string | null;
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

interface UserScopedConnectorState<T> {
  __paperclipUserScoped: true;
  byUser: Record<string, T>;
  legacy?: T;
}

const USER_SCOPED_MARKER = "__paperclipUserScoped";

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const err = error as { code?: string; constraint?: string };
  return err.code === "23505";
}

/**
 * Encrypted credentials are stored as JSON string in credentialsEncrypted field.
 */
function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toConfigObject(value: unknown): Record<string, unknown> {
  return isObjectRecord(value) ? value : {};
}

function normalizeUserId(userId: string | null | undefined): string | null {
  if (typeof userId !== "string") return null;
  const trimmed = userId.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseConnectorCredentials(value: unknown): ConnectorCredentials | null {
  if (!isObjectRecord(value)) return null;
  const accessToken =
    typeof value.accessToken === "string" && value.accessToken.trim().length > 0
      ? value.accessToken.trim()
      : null;
  if (!accessToken) return null;

  const refreshToken =
    typeof value.refreshToken === "string" && value.refreshToken.trim().length > 0
      ? value.refreshToken.trim()
      : undefined;
  const expiry =
    typeof value.expiry === "number" && Number.isFinite(value.expiry) && value.expiry > 0
      ? Math.floor(value.expiry)
      : undefined;
  return { accessToken, refreshToken, expiry };
}

function decodeUserScopedState<T>(
  raw: unknown,
  parser: (value: unknown) => T | null,
): { byUser: Record<string, T>; legacy: T | null } {
  const parsedLegacy = parser(raw);
  if (parsedLegacy) return { byUser: {}, legacy: parsedLegacy };
  if (!isObjectRecord(raw) || raw[USER_SCOPED_MARKER] !== true) return { byUser: {}, legacy: null };

  const byUser: Record<string, T> = {};
  const rawByUser = isObjectRecord(raw.byUser) ? raw.byUser : {};
  for (const [key, value] of Object.entries(rawByUser)) {
    const parsed = parser(value);
    if (parsed) byUser[key] = parsed;
  }
  return { byUser, legacy: parser(raw.legacy) };
}

function encodeUserScopedState<T>(state: { byUser: Record<string, T>; legacy?: T | null }): unknown {
  const byUserEntries = Object.entries(state.byUser);
  if (byUserEntries.length === 0) {
    return state.legacy ?? null;
  }
  return {
    [USER_SCOPED_MARKER]: true,
    byUser: state.byUser,
    ...(state.legacy ? { legacy: state.legacy } : {}),
  } satisfies UserScopedConnectorState<T>;
}

function encryptCredentialsPayload(payload: unknown): string {
  return encryptValue(JSON.stringify(payload));
}

function decryptCredentialsPayload(encrypted: string): unknown {
  const decrypted = decryptValue(encrypted);
  return JSON.parse(decrypted) as unknown;
}

function readCredentialsStore(encrypted: string | null | undefined): { byUser: Record<string, ConnectorCredentials>; legacy: ConnectorCredentials | null } {
  if (!encrypted) return { byUser: {}, legacy: null };
  return decodeUserScopedState<ConnectorCredentials>(
    decryptCredentialsPayload(encrypted),
    parseConnectorCredentials,
  );
}

function selectCredentialsForUser(
  encrypted: string | null | undefined,
  userId: string | null | undefined,
): ConnectorCredentials | null {
  const normalizedUserId = normalizeUserId(userId);
  const decoded = readCredentialsStore(encrypted);
  if (!normalizedUserId) return decoded.legacy;
  return decoded.byUser[normalizedUserId] ?? decoded.legacy ?? null;
}

function readConfigStore(rawConfig: unknown): { byUser: Record<string, Record<string, unknown>>; legacy: Record<string, unknown> } {
  const root = toConfigObject(rawConfig);
  if (root[USER_SCOPED_MARKER] !== true) {
    return { byUser: {}, legacy: root };
  }
  const rawByUser = toConfigObject(root.byUser);
  const byUser: Record<string, Record<string, unknown>> = {};
  for (const [key, value] of Object.entries(rawByUser)) {
    byUser[key] = toConfigObject(value);
  }
  return {
    byUser,
    legacy: toConfigObject(root.legacy),
  };
}

function buildConfigForUser(rawConfig: unknown, userId: string | null | undefined): Record<string, unknown> {
  const normalizedUserId = normalizeUserId(userId);
  const decoded = readConfigStore(rawConfig);
  if (!normalizedUserId) return decoded.legacy;
  return {
    ...decoded.legacy,
    ...(decoded.byUser[normalizedUserId] ?? {}),
  };
}

function writeConfigForUser(
  rawConfig: unknown,
  userId: string,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const decoded = readConfigStore(rawConfig);
  decoded.byUser[userId] = config;
  return encodeUserScopedState<Record<string, unknown>>({
    byUser: decoded.byUser,
    legacy: Object.keys(decoded.legacy).length > 0 ? decoded.legacy : null,
  }) as Record<string, unknown>;
}

function deleteConfigForUser(rawConfig: unknown, userId: string): Record<string, unknown> {
  const decoded = readConfigStore(rawConfig);
  delete decoded.byUser[userId];
  const encoded = encodeUserScopedState<Record<string, unknown>>({
    byUser: decoded.byUser,
    legacy: Object.keys(decoded.legacy).length > 0 ? decoded.legacy : null,
  });
  return toConfigObject(encoded);
}

function hasAnyCredentials(
  encrypted: string | null | undefined,
): boolean {
  const decoded = readCredentialsStore(encrypted);
  return Boolean(decoded.legacy) || Object.keys(decoded.byUser).length > 0;
}

function projectRecordForUser(
  record: ConnectorRecord,
  userId: string | null | undefined,
): ConnectorRecord {
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) return record;

  const userConfig = buildConfigForUser(record.config, normalizedUserId);
  const userCreds = selectCredentialsForUser(record.credentialsEncrypted, normalizedUserId);
  const status: ConnectorStatus = userCreds
    ? (record.status === "error" ? "error" : "connected")
    : (record.status === "connecting" ? "connecting" : "disconnected");
  const displayName = typeof userConfig.displayName === "string"
    ? userConfig.displayName
    : (userCreds ? record.displayName : null);
  return {
    ...record,
    config: userConfig,
    status,
    displayName,
  };
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
     * List connectors projected for a specific user.
     */
    listByCompanyForUser: async (companyId: string, userId: string) => {
      const rows = await db
        .select()
        .from(companyConnectors)
        .where(eq(companyConnectors.companyId, companyId));
      return rows.map((row) => projectRecordForUser(row, userId));
    },

    /**
     * Get a single connector by company + type.
     */
    getByType: async (companyId: string, type: ConnectorType, userId?: string | null) => {
      const row = await getByCompanyAndType(companyId, type);
      return row ? projectRecordForUser(row, userId) : null;
    },

    /**
     * Get a single connector by its ID.
     */
    getById,

    /**
     * Upsert a connector (create or update existing).
     * Used during OAuth callback to persist/update credentials.
     */
    upsert: async (input: UpsertConnectorInput): Promise<ConnectorRecord> => {
      const userId = normalizeUserId(input.userId);
      const existing = await getByCompanyAndType(input.companyId, input.type);

      if (existing) {
        const setClause: Partial<typeof companyConnectors.$inferInsert> & { updatedAt: Date } = {
          updatedAt: new Date(),
        };

        if (input.config !== undefined) {
          if (userId) {
            const userConfig = {
              ...buildConfigForUser(existing.config, userId),
              ...input.config,
            };
            if (input.displayName !== undefined) userConfig.displayName = input.displayName;
            setClause.config = writeConfigForUser(existing.config, userId, userConfig);
          } else {
            setClause.config = input.config;
          }
        } else if (userId && input.displayName !== undefined) {
          const userConfig = {
            ...buildConfigForUser(existing.config, userId),
            displayName: input.displayName,
          };
          setClause.config = writeConfigForUser(existing.config, userId, userConfig);
        }
        if (input.status !== undefined) setClause.status = input.status;
        if (input.credentials !== undefined) {
          if (userId) {
            const credsState = readCredentialsStore(existing.credentialsEncrypted);
            credsState.byUser[userId] = input.credentials;
            setClause.credentialsEncrypted = encryptCredentialsPayload(
              encodeUserScopedState<ConnectorCredentials>({
                byUser: credsState.byUser,
                legacy: credsState.legacy,
              }),
            );
          } else {
            setClause.credentialsEncrypted = encryptCredentialsPayload(input.credentials);
          }
        }
        if (!userId && input.displayName !== undefined) setClause.displayName = input.displayName;

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
        return projectRecordForUser(rows[0], userId);
      }

      // Insert new
      const insertConfig = userId && input.config
        ? writeConfigForUser({}, userId, {
            ...input.config,
            ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
          })
        : (input.config ?? {});

      const insertCredentials = (() => {
        if (!input.credentials) return null;
        if (!userId) return encryptCredentialsPayload(input.credentials);
        return encryptCredentialsPayload(
          encodeUserScopedState<ConnectorCredentials>({
            byUser: { [userId]: input.credentials },
          }),
        );
      })();

      const insertValues: typeof companyConnectors.$inferInsert = {
        companyId: input.companyId,
        type: input.type,
        config: insertConfig,
        status: input.status ?? "disconnected",
        credentialsEncrypted: insertCredentials,
        displayName: userId ? null : (input.displayName ?? null),
        connectedAt: input.status === "connected" ? new Date() : null,
        disconnectedAt: input.status === "disconnected" ? new Date() : null,
      };

      try {
        const rows = await db
          .insert(companyConnectors)
          .values(insertValues)
          .returning();
        return projectRecordForUser(rows[0], userId);
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
     * Disconnect only a single user's credentials for a connector.
     */
    disconnectForUser: async (
      companyId: string,
      type: ConnectorType,
      userId: string,
    ): Promise<ConnectorRecord | null> => {
      const existing = await getByCompanyAndType(companyId, type);
      if (!existing) return null;

      const normalizedUserId = normalizeUserId(userId);
      if (!normalizedUserId) return projectRecordForUser(existing, userId);

      const credsState = readCredentialsStore(existing.credentialsEncrypted);
      if (!credsState.byUser[normalizedUserId]) {
        return projectRecordForUser(existing, normalizedUserId);
      }
      delete credsState.byUser[normalizedUserId];

      const nextCredentialsPayload = encodeUserScopedState<ConnectorCredentials>({
        byUser: credsState.byUser,
        legacy: credsState.legacy,
      });
      const nextCredentialsEncrypted = nextCredentialsPayload
        ? encryptCredentialsPayload(nextCredentialsPayload)
        : null;
      const hasRemainingCredentials = hasAnyCredentials(nextCredentialsEncrypted);
      const nextConfig = deleteConfigForUser(existing.config, normalizedUserId);

      const rows = await db
        .update(companyConnectors)
        .set({
          status: hasRemainingCredentials ? existing.status : ("disconnected" as ConnectorStatus),
          credentialsEncrypted: nextCredentialsEncrypted,
          config: nextConfig,
          lastError: null,
          disconnectedAt: hasRemainingCredentials ? existing.disconnectedAt : new Date(),
          updatedAt: new Date(),
        })
        .where(eq(companyConnectors.id, existing.id))
        .returning();
      return rows[0] ? projectRecordForUser(rows[0], normalizedUserId) : null;
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
      opts?: { userId?: string | null },
    ): Promise<ConnectorCredentials | null> => {
      const existing = await getByCompanyAndType(companyId, type);
      if (!existing?.credentialsEncrypted) return null;
      return selectCredentialsForUser(existing.credentialsEncrypted, opts?.userId);
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
