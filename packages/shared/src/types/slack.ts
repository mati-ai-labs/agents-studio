/**
 * @fileoverview Shared Slack two-way integration types.
 *
 * @see PLAN.md §3 for the type contract.
 */

export type SlackDeliveryStatus =
  | "pending"
  | "processing"
  | "succeeded"
  | "ignored"
  | "failed"
  | "sent";

export type SlackOutboundDeliveryKind =
  | "acknowledgement"
  | "progress"
  | "completion"
  | "error";

export interface SlackChannelRoute {
  id: string;
  companyId: string;
  connectorId: string;
  workspaceId: string;
  channelId: string;
  channelName: string;
  assigneeAgentId: string;
  assigneeAgentName?: string | null;
  enabled: boolean;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SlackChannelRouteListResponse {
  routes: SlackChannelRoute[];
}

export interface UpsertSlackChannelRouteInput {
  assigneeAgentId: string;
  enabled?: boolean;
}

export interface SlackEventsInfo {
  eventRequestUrl: string;
  signingSecretConfigured: boolean;
  appIdConfigured: boolean;
  requiredScopesPresent: boolean;
  missingScopes: string[];
  enabledChannelRouteCount: number;
  workspaceId: string | null;
  workspaceName: string | null;
  scopes: string[];
}

export interface SlackChannelRouteEventsInfo {
  signingSecretConfigured: boolean;
  appIdConfigured: boolean;
  requiredScopesPresent: boolean;
  missingScopes: string[];
  enabledRouteCount: number;
  workspaceId: string | null;
}