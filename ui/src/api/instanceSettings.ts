import type {
  InstanceExperimentalSettings,
  InstanceGeneralSettings,
  IssueGraphLivenessAutoRecoveryPreview,
  PatchInstanceGeneralSettings,
  PatchInstanceExperimentalSettings,
} from "@paperclipai/shared";
import { api } from "./client";

export interface PreviewEventRecord {
  ok: boolean;
  at: string;
  error: string | null;
}

export interface InstancePreviewSettingsView {
  domain: string | null;
  dnsProvider: "hostinger";
  dnsZone: string | null;
  dnsTokenConfigured: boolean;
  enabledCompanyIds: string[];
  lastDnsTest: PreviewEventRecord | null;
  lastChallenge: PreviewEventRecord | null;
  challenge: { delegated: boolean; cnameName: string; cnameTarget: string } | null;
  certificate: {
    status: "valid" | "not_issued" | "expired" | "unreachable";
    expiresAt: string | null;
    issuer: string | null;
    error: string | null;
  } | null;
  companies: Array<{ id: string; name: string; previewsEnabled: boolean }>;
}

export interface PatchInstancePreviewSettings {
  domain?: string | null;
  dnsZone?: string | null;
  dnsToken?: string | null;
  enabledCompanyIds?: string[];
}

export const instanceSettingsApi = {
  getPreviews: () =>
    api.get<InstancePreviewSettingsView>("/instance/settings/previews"),
  updatePreviews: (patch: PatchInstancePreviewSettings) =>
    api.patch<InstancePreviewSettingsView>("/instance/settings/previews", patch),
  testPreviewsDns: () =>
    api.post<{ ok: boolean; record: string; error: string | null }>("/instance/settings/previews/test-dns", {}),
  getGeneral: () =>
    api.get<InstanceGeneralSettings>("/instance/settings/general"),
  updateGeneral: (patch: PatchInstanceGeneralSettings) =>
    api.patch<InstanceGeneralSettings>("/instance/settings/general", patch),
  getExperimental: () =>
    api.get<InstanceExperimentalSettings>("/instance/settings/experimental"),
  updateExperimental: (patch: PatchInstanceExperimentalSettings) =>
    api.patch<InstanceExperimentalSettings>("/instance/settings/experimental", patch),
  previewIssueGraphLivenessAutoRecovery: (input: { lookbackHours?: number }) =>
    api.post<IssueGraphLivenessAutoRecoveryPreview>(
      "/instance/settings/experimental/issue-graph-liveness-auto-recovery/preview",
      input,
    ),
  runIssueGraphLivenessAutoRecovery: (input: { lookbackHours?: number }) =>
    api.post<{
      findings: number;
      autoRecoveryEnabled: boolean;
      lookbackHours: number;
      cutoff: string;
      escalationsCreated: number;
      existingEscalations: number;
      skipped: number;
      skippedAutoRecoveryDisabled: number;
      skippedOutsideLookback: number;
      escalationIssueIds: string[];
    }>(
      "/instance/settings/experimental/issue-graph-liveness-auto-recovery/run",
      input,
    ),
};
