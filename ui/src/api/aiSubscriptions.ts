import { api } from "./client";

export type AiSubscriptionProvider = "claude" | "codex";

export interface AiSubscriptionSummary {
  provider: AiSubscriptionProvider;
  status: "active" | "invalid";
  method: string;
  accountLabel: string | null;
  lastError: string | null;
  lastUsedAt: string | null;
  connectedAt: string;
  updatedAt: string;
}

export type CodexDeviceLoginState =
  | { state: "idle" }
  | { state: "pending"; verificationUrl: string | null; userCode: string | null; startedAt: string; expiresAt: string }
  | { state: "succeeded"; finishedAt: string }
  | { state: "failed"; error: string; finishedAt: string };

export interface MyAiSubscriptions {
  subscriptions: AiSubscriptionSummary[];
  codexDeviceLogin: CodexDeviceLoginState;
}

export interface IssueAiSubscription {
  issueId: string;
  provider: AiSubscriptionProvider | null;
  ownerUserId: string | null;
  ownerName: string | null;
  isMine: boolean;
  canClear: boolean;
  mySubscription: AiSubscriptionSummary | null;
}

export const aiSubscriptionsApi = {
  listMine: () => api.get<MyAiSubscriptions>("/me/ai-subscriptions"),
  saveClaudeToken: (token: string) => api.put<AiSubscriptionSummary>("/me/ai-subscriptions/claude", { token }),
  saveCodexAuthJson: (authJson: string) =>
    api.put<AiSubscriptionSummary>("/me/ai-subscriptions/codex/auth-json", { authJson }),
  startCodexDeviceLogin: () => api.post<CodexDeviceLoginState>("/me/ai-subscriptions/codex/device-login", {}),
  getCodexDeviceLogin: () => api.get<CodexDeviceLoginState>("/me/ai-subscriptions/codex/device-login"),
  cancelCodexDeviceLogin: () => api.delete<CodexDeviceLoginState>("/me/ai-subscriptions/codex/device-login"),
  disconnect: (provider: AiSubscriptionProvider) => api.delete<{ ok: true }>(`/me/ai-subscriptions/${provider}`),
  myModels: (provider: AiSubscriptionProvider) =>
    api.get<Array<{ id: string; label: string }>>(`/me/ai-subscriptions/${provider}/models`),
  issueModels: (issueId: string) => api.get<Array<{ id: string; label: string }>>(`/issues/${issueId}/ai-subscription/models`),
  getForIssue: (issueId: string) => api.get<IssueAiSubscription>(`/issues/${issueId}/ai-subscription`),
  setForIssue: (issueId: string, enabled: boolean) =>
    api.put<IssueAiSubscription>(`/issues/${issueId}/ai-subscription`, { enabled }),
};
